import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { WorkerGitOps } from "../lib/git/workerGitOps.js";
import { OvernightSupervisor } from "../lib/subagents/supervisor.js";
import { TaskManifest } from "../lib/subagents/types.js";
import { formatMorningReportMarkdown, generateMorningReport, generateOvernightMorningReport, formatOvernightMorningReportMarkdown } from "../lib/subagents/morningReport.js";

describe("BUILD-1: GitOps Push Honesty, Bootstrap Safety & Morning Report Attribution", () => {
  it("(a) push failure -> honest local-only failure status, not false success or hallucinated PR", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-fail-test-"));
    try {
      const gitOps = new WorkerGitOps({
        runId: "run-fail-1",
        pushConfigured: true,
        commandRunner: async (_file, args) => {
          if (args[0] === "status") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "push") {
            return { exitCode: 1, stdout: "", stderr: "remote: Permission to zmh-oss/sandbox denied to token" };
          }
          return { exitCode: 0, stdout: "ok\n", stderr: "" };
        }
      });

      const supervisor = new OvernightSupervisor({
        checkpointDir: tmpDir
      });

      const task: TaskManifest = {
        taskId: "task-push-fail-1",
        goal: "Test push error honesty",
        toolchain: "node:22",
        branchName: "feat/push-fail-1",
        status: "active",
        currentMilestoneIndex: 0,
        milestones: [
          {
            id: "M1",
            title: "Simulated milestone",
            description: "No-op milestone",
            acceptanceCriteria: [{ id: "AC1", assertion: "passes" }],
            status: "completed",
            builderIterations: 1,
            criticRounds: 1
          }
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Set milestone to completed so loop finishes immediately and triggers terminal gate/push
      task.currentMilestoneIndex = 1;

      const completed = await supervisor.executeTaskWithRecovery(task, {
        gitOps,
        gateRunner: async () => ({ exitCode: 0, stdout: "Pre-merge gate passed" })
      });

      assert.equal(completed.status, "completed");
      assert.ok(
        completed.pushStatus && completed.pushStatus.startsWith("failed:"),
        `Expected pushStatus to report failure honestly, got: ${completed.pushStatus}`
      );
      assert.equal(completed.prUrl, undefined, "prUrl must never be populated on push failure");

      // Verify journal entry recorded failure honestly
      const pushJournal = completed.journal.find(j => j.role === "gitops" && j.message.includes("failed:"));
      assert.ok(pushJournal, "Journal must record honest push failure");

      // Verify Morning Report renders honest failure without claiming remote push
      const report = generateMorningReport({
        taskId: completed.taskId,
        goal: completed.goal,
        branch: completed.branchName,
        pushStatus: completed.pushStatus,
        gitHeadSha: "abc1234",
        status: "completed",
        startedAt: completed.startedAt,
        completedAt: completed.completedAt,
        milestones: [],
        ambiguityFlags: [],
        parkedItems: []
      });
      assert.ok(report.summaryMarkdown.includes(completed.pushStatus!), "Morning Report must include honest failure status");
      assert.ok(!report.summaryMarkdown.includes("Opened PR"), "Morning Report must not claim a PR");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("(b) successful push -> push status 'pushed' recorded in manifest and morning report", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-succ-test-"));
    try {
      const gitOps = new WorkerGitOps({
        runId: "run-succ-1",
        pushConfigured: true,
        commandRunner: async (_file, args) => {
          if (args[0] === "status") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "push") {
            return { exitCode: 0, stdout: "To github.com:zmh/sandbox.git\n * [new branch] feat/push-succ-1 -> feat/push-succ-1", stderr: "" };
          }
          return { exitCode: 0, stdout: "ok\n", stderr: "" };
        }
      });

      const supervisor = new OvernightSupervisor({
        checkpointDir: tmpDir
      });

      const task: TaskManifest = {
        taskId: "task-push-succ-1",
        goal: "Test push success recording",
        toolchain: "node:22",
        branchName: "feat/push-succ-1",
        status: "active",
        currentMilestoneIndex: 1,
        milestones: [
          {
            id: "M1",
            title: "Simulated milestone",
            description: "No-op milestone",
            acceptanceCriteria: [{ id: "AC1", assertion: "passes" }],
            status: "completed",
            builderIterations: 1,
            criticRounds: 1
          }
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const completed = await supervisor.executeTaskWithRecovery(task, {
        gitOps,
        gateRunner: async () => ({ exitCode: 0, stdout: "Pre-merge gate passed" })
      });

      assert.equal(completed.status, "completed");
      assert.equal(completed.pushStatus, "pushed");

      const journalEntry = completed.journal.find(j => j.role === "gitops" && j.message.includes("Pushed branch"));
      assert.ok(journalEntry, "Journal must record successful branch push");

      const overnightReport = generateOvernightMorningReport([completed]);
      const md = formatOvernightMorningReportMarkdown(overnightReport);
      assert.ok(md.includes("(pushed)"), "Overnight report must indicate pushed status");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("(b2) push not configured -> honest 'completed — local only, push not configured'", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-notconf-test-"));
    try {
      const gitOps = new WorkerGitOps({
        runId: "run-notconf-1",
        pushConfigured: false,
        commandRunner: async (_file, args) => {
          if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
          return { exitCode: 0, stdout: "ok\n", stderr: "" };
        }
      });

      const supervisor = new OvernightSupervisor({
        checkpointDir: tmpDir
      });

      const task: TaskManifest = {
        taskId: "task-push-notconf-1",
        goal: "Test push not configured honesty",
        toolchain: "node:22",
        branchName: "feat/push-notconf-1",
        status: "active",
        currentMilestoneIndex: 1,
        milestones: [
          {
            id: "M1",
            title: "Simulated milestone",
            description: "No-op milestone",
            acceptanceCriteria: [{ id: "AC1", assertion: "passes" }],
            status: "completed",
            builderIterations: 1,
            criticRounds: 1
          }
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const completed = await supervisor.executeTaskWithRecovery(task, {
        gitOps,
        gateRunner: async () => ({ exitCode: 0, stdout: "Pre-merge gate passed" })
      });

      assert.equal(completed.status, "completed");
      assert.equal(completed.pushStatus, "completed — local only, push not configured");

      const journalEntry = completed.journal.find(
        j => j.role === "gitops" && j.message === "completed — local only, push not configured"
      );
      assert.ok(journalEntry, "Journal must record 'completed — local only, push not configured'");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("(c) dirty working tree at bootstrap -> bootstrap error, task terminates immediately without proceeding", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-dirty-test-"));
    try {
      const gitOps = new WorkerGitOps({
        runId: "run-dirty-1",
        commandRunner: async (_file, args) => {
          if (args[0] === "status" && args[1] === "--porcelain") {
            return { exitCode: 0, stdout: " M uncommitted-change.ts\n?? stray-file.txt\n", stderr: "" };
          }
          return { exitCode: 0, stdout: "ok\n", stderr: "" };
        }
      });

      // Direct gitOps call must throw
      await assert.rejects(
        async () => {
          await gitOps.createAndSwitchBranch("feat/task-dirty");
        },
        /Bootstrap failed: dirty working tree in workspace/i
      );

      // Supervisor must catch, mark task failed, and not execute any milestone
      const supervisor = new OvernightSupervisor({
        checkpointDir: tmpDir
      });

      let milestoneExecuted = false;
      const task: TaskManifest = {
        taskId: "task-dirty-boot",
        goal: "Never proceed on dirty workspace",
        toolchain: "node:22",
        branchName: "feat/task-dirty",
        status: "active",
        currentMilestoneIndex: 0,
        milestones: [
          {
            id: "M1",
            title: "Must not execute",
            description: "Should be aborted before this runs",
            acceptanceCriteria: [{ id: "AC1", assertion: "passes" }],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0
          }
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const result = await supervisor.executeTaskWithRecovery(task, {
        gitOps,
        stepExecutor: async () => {
          milestoneExecuted = true;
          return { status: "completed", testsPassed: 1, testsFailed: 0 };
        }
      });

      assert.equal(result.status, "failed");
      assert.ok(result.errorSummary?.includes("Bootstrap failed"));
      assert.equal(milestoneExecuted, false, "Builder must never run when bootstrap fails");
      assert.equal(result.milestones[0].status, "pending", "Milestone must remain unexecuted");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("(d) clean bootstrap -> branch created from origin/develop", async () => {
    const executedCommands: string[] = [];
    const gitOps = new WorkerGitOps({
      runId: "run-clean-1",
      bootstrapFromOriginDevelop: true,
      commandRunner: async (file, args) => {
        const cmd = [file, ...args].join(" ");
        executedCommands.push(cmd);
        if (args[0] === "status" && args[1] === "--porcelain") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (cmd.includes("remote get-url origin")) {
          return { exitCode: 0, stdout: "https://github.com/zmh-oss/sandbox.git\n", stderr: "" };
        }
        if (cmd.includes("fetch origin develop")) {
          return { exitCode: 0, stdout: "From origin: develop -> origin/develop\n", stderr: "" };
        }
        if (cmd.includes("rev-parse origin/develop")) {
          return { exitCode: 0, stdout: "06fb0bdc540b9e3fb61b486e3f7b759ef229353a\n", stderr: "" };
        }
        if (cmd.includes("checkout -B feat/clean-boot origin/develop")) {
          return { exitCode: 0, stdout: "Switched to a new branch 'feat/clean-boot'\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      }
    });

    const res = await gitOps.createAndSwitchBranch("feat/clean-boot");
    assert.equal(res.branchName, "feat/clean-boot");
    assert.equal(res.baseSha, "06fb0bdc540b9e3fb61b486e3f7b759ef229353a");
    assert.ok(res.eventMarkdown.includes("from `origin/develop` (`06fb0bd`)"));

    // Verify correct commands in sequence
    assert.ok(executedCommands.some(c => c.includes("git status --porcelain")));
    assert.ok(executedCommands.some(c => c.includes("git fetch origin develop")));
    assert.ok(executedCommands.some(c => c.includes("git checkout -B feat/clean-boot origin/develop")));
  });
});
