import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { RunLedger, getSharedRunLedger } from "../ledger/runLedger";

const execFileAsync = promisify(execFile);

export type SelfDeployStatus = "deployed" | "rolled_back" | "failed" | "rollback_failed";
export type RollbackStatus = "none" | "rolled_back" | "failed";

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
  hostAddress?: string; // Node IP or hostname, defaults to host.docker.internal
}

export type CommandRunner = (
  file: string,
  args: string[],
  options?: { cwd?: string; timeout?: number }
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type HealthChecker = (url: string) => Promise<{ status: number; ok: boolean }>;

export interface SelfDeployPipelineOptions {
  enabled?: boolean;
  ledger?: RunLedger;
  repoRoot?: string;
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

const K8S_DNS_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function validateK8sResourceName(name: string, label: string = "resource"): void {
  if (!name || !K8S_DNS_LABEL_REGEX.test(name)) {
    throw new Error(
      `Invalid Kubernetes ${label} '${name}'. Must conform to RFC 1123 DNS label regex: ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`
    );
  }
}

export class SelfDeployPipeline {
  private enabled: boolean;
  private ledger?: RunLedger;
  private repoRoot: string;
  private commandRunner: CommandRunner;
  private healthChecker: HealthChecker;
  private explicitHealthCheckUrl?: string;

  constructor(options: SelfDeployPipelineOptions = {}) {
    this.enabled = options.enabled ?? isSelfDeployKillSwitchEnabled();
    this.ledger = options.ledger;
    this.explicitHealthCheckUrl = options.healthCheckUrl;
    this.repoRoot =
      options.repoRoot ||
      path.resolve(process.cwd(), fs.existsSync(path.join(process.cwd(), "web-ui")) ? "." : "..");

    this.commandRunner =
      options.commandRunner ??
      (async (file: string, args: string[], cmdOpts?: { cwd?: string; timeout?: number }) => {
        try {
          const { stdout, stderr } = await execFileAsync(file, args, {
            cwd: cmdOpts?.cwd || this.repoRoot,
            timeout: cmdOpts?.timeout || 120000
          });
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
          const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
          return { status: res.status, ok: res.status >= 200 && res.status < 400 };
        } catch {
          return { status: 503, ok: false };
        }
      });
  }

  public getDeployHistory(): SelfDeployRecord[] {
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
      const rows = db.prepare("SELECT * FROM self_deploy_history ORDER BY timestamp DESC").all() as any[];
      if (rows && rows.length > 0) {
        return rows.map((r) => ({
          deployId: r.deploy_id,
          timestamp: r.timestamp,
          branchName: r.branch_name,
          previousSha: r.previous_sha,
          newSha: r.new_sha,
          status: r.status as SelfDeployStatus,
          rollbackStatus: r.rollback_status as RollbackStatus,
          healthCheckResult: {
            status: r.health_status,
            ok: r.health_status >= 200 && r.health_status < 400
          },
          timeline: [],
          errorMessage: r.error_message || undefined
        }));
      }
    } catch {
      // Non-fatal, fallback to in-memory history
    }
    return [...inMemoryDeployHistory];
  }

  public async executeDeploy(
    input: SelfDeployInput & { preRollout?: boolean; skipPreRollout?: boolean }
  ): Promise<SelfDeployRecord> {
    const branchLower = (input.branchName || "").toLowerCase().trim();
    if (branchLower === "main" || branchLower === "master") {
      throw new Error("Self-deploy directly from main is strictly blocked by safety rails.");
    }

    if (input.branchName && (input.branchName.startsWith("feat/task-") || input.branchName.startsWith("feat/"))) {
      const checkoutRes = await this.commandRunner("git", ["checkout", "develop"], { cwd: this.repoRoot });
      if (checkoutRes.exitCode !== 0) {
        throw new Error(`Git checkout develop failed: ${checkoutRes.stderr || checkoutRes.stdout}`);
      }
      const mergeRes = await this.commandRunner("git", ["merge", "--no-ff", input.branchName], { cwd: this.repoRoot });
      if (mergeRes.exitCode !== 0) {
        throw new Error(`Git merge --no-ff ${input.branchName} into develop failed: ${mergeRes.stderr || mergeRes.stdout}`);
      }
    }

    if (input.preRollout === true) {
      const gateRes = await this.commandRunner("npm", ["run", "test:gate"], { cwd: this.repoRoot });
      if (gateRes.exitCode !== 0) {
        throw new Error(`Pre-rollout test:gate failed: ${gateRes.stderr || gateRes.stdout}`);
      }
      const buildRes = await this.commandRunner("npm", ["run", "build"], { cwd: this.repoRoot });
      if (buildRes.exitCode !== 0) {
        throw new Error(`Pre-rollout build failed: ${buildRes.stderr || buildRes.stdout}`);
      }
    }
    return this.executeSelfDeploy(input);
  }

  public async executeSelfDeploy(input: SelfDeployInput): Promise<SelfDeployRecord> {
    const deployId = `dep-${Date.now()}`;
    const timestamp = new Date().toISOString();
    const deploymentName = input.deploymentName || "web-ui";
    const namespace = input.namespace || "local-agentic-sandbox";
    const hostAddress = input.hostAddress || "host.docker.internal";
    const healthCheckUrl =
      this.explicitHealthCheckUrl || `http://${hostAddress}:3001/api/sandbox-status`;
    const newImage = input.imageTag || `local-agentic-sandbox-web-ui:${input.newSha.slice(0, 8)}`;

    // 1. Safety Rails: Kill Switch check
    if (!this.enabled) {
      throw new Error("Self-deploy is disabled by kill switch (SELF_DEPLOY_ENABLED=false)");
    }

    // 2. Safety Rails: Never deploy directly from main
    const branchLower = input.branchName.toLowerCase().trim();
    if (branchLower === "main" || branchLower === "master") {
      throw new Error("Self-deploy directly from main is strictly blocked by safety rails.");
    }

    // 3. Security: Validate namespace and deploymentName against strict Kubernetes DNS label regex
    validateK8sResourceName(namespace, "namespace");
    validateK8sResourceName(deploymentName, "deployment");

    const timeline: SelfDeployTimelineStage[] = [];

    // Stage 1: Rebuild image from repo root with explicit Dockerfile
    timeline.push({
      stage: "rebuild_image",
      status: "in_progress",
      timestamp: new Date().toISOString()
    });

    const buildRes = await this.commandRunner(
      "docker",
      ["build", "-f", "web-ui/Dockerfile", "-t", newImage, "."],
      { cwd: this.repoRoot }
    );

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
      this.logToLedger(record);
      return record;
    }
    timeline[0].status = "completed";

    // Stage 2: Rolling update k8s deployment
    timeline.push({
      stage: "rolling_update",
      status: "in_progress",
      timestamp: new Date().toISOString()
    });

    const deployRes = await this.commandRunner("kubectl", [
      "-n",
      namespace,
      "set",
      "image",
      `deployment/${deploymentName}`,
      `web-ui=${newImage}`
    ]);

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
      this.logToLedger(record);
      return record;
    }

    const rolloutStatusRes = await this.commandRunner("kubectl", [
      "-n",
      namespace,
      "rollout",
      "status",
      `deployment/${deploymentName}`,
      "--timeout=90s"
    ]);

    if (rolloutStatusRes.exitCode !== 0) {
      timeline[1].status = "failed";
      timeline[1].detail = rolloutStatusRes.stderr || "rollout status timed out";

      timeline.push({
        stage: "rollback",
        status: "in_progress",
        timestamp: new Date().toISOString()
      });

      const rollbackRes = await this.commandRunner("kubectl", [
        "-n",
        namespace,
        "rollout",
        "undo",
        `deployment/${deploymentName}`
      ]);

      if (rollbackRes.exitCode !== 0) {
        timeline[2].status = "failed";
        timeline[2].detail = rollbackRes.stderr;
        const record: SelfDeployRecord = {
          deployId,
          timestamp,
          branchName: input.branchName,
          previousSha: input.previousSha,
          newSha: input.newSha,
          status: "rollback_failed",
          rollbackStatus: "failed",
          healthCheckResult: { status: 0, ok: false },
          timeline,
          errorMessage: `Rollout status failed and rollout undo failed: ${rollbackRes.stderr}`
        };
        inMemoryDeployHistory.unshift(record);
        this.logToLedger(record);
        return record;
      }

      const rollbackHealth = await this.healthChecker(healthCheckUrl);
      if (rollbackHealth.ok) {
        timeline[2].status = "completed";
        timeline[2].detail = "Rolled back to previous revision and health verified";
        const record: SelfDeployRecord = {
          deployId,
          timestamp,
          branchName: input.branchName,
          previousSha: input.previousSha,
          newSha: input.newSha,
          status: "rolled_back",
          rollbackStatus: "rolled_back",
          healthCheckResult: rollbackHealth,
          timeline,
          errorMessage: `Rollout status failed: ${rolloutStatusRes.stderr || rolloutStatusRes.stdout}. Automatic rollback executed and verified.`
        };
        inMemoryDeployHistory.unshift(record);
        this.logToLedger(record);
        return record;
      } else {
        timeline[2].status = "failed";
        timeline[2].detail = `Rollback health check failed with HTTP ${rollbackHealth.status}`;
        const record: SelfDeployRecord = {
          deployId,
          timestamp,
          branchName: input.branchName,
          previousSha: input.previousSha,
          newSha: input.newSha,
          status: "rollback_failed",
          rollbackStatus: "failed",
          healthCheckResult: rollbackHealth,
          timeline,
          errorMessage: `CRITICAL: Deployment rolled back after rollout timeout but health check still failing with HTTP ${rollbackHealth.status}. Manual inspection required.`
        };
        inMemoryDeployHistory.unshift(record);
        this.logToLedger(record);
        return record;
      }
    }
    timeline[1].status = "completed";

    // Stage 3: Health check
    timeline.push({
      stage: "health_check",
      status: "in_progress",
      timestamp: new Date().toISOString()
    });
    const healthResult = await this.healthChecker(healthCheckUrl);

    if (!healthResult.ok) {
      timeline[2].status = "failed";
      timeline[2].detail = `HTTP ${healthResult.status} failure`;

      // Stage 4: Trigger automatic rollback
      timeline.push({
        stage: "rollback",
        status: "in_progress",
        timestamp: new Date().toISOString()
      });

      const rollbackRes = await this.commandRunner("kubectl", [
        "-n",
        namespace,
        "rollout",
        "undo",
        `deployment/${deploymentName}`
      ]);

      if (rollbackRes.exitCode !== 0) {
        timeline[3].status = "failed";
        timeline[3].detail = rollbackRes.stderr;
        const record: SelfDeployRecord = {
          deployId,
          timestamp,
          branchName: input.branchName,
          previousSha: input.previousSha,
          newSha: input.newSha,
          status: "rollback_failed",
          rollbackStatus: "failed",
          healthCheckResult: healthResult,
          timeline,
          errorMessage: `Health check failed (HTTP ${healthResult.status}) and rollout undo failed: ${rollbackRes.stderr}`
        };
        inMemoryDeployHistory.unshift(record);
        this.logToLedger(record);
        return record;
      }

      // Fix 7.4: Verify health of the rolled-back deployment
      const rollbackHealth = await this.healthChecker(healthCheckUrl);
      if (rollbackHealth.ok) {
        timeline[3].status = "completed";
        timeline[3].detail = "Rolled back to previous revision and health verified";
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
          errorMessage: `Health check failed with HTTP ${healthResult.status}. Automatic rollback executed and verified.`
        };
        inMemoryDeployHistory.unshift(record);
        this.logToLedger(record);
        return record;
      } else {
        timeline[3].status = "failed";
        timeline[3].detail = `Rollback health check failed with HTTP ${rollbackHealth.status}`;
        const record: SelfDeployRecord = {
          deployId,
          timestamp,
          branchName: input.branchName,
          previousSha: input.previousSha,
          newSha: input.newSha,
          status: "rollback_failed",
          rollbackStatus: "failed",
          healthCheckResult: rollbackHealth,
          timeline,
          errorMessage: `CRITICAL: Deployment rolled back but health check still failing with HTTP ${rollbackHealth.status}. Manual inspection required.`
        };
        inMemoryDeployHistory.unshift(record);
        this.logToLedger(record);
        return record;
      }
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
