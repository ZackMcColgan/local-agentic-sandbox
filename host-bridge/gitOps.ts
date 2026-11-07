import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";

export interface GitCapability {
  repo: string;
  branch: string;
}

export interface MergeGrant {
  prNumber?: number;
  prBranch?: string;
  targetBase?: string;
  allowMain?: boolean;
  consumed?: boolean;
}

export interface BridgeGitConfig {
  allowUnattendedGit: boolean;
  gitRepoAllowlist: Record<string, string>;
  gitOpsLogPath?: string;
}

export interface GitStatusResult {
  branch: string;
  headSha: string;
  trackedDirty: boolean;
  trackedFiles: string[];
  untrackedFiles: string[];
  runtimeDirs: string[];
}

export const KNOWN_RUNTIME_DIR_PREFIXES = [
  "data/",
  ".agent/",
  "logs/",
  "scratch/",
  "test-results/",
  "workspace/",
  "temp-test-sched-",
  "test_ui_",
  ".opencode-",
  "node_modules/",
  ".tmp-e2e-"
];

export function isProtectedBranch(branch: string): boolean {
  const b = (branch || "").toLowerCase().trim().replace(/^refs\/heads\//, "");
  return b === "develop" || b === "main" || b === "master";
}

export function isValidFeatureBranchName(branch: string): boolean {
  if (!branch || typeof branch !== "string") return false;
  return /^feature\/[a-zA-Z0-9._-]+$/i.test(branch.trim());
}

export function isProhibitedBranchToken(branch: string): boolean {
  if (!branch || typeof branch !== "string") return false;
  // Tokens prohibited by Hermes rules: agent, subagent, tool, bot, ai
  const prohibited = /(^|[-_])(subagent|agent|tool|bot|ai)([-_]|$)/i;
  const nameOnly = branch.replace(/^feature\//i, "");
  return prohibited.test(nameOnly);
}

export function isExactPathAllowed(relPath: string): boolean {
  if (!relPath || typeof relPath !== "string") return false;
  const normalized = relPath.trim().replace(/\\/g, "/");
  const lower = normalized.toLowerCase();

  // Disallow wildcards, flags, or directory recursion markers
  if (
    normalized === "." ||
    normalized === ".." ||
    lower === "-a" ||
    lower === "--all" ||
    lower === "-u" ||
    lower === "--update" ||
    normalized.includes("*") ||
    normalized.includes("?") ||
    normalized.includes("[") ||
    normalized.includes("]")
  ) {
    return false;
  }

  // Disallow staging inside known runtime directories
  for (const prefix of KNOWN_RUNTIME_DIR_PREFIXES) {
    if (lower.startsWith(prefix) || lower === prefix.replace(/\/$/, "")) {
      return false;
    }
  }

  return true;
}

export function parseGitStatusOutput(porcelainText: string): GitStatusResult {
  const trackedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  const runtimeDirs: string[] = [];

  const lines = (porcelainText || "").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    if (line.length < 3) continue;
    const statusCodes = line.slice(0, 2);
    const filePath = line.slice(3).trim().replace(/\\/g, "/");
    const lower = filePath.toLowerCase();

    const isRuntime = KNOWN_RUNTIME_DIR_PREFIXES.some(
      (prefix) => lower.startsWith(prefix) || lower === prefix.replace(/\/$/, "")
    );

    if (isRuntime) {
      runtimeDirs.push(filePath);
      continue;
    }

    if (statusCodes === "??") {
      untrackedFiles.push(filePath);
    } else {
      trackedFiles.push(filePath);
    }
  }

  return {
    branch: "",
    headSha: "",
    trackedDirty: trackedFiles.length > 0,
    trackedFiles,
    untrackedFiles,
    runtimeDirs
  };
}

export function resolveDefaultGitOpsLogPath(): string {
  const primary = "C:\\AI\\ai-control\\logs\\git-ops.jsonl";
  try {
    const dir = path.dirname(primary);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return primary;
  } catch {
    const localDir = path.resolve(process.cwd(), "logs");
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    return path.join(localDir, "git-ops.jsonl");
  }
}

export function appendGitOpsAuditLog(
  logPath: string,
  entry: {
    verb: string;
    repo: string;
    branch: string;
    headBefore?: string;
    headAfter?: string;
    result: "success" | "refused" | "error";
    error?: string;
    prNumber?: number;
    prUrl?: string;
    mergeSha?: string;
  }
): void {
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry
    }) + "\n";
    fs.appendFileSync(logPath, line, "utf8");
  } catch {}
}

