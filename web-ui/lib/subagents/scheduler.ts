import fs from "fs";
import path from "path";
import { TaskManifest, TaskStatus, Milestone } from "./types";
import { OvernightSupervisor, createProductionStepExecutor, type StepExecutor } from "./supervisor";
import { WorkerPool } from "./workerPool";

export type ScheduleId = string;

export interface Schedule {
  id: ScheduleId;
  cronExpression: string;
  taskDescription: string;
  enabled: boolean;
  createdAt: string;
  lastRun?: string;
  nextRun: string;
  failureCount?: number;
  backoffUntil?: string;
}

export interface SchedulerHeartbeat {
  runId: string;
  scheduleId: string;
  lastHeartbeat: string;
  attempt: number;
  active: boolean;
}

export interface SchedulerExecutionOptions {
  runner?: (manifest: TaskManifest) => Promise<TaskManifest>;
  stepExecutor?: StepExecutor;
  workerPool?: WorkerPool;
}

export interface SchedulerOptions {
  storageFile?: string;
  workspaceDir?: string;
  supervisor?: OvernightSupervisor;
  stepExecutor?: StepExecutor;
  workerPool?: WorkerPool;
}

function getDefaultWorkspace(): string {
  return process.env.WORKSPACE_DIR || path.resolve(process.cwd(), "workspace");
}
const BACKOFF_INTERVALS_MS = [60000, 120000, 240000, 480000, 1800000]; // 1m, 2m, 4m, 8m, max 30m

/**
 * Minimal robust cron parser for standard 5-part cron expressions:
 * minute (0-59), hour (0-23), dayOfMonth (1-31), month (1-12), dayOfWeek (0-6, 0=Sun)
 */
