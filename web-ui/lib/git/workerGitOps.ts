import { execFile } from "child_process";
import { promisify } from "util";
import { RunLedger, getSharedRunLedger } from "../ledger/runLedger";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (file: string, args: string[]) => Promise<GitCommandResult>;

export interface GitAuditLogEntry {
  timestamp: string;
  runId: string;
  command: string;
  exitCode: number;
  output: string;
}

export interface WorkerGitOpsOptions {
  runId: string;
  repoDir?: string;
  ledger?: RunLedger;
  commandRunner?: GitCommandRunner;
  pushConfigured?: boolean;
  bootstrapFromOriginDevelop?: boolean;
}

const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "production"]);

export class WorkerGitOps {
  private runId: string;
  private repoDir: string;
  private ledger?: RunLedger;
  private commandRunner: GitCommandRunner;
  private auditLogs: GitAuditLogEntry[] = [];
  private currentBranch = "";
  private hasCustomCommandRunner: boolean;
  private pushConfiguredExplicit?: boolean;
  private bootstrapFromOriginDevelop: boolean;

  constructor(options: WorkerGitOpsOptions) {
    this.runId = options.runId;
    this.repoDir = options.repoDir || process.cwd();
    this.ledger = options.ledger;
    this.hasCustomCommandRunner = Boolean(options.commandRunner);
    this.pushConfiguredExplicit = options.pushConfigured;
    this.bootstrapFromOriginDevelop = Boolean(options.bootstrapFromOriginDevelop);
    this.commandRunner =
      options.commandRunner ??
      (async (file: string, args: string[]) => {
        try {
          const { stdout, stderr } = await execFileAsync(file, args, {
            cwd: this.repoDir,
            timeout: 120000
          });
          return { exitCode: 0, stdout: stdout || "", stderr: stderr || "" };
        } catch (err: any) {
          return {
            exitCode: typeof err?.code === "number" ? err.code : 1,
            stdout: err?.stdout || "",
            stderr: err?.stderr || err?.message || String(err)
          };
        }
      });
  }