function runGit(repoRoot: string, args: string[], timeoutMs = 60000): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0"
    }
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || (result.error ? result.error.message : ""),
    exitCode: result.status ?? 1
  };
}

function runGh(repoRoot: string, args: string[], timeoutMs = 60000): { stdout: string; stderr: string; exitCode: number } {
  const ghBin = process.env.GH_BIN_PATH || "gh";
  const isCmdOrBat = ghBin.endsWith(".cmd") || ghBin.endsWith(".bat");
  const result = spawnSync(ghBin, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    shell: isCmdOrBat,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0"
    }
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || (result.error ? result.error.message : ""),
    exitCode: result.status ?? 1
  };
}

export async function executeGitVerb(
  verb: string,
  args: any = {},
  capability?: GitCapability,
  config?: BridgeGitConfig,
  grant?: MergeGrant
): Promise<any> {
  const gitLogPath = config?.gitOpsLogPath || resolveDefaultGitOpsLogPath();

  // 1. Two-Key Bridge Flag (Key b)
  if (!config || config.allowUnattendedGit !== true) {
    const refusal = "Unattended host git is disabled in bridge configuration (key b is OFF)";
    appendGitOpsAuditLog(gitLogPath, {
      verb,
      repo: capability?.repo || "unknown",
      branch: capability?.branch || "unknown",
      result: "refused",
      error: refusal
    });
    return { success: false, error: refusal };
  }

  // 2. Capability Scoping
  if (!capability || !capability.repo || !capability.branch) {
    const refusal = "Refused: Missing explicit git capability (repo and branch required)";
    appendGitOpsAuditLog(gitLogPath, {
      verb,
      repo: capability?.repo || "unknown",
      branch: capability?.branch || "unknown",
      result: "refused",
      error: refusal
    });
    return { success: false, error: refusal };
  }

  const repoRoot = config.gitRepoAllowlist[capability.repo];
  if (!repoRoot || !fs.existsSync(repoRoot)) {
    const refusal = `Refused: Repository '${capability.repo}' is not in allowlist or path does not exist`;
    appendGitOpsAuditLog(gitLogPath, {
      verb,
      repo: capability.repo,
      branch: capability.branch,
      result: "refused",
      error: refusal
    });
    return { success: false, error: refusal };
  }

  const targetBranch = args.branch || capability.branch;

  // Immediate Protected Branch Protection for Mutating / Checkout / Push
  if (
    isProtectedBranch(targetBranch) &&
    (verb === "host_git_push" || verb === "host_git_checkout" || verb === "host_git_commit" || verb === "host_git_branch_create")
  ) {
    const refusal = verb === "host_git_push"
      ? `Refused: direct push to protected branch '${targetBranch}' is forbidden`
      : `Refused: direct operation on protected branch '${targetBranch}' is forbidden`;
    appendGitOpsAuditLog(gitLogPath, {
      verb,
      repo: capability.repo,
      branch: targetBranch,
      result: "refused",
      error: refusal
    });
    return { success: false, error: refusal };
  }

  // Capability Retarget Prevention
  if (args.branch && typeof args.branch === "string" && args.branch !== capability.branch) {
    const refusal = `Refused: Capability mismatch: repo/branch does not match granted capability (target=${args.branch}, granted=${capability.branch})`;
    appendGitOpsAuditLog(gitLogPath, {
      verb,
      repo: capability.repo,
      branch: capability.branch,
      result: "refused",
      error: refusal
    });
    return { success: false, error: refusal };
  }

  // Helper for current HEAD SHA
  const getHeadSha = () => {
    const res = runGit(repoRoot, ["rev-parse", "HEAD"]);
    return res.exitCode === 0 ? res.stdout.trim() : "";
  };

  const headBefore = getHeadSha();

  // Helper for Pre-op Tracked-Tree Census
  const checkTrackedClean = (): { clean: boolean; status?: GitStatusResult } => {
    const statusRes = runGit(repoRoot, ["status", "--porcelain=v1", "-uall"]);
    const parsed = parseGitStatusOutput(statusRes.stdout);
    return { clean: !parsed.trackedDirty, status: parsed };
  };

  try {
    switch (verb) {
      case "host_git_status": {
        const branchRes = runGit(repoRoot, ["branch", "--show-current"]);
        const statusRes = runGit(repoRoot, ["status", "--porcelain=v1", "-uall"]);
        const parsed = parseGitStatusOutput(statusRes.stdout);
        parsed.branch = branchRes.stdout.trim();
        parsed.headSha = headBefore;

        appendGitOpsAuditLog(gitLogPath, {
          verb,
          repo: capability.repo,
          branch: capability.branch,
          headBefore,
          headAfter: headBefore,
          result: "success"
        });

        return {
          success: true,
          ...parsed
        };
      }

      case "host_git_fetch": {
        const fetchRes = runGit(repoRoot, ["fetch", "--all", "--prune"]);
        const headAfter = getHeadSha();
        const success = fetchRes.exitCode === 0;

        appendGitOpsAuditLog(gitLogPath, {
          verb,
          repo: capability.repo,
          branch: capability.branch,
          headBefore,
          headAfter,
          result: success ? "success" : "error",
          error: success ? undefined : fetchRes.stderr || fetchRes.stdout
        });

        return {
          success,
          stdout: fetchRes.stdout,
          stderr: fetchRes.stderr,
          exitCode: fetchRes.exitCode
        };
      }

      case "host_git_pull_ff": {
        const preCheck = checkTrackedClean();
        if (!preCheck.clean) {
          const refusal = "Refused: working tree has tracked modifications";
          appendGitOpsAuditLog(gitLogPath, {
            verb,
            repo: capability.repo,
            branch: capability.branch,
            headBefore,
            result: "refused",
            error: refusal
          });
          return { success: false, error: refusal, trackedFiles: preCheck.status?.trackedFiles };
        }

        const pullRes = runGit(repoRoot, ["pull", "--ff-only", "origin", capability.branch]);
        const headAfter = getHeadSha();
        const success = pullRes.exitCode === 0;

        appendGitOpsAuditLog(gitLogPath, {
          verb,
          repo: capability.repo,
          branch: capability.branch,
          headBefore,
          headAfter,
          result: success ? "success" : "error",
          error: success ? undefined : pullRes.stderr || pullRes.stdout
        });

        return {
          success,
          stdout: pullRes.stdout,
          stderr: pullRes.stderr,
          exitCode: pullRes.exitCode,
          headBefore,
          headAfter
        };
      }

      case "host_git_branch_create": {
        const branchName = args.branch || capability.branch;
        const baseRef = args.baseRef || "origin/develop";

        if (!isValidFeatureBranchName(branchName)) {
          const refusal = `Refused: branch name '${branchName}' must match feature/* format`;
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: branchName, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        if (isProhibitedBranchToken(branchName)) {
          const refusal = `Refused: branch name '${branchName}' contains prohibited agent/tool tokens`;
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: branchName, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        const preCheck = checkTrackedClean();
        if (!preCheck.clean) {
          const refusal = "Refused: working tree has tracked modifications";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: branchName, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        // Verify branch does not already exist
        const existsCheck = runGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${branchName}`]);
        if (existsCheck.exitCode === 0) {
          const refusal = `Refused: branch '${branchName}' already exists`;
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: branchName, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        const createRes = runGit(repoRoot, ["checkout", "-b", branchName, baseRef]);
        const headAfter = getHeadSha();
        const success = createRes.exitCode === 0;

        appendGitOpsAuditLog(gitLogPath, {
          verb,
          repo: capability.repo,
          branch: branchName,
          headBefore,
          headAfter,
          result: success ? "success" : "error",
          error: success ? undefined : createRes.stderr || createRes.stdout
        });

        return {
          success,
          branch: branchName,
          baseRef,
          headSha: headAfter,
          stdout: createRes.stdout,
          stderr: createRes.stderr
        };
      }

      case "host_git_checkout": {
        const branchName = args.branch || capability.branch;

        if (isProtectedBranch(branchName)) {
          const refusal = `Refused: checkout of protected branch '${branchName}' as working branch is not permitted`;
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: branchName, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        if (!isValidFeatureBranchName(branchName)) {
          const refusal = `Refused: checkout only permitted on feature/* branches, got '${branchName}'`;
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: branchName, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        const preCheck = checkTrackedClean();
        if (!preCheck.clean) {
          const refusal = "Refused: working tree has tracked modifications";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: branchName, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        const checkoutRes = runGit(repoRoot, ["checkout", branchName]);
        const headAfter = getHeadSha();
        const success = checkoutRes.exitCode === 0;

        appendGitOpsAuditLog(gitLogPath, {
          verb,
          repo: capability.repo,
          branch: branchName,
          headBefore,
          headAfter,
          result: success ? "success" : "error",
          error: success ? undefined : checkoutRes.stderr || checkoutRes.stdout
        });

        return {
          success,
          branch: branchName,
          headSha: headAfter,
          stdout: checkoutRes.stdout,
          stderr: checkoutRes.stderr
        };
      }

      case "host_git_add": {
        const rawPaths: string[] = Array.isArray(args.paths) ? args.paths : [];
        if (rawPaths.length === 0) {
          const refusal = "Refused: exact relative file paths required in paths list";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        for (const p of rawPaths) {
          if (!isExactPathAllowed(p)) {
            const isRuntime = KNOWN_RUNTIME_DIR_PREFIXES.some((k) => p.toLowerCase().startsWith(k));
            const refusal = isRuntime
              ? `Refused: staging runtime directories is forbidden ('${p}')`
              : `Refused: exact relative file paths required; wildcards or flags forbidden ('${p}')`;
            appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal });
            return { success: false, error: refusal };
          }

          const fullPath = path.resolve(repoRoot, p);
          if (!fs.existsSync(fullPath)) {
            const refusal = `Refused: file does not exist on disk ('${p}')`;
            appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal });
            return { success: false, error: refusal };
          }
        }

        const addRes = runGit(repoRoot, ["add", "--", ...rawPaths]);
        const success = addRes.exitCode === 0;

        appendGitOpsAuditLog(gitLogPath, {
          verb,
          repo: capability.repo,
          branch: capability.branch,
          headBefore,
          headAfter: headBefore,
          result: success ? "success" : "error",
          error: success ? undefined : addRes.stderr || addRes.stdout
        });

        return {
          success,
          stagedPaths: rawPaths,
          stdout: addRes.stdout,
          stderr: addRes.stderr
        };
      }

      case "host_git_commit": {
        const message = typeof args.message === "string" ? args.message.trim() : "";
        if (!message) {
          const refusal = "Refused: commit message cannot be empty";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        // Verify something is staged
        const stagedRes = runGit(repoRoot, ["diff", "--cached", "--name-only"]);
        const stagedFiles = stagedRes.stdout.split(/\r?\n/).filter(Boolean);
        if (stagedFiles.length === 0) {
          const refusal = "Refused: nothing staged to commit";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        // Check no runtime files in staged
        for (const file of stagedFiles) {
          if (!isExactPathAllowed(file)) {
            const refusal = `Refused: staged set contains forbidden or runtime path: '${file}'`;
            appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal });
            return { success: false, error: refusal };
          }
        }

        const commitRes = runGit(repoRoot, ["commit", "-m", message]);
        const headAfter = getHeadSha();
        const success = commitRes.exitCode === 0;

        appendGitOpsAuditLog(gitLogPath, {
          verb,
          repo: capability.repo,
          branch: capability.branch,
          headBefore,
          headAfter,
          result: success ? "success" : "error",
          error: success ? undefined : commitRes.stderr || commitRes.stdout
        });

        return {
          success,
          headSha: headAfter,
          stagedFiles,
          stdout: commitRes.stdout,
          stderr: commitRes.stderr
        };
      }

      case "host_git_push": {
        const targetBranch = args.branch || capability.branch;
        if (isProtectedBranch(targetBranch)) {
          const refusal = `Refused: direct push to protected branch '${targetBranch}' is forbidden`;
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: targetBranch, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        const pushRes = runGit(repoRoot, ["push", "origin", targetBranch]);
        const success = pushRes.exitCode === 0;

        appendGitOpsAuditLog(gitLogPath, {
          verb,
          repo: capability.repo,
          branch: targetBranch,
          headBefore,
          headAfter: headBefore,
          result: success ? "success" : "error",
          error: success ? undefined : pushRes.stderr || pushRes.stdout
        });

        return {
          success,
          branch: targetBranch,
          stdout: pushRes.stdout,
          stderr: pushRes.stderr,
          exitCode: pushRes.exitCode
        };
      }

      case "host_git_pr_create": {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const body = typeof args.body === "string" ? args.body.trim() : "";
        const base = typeof args.base === "string" && args.base.trim() ? args.base.trim() : "develop";
        const branch = args.branch || capability.branch;

        if (!title || !body) {
          const refusal = "Refused: PR title and body must be non-empty";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        if (isProtectedBranch(base) && base.toLowerCase() === "main") {
          const refusal = "Refused: direct PR into main is forbidden; PRs must target develop";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        // Check if PR already exists for this branch
        const listRes = runGh(repoRoot, ["pr", "list", "--head", branch, "--json", "number,url"]);
        if (listRes.exitCode === 0) {
          try {
            const list = JSON.parse(listRes.stdout || "[]");
            if (Array.isArray(list) && list.length > 0) {
              const existing = list[0];
              appendGitOpsAuditLog(gitLogPath, {
                verb,
                repo: capability.repo,
                branch,
                headBefore,
                headAfter: headBefore,
                result: "success",
                prNumber: existing.number,
                prUrl: existing.url
              });
              return {
                success: true,
                alreadyExisted: true,
                prNumber: existing.number,
                prUrl: existing.url
              };
            }
          } catch {}
        }

        const createRes = runGh(repoRoot, ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body]);
        const success = createRes.exitCode === 0;
        let prUrl = "";
        let prNumber = 0;

        if (success) {
          const urlMatch = createRes.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
          if (urlMatch) {
            prUrl = urlMatch[0];
            prNumber = parseInt(urlMatch[1], 10);
          } else {
            prUrl = createRes.stdout.trim();
          }
        }

        appendGitOpsAuditLog(gitLogPath, {
          verb,
          repo: capability.repo,
          branch,
          headBefore,
          headAfter: headBefore,
          result: success ? "success" : "error",
          error: success ? undefined : createRes.stderr || createRes.stdout,
          prNumber: prNumber || undefined,
          prUrl: prUrl || undefined
        });

        return {
          success,
          prNumber,
          prUrl,
          stdout: createRes.stdout,
          stderr: createRes.stderr
        };
      }

      case "host_git_pr_status": {
        const prNumber = parseInt(args.prNumber, 10);
        if (isNaN(prNumber) || prNumber <= 0) {
          const refusal = "Refused: valid prNumber required";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        const viewRes = runGh(repoRoot, [
          "pr",
          "view",
          String(prNumber),
          "--json",
          "number,title,state,isDraft,mergeable,statusCheckRollup"
        ]);

        if (viewRes.exitCode !== 0) {
          return { success: false, error: viewRes.stderr || viewRes.stdout };
        }

        try {
          const data = JSON.parse(viewRes.stdout);
          return {
            success: true,
            data
          };
        } catch (err: any) {
          return { success: false, error: `Failed to parse gh output: ${err.message}` };
        }
      }

      case "host_git_pr_merge": {
        const prNumber = parseInt(args.prNumber, 10);
        if (isNaN(prNumber) || prNumber <= 0) {
          const refusal = "Refused: valid prNumber required";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal });
          return { success: false, error: refusal };
        }

        // Part 1.5 Merge Grant Pre-checks
        if (!grant) {
          const refusal = "Refused: No merge grant exists for this job";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal, prNumber });
          return { success: false, error: refusal };
        }

        if (grant.consumed) {
          const refusal = "Refused: Merge grant for this PR has already been consumed";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal, prNumber });
          return { success: false, error: refusal };
        }

        if (grant.prNumber && grant.prNumber !== prNumber) {
          const refusal = `Refused: PR mismatch: grant is for PR #${grant.prNumber}, not #${prNumber}`;
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal, prNumber });
          return { success: false, error: refusal };
        }

        if (grant.targetBase && grant.targetBase.toLowerCase() === "main" && !grant.allowMain) {
          const refusal = "Refused: Merge into main is refused: instruction did not explicitly approve main base";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal, prNumber });
          return { success: false, error: refusal };
        }

        // View PR to check base, checks, draft, mergeable
        const viewRes = runGh(repoRoot, [
          "pr",
          "view",
          String(prNumber),
          "--json",
          "number,state,isDraft,mergeable,baseRefName,statusCheckRollup"
        ]);

        if (viewRes.exitCode !== 0) {
          const refusal = `Refused: gh pr view failed: ${viewRes.stderr || viewRes.stdout}`;
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal, prNumber });
          return { success: false, error: refusal };
        }

        let prInfo: any;
        try {
          prInfo = JSON.parse(viewRes.stdout);
        } catch {
          return { success: false, error: "Failed to parse PR info" };
        }

        const base = (prInfo.baseRefName || grant.targetBase || "").toLowerCase();
        if (base === "main" && !grant.allowMain) {
          const refusal = "Refused: Merge into main is refused: instruction did not explicitly approve main base";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal, prNumber });
          return { success: false, error: refusal };
        }

        if (prInfo.state !== "OPEN") {
          const refusal = `Refused: PR is not OPEN (current state: ${prInfo.state})`;
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal, prNumber });
          return { success: false, error: refusal };
        }

        if (prInfo.isDraft) {
          const refusal = "Refused: PR is still marked as draft";
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal, prNumber });
          return { success: false, error: refusal };
        }

        if (prInfo.mergeable !== "MERGEABLE") {
          const refusal = `Refused: PR is not mergeable (mergeable state: ${prInfo.mergeable})`;
          appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal, prNumber });
          return { success: false, error: refusal };
        }

        // CI check status verification
        const rollup = prInfo.statusCheckRollup || [];
        for (const check of rollup) {
          const state = (check.conclusion || check.status || check.state || "").toUpperCase();
          if (state !== "SUCCESS" && state !== "COMPLETED") {
            const refusal = `Refused: PR CI checks are not all green: check '${check.name || check.context}' is ${state}`;
            appendGitOpsAuditLog(gitLogPath, { verb, repo: capability.repo, branch: capability.branch, result: "refused", error: refusal, prNumber });
            return { success: false, error: refusal };
          }
        }

        // Pre-checks passed! Execute merge
        const mergeArgs = ["pr", "merge", String(prNumber), "--merge"];
        if (args.deleteSourceBranch) {
          mergeArgs.push("--delete-branch");
        }

        const mergeRes = runGh(repoRoot, mergeArgs);
        const success = mergeRes.exitCode === 0;

        let mergeSha = "";
        const shaMatch = mergeRes.stdout.match(/[0-9a-f]{40}/i);
        if (shaMatch) {
          mergeSha = shaMatch[0];
        }

        if (success) {
          grant.consumed = true;
        }

        appendGitOpsAuditLog(gitLogPath, {
          verb,
          repo: capability.repo,
          branch: capability.branch,
          headBefore,
          headAfter: getHeadSha(),
          result: success ? "success" : "error",
          error: success ? undefined : mergeRes.stderr || mergeRes.stdout,
          prNumber,
          mergeSha: mergeSha || undefined
        });

        return {
          success,
          prNumber,
          mergeSha,
          stdout: mergeRes.stdout,
          stderr: mergeRes.stderr
        };
      }

      default: {
        return { success: false, error: `Unknown git verb: ${verb}` };
      }
    }
  } catch (err: any) {
    appendGitOpsAuditLog(gitLogPath, {
      verb,
      repo: capability.repo,
      branch: capability.branch,
      headBefore,
      result: "error",
      error: err.message
    });
    return { success: false, error: err.message };
  }
}
