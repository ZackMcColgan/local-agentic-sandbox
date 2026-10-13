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
        commandRunner: async (cmd: string) => {
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
});
