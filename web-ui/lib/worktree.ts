import { execFileSync } from "child_process";
export interface WorktreeHandle { jobId: string; path: string; branch: string; }
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
export function createJobWorktree(repoRoot: string, jobId: string): WorktreeHandle {
  const branch = `job/${jobId}`;
  const path = `${repoRoot}/.worktrees/${jobId}`;
  git(["worktree", "add", "-b", branch, path, "HEAD"], repoRoot);
  return { jobId, path, branch };
}
export function removeJobWorktree(repoRoot: string, handle: WorktreeHandle): void {
  git(["worktree", "remove", "--force", handle.path], repoRoot);
}