export function calculateNextRun(cronExpr: string, fromDate?: Date): Date {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression '${cronExpr}': expected 5 fields`);
  }

  const [minPart, hrPart, domPart, monPart, dowPart] = parts;
  const start = new Date(fromDate || Date.now());
  start.setUTCSeconds(0);
  start.setUTCMilliseconds(0);

  function matchesField(val: number, expr: string, minRange: number, maxRange: number): boolean {
    if (expr === "*") return true;
    if (expr.startsWith("*/")) {
      const step = parseInt(expr.slice(2), 10);
      return !isNaN(step) && step > 0 && val % step === 0;
    }
    const subParts = expr.split(",");
    for (const sub of subParts) {
      if (sub.includes("-")) {
        const [low, high] = sub.split("-").map(Number);
        if (val >= low && val <= high) return true;
      } else if (parseInt(sub, 10) === val) {
        return true;
      }
    }
    return false;
  }

  const candidate = new Date(start.getTime() + 60000);
  const maxSearch = 366 * 24 * 60;

  for (let i = 0; i < maxSearch; i++) {
    const min = candidate.getUTCMinutes();
    const hr = candidate.getUTCHours();
    const dom = candidate.getUTCDate();
    const mon = candidate.getUTCMonth() + 1;
    const dow = candidate.getUTCDay();

    if (
      matchesField(min, minPart, 0, 59) &&
      matchesField(hr, hrPart, 0, 23) &&
      matchesField(dom, domPart, 1, 31) &&
      matchesField(mon, monPart, 1, 12) &&
      matchesField(dow, dowPart, 0, 6)
    ) {
      return candidate;
    }
    candidate.setTime(candidate.getTime() + 60000);
  }

  throw new Error(`Could not find next run within 1 year for cron expression: ${cronExpr}`);
}

export class UnattendedScheduler {
  readonly storageFile: string;
  readonly workspaceDir: string;
  private supervisor?: OvernightSupervisor;
  private stepExecutor?: StepExecutor;
  private workerPool?: WorkerPool;

  constructor(options?: SchedulerOptions) {
    this.workspaceDir = options?.workspaceDir || getDefaultWorkspace();
    this.storageFile = options?.storageFile || path.join(this.workspaceDir, "schedules.json");
    this.supervisor = options?.supervisor;
    this.stepExecutor = options?.stepExecutor;
    this.workerPool = options?.workerPool;

    this.ensureDirectories();
  }

  private ensureDirectories() {
    try {
      if (!fs.existsSync(this.workspaceDir)) fs.mkdirSync(this.workspaceDir, { recursive: true });
      const logsDir = path.join(this.workspaceDir, "logs");
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const reportsDir = path.join(this.workspaceDir, "reports");
      if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    } catch {}
  }

  getHeartbeatPath(): string {
    return path.join(this.workspaceDir, ".scheduler-heartbeat");
  }

  loadSchedules(): Schedule[] {
    try {
      if (!fs.existsSync(this.storageFile)) return [];
      const raw = fs.readFileSync(this.storageFile, "utf8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  saveSchedules(schedules: Schedule[]) {
    try {
      fs.writeFileSync(this.storageFile, JSON.stringify(schedules, null, 2), "utf8");
    } catch (err: any) {
      console.warn("[Scheduler] Could not save schedules:", err.message);
      throw err;
    }
  }

  async scheduleTask(cronExpr: string, taskDesc: string): Promise<ScheduleId> {
    const nextRun = calculateNextRun(cronExpr).toISOString();
    const id: ScheduleId = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newSchedule: Schedule = {
      id,
      cronExpression: cronExpr,
      taskDescription: taskDesc,
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRun,
      failureCount: 0
    };

    const schedules = this.loadSchedules();
    schedules.push(newSchedule);
    this.saveSchedules(schedules);
    return id;
  }

  async cancelSchedule(id: ScheduleId): Promise<void> {
    const schedules = this.loadSchedules();
    const filtered = schedules.filter((s) => s.id !== id);
    this.saveSchedules(filtered);
  }

  async listSchedules(): Promise<Schedule[]> {
    return this.loadSchedules();
  }

  async triggerMorningReport(runId: string, manifest?: TaskManifest): Promise<string> {
    const dateStr = new Date().toISOString().slice(0, 10);
    const reportsDir = path.join(this.workspaceDir, "reports");
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, `morning-${dateStr}.md`);

    const milestones = manifest?.milestones || [];
    const completedCount = milestones.filter((m) => m.status === "completed").length;
    const totalCount = milestones.length;
    const ambiguities = manifest?.ambiguityFlags || [];

    const milestonesTable = milestones.length > 0
      ? milestones.map((m) => `| ${m.id} | ${m.title} | ${m.status} | ${m.builderIterations || 1} | ${m.criticRounds || 0} |`).join("\n")
      : "| None | None | None | 0 | 0 |";

    const commitsSummary = milestones.filter((m) => m.commitSha).map((m) => `- \`${m.commitSha}\`: Milestone [${m.id}] ${m.title}`).join("\n") || "No new commits recorded.";

    const passedTests = milestones.reduce((sum, m) => sum + (m.testsPassed || 0), 0);
    const failedTests = milestones.reduce((sum, m) => sum + (m.testsFailed || 0), 0);

    const reportContent = `# Autonomous Overnight Morning Report: ${dateStr}

## Overview
- **Run ID**: ${runId}
- **Task Goal**: ${manifest?.goal || "Unattended Scheduled Run"}
- **Status**: ${manifest?.status || "completed"}
- **Milestones**: ${completedCount} / ${totalCount} completed
- **Started At**: ${manifest?.startedAt || new Date().toISOString()}
- **Completed At**: ${manifest?.completedAt || new Date().toISOString()}

## Milestones Completed
| ID | Title | Status | Builder Iterations | Critic Rounds |
| :--- | :--- | :--- | :--- | :--- |
${milestonesTable}

## Commits Made
${commitsSummary}

## Test Results
- **Passed**: ${passedTests}
- **Failed**: ${failedTests}

## Ambiguities Flagged & Parking Status
${ambiguities.length > 0 ? ambiguities.map((a) => `- [${a.id}]: ${a.question} (Action:${a.judgmentCall})`).join("\n") : "None flagged."}
${manifest?.parkedReason ? `\n**Parked Reason**: ${manifest.parkedReason}` : ""}
`;

    fs.writeFileSync(reportPath, reportContent, "utf8");
    return reportContent;
  }

  writeHeartbeat(runId: string, scheduleId: string, attempt: number, active: boolean) {
    try {
      const payload: SchedulerHeartbeat = {
        runId,
        scheduleId,
        lastHeartbeat: new Date().toISOString(),
        attempt,
        active
      };
      fs.writeFileSync(this.getHeartbeatPath(), JSON.stringify(payload, null, 2), "utf8");
    } catch {}
  }

  clearHeartbeat() {
    try {
      if (fs.existsSync(this.getHeartbeatPath())) {
        fs.unlinkSync(this.getHeartbeatPath());
      }
    } catch {}
  }

  async checkCrashAndRecover(): Promise<{ recovered: boolean; scheduleId?: string; attempt?: number }> {
    const hbPath = this.getHeartbeatPath();
    if (!fs.existsSync(hbPath)) return { recovered: false };

    try {
      const hb: SchedulerHeartbeat = JSON.parse(fs.readFileSync(hbPath, "utf8"));
      if (!hb.active) return { recovered: false };

      const schedules = this.loadSchedules();
      const sched = schedules.find((s) => s.id === hb.scheduleId);
      if (!sched) {
        this.clearHeartbeat();
        return { recovered: false };
      }

      const nextAttempt = (hb.attempt || 1) + 1;
      sched.failureCount = (sched.failureCount || 0) + 1;

      if (sched.failureCount >= 5) {
        sched.enabled = false;
        console.warn(`[SCHEDULER CRASH BACKOFF] Schedule ${sched.id} disabled after 5 consecutive failed restarts. Flagged for morning review.`);
        this.clearHeartbeat();
        this.saveSchedules(schedules);
        return { recovered: false, scheduleId: sched.id, attempt: nextAttempt };
      }

      const backoffIndex = Math.min(sched.failureCount - 1, BACKOFF_INTERVALS_MS.length - 1);
      const backoffMs = BACKOFF_INTERVALS_MS[backoffIndex];
      sched.backoffUntil = new Date(Date.now() + backoffMs).toISOString();

      this.saveSchedules(schedules);
      this.writeHeartbeat(hb.runId, hb.scheduleId, nextAttempt, false);

      return { recovered: true, scheduleId: sched.id, attempt: nextAttempt };
    } catch {
      this.clearHeartbeat();
      return { recovered: false };
    }
  }

  async executeScheduledRun(
    scheduleId: string,
    options?: SchedulerExecutionOptions
  ): Promise<TaskManifest | null> {
    const schedules = this.loadSchedules();
    const sched = schedules.find((s) => s.id === scheduleId);
    if (!sched || !sched.enabled) {
      return null;
    }

    if (sched.backoffUntil && new Date(sched.backoffUntil).getTime() > Date.now()) {
      return null;
    }

    const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = path.join(this.workspaceDir, "logs", `run-${runTimestamp}.log`);
    const runId = `run-${Date.now()}`;

    this.writeHeartbeat(runId, sched.id, (sched.failureCount || 0) + 1, true);

    const logStream = (msg: string) => {
      try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
      } catch {}
    };

    logStream(`Starting unattended scheduled run for schedule: ${sched.id} (${sched.taskDescription})`);

    const manifest: TaskManifest = {
      taskId: `task-${Date.now()}`,
      goal: sched.taskDescription,
      toolchain: "node:22",
      branchName: `sched/${sched.id}`,
      status: "active",
      milestones: [
        {
          id: "M1",
          title: `Scheduled: ${sched.taskDescription.slice(0, 40)}`,
          description: sched.taskDescription,
          acceptanceCriteria: [{ id: "AC-1", assertion: "Complete task objective" }],
          status: "pending",
          builderIterations: 0,
          criticRounds: 0
        }
      ],
      currentMilestoneIndex: 0,
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    try {
      let result: TaskManifest;
      if (options?.runner) {
        result = await options.runner(manifest);
      } else {
        const supervisor = this.supervisor || new OvernightSupervisor({
          checkpointDirectory: path.join(this.workspaceDir, ".agent/checkpoints")
        });
        const executor =
          options?.stepExecutor ||
          this.stepExecutor ||
          createProductionStepExecutor({
            workerPool: options?.workerPool || this.workerPool,
            repoRoot: this.workspaceDir,
            model: "swift-27b-mtp"
          });

        result = await supervisor.executeTaskWithRecovery(manifest, {
          stepExecutor: executor
        });
      }
      if (result.status === "completed") {
        sched.lastRun = new Date().toISOString();
        sched.nextRun = calculateNextRun(sched.cronExpression).toISOString();
        sched.failureCount = 0;
        delete sched.backoffUntil;
        this.saveSchedules(schedules);

        // Trigger morning report
        await this.triggerMorningReport(runId, result);
        this.clearHeartbeat();
        logStream(`Completed scheduled run successfully.`);
        return result;
      } else {
        // Run failed or parked (refusing to fake completion; surface failure loudly)
        sched.failureCount = (sched.failureCount || 0) + 1;
        const backoffIdx = Math.min(sched.failureCount - 1, BACKOFF_INTERVALS_MS.length - 1);
        sched.backoffUntil = new Date(Date.now() + BACKOFF_INTERVALS_MS[backoffIdx]).toISOString();
        if (sched.failureCount >= 5) {
          sched.enabled = false;
        }
        this.saveSchedules(schedules);

        await this.triggerMorningReport(runId, result);
        this.clearHeartbeat();
        logStream(`Scheduled run finished with status '${result.status}': ${result.parkedReason || "Milestone execution failed"}`);
        return result;
      }
    } catch (err: any) {
      sched.failureCount = (sched.failureCount || 0) + 1;
      const backoffIdx = Math.min(sched.failureCount - 1, BACKOFF_INTERVALS_MS.length - 1);
      sched.backoffUntil = new Date(Date.now() + BACKOFF_INTERVALS_MS[backoffIdx]).toISOString();
      if (sched.failureCount >= 5) {
        sched.enabled = false;
      }
      try {
        this.saveSchedules(schedules);
      } catch (saveErr: any) {
        console.warn("[Scheduler] Could not save schedules during crash handler:", saveErr.message);
      }

      manifest.status = "parked";
      manifest.parkedReason = err.message;
      await this.triggerMorningReport(runId, manifest).catch(() => {});
      this.clearHeartbeat();
      logStream(`Scheduled run crashed: ${err.message}`);
      throw err;
    }
  }
}