  private assertSafeBranchName(branchName: string): void {
    const normalized = branchName.trim().replace(/^refs\/heads\//, "");
    if (!normalized) {
      throw new Error("Branch name cannot be empty");
    }
    if (PROTECTED_BRANCHES.has(normalized.toLowerCase())) {
      throw new Error(`Cannot push directly to protected branch: ${normalized}`);
    }
    if (!/^(feat|feature|fix|chore|docs|refactor|test)\/[a-zA-Z0-9._-]+$/i.test(normalized)) {
      throw new Error(
        `Invalid worker branch name '${normalized}'. Must follow feat/<slug>, feature/<slug> or fix/<slug> convention.`
      );
    }
  }

  private recordAudit(command: string, res: GitCommandResult): void {
    const entry: GitAuditLogEntry = {
      timestamp: new Date().toISOString(),
      runId: this.runId,
      command,
      exitCode: res.exitCode,
      output: `${res.stdout}\n${res.stderr}`.trim()
    };
    this.auditLogs.push(entry);
  }

  public getAuditLogs(): GitAuditLogEntry[] {
    return [...this.auditLogs];
  }

  public async createAndSwitchBranch(branchName: string): Promise<{
    branchName: string;
    baseSha?: string;
    eventMarkdown: string;
  }> {
    this.assertSafeBranchName(branchName);
    let baseSha: string | undefined;

    // Workspace bootstrap safety check: ensure working tree is clean (no modified/staged tracked files)
    const statusRes = await this.commandRunner("git", ["status", "--porcelain", "-uno"]);
    this.recordAudit("git status --porcelain -uno", statusRes);
    const porcelainOut = statusRes.stdout.trim();
    if (statusRes.exitCode === 0 && porcelainOut.length > 0 && porcelainOut !== "ok") {
      throw new Error(`Bootstrap failed: dirty working tree in workspace:\n${porcelainOut}`);
    }

    if (!this.hasCustomCommandRunner || this.bootstrapFromOriginDevelop) {
      // Fresh-pull discipline: if origin remote exists, fetch origin/develop and branch from origin/develop
      const remoteRes = await this.commandRunner("git", ["remote", "get-url", "origin"]);
      this.recordAudit("git remote get-url origin", remoteRes);
      if (remoteRes.exitCode === 0 && remoteRes.stdout.trim()) {
        const fetchRes = await this.commandRunner("git", ["fetch", "origin", "develop"]);
        this.recordAudit("git fetch origin develop", fetchRes);
        if (fetchRes.exitCode !== 0) {
          throw new Error(`Bootstrap failed: git fetch origin develop failed: ${fetchRes.stderr || fetchRes.stdout}`);
        }
        const verifyOriginDev = await this.commandRunner("git", ["rev-parse", "origin/develop"]);
        this.recordAudit("git rev-parse origin/develop", verifyOriginDev);
        if (verifyOriginDev.exitCode !== 0 || !verifyOriginDev.stdout.trim()) {
          throw new Error(`Bootstrap failed: cannot resolve origin/develop: ${verifyOriginDev.stderr || verifyOriginDev.stdout}`);
        }
        baseSha = verifyOriginDev.stdout.trim();
        const checkoutOriginArgs = ["checkout", "-B", branchName, "origin/develop"];
        const coRes = await this.commandRunner("git", checkoutOriginArgs);
        this.recordAudit(["git", ...checkoutOriginArgs].join(" "), coRes);
        if (coRes.exitCode !== 0) {
          throw new Error(`Bootstrap failed: git checkout -B ${branchName} origin/develop failed: ${coRes.stderr || coRes.stdout}`);
        }
        this.currentBranch = branchName;
        return {
          branchName,
          baseSha,
          eventMarkdown: `Created and switched to branch \`${branchName}\` from \`origin/develop\` (\`${baseSha.slice(0, 7)}\`)`
        };
      }
    }

    const args = ["checkout", "-B", branchName];
    const res = await this.commandRunner("git", args);
    this.recordAudit(["git", ...args].join(" "), res);

    if (res.exitCode !== 0) {
      throw new Error(`Bootstrap failed: checkout -B ${branchName} failed: ${res.stderr || res.stdout}`);
    }

    this.currentBranch = branchName;
    return {
      branchName,
      eventMarkdown: `Created and switched to branch \`${branchName}\``
    };
  }

  public async isPushConfigured(): Promise<{ configured: boolean; reason?: string }> {
    if (this.pushConfiguredExplicit !== undefined) {
      return {
        configured: this.pushConfiguredExplicit,
        reason: this.pushConfiguredExplicit ? undefined : "Push explicitly disabled in configuration"
      };
    }
    try {
      const remoteRes = await this.commandRunner("git", ["remote", "get-url", "origin"]);
      if (remoteRes.exitCode !== 0 || !remoteRes.stdout.trim()) {
        return { configured: false, reason: "No origin remote configured" };
      }
      const remoteUrl = remoteRes.stdout.trim();
      if (remoteUrl.endsWith(".bundle") || remoteUrl.startsWith("/") || remoteUrl.startsWith("file://")) {
        return { configured: false, reason: "origin remote is a local bundle archive (push not configured)" };
      }
      const hasAuth = Boolean(
        process.env.GITHUB_TOKEN ||
        process.env.GH_TOKEN ||
        process.env.GIT_CREDENTIALS ||
        process.env.ALLOW_GIT_PUSH === "1"
      );
      if (!hasAuth) {
        return { configured: false, reason: "Git push credentials (GITHUB_TOKEN / GH_TOKEN) not configured in environment" };
      }
      return { configured: true };
    } catch {
      return { configured: false, reason: "Unable to check git remote origin" };
    }
  }

  public async runGateTest(): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    passed: boolean;
  }> {
    const res = await this.commandRunner("npm", ["run", "test:gate"]);
    this.recordAudit("npm run test:gate", res);
    return {
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      passed: res.exitCode === 0
    };
  }

