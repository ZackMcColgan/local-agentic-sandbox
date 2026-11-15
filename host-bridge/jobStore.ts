import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn, execSync } from "child_process";

export type JobStatus = "pending" | "running" | "done" | "failed" | "interrupted";

export interface JobRecord {
  id: string;
  tool: string;
  args: any;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  error?: string;
  timeoutMs: number;
}

export interface SpoolSlice {
  chunk: string;
  nextOffset: number;
  totalLength: number;
}

// 60-minute class: async jobs may run up to one hour; default is the full class.
export const MAX_ASYNC_TIMEOUT_SECONDS = 3600;
export const DEFAULT_ASYNC_TIMEOUT_SECONDS = 3600;
const MAX_SPOOL_READ_BYTES = 256 * 1024;

export function resolveAsyncTimeoutSeconds(args: any): number {
  let seconds = DEFAULT_ASYNC_TIMEOUT_SECONDS;
  if (typeof args?.timeoutSeconds === "number" && !isNaN(args.timeoutSeconds)) {
    seconds = Math.max(1, Math.min(MAX_ASYNC_TIMEOUT_SECONDS, Math.floor(args.timeoutSeconds)));
  }
  return seconds;
}

export class JobStore {
  readonly jobsDir: string;
  private records = new Map<string, JobRecord>();
  private killFns = new Map<string, () => void>();
  private indexPath: string;

  constructor(jobsDir: string) {
    this.jobsDir = jobsDir;
    this.indexPath = path.join(jobsDir, "jobs.json");
    fs.mkdirSync(jobsDir, { recursive: true });

    // Orphan recovery: a daemon restart means every pending/running job lost its
    // executor. Stamp them interrupted so they never read as running forever.
    let loaded: JobRecord[] = [];
    try {
      if (fs.existsSync(this.indexPath)) {
        loaded = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
      }
    } catch {
      loaded = [];
    }
    let changed = false;
    for (const rec of loaded) {
      if (rec.status === "pending" || rec.status === "running") {
        rec.status = "interrupted";
        rec.finishedAt = rec.finishedAt ?? Date.now();
        rec.error = "Job orphaned by daemon restart; executor lost.";
        changed = true;
      }
      this.records.set(rec.id, rec);
    }
    if (changed) this.persist();
  }

  registerKill(id: string, kill: () => void): void {
    this.killFns.set(id, kill);
  }

  unregisterKill(id: string): void {
    this.killFns.delete(id);
  }

