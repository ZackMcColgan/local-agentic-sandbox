import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

describe("Sprint 12 Phase 8 — Worker Git Operations (workerGitOps.test.ts)", () => {
  it("Worker creates a branch, commits, pushes, and opens PR with valid events and ledger logging", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitops-test-"));
    const dbPath = path.join(tmpDir, "runs.db");

    try {
      const { WorkerGitOps } = await import("../lib/git/workerGitOps.js");
      const { RunLedger } = await import("../lib/ledger/runLedger.js");

      const ledger = new RunLedger(dbPath);
      ledger.recordRunStart({
        runId: "run-git-1",
        threadId: "thread-git-1",
        prompt: "Add weather endpoint",
        status: "running",
        startedAt: new Date().toISOString(),
        model: "swift-27b-mtp",
        gitShas: [],
        milestoneSummary: [],
        deploymentRef: "none"
      });

      const executedCommands: string[] = [];
      const gitOps = new WorkerGitOps({
        runId: "run-git-1",
        ledger,
        commandRunner: async (file: string, args: string[]) => {
          const cmd = [file, ...args].join(" ");
          executedCommands.push(cmd);
          if (cmd.includes("rev-parse HEAD")) {
            return { exitCode: 0, stdout: "abc1234567890\n", stderr: "" };
          }
          if (cmd.includes("gh pr create") || cmd.includes("pr create")) {
            return {
              exitCode: 0,
              stdout: "https://github.com/ZackMcColgan/local-agentic-sandbox/pull/99\n",
              stderr: ""
            };
          }
          return { exitCode: 0, stdout: "ok\n", stderr: "" };
        }
      });

      const branchRes = await gitOps.createAndSwitchBranch("feature/weather-endpoint");
      assert.equal(branchRes.branchName, "feature/weather-endpoint");
      assert.equal(branchRes.eventMarkdown, "Created and switched to branch `feature/weather-endpoint`");

      const commitRes = await gitOps.stageAndCommit(["web-ui/api/weather.ts"], "feat(api): add weather forecast endpoint");
      assert.equal(commitRes.commitSha, "abc1234567890");
      assert.ok(commitRes.eventMarkdown.includes("Committed `abc1234`"));

      const pushRes = await gitOps.pushBranch("feature/weather-endpoint");
      assert.equal(pushRes.success, true);
      assert.ok(pushRes.eventMarkdown.includes("Pushed branch `feature/weather-endpoint` to origin"));

      const prRes = await gitOps.openPullRequest({
        baseBranch: "develop",
        title: "feat(api): add weather forecast endpoint",
        body: "Automated PR from worker run-git-1"
      });
      assert.equal(prRes.prNumber, 99);
      assert.equal(prRes.prUrl, "https://github.com/ZackMcColgan/local-agentic-sandbox/pull/99");
      assert.ok(prRes.eventMarkdown.includes("[PR #99](https://github.com/ZackMcColgan/local-agentic-sandbox/pull/99)"));

      // Verify that all git operations updated the run ledger gitShas and history
      const updatedRun = ledger.getRun("run-git-1");
      assert.ok(updatedRun);
      assert.ok(updatedRun.gitShas.includes("abc1234567890"), "Ledger must record commitSha");

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Direct push to main or develop is strictly blocked with a descriptive error", async () => {
    const { WorkerGitOps } = await import("../lib/git/workerGitOps.js");
    const gitOps = new WorkerGitOps({ runId: "run-git-block-1" });

    await assert.rejects(
      async () => {
        await gitOps.pushBranch("main");
      },
      /Cannot push directly to protected branch: main/i,
      "Pushing to main must be strictly blocked"
    );

    await assert.rejects(
      async () => {
        await gitOps.pushBranch("develop");
      },
      /Cannot push directly to protected branch: develop/i,
      "Pushing to develop must be strictly blocked"
    );
  });

  it("Force-push is strictly blocked with a descriptive error", async () => {
    const { WorkerGitOps } = await import("../lib/git/workerGitOps.js");
    const gitOps = new WorkerGitOps({ runId: "run-git-block-2" });

    await assert.rejects(
      async () => {
        await gitOps.pushBranch("feature/my-feat", { force: true });
      },
      /Force-pushing is strictly prohibited/i,
      "Force-push must be blocked"
    );
  });

  it("Deleting branches is strictly prohibited", async () => {
    const { WorkerGitOps } = await import("../lib/git/workerGitOps.js");
    const gitOps = new WorkerGitOps({ runId: "run-git-block-3" });

    await assert.rejects(
      async () => {
        await gitOps.deleteBranch("feature/old-feat");
      },
      /Branch deletion is strictly prohibited/i,
      "Branch deletion must be blocked"
    );
  });

  it("Fix 5.1: stageAndCommit and openPullRequest prevent command injection via execFile array arguments", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitops-inject-test-"));
    const pwnedFile = path.join(tmpDir, "pwned.txt");

    try {
      const { WorkerGitOps } = await import("../lib/git/workerGitOps.js");

      const executedArgs: { file: string; args: string[] }[] = [];
      const gitOps = new WorkerGitOps({
        runId: "run-inject-test",
        repoDir: tmpDir,
        commandRunner: async (file: string, args: string[]) => {
          executedArgs.push({ file, args });
          if (args.includes("rev-parse")) {
            return { exitCode: 0, stdout: "commit123456789\n", stderr: "" };
          }
          if (args.includes("create")) {
            return {
              exitCode: 0,
              stdout: "https://github.com/ZackMcColgan/local-agentic-sandbox/pull/101\n",
              stderr: ""
            };
          }
          return { exitCode: 0, stdout: "ok\n", stderr: "" };
        }
      });

      // 1. Filename with command injection payload
      const maliciousFilename = `evil"; touch "${pwnedFile}"; echo "`;
      await gitOps.stageAndCommit([maliciousFilename], "normal commit");

      assert.equal(fs.existsSync(pwnedFile), false, "Command in filename must NEVER execute");
      const addCall = executedArgs.find((e) => e.file === "git" && e.args[0] === "add");
      assert.ok(addCall, "git add must have been called");
      assert.deepEqual(addCall.args, ["add", maliciousFilename], "Filename passed literally as array element");

      // 2. Commit message with $(...) injection payload
      const maliciousMessage = `fix: $(touch "${pwnedFile}")`;
      await gitOps.stageAndCommit(["file.txt"], maliciousMessage);

      assert.equal(fs.existsSync(pwnedFile), false, "Command in commit message must NEVER execute");
      const commitCalls = executedArgs.filter((e) => e.file === "git" && e.args[0] === "commit");
      const commitCall = commitCalls[commitCalls.length - 1];
      assert.ok(commitCall, "git commit must have been called");
      assert.equal(commitCall.args[2], maliciousMessage, "Commit message passed literally without shell expansion");

      // 3. PR title with backticks injection payload
      await gitOps.createAndSwitchBranch("feature/test-pr-title");
      await gitOps.openPullRequest({
        title: `feat: \`touch "${pwnedFile}"\``,
        body: "Automated PR body"
      });

      assert.equal(fs.existsSync(pwnedFile), false, "Backticks in PR title must NEVER execute");
      const prCall = executedArgs.find((e) => e.file === "gh" && e.args[0] === "pr");
      assert.ok(prCall, "gh pr create must have been called");
      assert.equal(prCall.args[7], `feat: \`touch "${pwnedFile}"\``, "PR title passed literally");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
