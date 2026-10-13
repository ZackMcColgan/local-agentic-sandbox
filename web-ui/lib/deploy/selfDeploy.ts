import { exec } from "child_process";
import { promisify } from "util";
import { RunLedger, getSharedRunLedger } from "../ledger/runLedger";

const execAsync = promisify(exec);

export type SelfDeployStatus = "deployed" | "rolled_back" | "failed";
export type RollbackStatus = "none" | "rolled_back";

export interface SelfDeployTimelineStage {
  stage: "rebuild_image" | "rolling_update" | "health_check" | "rollback";
  status: "pending" | "in_progress" | "completed" | "failed";
  timestamp: string;
  detail?: string;
}

export interface SelfDeployRecord {
  deployId: string;
  timestamp: string;
  branchName: string;
  previousSha: string;
  newSha: string;
  status: SelfDeployStatus;
  rollbackStatus: RollbackStatus;
  healthCheckResult: { status: number; ok: boolean };
  timeline: SelfDeployTimelineStage[];
  errorMessage?: string;
}

export interface SelfDeployInput {
  branchName: string;
  previousSha: string;
  newSha: string;
  deploymentName?: string;
  namespace?: string;
  imageTag?: string;
}

export type CommandRunner = (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export type HealthChecker = (url: string) => Promise<{ status: number; ok: boolean }>;

export interface SelfDeployPipelineOptions {
  enabled?: boolean;
  ledger?: RunLedger;
  commandRunner?: CommandRunner;
  healthChecker?: HealthChecker;
  healthCheckUrl?: string;
}

let inMemoryDeployHistory: SelfDeployRecord[] = [];

export function getGlobalSelfDeployHistory(): SelfDeployRecord[] {
  return [...inMemoryDeployHistory];
}

export function isSelfDeployKillSwitchEnabled(): boolean {
  return process.env.SELF_DEPLOY_ENABLED === "true" || process.env.SELF_DEPLOY_ENABLED === "1";
}

export class SelfDeployPipeline {
  private enabled: boolean;
  private ledger?: RunLedger;
  private commandRunner: CommandRunner;
  private healthChecker: HealthChecker;
  private healthCheckUrl: string;

  constructor(options: SelfDeployPipelineOptions = {}) {
    this.enabled = options.enabled ?? isSelfDeployKillSwitchEnabled();
    this.ledger = options.ledger;
    this.healthCheckUrl = options.healthCheckUrl || "http://localhost:3001/api/sandbox-status";

    this.commandRunner =
      options.commandRunner ??
      (async (cmd: string) => {
        try {
          const { stdout, stderr } = await execAsync(cmd, { timeout: 120000 });
          return { exitCode: 0, stdout: stdout || "", stderr: stderr || "" };
        } catch (err: any) {
          return {
            exitCode: typeof err?.code === "number" ? err.code : 1,
            stdout: err?.stdout || "",
            stderr: err?.stderr || err?.message || String(err)
          };
        }
      });

    this.healthChecker =
      options.healthChecker ??
      (async (url: string) => {
        try {
          const res = await fetch(url);
          return { status: res.status, ok: res.status >= 200 && res.status < 400 };
        } catch {
          return { status: 503, ok: false };
        }
      });
  }

  public getDeployHistory(): SelfDeployRecord[] {
    return [...inMemoryDeployHistory];
  }

  public async executeSelfDeploy(input: SelfDeployInput): Promise<SelfDeployRecord> {
    const deployId = `dep-${Date.now()}`;
    const timestamp = new Date().toISOString();
    const deploymentName = input.deploymentName || "web-ui";
    const namespace = input.namespace || "local-agentic-sandbox";
    const newImage = input.imageTag || `local-agentic-sandbox/web-ui:${input.newSha.slice(0, 8)}`;

    // 1. Safety Rails: Kill Switch check
    if (!this.enabled) {
      throw new Error("Self-deploy is disabled by kill switch (SELF_DEPLOY_ENABLED=false)");
    }

    // 2. Safety Rails: Never deploy directly from main
    const branchLower = input.branchName.toLowerCase().trim();
    if (branchLower === "main" || branchLower === "master") {
      throw new Error("Self-deploy directly from main is strictly blocked by safety rails.");
    }

    const timeline: SelfDeployTimelineStage[] = [];

    // Stage 1: Rebuild image
    timeline.push({
      stage: "rebuild_image",
      status: "in_progress",
      timestamp: new Date().toISOString()
    });
    const buildRes = await this.commandRunner(`docker build -t ${newImage} web-ui`);
    if (buildRes.exitCode !== 0) {
      timeline[0].status = "failed";
      timeline[0].detail = buildRes.stderr;
      const record: SelfDeployRecord = {
        deployId,
        timestamp,
        branchName: input.branchName,
        previousSha: input.previousSha,
        newSha: input.newSha,
        status: "failed",
        rollbackStatus: "none",
        healthCheckResult: { status: 0, ok: false },
        timeline,
        errorMessage: `Build failed: ${buildRes.stderr || buildRes.stdout}`
      };
      inMemoryDeployHistory.unshift(record);
      return record;
    }
    timeline[0].status = "completed";

    // Stage 2: Rolling update k8s deployment
    timeline.push({
      stage: "rolling_update",
      status: "in_progress",
      timestamp: new Date().toISOString()
    });
    const deployRes = await this.commandRunner(
      `kubectl -n ${namespace} set image deployment/${deploymentName} web-ui=${newImage}`
    );
    if (deployRes.exitCode !== 0) {
      timeline[1].status = "failed";
      timeline[1].detail = deployRes.stderr;
      const record: SelfDeployRecord = {
        deployId,
        timestamp,
        branchName: input.branchName,
        previousSha: input.previousSha,
        newSha: input.newSha,
        status: "failed",
        rollbackStatus: "none",
        healthCheckResult: { status: 0, ok: false },
        timeline,
        errorMessage: `kubectl deployment set image failed: ${deployRes.stderr || deployRes.stdout}`
      };
      inMemoryDeployHistory.unshift(record);
      return record;
    }
    timeline[1].status = "completed";

    // Stage 3: Health check
    timeline.push({
      stage: "health_check",
      status: "in_progress",
      timestamp: new Date().toISOString()
    });
    const healthResult = await this.healthChecker(this.healthCheckUrl);

    if (!healthResult.ok) {
      timeline[2].status = "failed";
      timeline[2].detail = `HTTP ${healthResult.status} failure`;

      // Stage 4: Trigger automatic rollback
      timeline.push({
        stage: "rollback",
        status: "in_progress",
        timestamp: new Date().toISOString()
      });

      const rollbackCmd = `kubectl -n ${namespace} rollout undo deployment/${deploymentName}`;
      const rollbackRes = await this.commandRunner(rollbackCmd);
      timeline[3].status = rollbackRes.exitCode === 0 ? "completed" : "failed";
      timeline[3].detail = rollbackRes.exitCode === 0 ? "Rolled back to previous revision" : rollbackRes.stderr;

      const record: SelfDeployRecord = {
        deployId,
        timestamp,
        branchName: input.branchName,
        previousSha: input.previousSha,
        newSha: input.newSha,
        status: "rolled_back",
        rollbackStatus: "rolled_back",
        healthCheckResult: healthResult,
        timeline,
        errorMessage: `Health check failed with HTTP ${healthResult.status}. Automatic rollback executed.`
      };
      inMemoryDeployHistory.unshift(record);
      this.logToLedger(record);
      return record;
    }

    timeline[2].status = "completed";

    const record: SelfDeployRecord = {
      deployId,
      timestamp,
      branchName: input.branchName,
      previousSha: input.previousSha,
      newSha: input.newSha,
      status: "deployed",
      rollbackStatus: "none",
      healthCheckResult: healthResult,
      timeline
    };

    inMemoryDeployHistory.unshift(record);
    this.logToLedger(record);
    return record;
  }

  private logToLedger(record: SelfDeployRecord): void {
    try {
      const ledgerToUse = this.ledger || getSharedRunLedger();
      const db = ledgerToUse.getDatabase();
      db.exec(`
        CREATE TABLE IF NOT EXISTS self_deploy_history (
          deploy_id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          branch_name TEXT NOT NULL,
          previous_sha TEXT NOT NULL,
          new_sha TEXT NOT NULL,
          status TEXT NOT NULL,
          rollback_status TEXT NOT NULL,
          health_status INTEGER NOT NULL,
          error_message TEXT
        );
      `);
      const stmt = db.prepare(`
        INSERT INTO self_deploy_history (
          deploy_id, timestamp, branch_name, previous_sha, new_sha,
          status, rollback_status, health_status, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        record.deployId,
        record.timestamp,
        record.branchName,
        record.previousSha,
        record.newSha,
        record.status,
        record.rollbackStatus,
        record.healthCheckResult.status,
        record.errorMessage ?? null
      );
    } catch {
      // Non-fatal if DB write fails
    }
  }
}
