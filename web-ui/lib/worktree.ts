import { execFileSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { join } from "path";
export interface WorktreeHandle { jobId: string; path: string; branch: string; }
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
function clearStaleLock(repoRoot: string): void {
  try {
    const lock = join(repoRoot, ".git", "index.lock");
    if (existsSync(lock)) rmSync(lock);
  } catch {}
  try { execFileSync("git", ["worktree", "prune"], { cwd: repoRoot, encoding: "utf8", timeout: GIT_TIMEOUT_MS }); } catch {}
}
function git(args: string[], cwd: string): string {
  let attempt = 0;
  for (;;) {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS }).trim();
    } catch (err: any) {
      const timedOut = err?.code === "ETIMEDOUT" || /timed out/i.test(String(err?.message ?? ""));
      if (!timedOut || attempt >= GIT_LOCK_RETRIES) throw err;
      attempt += 1;
      clearStaleLock(cwd);
      sleep(250 * attempt);
    }
  }
}
export function createJobWorktree(repoRoot: string, jobId: string): WorktreeHandle {
  const branch = `job/${jobId}`;
  const path = `${repoRoot}/.worktrees/${jobId}`;
  // Job branches are ephemeral per-turn scratch: force-remove any leftover
  // worktree (dir + registration) BEFORE deleting the branch, then prune
  // stale registrations, so a reused job id never fails with
  // "branch already exists" / "cannot delete branch used by worktree".
  try { git(["worktree", "remove", "--force", path], repoRoot); } catch {}
  try { git(["branch", "-D", branch], repoRoot); } catch {}
  git(["worktree", "prune"], repoRoot);
  git(["worktree", "add", "-b", branch, path, "HEAD"], repoRoot);
  return { jobId, path, branch };
}
export function removeJobWorktree(repoRoot: string, handle: WorktreeHandle): void {
  git(["worktree", "remove", "--force", handle.path], repoRoot);
  try { git(["branch", "-D", handle.branch], repoRoot); } catch {}
}
