import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import {
  OvernightSupervisor,
  createOvernightGraph,
  createProductionStepExecutor
} from "../lib/subagents/supervisor.js";
import { TaskManifest, Milestone } from "../lib/subagents/types.js";
import { WorkerPool } from "../lib/subagents/workerPool.js";

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

  it("executeTaskWithRecovery with no stepExecutor and pending milestones refuses to fake completion and throws", async () => {
    if (!fs.existsSync(testCheckpointDir)) fs.mkdirSync(testCheckpointDir, { recursive: true });

    try {
      const supervisor = new OvernightSupervisor({
        checkpointDirectory: testCheckpointDir,
        stallTimeoutMs: 10000
      });

      const task: TaskManifest = {
        taskId: "task-refuse-fake-completion",
        goal: "Pending milestones without executor must not silently complete",
        toolchain: "node:22",
        branchName: "task/refuse-fake-completion",
        status: "active",
        milestones: [
          {
            id: "M1",
            title: "Pending Milestone 1",
            description: "Work that requires an actual executor",
            acceptanceCriteria: [{ id: "AC-1", assertion: "Work verified" }],
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

      await assert.rejects(
        async () => {
          await supervisor.executeTaskWithRecovery(task);
        },
        /no stepExecutor provided; refusing to fake completion/i
      );

      // Verify that milestones were NOT marked completed
      assert.equal(task.milestones[0].status, "pending", "Pending milestones must remain pending");
      assert.notEqual(task.status, "completed", "Task must not report success without an executor");
    } finally {
      if (fs.existsSync(testCheckpointDir)) {
        fs.rmSync(testCheckpointDir, { recursive: true, force: true });
      }
    }
  });

  it("createProductionStepExecutor with empty builder targetFile refuses to commit and fails milestone", async () => {
    const testRepo = path.resolve(process.cwd(), `temp-test-no-target-${Date.now()}`);
    fs.mkdirSync(testRepo, { recursive: true });

    try {
      // Initialize a temporary git repository
      execSync("git init", { cwd: testRepo, stdio: ["pipe", "pipe", "ignore"] });
      execSync("git config user.email \"test@example.com\"", { cwd: testRepo, stdio: ["pipe", "pipe", "ignore"] });
      execSync("git config user.name \"Test\"", { cwd: testRepo, stdio: ["pipe", "pipe", "ignore"] });
      fs.writeFileSync(path.join(testRepo, "initial.txt"), "initial", "utf8");
      execSync("git add initial.txt", { cwd: testRepo, stdio: ["pipe", "pipe", "ignore"] });
      execSync("git commit -m \"initial commit\"", { cwd: testRepo, stdio: ["pipe", "pipe", "ignore"] });
      const initialHead = execSync("git rev-parse HEAD", { cwd: testRepo, encoding: "utf8" }).trim();

      // Create an unrelated local edit that must NOT be swept into a commit
      fs.writeFileSync(path.join(testRepo, "unrelated.txt"), "unrelated change", "utf8");

      const mockPool = new WorkerPool();
      mockPool.executeJob = async (job: any) => {
        if (job.role === "builder") {
          return {
            diff: "+dummy modification",
            gitSha: initialHead,
            iterations: 1,
            synthetic: false,
            targetFile: "", // Explicitly empty targetFile
            stuck: false
          };
        }
        if (job.role === "critic") {
          return {
            approved: true,
            feedback: [],
            abstained: false,
            synthetic: false,
            verdict: "approved"
          };
        }
        return job.taskFn(new AbortController().signal);
      };

      const stepExecutor = createProductionStepExecutor({
        workerPool: mockPool,
        repoRoot: testRepo
      });

      const milestone: Milestone = {
        id: "M1",
        title: "Milestone with no target file",
        description: "Builder forgot target file",
        acceptanceCriteria: [{ id: "AC-1", assertion: "Criterion" }],
        status: "pending",
        builderIterations: 0,
        criticRounds: 0
      };

      const res = await stepExecutor(milestone, 1);

      // Assert milestone does NOT report success
      assert.equal(res.status, "failed", "Milestone must fail when builder targetFile is missing");

      // Assert no git add / git commit occurred
      const currentHead = execSync("git rev-parse HEAD", { cwd: testRepo, encoding: "utf8" }).trim();
      assert.equal(currentHead, initialHead, "Git HEAD must not change when targetFile is missing");

      const gitStatus = execSync("git status --porcelain", { cwd: testRepo, encoding: "utf8" });
      assert.ok(gitStatus.includes("?? unrelated.txt"), "Unrelated files must not be staged or committed");
    } finally {
      if (fs.existsSync(testRepo)) {
        fs.rmSync(testRepo, { recursive: true, force: true });
      }
    }
  });

  it("asserts structured log lines appear when stepExecutor throws and is logged not swallowed", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: any[]) => { logs.push(args.map(a => String(a)).join(" ")); };
    console.error = (...args: any[]) => { errors.push(args.map(a => String(a)).join(" ")); };

    const testDir = path.resolve(process.cwd(), "temp-test-logs-" + Date.now());
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

    try {
      const supervisor = new OvernightSupervisor({
        checkpointDirectory: testDir,
        stallTimeoutMs: 10000
      });

      const task: TaskManifest = {
        taskId: "task-logging-test",
        goal: "Verify structured logging",
        toolchain: "node:22",
        branchName: "task/logging-test",
        status: "active",
        milestones: [
          {
            id: "M1",
            title: "Failing step",
            description: "Throws an error",
            acceptanceCriteria: [{ id: "AC-1", assertion: "Fails" }],
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

      const failingExecutor = async (m: Milestone, attempt: number) => {
        throw new Error("Intentional step failure for logging check");
      };

      await supervisor.executeTaskWithRecovery(task, { stepExecutor: failingExecutor });

      // Verify the required structured logging lines were emitted
      assert.ok(
        logs.some(l => l.includes("[supervisor] executeTaskWithRecovery start taskId=task-logging-test")),
        "Must log executeTaskWithRecovery entry"
      );
      assert.ok(
        logs.some(l => l.includes("[supervisor] executing milestone M1 attempt 1")),
        "Must log executing milestone attempt"
      );
      assert.ok(
        errors.some(l => l.includes("[supervisor] stepExecutor threw for milestone M1:")),
        "Must log stepExecutor thrown error with stack"
      );
      assert.ok(
        logs.some(l => l.includes("[supervisor] saving checkpoint for task-logging-test")),
        "Must log checkpoint save"
      );
      assert.ok(
        logs.some(l => l.includes("[supervisor] checkpoint saved for task-logging-test")),
        "Must log checkpoint saved"
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});
