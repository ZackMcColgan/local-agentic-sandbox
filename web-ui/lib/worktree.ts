import { execFileSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { join } from "path";
export interface WorktreeHandle {
  jobId: string;
  path: string;
  branch: string;
}
// A git spawn must never wait forever: under parallel test churn, `worktree
// add` can queue behind index/worktree locks indefinitely (CI run 43737566475
// went silent 24 min on exactly this). Bound every spawn to 30s and retry a
// bounded number of times after clearing a stale lock; worst case we throw
// instead of hanging, so the queue drain always settles.
const GIT_TIMEOUT_MS = 30_000;
const GIT_LOCK_RETRIES = 3;
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function errorText(err: any): string {
  return [err?.message, err?.stderr, err?.stdout].filter(Boolean).map(String).join("\n");
}
const LOCK_OR_RACE_RE =
  /\.lock\b|unable to create|could not lock|cannot lock ref|already exists|is not a working tree/i;

function clearStaleLock(repoRoot: string): void {
  try {
    const lock = join(repoRoot, ".git", "index.lock");
    if (existsSync(lock)) rmSync(lock);
  } catch {}
  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {}
}
function git(args: string[], cwd: string): string {
  let attempt = 0;
  for (;;) {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (err: any) {
      const text = errorText(err);
      const timedOut = err?.code === "ETIMEDOUT" || /timed out/i.test(text);
      const lockOrRace = LOCK_OR_RACE_RE.test(text);
      if ((!timedOut && !lockOrRace) || attempt >= GIT_LOCK_RETRIES) throw err;
      attempt += 1;
      if (timedOut) clearStaleLock(cwd);
      sleep(150 * attempt + (process.pid % 97));
    }
  }
}
export function createJobWorktree(repoRoot: string, jobId: string): WorktreeHandle {
  const branch = `job/${jobId}`;
  const path = `${repoRoot}/.worktrees/${jobId}`;
  // Job branches are ephemeral per-turn scratch: force-remove any leftover
  // worktree (dir + registration) BEFORE deleting the branch, then prune
  // stale registrations, retrying across concurrent git lock races.
  for (let attempt = 0; ; attempt++) {
    if (existsSync(path)) {
      try {
        git(["worktree", "remove", "--force", path], repoRoot);
      } catch {}
    }
    try {
      git(["branch", "-D", branch], repoRoot);
    } catch {}
    try {
      git(["worktree", "prune"], repoRoot);
    } catch {}
    try {
      git(["worktree", "add", "-b", branch, path, "HEAD"], repoRoot);
      return { jobId, path, branch };
    } catch (err: any) {
      const text = errorText(err);
      const retryable =
        err?.code === "ETIMEDOUT" || /timed out/i.test(text) || LOCK_OR_RACE_RE.test(text);
      if (!retryable || attempt >= GIT_LOCK_RETRIES) throw err;
      sleep(150 * (attempt + 1) + (process.pid % 97));
    }
  }
}
export function removeJobWorktree(repoRoot: string, handle: WorktreeHandle): void {
  try {
    git(["worktree", "remove", "--force", handle.path], repoRoot);
  } catch {
    try {
      if (existsSync(handle.path)) rmSync(handle.path, { recursive: true, force: true });
    } catch {}
    try {
      git(["worktree", "prune"], repoRoot);
    } catch {}
  }
  try {
    git(["branch", "-D", handle.branch], repoRoot);
  } catch {}
}
