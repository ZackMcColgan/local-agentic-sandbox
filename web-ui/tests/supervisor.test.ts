import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  OvernightSupervisor,
  createOvernightGraph
} from "../lib/subagents/supervisor.js";
import { TaskManifest } from "../lib/subagents/types.js";

describe("Phase 1 — Supervisor & LangGraph Checkpointing Suite", () => {
  const testCheckpointDir = path.resolve(process.cwd(), "temp-test-checkpoints");

  it("builds LangGraph state graph with per-step state transitions", async () => {
    const graph = createOvernightGraph();
    assert.ok(graph, "LangGraph graph must be defined");
    assert.ok(typeof graph.compile === "function", "Graph must be compilable");
  });

  it("kill worker pool mid-milestone in a test -> supervisor resumes from checkpoint and completes", async () => {
    if (!fs.existsSync(testCheckpointDir)) fs.mkdirSync(testCheckpointDir, { recursive: true });

    try {
      const supervisor = new OvernightSupervisor({
        checkpointDirectory: testCheckpointDir,
        stallTimeoutMs: 10000
      });

      const task: TaskManifest = {
        taskId: "task-crash-worker-test",
        goal: "Build feature with worker crash test",
        toolchain: "node:22",
        branchName: "task/crash-worker-test",
        status: "active",
        milestones: [
          {
            id: "M1",
            title: "Milestone 1 - Initial setup",
            description: "Setup project structure",
            acceptanceCriteria: [{ id: "AC-1", assertion: "Setup complete" }],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0
          },
          {
            id: "M2",
            title: "Milestone 2 - Core build (will crash once)",
            description: "Worker dies here",
            acceptanceCriteria: [{ id: "AC-2", assertion: "Core complete" }],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0
          },
          {
            id: "M3",
            title: "Milestone 3 - Final verification",
            description: "Final verification",
            acceptanceCriteria: [{ id: "AC-3", assertion: "Verified" }],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0
          }
        ],
        currentMilestoneIndex: 0,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      let workerCrashSimulated = false;

      // Run execution where milestone 2 crashes on first attempt
      const result = await supervisor.executeTaskWithRecovery(task, {
        stepExecutor: async (m, attempt) => {
          if (m.id === "M2" && !workerCrashSimulated) {
            workerCrashSimulated = true;
            throw new Error("Simulated unhandled worker crash / container OOM at 2 AM");
          }
          return {
            status: "completed",
            gitSha: `commit-${m.id}-${attempt}`
          };
        }
      });

      assert.equal(result.status, "completed", "Task must complete after resuming from checkpoint");
      assert.equal(result.milestones[0].status, "completed");
      assert.equal(result.milestones[1].status, "completed");
      assert.equal(result.milestones[2].status, "completed");
      assert.ok(result.checkpoints.length >= 2, "Checkpoints must have been recorded");
      assert.equal(workerCrashSimulated, true, "Worker crash must have been simulated and recovered");
    } finally {
      if (fs.existsSync(testCheckpointDir)) {
        fs.rmSync(testCheckpointDir, { recursive: true, force: true });
      }
    }
  });

  it("kill supervisor itself -> on restart new supervisor picks up the task from checkpoint and completes", async () => {
    if (!fs.existsSync(testCheckpointDir)) fs.mkdirSync(testCheckpointDir, { recursive: true });

    try {
      const taskId = "task-kill-supervisor-test";

      // 1. First supervisor instance runs Milestone 1, saves checkpoint, and dies
      let supervisor1: OvernightSupervisor | null = new OvernightSupervisor({
        checkpointDirectory: testCheckpointDir,
        stallTimeoutMs: 10000
      });

      const initialTask: TaskManifest = {
        taskId,
        goal: "Supervisor restart recovery test",
        toolchain: "node:22",
        branchName: "task/supervisor-restart",
        status: "active",
        milestones: [
          {
            id: "M1",
            title: "Step 1",
            description: "Initial step",
            acceptanceCriteria: [{ id: "AC-1", assertion: "Done" }],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0
          },
          {
            id: "M2",
            title: "Step 2",
            description: "Second step",
            acceptanceCriteria: [{ id: "AC-2", assertion: "Done" }],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0
          }
        ],
        currentMilestoneIndex: 0,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Run only first step and simulate supervisor SIGKILL / host reboot
      const stateAfterStep1 = await supervisor1.executeSingleMilestone(initialTask, 0, {
        gitSha: "sha-step-1"
      });
      assert.equal(stateAfterStep1.milestones[0].status, "completed");

      // Supervisor 1 is killed (garbage collected / process termination)
      supervisor1 = null;

      // 2. New supervisor instance starts up (fresh reboot / new container)
      const supervisor2 = new OvernightSupervisor({
        checkpointDirectory: testCheckpointDir,
        stallTimeoutMs: 10000
      });

      // Resume task from disk checkpoint
      const resumedState = await supervisor2.resumeTaskFromCheckpoint(taskId);
      assert.ok(resumedState, "Resumed state must be recovered from disk checkpoint");
      assert.equal(resumedState.milestones[0].status, "completed", "Milestone 1 must remain completed");
      assert.equal(resumedState.currentMilestoneIndex, 1, "Must resume from Milestone 2, not restart at 0");

      // Execute remaining step to completion
      const completedTask = await supervisor2.executeTaskWithRecovery(resumedState, {
        stepExecutor: async (m) => ({
          status: "completed",
          gitSha: `sha-${m.id}-final`
        })
      });

      assert.equal(completedTask.status, "completed");
      assert.equal(completedTask.milestones[1].status, "completed");
    } finally {
      if (fs.existsSync(testCheckpointDir)) {
        fs.rmSync(testCheckpointDir, { recursive: true, force: true });
      }
    }
  });

  it("stall detection parks task after N minutes of no forward progress and flags ambiguity for morning", async () => {
    if (!fs.existsSync(testCheckpointDir)) fs.mkdirSync(testCheckpointDir, { recursive: true });

    try {
      // Test with short 100ms stall threshold to verify state snapshot & parking logic
      const supervisor = new OvernightSupervisor({
        checkpointDirectory: testCheckpointDir,
        stallTimeoutMs: 100
      });

      const stalledTask: TaskManifest = {
        taskId: "task-stall-detection",
        goal: "Stalled task with zero forward progress",
        toolchain: "node:22",
        branchName: "task/stalled",
        status: "active",
        milestones: [
          {
            id: "M1",
            title: "Milestone that makes no progress",
            description: "Endless spin simulation",
            acceptanceCriteria: [{ id: "AC-1", assertion: "Never satisfied" }],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0
          }
        ],
        currentMilestoneIndex: 0,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date(Date.now() - 500).toISOString(),
        updatedAt: new Date(Date.now() - 500).toISOString() // 500ms ago -> stalled relative to 100ms
      };

      const result = await supervisor.checkStallAndReconcile(stalledTask);
      assert.equal(result.status, "parked", "Task must be parked when stall threshold is exceeded");
      assert.ok(result.ambiguityFlags.length >= 1, "Must flag an ambiguity for the morning report");
      assert.ok(result.parkedReason, "Must record a parked reason");
      assert.ok(result.parkedReason?.includes("Stall detected"), "Reason must mention stall");
    } finally {
      if (fs.existsSync(testCheckpointDir)) {
        fs.rmSync(testCheckpointDir, { recursive: true, force: true });
      }
    }
  });
});
