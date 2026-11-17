import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { POST as threadsPost } from "../app/api/threads/route.js";
import { GET as tasksGet } from "../app/api/tasks/route.js";
import { ThreadStore } from "../lib/threads/threadStore.js";
import { OvernightSupervisor } from "../lib/subagents/supervisor.js";
import { setPlanSpecGenerator } from "../lib/subagents/planner.js";
import { TaskManifest } from "../lib/subagents/types.js";
import { getCanonicalCheckpointDir } from "../lib/subagents/morningReport.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("BUILD-2: Build Launch Visibility, Listing, and Streamed Thinking", () => {
  const threadStore = new ThreadStore();
  const supervisor = new OvernightSupervisor();
  const testCheckpointDir = path.resolve(__dirname, ".tmp-build2-checkpoints-" + Date.now());
  const originalExecute = OvernightSupervisor.prototype.executeTaskWithRecovery;

  beforeEach(() => {
    process.env.AGENT_CHECKPOINT_DIR = testCheckpointDir;
    fs.mkdirSync(testCheckpointDir, { recursive: true });

    // Mock executeTaskWithRecovery so unit test runs never touch git branches or spawn workers
    OvernightSupervisor.prototype.executeTaskWithRecovery = async function (task: TaskManifest) {
      return task;
    };
  });

  afterEach(() => {
    OvernightSupervisor.prototype.executeTaskWithRecovery = originalExecute;
    setPlanSpecGenerator(null);
    delete process.env.AGENT_CHECKPOINT_DIR;
    try {
      fs.rmSync(testCheckpointDir, { recursive: true, force: true });
    } catch {}
  });

  it("Test A: POST /api/threads action='launchTask' returns 201 immediately with status 'planning' while planner is blocked", async () => {
    let plannerStarted = false;
    let finishPlanner: (() => void) | null = null;

    const plannerPromise = new Promise<void>((resolve) => {
      finishPlanner = resolve;
    });

    setPlanSpecGenerator(async (input) => {
      plannerStarted = true;
      await plannerPromise;
      return {
        taskId: input.taskId,
        goal: input.goal,
        toolchain: input.toolchain || "node:22",
        complexity: "SINGLE_ARTIFACT",
        milestones: [
          {
            id: "M1",
            title: "Generate SVG",
            description: "Generate SVG",
            acceptanceCriteria: [],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0
          }
        ],
        toMarkdown: () => "# Spec"
      };
    });

    const req = new Request("http://localhost:3000/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "launchTask",
        goal: "Build an architectural diagram of the cluster",
        enableGitOps: false
      })
    });

    // POST must resolve quickly (under 2s) even though planner is waiting on finishPlanner
    const startTime = Date.now();
    const resPromise = threadsPost(req);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("POST /api/threads blocked on planner!")), 2500)
    );

    const res = await Promise.race([resPromise, timeoutPromise]);
    const duration = Date.now() - startTime;
    assert.ok(duration < 2000, `POST /api/threads took ${duration}ms, must return immediately before planner finishes`);
    assert.equal(res.status, 201);

    const data = await res.json();
    assert.ok(data.thread, "Response must include thread");
    assert.ok(data.task, "Response must include task manifest");
    assert.equal(data.task.status, "planning", "Task status must initially be 'planning'");

    // Verify thread on disk contains the user goal message
    const threadOnDisk = await threadStore.getThread(data.thread.id);
    assert.ok(threadOnDisk, "Thread must be persisted on disk immediately");
    const userMsg = threadOnDisk.messages.find((m) => m.role === "user");
    assert.ok(userMsg, "Thread must contain user goal message");
    assert.equal(userMsg.content, "Build an architectural diagram of the cluster");

    // Clean up background planner promise
    if (finishPlanner) (finishPlanner as () => void)();
  });

  it("Test B: Planner throws -> task transitions to 'failed', checkpoint on disk reflects 'failed', and thread has terminal assistant error message", async () => {
    setPlanSpecGenerator(async () => {
      throw new Error("Simulated planner decomposition crash");
    });

    const req = new Request("http://localhost:3000/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "launchTask",
        goal: "Goal destined to fail planning",
        enableGitOps: false
      })
    });

    const res = await threadsPost(req);
    assert.equal(res.status, 201);
    const data = await res.json();
    const taskId = data.task.taskId;
    const threadId = data.thread.id;

    // Await background failure handling (up to 3s)
    let finalTask: TaskManifest | null = null;
    const start = Date.now();
    while (Date.now() - start < 3000) {
      finalTask = await supervisor.resumeTaskFromCheckpoint(taskId);
      if (finalTask && finalTask.status === "failed") {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(finalTask, "Checkpoint must exist on disk");
    assert.equal(finalTask.status, "failed", "Task status in checkpoint must transition to 'failed'");
    assert.ok(
      finalTask.parkedReason?.includes("Simulated planner decomposition crash") ||
      finalTask.journal?.some((j) => j.message?.includes("Simulated planner decomposition crash")),
      "Parked reason or journal must record planner error"
    );

    const threadOnDisk = await threadStore.getThread(threadId);
    assert.ok(threadOnDisk, "Thread must exist on disk");
    assert.equal(threadOnDisk.status, "failed", "Thread status must transition to 'failed'");
    const lastMsg = threadOnDisk.messages[threadOnDisk.messages.length - 1];
    assert.equal(lastMsg.role, "assistant");
    assert.ok(
      lastMsg.content.includes("Simulated planner decomposition crash") || lastMsg.content.includes("Task failed"),
      `Assistant message must contain error details, got: ${lastMsg.content}`
    );
  });

  it("Test C: GET /api/tasks rehydrates and lists tasks from disk checkpoints across restarts including planning, active, parked", async () => {
    const cpDir = getCanonicalCheckpointDir();

    const t1: TaskManifest = {
      taskId: "task-test-planning-1",
      goal: "Planning task test",
      branchName: "feat/planning-1",
      toolchain: "node:22",
      status: "planning",
      currentMilestoneIndex: 0,
      milestones: [],
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      startedAt: new Date(Date.now() - 10000).toISOString(),
      updatedAt: new Date(Date.now() - 10000).toISOString()
    };

    const t2: TaskManifest = {
      taskId: "task-test-parked-2",
      goal: "Parked task test",
      branchName: "feat/parked-2",
      toolchain: "node:22",
      status: "parked",
      currentMilestoneIndex: 0,
      milestones: [],
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      startedAt: new Date(Date.now() - 20000).toISOString(),
      updatedAt: new Date(Date.now() - 5000).toISOString()
    };

    fs.writeFileSync(path.join(cpDir, `${t1.taskId}-checkpoint.json`), JSON.stringify(t1, null, 2), "utf8");
    fs.writeFileSync(path.join(cpDir, `${t2.taskId}-checkpoint.json`), JSON.stringify(t2, null, 2), "utf8");

    const req = new Request("http://localhost:3000/api/tasks");
    const res = await tasksGet(req);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(Array.isArray(data.tasks), "Response must contain 'tasks' array");
    const foundPlanning = data.tasks.find((t: any) => t.taskId === "task-test-planning-1");
    const foundParked = data.tasks.find((t: any) => t.taskId === "task-test-parked-2");

    assert.ok(foundPlanning, "Tasks list must include planning task");
    assert.equal(foundPlanning.status, "planning");
    assert.ok(foundParked, "Tasks list must include parked task");
    assert.equal(foundParked.status, "parked");
  });

  it("Test D: BuildsView component contract: accepts tasks list and renders multiple tasks", async () => {
    const buildsViewMod = await import("../components/BuildsView.js");
    assert.ok(typeof buildsViewMod.BuildsView === "function", "BuildsView component must be exported");

    const source = fs.readFileSync(path.resolve(__dirname, "../components/BuildsView.tsx"), "utf8");
    assert.ok(
      source.includes("tasks?: TaskManifest[]") || source.includes("tasks: TaskManifest[]") || source.includes("/api/tasks"),
      "BuildsView must support tasks list from props or API"
    );
  });

  it("Test E: Task builder thinking emitted in chunks exposes full thinking in checkpoint and GET /api/tasks?taskId without truncation to 180 chars", async () => {
    const longThinking = "This is a detailed step-by-step reasoning trace that exceeds the previous 180-character truncation limit. It explains architectural decisions, file mappings, test fixtures, security invariants, and edge case validations in extensive technical depth so that the user and downstream tooling can inspect the complete thought process without clipping or missing sentences.";
    assert.ok(longThinking.length > 250, "Test string must exceed 250 chars");

    const t: TaskManifest = {
      taskId: "task-test-thinking-full",
      goal: "Test thinking preservation",
      branchName: "feat/thinking-full",
      toolchain: "node:22",
      status: "active",
      builderThinking: longThinking,
      currentMilestoneIndex: 0,
      milestones: [
        {
          id: "M1",
          title: "Milestone with full thinking",
          description: "Milestone with full thinking",
          acceptanceCriteria: [],
          status: "in_progress",
          builderThinking: longThinking,
          builderIterations: 1,
          criticRounds: 0
        }
      ],
      checkpoints: [],
      ambiguityFlags: [],
      journal: [
        {
          timestamp: new Date().toISOString(),
          role: "builder",
          message: `Builder reasoning: ${longThinking}`
        }
      ],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    supervisor.saveCheckpoint(t);

    const req = new Request(`http://localhost:3000/api/tasks?taskId=${t.taskId}`);
    const res = await tasksGet(req);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(data.task, "Response must include task");
    assert.equal(data.task.builderThinking, longThinking, "Task builderThinking must match full longThinking without truncation");
    assert.equal(data.task.milestones[0].builderThinking, longThinking, "Milestone builderThinking must match full longThinking");
    const journalThinking = data.task.journal.find((j: any) => j.role === "builder" && j.message?.includes("Builder reasoning:"));
    assert.ok(journalThinking, "Journal entry for builder reasoning must exist");
    assert.ok(journalThinking.message.length > 200, "Journal reasoning message must not be truncated to 180 chars");
  });
});
