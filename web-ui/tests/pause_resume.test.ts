import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

describe("Sprint 12 Phase 4 — Pause & Resume Controls (pause_resume.test.ts)", () => {
  it("start task → pause at milestone 2 → assert status=paused, checkpoint saved → resume → assert milestone 1 already complete (not re-executed), task completes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pause-resume-test-"));
    const dbPath = path.join(tmpDir, "runs.db");
    const checkpointDir = path.join(tmpDir, "checkpoints");

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");
      const ledger = new RunLedger(dbPath, { checkpointDir });

      const executionLog: string[] = [];

      // Start task with 2 milestones
      ledger.recordRunStart({
        runId: "run-pr-1",
        threadId: "thread-pr",
        prompt: "Build 2-milestone app",
        status: "running",
        startedAt: new Date().toISOString(),
        model: "swift-27b-mtp",
        gitShas: ["sha000"],
        milestoneSummary: [
          { id: "M1", title: "Milestone 1", status: "completed", commitSha: "sha111" },
          { id: "M2", title: "Milestone 2", status: "in_progress" }
        ],
        deploymentRef: "local"
      });
      executionLog.push("M1");

      // Pause at milestone 2
      const pausedRun = ledger.pauseRun("run-pr-1", {
        taskId: "run-pr-1",
        threadId: "thread-pr",
        completedMilestoneIds: ["M1"],
        currentMilestoneId: "M2"
      });

      assert.equal(pausedRun.status, "paused", "Run status must transition to paused");
      assert.ok(pausedRun.checkpointPath, "Checkpoint path must be saved when paused");
      assert.ok(fs.existsSync(pausedRun.checkpointPath!), "Checkpoint file must exist on disk");

      // Resume from checkpoint and execute remaining milestones
      const resumed = await ledger.resumeRun("run-pr-1", async (milestone) => {
        executionLog.push(milestone.id);
        return { commitSha: `sha-${milestone.id}` };
      });

      assert.equal(resumed.status, "completed", "Resumed task must complete");
      // M1 was already completed before pause, so only M2 should execute on resume
      assert.deepEqual(
        executionLog,
        ["M1", "M2"],
        "Milestone 1 must NOT be re-executed after resume"
      );
      assert.ok(
        resumed.milestoneSummary.every((m) => m.status === "completed"),
        "All milestones must be marked completed"
      );

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("pause with no checkpoint yet → assert graceful handling, no crash", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pause-nocheckpoint-test-"));
    const dbPath = path.join(tmpDir, "runs.db");
    const checkpointDir = path.join(tmpDir, "checkpoints");

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");
      const ledger = new RunLedger(dbPath, { checkpointDir });

      ledger.recordRunStart({
        runId: "run-pr-nockpt",
        threadId: "thread-pr-2",
        prompt: "Task paused immediately before any checkpoint",
        status: "running",
        startedAt: new Date().toISOString(),
        model: "swift-27b-mtp",
        gitShas: [],
        milestoneSummary: [
          { id: "M1", title: "Initial Setup", status: "pending" }
        ],
        deploymentRef: "none"
      });

      // Call pauseRun without a pre-existing checkpoint payload
      const paused = ledger.pauseRun("run-pr-nockpt");
      assert.equal(paused.status, "paused", "Status must be paused even without prior checkpoint");
      assert.ok(paused.checkpointPath, "Synthesized fallback checkpoint must be created gracefully");
      assert.equal(paused.milestoneSummary[0].status, "pending");

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Fix 2.3: executeTaskWithRecovery halts milestone loop when paused or removed from activeExecutionSet", async () => {
    const { OvernightSupervisor } = await import("../lib/subagents/supervisor.js");
    const { activeExecutionSet } = await import("../lib/threads/threadStore.js");

    const supervisor = new OvernightSupervisor();
    const taskId = "task-pause-in-flight-test";
    activeExecutionSet.add(taskId);

    const executedMilestones: string[] = [];

    const task: any = {
      taskId,
      goal: "Test in-flight pause stop semantics",
      branchName: "feature/pause-test",
      toolchain: "node:22",
      status: "active",
      currentMilestoneIndex: 0,
      milestones: [
        { id: "M1", title: "M1", status: "pending" },
        { id: "M2", title: "M2", status: "pending" },
        { id: "M3", title: "M3", status: "pending" }
      ],
      checkpoints: [],
      ambiguityFlags: [],
      journal: []
    };

    const mockExecutor = async (milestone: any) => {
      executedMilestones.push(milestone.id);
      if (milestone.id === "M1") {
        activeExecutionSet.delete(taskId);
        task.status = "paused";
      }
      return { status: "completed" as const, gitSha: `sha-${milestone.id}` };
    };

    await supervisor.executeTaskWithRecovery(task, { stepExecutor: mockExecutor });

    assert.deepEqual(executedMilestones, ["M1"], "Milestone 2 and 3 must never execute after pause");
    assert.equal(task.status, "paused");
  });

  it("cross-supervisor pause: supB.pauseTask halts supA.executeTaskWithRecovery in-flight, saves status=paused on disk", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-sup-pause-"));
    try {
      const { OvernightSupervisor } = await import("../lib/subagents/supervisor.js");
      const { activeExecutionSet } = await import("../lib/threads/threadStore.js");

      const supA = new OvernightSupervisor(tmpDir);
      const supB = new OvernightSupervisor(tmpDir);

      const taskId = `task-cross-sup-pause-${Date.now()}`;
      activeExecutionSet.add(taskId);

      const executedMilestones: string[] = [];

      const task: any = {
        taskId,
        goal: "Test cross-supervisor in-flight pause",
        branchName: "feature/cross-sup-test",
        toolchain: "node:22",
        status: "active",
        currentMilestoneIndex: 0,
        milestones: [
          { id: "M1", title: "M1", status: "pending" },
          { id: "M2", title: "M2", status: "pending" },
          { id: "M3", title: "M3", status: "pending" }
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: []
      };

      const mockExecutor = async (milestone: any) => {
        executedMilestones.push(milestone.id);
        if (milestone.id === "M1") {
          supB.pauseTask(task, "User paused mid-milestone via supB");
        }
        return { status: "completed" as const, gitSha: `sha-${milestone.id}` };
      };

      const result = await supA.executeTaskWithRecovery(task, { stepExecutor: mockExecutor });

      assert.deepEqual(executedMilestones, ["M1"], "Milestone 2 and 3 must never execute after supB pause");
      assert.equal(result.status, "paused", "supA must return status=paused");

      const checkpointFile = supA.getCheckpointFilePath(taskId);
      assert.ok(fs.existsSync(checkpointFile), "Checkpoint file must exist on disk");
      const onDisk = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
      assert.equal(onDisk.status, "paused", "Checkpoint on disk must have status=paused");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ThreadStore.reconcileThread keeps thread.status === 'paused' when checkpoint on disk has status === 'paused'", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "threadstore-pause-"));
    try {
      const { ThreadStore, activeExecutionSet } = await import("../lib/threads/threadStore.js");
      const { OvernightSupervisor } = await import("../lib/subagents/supervisor.js");

      const supervisor = new OvernightSupervisor(tmpDir);
      const threadStore = new ThreadStore(path.join(tmpDir, "threads.json"), supervisor);

      const taskId = `task-thread-pause-${Date.now()}`;
      supervisor.saveCheckpoint({
        taskId,
        goal: "Test paused thread reconcile",
        branchName: "feat/test",
        toolchain: "node:22",
        status: "paused",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentMilestoneIndex: 0,
        milestones: [{ id: "M1", title: "M1", status: "pending" }],
        checkpoints: [],
        ambiguityFlags: [],
        journal: []
      } as any);

      activeExecutionSet.delete(taskId);

      const thread = threadStore.createThread({
        title: "Paused thread test",
        taskId
      });
      thread.status = "active";
      threadStore.saveThread(thread);

      threadStore.reconcileThread(thread);
      assert.equal(thread.status, "paused", "Thread must be reconciled to 'paused', NOT 'stopped'");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
