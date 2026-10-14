import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";
import { MORNING_REPORT_CHECKPOINT_DIR, getCanonicalCheckpointDir } from "../subagents/morningReport";

const requireModule = createRequire(import.meta.url);

export type RunLedgerStatus =
  | "running"
  | "paused"
  | "stopped"
  | "crashed"
  | "completed"
  | "parked"
  | "failed";

export interface LedgerMilestoneItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "parked" | "failed";
  commitSha?: string;
}

export interface RunLedgerEntry {
  runId: string;
  parentRunId?: string;
  threadId: string;
  prompt: string;
  status: RunLedgerStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  lastHeartbeatAt: string;
  model: string;
  gitShas: string[];
  milestoneSummary: LedgerMilestoneItem[];
  deploymentRef: string;
  checkpointPath?: string;
  resumable: boolean;
  errorMessage?: string;
}

export interface RecordRunStartInput {
  runId: string;
  parentRunId?: string;
  threadId: string;
  prompt: string;
  status: RunLedgerStatus;
  startedAt: string;
  completedAt?: string;
  lastHeartbeatAt?: string;
  model: string;
  gitShas: string[];
  milestoneSummary: LedgerMilestoneItem[];
  deploymentRef: string;
  checkpointPath?: string;
  resumable?: boolean;
  errorMessage?: string;
}

export interface UpdateRunProgressInput {
  status?: RunLedgerStatus;
  completedAt?: string;
  lastHeartbeatAt?: string;
  model?: string;
  gitShas?: string[];
  milestoneSummary?: LedgerMilestoneItem[];
  deploymentRef?: string;
  checkpointPath?: string;
  resumable?: boolean;
  errorMessage?: string;
}

export interface RunLedgerOptions {
  checkpointDir?: string;
  defaultStaleThresholdSeconds?: number;
}

export function getDefaultLedgerDbPath(): string {
  if (process.env.RUN_LEDGER_DB_PATH) {
    return process.env.RUN_LEDGER_DB_PATH;
  }
  return path.join(os.homedir(), ".local-agentic-sandbox", "runs.db");
}

export function getDefaultCheckpointDir(_dbPath?: string): string {
  if (process.env.AGENT_CHECKPOINT_DIR) {
    return path.resolve(process.env.AGENT_CHECKPOINT_DIR);
  }
  return getCanonicalCheckpointDir();
}

interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function openSqliteDatabase(dbPath: string): SqliteDatabase {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const { DatabaseSync } = requireModule("node:sqlite") as {
    DatabaseSync: new (filename: string) => SqliteDatabase;
  };
  return new DatabaseSync(dbPath);
}

export class RunLedger {
  private db: SqliteDatabase;
  private dbPath: string;
  private checkpointDir: string;
  private defaultStaleThresholdSeconds: number;
  private isClosed = false;

