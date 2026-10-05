import fs from "fs";
import path from "path";
import { UnattendedScheduler, Schedule } from "./scheduler";

export interface DaemonHeartbeat {
  pid: number;
  startedAt: string;
  lastTick: string;
  active: boolean;
}

export interface DaemonOptions {
  tickIntervalMs?: number;
  workspaceDir?: string;
  scheduler?: UnattendedScheduler;
  onTick?: (dueCount: number) => Promise<void> | void;
  singleTick?: boolean;
  registerSignalHandlers?: boolean;
}

export type LogLevel = "INFO" | "WARN" | "ERROR";

export class SchedulerDaemon {
  readonly workspaceDir: string;
  readonly tickIntervalMs: number;
  readonly scheduler: UnattendedScheduler;
  public shutdownRequested: boolean = false;
  private isRunning: boolean = false;
  private startedAt: string = "";

  constructor(options?: DaemonOptions) {
    this.workspaceDir =
      options?.workspaceDir ||
      process.env.WORKSPACE_DIR ||
      path.resolve(process.cwd(), "workspace");

    const envInterval = process.env.SCHEDULER_TICK_INTERVAL_MS
      ? parseInt(process.env.SCHEDULER_TICK_INTERVAL_MS, 10)
      : NaN;

    this.tickIntervalMs =
      options?.tickIntervalMs ??
      (!isNaN(envInterval) && envInterval > 0 ? envInterval : 60000);

    this.scheduler =
      options?.scheduler ||
      new UnattendedScheduler({ workspaceDir: this.workspaceDir });

    this.ensureDirectories();

    // The constructor owns signal registration so the flag is honored even
    // when tick()/checkStartupRecovery() are exercised without start().
    if (options?.registerSignalHandlers !== false) {
      this.setupSignalHandlers();
    }
  }

  private ensureDirectories(): void {
    try {
      if (!fs.existsSync(this.workspaceDir)) {
        fs.mkdirSync(this.workspaceDir, { recursive: true });
      }
      const logsDir = path.join(this.workspaceDir, "logs");
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
    } catch {}
  }

  getHeartbeatPath(): string {
    return path.join(this.workspaceDir, ".scheduler-daemon-heartbeat");
  }

  getLogFilePath(dateStr?: string): string {
    const d = dateStr || new Date().toISOString().slice(0, 10);
    return path.join(this.workspaceDir, "logs", `scheduler-daemon-${d}.log`);
  }

  log(level: LogLevel, message: string): void {
    const now = new Date();
    const isoTime = now.toISOString();
    const dateStr = isoTime.slice(0, 10);
    const logLine = `[${isoTime}] [${level}] ${message}\n`;

    try {
      const logFile = this.getLogFilePath(dateStr);
      fs.appendFileSync(logFile, logLine, "utf8");
    } catch (err: any) {
      console.error(`[SchedulerDaemon] Failed to write to log file: ${err.message}`);
    }

    if (level === "ERROR") {
      console.error(logLine.trim());
    } else if (level === "WARN") {
      console.warn(logLine.trim());
    } else {
      console.log(logLine.trim());
    }
  }

