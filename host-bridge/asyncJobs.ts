import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn, exec, ChildProcess } from "child_process";

export type AsyncJobStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface AsyncJobMeta {
  jobId: string;
  tool: string;
  status: AsyncJobStatus;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  finishedAt: string | null;
  error?: string;
}

interface ActiveJob {
  child: ChildProcess;
  timer: NodeJS.Timeout;
  cancelled: boolean;
}

export class AsyncJobManager {
  private readonly jobsDir: string;
  private readonly active = new Map<string, ActiveJob>();

  constructor(jobsDir: string) {
    this.jobsDir = jobsDir;
    fs.mkdirSync(this.jobsDir, { recursive: true });
    this.markInterruptedJobs();
  }

  private metaPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.meta.json`);
  }

  private logPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.log`);
  }

  private writeMeta(meta: AsyncJobMeta): void {
    const tmp = `${this.metaPath(meta.jobId)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf8");
    fs.renameSync(tmp, this.metaPath(meta.jobId));
  }

  private markInterruptedJobs(): void {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.jobsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".meta.json")) continue;
      const fullPath = path.join(this.jobsDir, entry);
      try {
        const raw = fs.readFileSync(fullPath, "utf8");
        const meta = JSON.parse(raw) as AsyncJobMeta;
        if (meta.status === "running") {
          meta.status = "interrupted";
          meta.finishedAt = new Date().toISOString();
          meta.error = "Daemon restarted mid-flight";
          this.writeMeta(meta);
        }
      } catch {
        // Ignore malformed metadata files
      }
    }
  }

  startJob(tool: string, args: Record<string, any>, timeoutMs = 3_600_000): AsyncJobMeta {
    if (tool !== "run_command" && tool !== "host_run_command" && tool !== "host_run_powershell") {
      throw new Error(`Unsupported async job tool: ${tool}`);
    }
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) {
      throw new Error("Missing command for run_command");
    }
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : process.cwd();

    const jobId = crypto.randomUUID();
    const meta: AsyncJobMeta = {
      jobId,
      tool,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: new Date().toISOString(),
      finishedAt: null
    };
    this.writeMeta(meta);
    fs.writeFileSync(this.logPath(jobId), "", "utf8");

    const child = spawn(command, [], {
      cwd,
      shell: true,
      env: process.env,
      windowsHide: true
    });

    const appendLog = (chunk: Buffer | string) => {
      try {
        fs.appendFileSync(this.logPath(jobId), chunk);
      } catch {
        // Ignore log append errors if dir was removed
      }
    };

    child.stdout?.on("data", appendLog);
    child.stderr?.on("data", appendLog);

    const timer = setTimeout(() => {
      const entry = this.active.get(jobId);
      if (!entry || entry.cancelled) return;
      this.killProcessTree(child);
      const current = this.getStatus(jobId);
      if (current && current.status === "running") {
        current.status = "failed";
        current.finishedAt = new Date().toISOString();
        current.error = `Job timed out after ${timeoutMs}ms`;
        this.writeMeta(current);
      }
      this.active.delete(jobId);
    }, timeoutMs);

    this.active.set(jobId, { child, timer, cancelled: false });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const entry = this.active.get(jobId);
      const wasCancelled = entry?.cancelled ?? false;
      this.active.delete(jobId);

      const current = this.getStatus(jobId);
      if (!current || current.status !== "running") return;
      if (wasCancelled) {
        current.status = "cancelled";
      } else {
        current.status = code === 0 ? "completed" : "failed";
      }
      current.exitCode = code;
      current.signal = signal;
      current.finishedAt = new Date().toISOString();
      this.writeMeta(current);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      this.active.delete(jobId);
      const current = this.getStatus(jobId);
      if (!current || current.status !== "running") return;
      current.status = "failed";
      current.finishedAt = new Date().toISOString();
      current.error = err.message;
      this.writeMeta(current);
    });

    return meta;
  }

  getStatus(jobId: string): AsyncJobMeta | null {
    const p = this.metaPath(jobId);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as AsyncJobMeta;
    } catch {
      return null;
    }
  }

  getOutput(
    jobId: string,
    offset = 0,
    limit = 65536
  ): { jobId: string; offset: number; nextOffset: number; data: string; eof: boolean } | null {
    const meta = this.getStatus(jobId);
    if (!meta) return null;
    const lp = this.logPath(jobId);
    if (!fs.existsSync(lp)) {
      return { jobId, offset, nextOffset: offset, data: "", eof: meta.status !== "running" };
    }
    const stat = fs.statSync(lp);
    const safeOffset = Math.max(0, Math.min(offset, stat.size));
    const toRead = Math.max(0, Math.min(limit, stat.size - safeOffset));
    let data = "";
    if (toRead > 0) {
      const fd = fs.openSync(lp, "r");
      try {
        const buf = Buffer.alloc(toRead);
        fs.readSync(fd, buf, 0, toRead, safeOffset);
        data = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    }
    const nextOffset = safeOffset + toRead;
    const eof = meta.status !== "running" && nextOffset >= stat.size;
    return { jobId, offset: safeOffset, nextOffset, data, eof };
  }

  cancelJob(jobId: string): AsyncJobMeta | null {
    const meta = this.getStatus(jobId);
    if (!meta) return null;
    const entry = this.active.get(jobId);
    if (entry) {
      entry.cancelled = true;
      clearTimeout(entry.timer);
      this.killProcessTree(entry.child);
      this.active.delete(jobId);
    }
    if (meta.status === "running") {
      meta.status = "cancelled";
      meta.finishedAt = new Date().toISOString();
      this.writeMeta(meta);
    }
    return meta;
  }

  private killProcessTree(child: ChildProcess): void {
    if (!child.pid) return;
    if (process.platform === "win32") {
      exec(`taskkill /PID ${child.pid} /T /F`, { windowsHide: true }, () => {});
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore
      }
    }
  }
}
