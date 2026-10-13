import { exec } from "child_process";
import { promisify } from "util";
import { RunLedger, getSharedRunLedger } from "../ledger/runLedger";

const execAsync = promisify(exec);

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (command: string) => Promise<GitCommandResult>;

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
}

const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "production"]);

export class WorkerGitOps {
  private runId: string;
  private repoDir: string;
  private ledger?: RunLedger;
  private commandRunner: GitCommandRunner;
  private auditLogs: GitAuditLogEntry[] = [];
  private currentBranch = "";

  constructor(options: WorkerGitOpsOptions) {
    this.runId = options.runId;
    this.repoDir = options.repoDir || process.cwd();
    this.ledger = options.ledger;
    this.commandRunner =
      options.commandRunner ??
      (async (cmd: string) => {
        try {
          const { stdout, stderr } = await execAsync(cmd, {
            cwd: this.repoDir,
            timeout: 60000
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
    if (!/^(feature|fix|chore|docs|refactor|test)\/[a-zA-Z0-9._-]+$/i.test(normalized)) {
      throw new Error(
        `Invalid worker branch name '${normalized}'. Must follow feature/<slug> or fix/<slug> convention.`
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
    eventMarkdown: string;
  }> {
    this.assertSafeBranchName(branchName);
    const cmd = `git checkout -B ${branchName}`;
    const res = await this.commandRunner(cmd);
    this.recordAudit(cmd, res);

    if (res.exitCode !== 0) {
      throw new Error(`Failed to create/switch branch ${branchName}: ${res.stderr || res.stdout}`);
    }

    this.currentBranch = branchName;
    return {
      branchName,
      eventMarkdown: `Created and switched to branch \`${branchName}\``
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

    const targets = files.length > 0 ? files.map((f) => `"${f}"`).join(" ") : "-A";
    const addCmd = `git add ${targets}`;
    const addRes = await this.commandRunner(addCmd);
    this.recordAudit(addCmd, addRes);
    if (addRes.exitCode !== 0) {
      throw new Error(`git add failed: ${addRes.stderr || addRes.stdout}`);
    }

    const safeMessage = commitMessage.replace(/"/g, '\\"');
    const commitCmd = `git commit -m "${safeMessage}"`;
    const commitRes = await this.commandRunner(commitCmd);
    this.recordAudit(commitCmd, commitRes);
    if (commitRes.exitCode !== 0) {
      throw new Error(`git commit failed: ${commitRes.stderr || commitRes.stdout}`);
    }

    const shaCmd = "git rev-parse HEAD";
    const shaRes = await this.commandRunner(shaCmd);
    this.recordAudit(shaCmd, shaRes);
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

    const cmd = `git push -u origin ${targetBranch}`;
    const res = await this.commandRunner(cmd);
    this.recordAudit(cmd, res);

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

    const safeTitle = input.title.replace(/"/g, '\\"');
    const safeBody = input.body.replace(/"/g, '\\"');
    const cmd = `gh pr create --base ${base} --head ${head} --title "${safeTitle}" --body "${safeBody}"`;
    const res = await this.commandRunner(cmd);
    this.recordAudit(cmd, res);

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