  rotateLogs(retentionDays: number = 7): void {
    try {
      const logsDir = path.join(this.workspaceDir, "logs");
      if (!fs.existsSync(logsDir)) return;

      const files = fs.readdirSync(logsDir);
      const nowMs = Date.now();
      const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file.startsWith("scheduler-daemon-") && file.endsWith(".log")) {
          const filePath = path.join(logsDir, file);
          const match = file.match(/^scheduler-daemon-(\d{4}-\d{2}-\d{2})\.log$/);
          let fileAgeMs: number;
          if (match) {
            const fileDate = new Date(match[1]);
            fileAgeMs = nowMs - fileDate.getTime();
          } else {
            const stats = fs.statSync(filePath);
            fileAgeMs = nowMs - stats.mtimeMs;
          }

          if (fileAgeMs > maxAgeMs) {
            try {
              fs.unlinkSync(filePath);
              this.log("INFO", `Rotated log file: ${file}`);
            } catch {}
          }
        }
      }
    } catch (err: any) {
      this.log("WARN", `Log rotation check failed: ${err.message}`);
    }
  }

  writeHeartbeat(active: boolean): void {
    try {
      const hb: DaemonHeartbeat = {
        pid: process.pid,
        startedAt: this.startedAt,
        lastTick: new Date().toISOString(),
        active
      };
      fs.writeFileSync(this.getHeartbeatPath(), JSON.stringify(hb, null, 2), "utf8");
    } catch (err: any) {
      this.log("WARN", `Failed to write heartbeat: ${err.message}`);
    }
  }

  readHeartbeat(): DaemonHeartbeat | null {
    try {
      const hbPath = this.getHeartbeatPath();
      if (!fs.existsSync(hbPath)) return null;
      const raw = fs.readFileSync(hbPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async checkStartupRecovery(): Promise<void> {
    const hb = this.readHeartbeat();
    if (hb && hb.active) {
      const lastTickTime = new Date(hb.lastTick).getTime();
      const staleThresholdMs = 5 * 60 * 1000; // 5 minutes
      if (Date.now() - lastTickTime > staleThresholdMs) {
        this.log(
          "WARN",
          `Stale heartbeat detected (PID: ${hb.pid}, lastTick: ${hb.lastTick}). Invoking crash recovery.`
        );
        try {
          const recoveryRes = await this.scheduler.checkCrashAndRecover();
          if (recoveryRes.recovered) {
            this.log(
              "INFO",
              `Crash recovery triggered for schedule: ${recoveryRes.scheduleId} (attempt: ${recoveryRes.attempt})`
            );
          } else {
            this.log("INFO", `Crash recovery completed with no active schedule recovered.`);
          }
        } catch (err: any) {
          this.log("ERROR", `Crash recovery failed: ${err.message}`);
        }
      }
    }
  }

  async tick(): Promise<number> {
    const now = Date.now();
    const schedules = this.scheduler.loadSchedules();

    const dueSchedules = schedules.filter((s: Schedule) => {
      if (!s.enabled) return false;
      const nextRunMs = new Date(s.nextRun).getTime();
      if (isNaN(nextRunMs) || nextRunMs > now) return false;
      if (s.backoffUntil) {
        const backoffMs = new Date(s.backoffUntil).getTime();
        if (!isNaN(backoffMs) && backoffMs > now) return false;
      }
      return true;
    });

    this.log(
      "INFO",
      `Tick started. Found ${schedules.length} total schedules, ${dueSchedules.length} due.`
    );

    for (const sched of dueSchedules) {
      if (this.shutdownRequested) {
        this.log("WARN", `Shutdown requested; skipping remaining due schedule ${sched.id}`);
        break;
      }

      try {
        this.log(
          "INFO",
          `Executing due schedule ${sched.id} ("${sched.taskDescription}")`
        );
        await this.scheduler.executeScheduledRun(sched.id);
        this.log("INFO", `Successfully completed schedule run for ${sched.id}`);
      } catch (err: any) {
        // Catch per-schedule errors: one failure does not stop others
        this.log(
          "ERROR",
          `Error executing schedule ${sched.id} ("${sched.taskDescription}"): ${err.message}`
        );
      }
    }

    this.writeHeartbeat(true);
    this.rotateLogs(7);

    return dueSchedules.length;
  }

  requestShutdown(): void {
    if (!this.shutdownRequested) {
      this.shutdownRequested = true;
      this.log("INFO", "Shutdown requested. Marking daemon inactive.");
      this.writeHeartbeat(false);
    }
  }

  setupSignalHandlers(): void {
    const handler = (signal: string) => {
      this.log("INFO", `Received ${signal}, initiating graceful shutdown`);
      this.requestShutdown();
    };
    process.once("SIGTERM", () => handler("SIGTERM"));
    process.once("SIGINT", () => handler("SIGINT"));
  }

  async start(options?: DaemonOptions): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startedAt = new Date().toISOString();
    this.log(
      "INFO",
      `Scheduler daemon started (PID: ${process.pid}, interval: ${this.tickIntervalMs}ms)`
    );

    await this.checkStartupRecovery();
    this.writeHeartbeat(true);

    if (options?.singleTick) {
      const dueCount = await this.tick();
      if (options.onTick) await options.onTick(dueCount);
      this.isRunning = false;
      return;
    }

    while (!this.shutdownRequested) {
      const dueCount = await this.tick();

      if (options?.onTick) {
        try {
          await options.onTick(dueCount);
        } catch (err: any) {
          this.log("ERROR", `Error in onTick callback: ${err.message}`);
        }
      }

      if (this.shutdownRequested) break;

      await this.sleep(this.tickIntervalMs);
    }

    this.log("INFO", "Scheduler daemon loop terminated. Performing final shutdown.");
    this.writeHeartbeat(false);
    this.isRunning = false;
  }

  private async sleep(ms: number): Promise<void> {
    const checkInterval = 250;
    let elapsed = 0;
    while (elapsed < ms && !this.shutdownRequested) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(checkInterval, ms - elapsed))
      );
      elapsed += checkInterval;
    }
  }
}

export async function startDaemon(options?: DaemonOptions): Promise<void> {
  const daemon = new SchedulerDaemon(options);
  await daemon.start(options);
}

// Auto-run if executed directly as node script
const isMainScript = Boolean(
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1] &&
  (process.argv[1].endsWith("schedulerDaemon.js") ||
   process.argv[1].endsWith("schedulerDaemon.ts")) &&
  !process.env.NODE_TEST_CONTEXT &&
  !process.argv[1].includes(".test.")
);

if (isMainScript) {
  startDaemon().catch((err) => {
    console.error("[FATAL] Scheduler daemon crashed:", err);
    process.exit(1);
  });
}