  // Graceful shutdown: kill active processes and stamp pending/running jobs
  // interrupted so they never read as running forever.
  interruptActive(): void {
    for (const [id, kill] of this.killFns.entries()) {
      try { kill(); } catch {}
    }
    this.killFns.clear();
    let changed = false;
    for (const rec of this.records.values()) {
      if (rec.status === "pending" || rec.status === "running") {
        rec.status = "interrupted";
        rec.finishedAt = rec.finishedAt ?? Date.now();
        rec.error = "Job interrupted by daemon shutdown.";
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  create(tool: string, args: any, timeoutMs: number): JobRecord {
    const rec: JobRecord = {
      id: crypto.randomUUID(),
      tool,
      args,
      status: "pending",
      createdAt: Date.now(),
      timeoutMs
    };
    this.records.set(rec.id, rec);
    this.persist();
    return rec;
  }

  get(id: string): JobRecord | undefined {
    return this.records.get(id);
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord | undefined {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    Object.assign(rec, patch);
    this.persist();
    return rec;
  }

  private persist(): void {
    const all = Array.from(this.records.values());
    fs.writeFileSync(this.indexPath, JSON.stringify(all), "utf8");
  }

  spoolPath(id: string, stream: "stdout" | "stderr"): string {
    return path.join(this.jobsDir, `${id}.${stream}.log`);
  }

  appendSpool(id: string, stream: "stdout" | "stderr", text: string): void {
    fs.appendFileSync(this.spoolPath(id, stream), text, "utf8");
  }

  readSpool(id: string, stream: "stdout" | "stderr", offset: number, limit: number): SpoolSlice {
    const filePath = this.spoolPath(id, stream);
    let totalLength = 0;
    try {
      if (fs.existsSync(filePath)) {
        totalLength = fs.statSync(filePath).size;
      }
    } catch {}
    if (offset >= totalLength) {
      return { chunk: "", nextOffset: totalLength, totalLength };
    }
    const readLen = Math.min(limit, MAX_SPOOL_READ_BYTES, totalLength - offset);
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, offset);
      return { chunk: buf.toString("utf8"), nextOffset: offset + readLen, totalLength };
    } finally {
      fs.closeSync(fd);
    }
  }
}

// Async powershell runner: spools stdout/stderr to files independent of any
// HTTP request lifetime; job-level timeout kills the whole process tree.
function runPowershellJob(store: JobStore, rec: JobRecord, effectiveCwd: string): Promise<void> {
  return new Promise((resolve) => {
    const command = String(rec.args?.command || "");
    const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: effectiveCwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    store.update(rec.id, { status: "running", startedAt: Date.now() });

    let timedOut = false;
    let killed = false;
    const killTree = () => {
      killed = true;
      const pid = proc.pid;
      if (pid) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
        } catch {}
        try {
          const check = execSync(
            `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | ForEach-Object { $_.ProcessId }"`,
            { encoding: "utf8", timeout: 3000 }
          );
          for (const p of check.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
            try { execSync(`taskkill /PID ${p} /T /F`, { stdio: "ignore" }); } catch {}
          }
        } catch {}
      }
      try { proc.kill("SIGKILL"); } catch {}
    };
    store.registerKill(rec.id, killTree);

    proc.stdout?.on("data", (d) => store.appendSpool(rec.id, "stdout", d.toString()));
    proc.stderr?.on("data", (d) => store.appendSpool(rec.id, "stderr", d.toString()));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, rec.timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      store.unregisterKill(rec.id);
      if (timedOut) {
        store.update(rec.id, {
          status: "failed",
          finishedAt: Date.now(),
          exitCode: code,
          timedOut: true,
          error: `Job timed out after ${Math.round(rec.timeoutMs / 1000)}s (async job-level timeout)`
        });
      } else if (killed) {
        store.update(rec.id, {
          status: "interrupted",
          finishedAt: Date.now(),
          exitCode: code,
          error: "Job interrupted by daemon shutdown."
        });
      } else {
        store.update(rec.id, {
          status: code === 0 ? "done" : "failed",
          finishedAt: Date.now(),
          exitCode: code,
          error: code === 0 ? undefined : `Process exited with code ${code}`
        });
      }
      resolve();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      store.update(rec.id, {
        status: "failed",
        finishedAt: Date.now(),
        timedOut: false,
        error: err.message
      });
      resolve();
    });
  });
}

export async function runAsyncJob(
  store: JobStore,
  rec: JobRecord,
  executeOtherTool: (tool: string, args: any) => Promise<any>
): Promise<void> {
  try {
    if (rec.tool === "host_run_powershell") {
      let effectiveCwd = process.cwd();
      if (rec.args?.cwd && typeof rec.args.cwd === "string" && rec.args.cwd.trim()) {
        if (!fs.existsSync(rec.args.cwd) || !fs.statSync(rec.args.cwd).isDirectory()) {
          store.update(rec.id, {
            status: "failed",
            finishedAt: Date.now(),
            error: `Directory not found: ${rec.args.cwd}`
          });
          return;
        }
        effectiveCwd = rec.args.cwd;
      }
      await runPowershellJob(store, rec, effectiveCwd);
      return;
    }

    store.update(rec.id, { status: "running", startedAt: Date.now() });
    const result = await executeOtherTool(rec.tool, rec.args);
    store.appendSpool(rec.id, "stdout", JSON.stringify(result ?? {}));
    const failed = result && (result.success === false || result.error);
    store.update(rec.id, {
      status: failed ? "failed" : "done",
      finishedAt: Date.now(),
      exitCode: failed ? 1 : 0,
      error: failed ? String(result.error || "Tool reported failure") : undefined
    });
  } catch (err: any) {
    store.update(rec.id, {
      status: "failed",
      finishedAt: Date.now(),
      error: err?.message || "Async job execution error"
    });
  }
}
