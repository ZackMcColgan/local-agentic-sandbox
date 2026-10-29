// Test-only workspace isolation.
//
// Every suite that registers workspace/git tools must get its OWN scratch
// workspace directory, because the suites run as concurrent processes and
// ensureWorkspaceInitialized()/git_commit perform "git add -A" and
// "git commit" on the workspace root. Sharing one directory across suites
// races on git's index.lock and surfaces as EXECUTION_ERROR.
//
// Mechanism: workspaceTools.ts resolves its root from process.env.WORKSPACE_DIR
// at module load. Importing this module BEFORE any import of
// ../src/tools/workspaceTools.js sets a unique per-file directory first, so
// each suite's git operations happen in its own repo — no assertion is
// weakened; the real git paths are still exercised, just in an isolated repo.
//
// The scratch repo is also pre-initialized (born HEAD) synchronously here, so
// the suite never runs overlapping "add -A"/"commit" initialization passes
// against a repo another in-flight ensure is mid-commit on — the same
// index.lock race, but inside a single suite.
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "mcp-test-workspace-"));
process.env.WORKSPACE_DIR = dir;

const gitIdentity = [
  "-c", "safe.directory=*",
  "-c", "user.name=Autonomous Agent",
  "-c", "user.email=agent@local-sandbox.internal",
];

execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
fsSync.writeFileSync(
  path.join(dir, "README.md"),
  "# Autonomous Agent Workspace\n\nPersistent workspace for code, branches, tests, and architecture diagrams.\n",
  "utf8"
);
execFileSync("git", [...gitIdentity, "add", "-A"], { cwd: dir, stdio: "ignore" });
execFileSync("git", [...gitIdentity, "commit", "-m", "chore: initialize persistent agent workspace"], { cwd: dir, stdio: "ignore" });

export const TEST_WORKSPACE_DIR = dir;

// Remove the scratch repo after the suite finishes. Windows git can hold
// short locks on object files, so retry briefly.
export function cleanupTestWorkspace(): void {
  fsSync.rmSync(dir, { recursive: true, maxRetries: 5, retryDelay: 150 });
}
