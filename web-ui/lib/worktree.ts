import { execFileSync } from "child_process";
export interface WorktreeHandle { jobId: string; path: string; branch: string; }
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