  constructor(dbPath: string = getDefaultLedgerDbPath(), options: RunLedgerOptions = {}) {
    this.dbPath = dbPath;
    this.checkpointDir = options.checkpointDir || getDefaultCheckpointDir(dbPath);
    this.defaultStaleThresholdSeconds = options.defaultStaleThresholdSeconds ?? 90;
    this.db = openSqliteDatabase(this.dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        parent_run_id TEXT,
        thread_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        last_heartbeat_at TEXT NOT NULL,
        model TEXT NOT NULL,
        git_shas_json TEXT NOT NULL,
        milestone_summary_json TEXT NOT NULL,
        deployment_ref TEXT NOT NULL,
        checkpoint_path TEXT,
        resumable INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_thread_id ON runs(thread_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
    `);
  }

  private validateRequiredFields(input: RecordRunStartInput): void {
    const requiredStrings: Array<[keyof RecordRunStartInput, unknown]> = [
      ["runId", input.runId],
      ["threadId", input.threadId],
      ["prompt", input.prompt],
      ["status", input.status],
      ["startedAt", input.startedAt],
      ["model", input.model],
      ["deploymentRef", input.deploymentRef]
    ];

    for (const [key, val] of requiredStrings) {
      if (typeof val !== "string" || val.trim().length === 0) {
        throw new Error(`Missing required ledger field: ${String(key)}`);
      }
    }

    if (!Array.isArray(input.gitShas)) {
      throw new Error("Missing required ledger field: gitShas");
    }
    if (!Array.isArray(input.milestoneSummary)) {
      throw new Error("Missing required ledger field: milestoneSummary");
    }
  }

  private rowToEntry(row: Record<string, unknown>): RunLedgerEntry {
    let gitShas: string[] = [];
    let milestoneSummary: LedgerMilestoneItem[] = [];
    try {
      gitShas = JSON.parse(String(row.git_shas_json || "[]"));
    } catch {
      gitShas = [];
    }
    try {
      milestoneSummary = JSON.parse(String(row.milestone_summary_json || "[]"));
    } catch {
      milestoneSummary = [];
    }

    return {
      runId: String(row.run_id),
      parentRunId: row.parent_run_id ? String(row.parent_run_id) : undefined,
      threadId: String(row.thread_id),
      prompt: String(row.prompt),
      status: String(row.status) as RunLedgerStatus,
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at ? String(row.completed_at) : undefined,
      lastHeartbeatAt: String(row.last_heartbeat_at),
      model: String(row.model),
      gitShas,
      milestoneSummary,
      deploymentRef: String(row.deployment_ref),
      checkpointPath: row.checkpoint_path ? String(row.checkpoint_path) : undefined,
      resumable: Number(row.resumable) === 1,
      errorMessage: row.error_message ? String(row.error_message) : undefined
    };
  }

  public recordRunStart(input: RecordRunStartInput): RunLedgerEntry {
    this.validateRequiredFields(input);

    const nowIso = new Date().toISOString();
    const lastHeartbeatAt = input.lastHeartbeatAt || input.startedAt || nowIso;
    const resumableInt = input.resumable ? 1 : 0;

    const stmt = this.db.prepare(`
      INSERT INTO runs (
        run_id, parent_run_id, thread_id, prompt, status,
        started_at, updated_at, completed_at, last_heartbeat_at,
        model, git_shas_json, milestone_summary_json, deployment_ref,
        checkpoint_path, resumable, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        parent_run_id = excluded.parent_run_id,
        thread_id = excluded.thread_id,
        prompt = excluded.prompt,
        status = excluded.status,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        last_heartbeat_at = excluded.last_heartbeat_at,
        model = excluded.model,
        git_shas_json = excluded.git_shas_json,
        milestone_summary_json = excluded.milestone_summary_json,
        deployment_ref = excluded.deployment_ref,
        checkpoint_path = excluded.checkpoint_path,
        resumable = excluded.resumable,
        error_message = excluded.error_message
    `);

    stmt.run(
      input.runId,
      input.parentRunId ?? null,
      input.threadId,
      input.prompt,
      input.status,
      input.startedAt,
      nowIso,
      input.completedAt ?? null,
      lastHeartbeatAt,
      input.model,
      JSON.stringify(input.gitShas),
      JSON.stringify(input.milestoneSummary),
      input.deploymentRef,
      input.checkpointPath ?? null,
      resumableInt,
      input.errorMessage ?? null
    );

    const saved = this.getRun(input.runId);
    if (!saved) {
      throw new Error(`Failed to read back run ${input.runId} from SQLite ledger`);
    }
    return saved;
  }

  public getRun(runId: string): RunLedgerEntry | null {
    const stmt = this.db.prepare("SELECT * FROM runs WHERE run_id = ?");
    const row = stmt.get(runId);
    if (!row) return null;
    return this.rowToEntry(row);
  }

  public listRuns(filter?: {
    threadId?: string;
    status?: RunLedgerStatus;
    limit?: number;
  }): RunLedgerEntry[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter?.threadId) {
      clauses.push("thread_id = ?");
      params.push(filter.threadId);
    }
    if (filter?.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitSql = filter?.limit ? `LIMIT ${Number(filter.limit)}` : "";

    const stmt = this.db.prepare(
      `SELECT * FROM runs ${whereSql} ORDER BY started_at DESC ${limitSql}`
    );
    const rows = stmt.all(...params);
    return rows.map((r) => this.rowToEntry(r));
  }

  public updateRunProgress(runId: string, update: UpdateRunProgressInput): RunLedgerEntry {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`Run not found in ledger: ${runId}`);
    }

    const nowIso = new Date().toISOString();
    const nextStatus = update.status ?? existing.status;
    const nextCompletedAt =
      update.completedAt !== undefined ? update.completedAt : existing.completedAt;
    const nextHeartbeat = update.lastHeartbeatAt ?? nowIso;
    const nextModel = update.model ?? existing.model;
    const nextGitShas = update.gitShas ?? existing.gitShas;
    const nextMilestones = update.milestoneSummary ?? existing.milestoneSummary;
    const nextDeployRef = update.deploymentRef ?? existing.deploymentRef;
    const nextCheckpoint =
      update.checkpointPath !== undefined ? update.checkpointPath : existing.checkpointPath;
    const nextResumable =
      update.resumable !== undefined ? update.resumable : existing.resumable;
    const nextError =
      update.errorMessage !== undefined ? update.errorMessage : existing.errorMessage;

    if (!nextModel || nextModel.trim().length === 0) {
      throw new Error("Missing required ledger field: model");
    }

    const stmt = this.db.prepare(`
      UPDATE runs SET
        status = ?,
        updated_at = ?,
        completed_at = ?,
        last_heartbeat_at = ?,
        model = ?,
        git_shas_json = ?,
        milestone_summary_json = ?,
        deployment_ref = ?,
        checkpoint_path = ?,
        resumable = ?,
        error_message = ?
      WHERE run_id = ?
    `);

    stmt.run(
      nextStatus,
      nowIso,
      nextCompletedAt ?? null,
      nextHeartbeat,
      nextModel,
      JSON.stringify(nextGitShas),
      JSON.stringify(nextMilestones),
      nextDeployRef,
      nextCheckpoint ?? null,
      nextResumable ? 1 : 0,
      nextError ?? null,
      runId
    );

    return this.getRun(runId)!;
  }

  public recordHeartbeat(runId: string, nowIso: string = new Date().toISOString()): RunLedgerEntry | null {
    const existing = this.getRun(runId);
    if (!existing) return null;
    return this.updateRunProgress(runId, { lastHeartbeatAt: nowIso });
  }

  public markStoppedMidFlight(runId: string, reason = "Run stopped mid-flight"): RunLedgerEntry {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`Run not found in ledger: ${runId}`);
    }

    return this.updateRunProgress(runId, {
      status: "stopped",
      resumable: true,
      errorMessage: reason,
      completedAt: new Date().toISOString()
    });
  }

  public pauseRun(
    runId: string,
    checkpointPayload?: Record<string, unknown>
  ): RunLedgerEntry {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`Run not found in ledger: ${runId}`);
    }

    if (!fs.existsSync(this.checkpointDir)) {
      fs.mkdirSync(this.checkpointDir, { recursive: true });
    }

    const checkpointPath =
      existing.checkpointPath || path.join(this.checkpointDir, `${runId}.checkpoint.json`);

    const completedMilestoneIds = existing.milestoneSummary
      .filter((m) => m.status === "completed")
      .map((m) => m.id);

    const payloadToSave = checkpointPayload ?? {
      taskId: existing.runId,
      threadId: existing.threadId,
      status: "paused",
      completedMilestoneIds,
      milestoneSummary: existing.milestoneSummary,
      savedAt: new Date().toISOString()
    };

    fs.writeFileSync(checkpointPath, JSON.stringify(payloadToSave, null, 2), "utf8");

    return this.updateRunProgress(runId, {
      status: "paused",
      checkpointPath,
      resumable: true
    });
  }

  public async resumeRun(
    runId: string,
    milestoneExecutor?: (milestone: LedgerMilestoneItem) => Promise<{ commitSha?: string }>
  ): Promise<RunLedgerEntry> {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`Run not found in ledger: ${runId}`);
    }

    if (
      existing.status !== "paused" &&
      existing.status !== "crashed" &&
      existing.status !== "stopped"
    ) {
      throw new Error(`Run ${runId} is in status '${existing.status}' and cannot be resumed`);
    }

    let completedIdsFromCheckpoint = new Set<string>(
      existing.milestoneSummary.filter((m) => m.status === "completed").map((m) => m.id)
    );

    if (existing.checkpointPath && fs.existsSync(existing.checkpointPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(existing.checkpointPath, "utf8"));
        if (Array.isArray(raw.completedMilestoneIds)) {
          for (const id of raw.completedMilestoneIds) {
            completedIdsFromCheckpoint.add(String(id));
          }
        }
      } catch {
        // Ignore malformed checkpoint file and rely on ledger milestone summary
      }
    }

    // Mark running immediately
    let current = this.updateRunProgress(runId, {
      status: "running",
      resumable: false
    });

    if (!milestoneExecutor) {
      return current;
    }

    const updatedMilestones: LedgerMilestoneItem[] = [...current.milestoneSummary];
    const updatedShas: string[] = [...current.gitShas];

    for (let i = 0; i < updatedMilestones.length; i++) {
      const m = updatedMilestones[i];
      if (m.status === "completed" || completedIdsFromCheckpoint.has(m.id)) {
        updatedMilestones[i] = { ...m, status: "completed" };
        continue;
      }

      updatedMilestones[i] = { ...m, status: "in_progress" };
      this.updateRunProgress(runId, {
        milestoneSummary: updatedMilestones
      });

      const execResult = await milestoneExecutor(updatedMilestones[i]);
      if (execResult?.commitSha) {
        updatedShas.push(execResult.commitSha);
      }
      updatedMilestones[i] = {
        ...updatedMilestones[i],
        status: "completed",
        commitSha: execResult?.commitSha ?? updatedMilestones[i].commitSha
      };

      current = this.updateRunProgress(runId, {
        gitShas: updatedShas,
        milestoneSummary: updatedMilestones
      });
    }

    return this.updateRunProgress(runId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      gitShas: updatedShas,
      milestoneSummary: updatedMilestones,
      resumable: false
    });
  }

  public restartRun(runId: string, customNewRunId?: string): RunLedgerEntry {
    const original = this.getRun(runId);
    if (!original) {
      throw new Error(`Cannot restart non-existent run: ${runId}`);
    }

    const newRunId =
      customNewRunId || `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const nowIso = new Date().toISOString();

    const freshMilestones: LedgerMilestoneItem[] = original.milestoneSummary.map((m) => ({
      id: m.id,
      title: m.title,
      status: "pending"
    }));

    return this.recordRunStart({
      runId: newRunId,
      parentRunId: original.runId,
      threadId: original.threadId,
      prompt: original.prompt,
      status: "running",
      startedAt: nowIso,
      lastHeartbeatAt: nowIso,
      model: original.model,
      gitShas: [],
      milestoneSummary: freshMilestones,
      deploymentRef: "pending",
      resumable: false
    });
  }

  public scanAndMarkCrashedRuns(options?: {
    staleThresholdSeconds?: number;
    nowMs?: number;
  }): RunLedgerEntry[] {
    const thresholdSec =
      options?.staleThresholdSeconds ?? this.defaultStaleThresholdSeconds;
    const nowMs = options?.nowMs ?? Date.now();

    const runningEntries = this.listRuns({ status: "running" });
    const crashed: RunLedgerEntry[] = [];

    for (const entry of runningEntries) {
      const hbMs = Date.parse(entry.lastHeartbeatAt || entry.startedAt);
      const elapsedSeconds = Number.isNaN(hbMs)
        ? thresholdSec + 1
        : (nowMs - hbMs) / 1000;

      if (elapsedSeconds > thresholdSec) {
        const updated = this.updateRunProgress(entry.runId, {
          status: "crashed",
          resumable: true,
          errorMessage: `No heartbeat for ${Math.round(elapsedSeconds)}s (threshold: ${thresholdSec}s). Marked crashed for resume.`
        });
        crashed.push(updated);
      }
    }

    return crashed;
  }

  public getDatabase(): SqliteDatabase {
    return this.db;
  }

  public close(): void {
    if (!this.isClosed) {
      this.isClosed = true;
      this.db.close();
    }
  }
}

let sharedLedger: RunLedger | null = null;
let startupScanCompleted = false;

export function getSharedRunLedger(): RunLedger {
  if (!sharedLedger) {
    sharedLedger = new RunLedger(getDefaultLedgerDbPath());
  }
  if (!startupScanCompleted) {
    startupScanCompleted = true;
    try {
      sharedLedger.scanAndMarkCrashedRuns();
    } catch {
      // Non-fatal on startup scan
    }
  }
  return sharedLedger;
}

export function closeSharedRunLedger(): void {
  if (sharedLedger) {
    sharedLedger.close();
    sharedLedger = null;
    startupScanCompleted = false;
  }
}