  public async stageAndCommit(
    files: string[],
    commitMessage: string
  ): Promise<{
    commitSha: string;
    shortSha: string;
    eventMarkdown: string;
  }> {
    if (!commitMessage || !commitMessage.trim()) {
      throw new Error("Commit message is required");
    }

    if (this.currentBranch && PROTECTED_BRANCHES.has(this.currentBranch.toLowerCase())) {
      throw new Error(`WorkerGitOps cannot commit directly to protected branch: ${this.currentBranch}`);
    }

    const currentBranchRes = await this.commandRunner("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    const activeBranch = currentBranchRes.stdout.trim().toLowerCase();
    if (activeBranch && PROTECTED_BRANCHES.has(activeBranch)) {
      throw new Error(`WorkerGitOps cannot commit directly to protected branch: ${activeBranch}`);
    }

    const addArgs = files.length > 0 ? ["add", ...files] : ["add", "-A"];
    const addRes = await this.commandRunner("git", addArgs);
    this.recordAudit(["git", ...addArgs].join(" "), addRes);
    if (addRes.exitCode !== 0) {
      throw new Error(`git add failed: ${addRes.stderr || addRes.stdout}`);
    }

    const commitArgs = ["commit", "-m", commitMessage];
    const commitRes = await this.commandRunner("git", commitArgs);
    this.recordAudit(["git", ...commitArgs].join(" "), commitRes);
    const combinedCommitOut = `${commitRes.stdout}\n${commitRes.stderr}`;
    if (commitRes.exitCode !== 0 && !/nothing to commit|working tree clean/i.test(combinedCommitOut)) {
      throw new Error(`git commit failed: ${commitRes.stderr || commitRes.stdout}`);
    }

    const shaArgs = ["rev-parse", "HEAD"];
    const shaRes = await this.commandRunner("git", shaArgs);
    this.recordAudit(["git", ...shaArgs].join(" "), shaRes);
    const commitSha = shaRes.stdout.trim() || "HEAD";
    const shortSha = commitSha.slice(0, 7);

    // Record commit SHA in RunLedger
    try {
      const ledgerToUse = this.ledger || getSharedRunLedger();
      const existing = ledgerToUse.getRun(this.runId);
      if (existing) {
        const nextShas = Array.from(new Set([...existing.gitShas, commitSha]));
        ledgerToUse.updateRunProgress(this.runId, { gitShas: nextShas });
      }
    } catch {
      // Non-fatal if runId is not registered in ledger
    }

    return {
      commitSha,
      shortSha,
      eventMarkdown: `Committed \`${shortSha}\` — ${commitMessage}`
    };
  }

  public async pushBranch(
    branchName?: string,
    options?: { force?: boolean }
  ): Promise<{
    branchName: string;
    success: boolean;
    eventMarkdown: string;
  }> {
    if (options?.force) {
      throw new Error("Force-pushing is strictly prohibited by sandbox safety rails.");
    }

    const targetBranch = (branchName || this.currentBranch).trim();
    this.assertSafeBranchName(targetBranch);

    const pushArgs = ["push", "-u", "origin", targetBranch];
    const res = await this.commandRunner("git", pushArgs);
    this.recordAudit(["git", ...pushArgs].join(" "), res);

    if (res.exitCode !== 0) {
      throw new Error(`git push failed for ${targetBranch}: ${res.stderr || res.stdout}`);
    }

    return {
      branchName: targetBranch,
      success: true,
      eventMarkdown: `Pushed branch \`${targetBranch}\` to origin`
    };
  }

  public async openPullRequest(input: {
    baseBranch?: string;
    headBranch?: string;
    title: string;
    body: string;
  }): Promise<{
    prNumber: number;
    prUrl: string;
    eventMarkdown: string;
  }> {
    const base = input.baseBranch || "develop";
    if (base.toLowerCase() === "main" || base.toLowerCase() === "master") {
      throw new Error("Worker PRs must target 'develop', never 'main' directly.");
    }

    const head = input.headBranch || this.currentBranch;
    this.assertSafeBranchName(head);

    const prArgs = ["pr", "create", "--base", base, "--head", head, "--title", input.title, "--body", input.body];
    const res = await this.commandRunner("gh", prArgs);
    this.recordAudit(["gh", ...prArgs].join(" "), res);

    if (res.exitCode !== 0) {
      throw new Error(`Failed to open PR: ${res.stderr || res.stdout}`);
    }

    const prUrl = res.stdout.trim().split(/\s+/).pop() || "";
    const match = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = match ? parseInt(match[1], 10) : 1;

    return {
      prNumber,
      prUrl,
      eventMarkdown: `Opened [PR #${prNumber}](${prUrl}): ${input.title}`
    };
  }

  public async deleteBranch(_branchName: string): Promise<never> {
    throw new Error("Branch deletion is strictly prohibited by sandbox safety rails.");
  }
}