let globalScheduler: UnattendedScheduler | null = null;

export function resetGlobalScheduler(): void {
  globalScheduler = null;
}

export function getGlobalScheduler(options?: SchedulerOptions): UnattendedScheduler {
  const currentWorkspace = options?.workspaceDir || getDefaultWorkspace();
  if (!globalScheduler || options || globalScheduler.workspaceDir !== currentWorkspace) {
    globalScheduler = new UnattendedScheduler({
      workspaceDir: currentWorkspace,
      ...options
    });
  }
  return globalScheduler;
}

export async function scheduleTask(cronExpr: string, taskDesc: string, options?: SchedulerOptions): Promise<ScheduleId> {
  return await getGlobalScheduler(options).scheduleTask(cronExpr, taskDesc);
}

export async function cancelSchedule(id: ScheduleId, options?: SchedulerOptions): Promise<void> {
  return await getGlobalScheduler(options).cancelSchedule(id);
}

export async function listSchedules(options?: SchedulerOptions): Promise<Schedule[]> {
  return await getGlobalScheduler(options).listSchedules();
}

export async function triggerMorningReport(runId: string, manifest?: TaskManifest, options?: SchedulerOptions): Promise<string> {
  return await getGlobalScheduler(options).triggerMorningReport(runId, manifest);
}

export async function triggerScheduleRun(
  id: ScheduleId,
  options?: SchedulerOptions & SchedulerExecutionOptions
): Promise<{ runId: string; status: string } | null> {
  const scheduler = getGlobalScheduler(options);
  const sched = (await scheduler.listSchedules()).find((s) => s.id === id);
  if (!sched || !sched.enabled) {
    return null;
  }
  const manifest = await scheduler.executeScheduledRun(id, options);
  if (!manifest) return null;
  return {
    runId: manifest.taskId,
    status: manifest.status
  };
}
