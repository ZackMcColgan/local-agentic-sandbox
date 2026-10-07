import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/threads/route";
import { OvernightSupervisor } from "../lib/subagents/supervisor";
import { TaskManifest } from "../lib/subagents/types";

// Weather SVG scenario behavioral test suite for threads launchTask
// Regression test for 2026-10-06 bug: tasks were created and planned but
// executeTaskWithRecovery was never called, so no workers ever spawned.
describe("Threads API — launchTask Behavioral Test Suite (Weather SVG Scenario)", () => {
  it("Case 1: POST /api/threads triggers execution and calls executeTaskWithRecovery with manifest", async () => {
    let executeCalled = false;
    let receivedManifest: TaskManifest | null = null;

    const originalExecute = OvernightSupervisor.prototype.executeTaskWithRecovery;
    OvernightSupervisor.prototype.executeTaskWithRecovery = async function(task: TaskManifest, options?: any) {
      executeCalled = true;
      receivedManifest = task;
      return task;
    };

    try {
      const req = new Request("http://localhost:3000/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Create a svg of the weather tomorrow",
          action: "launchTask"
        })
      });

      const res = await POST(req);
      assert.ok(res.status === 200 || res.status === 201, `Expected 200/201 but got ${res.status}`);
      const data = await res.json();
      assert.ok(data.taskId || (data.task && data.task.taskId), "Response must include a task ID");

      // Give fire-and-forget a moment to trigger (within 10s budget)
      const startTime = Date.now();
      while (!executeCalled && Date.now() - startTime < 10000) {
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(executeCalled, "executeTaskWithRecovery must be called within 10s");
      assert.ok(receivedManifest !== null, "executeTaskWithRecovery must receive a generated manifest");
      assert.ok(Array.isArray(receivedManifest.milestones) && receivedManifest.milestones.length > 0, "Manifest must contain planned milestones");
    } finally {
      OvernightSupervisor.prototype.executeTaskWithRecovery = originalExecute;
    }
  });

  it("Case 2: Milestones progress (M1 leaves pending, builderIterations > 0)", async () => {
    const supervisor = new OvernightSupervisor();
    const manifest: TaskManifest = {
      taskId: `test-weather-progress-${Date.now()}`,
      goal: "Create a svg of the weather tomorrow",
      toolchain: "node:22",
      status: "active",
      currentMilestoneIndex: 0,
      milestones: [
        {
          id: "M1",
          title: "Scaffold weather SVG component",
          dependencies: [],
          acceptanceCriteria: [{ id: "c1", assertion: "SVG layout defined" }],
          status: "pending"
        },
        {
          id: "M2",
          title: "Render dynamic sun and cloud elements",
          dependencies: ["M1"],
          acceptanceCriteria: [{ id: "c2", assertion: "Weather glyphs present" }],
          status: "pending"
        },
        {
          id: "M3",
          title: "Style SVG with forecast metadata text",
          dependencies: ["M2"],
          acceptanceCriteria: [{ id: "c3", assertion: "Forecast metadata included" }],
          status: "pending"
        }
      ],
      checkpoints: [],
      ambiguityFlags: [],
      journal: []
    };

    supervisor.saveCheckpoint(manifest);

    const mockExecutor = async (milestone: any, attempt: number) => {
      return {
        status: "completed" as const,
        gitSha: "c0ffee1",
        diff: "+ <svg class=\"weather\">weather forecast</svg>",
        diffSummary: "Added weather SVG component",
        builderIterations: 1,
        criticRounds: 1,
        builderModel: "swift-27b-mtp"
      };
    };

    const completedTask = await supervisor.executeTaskWithRecovery(manifest, { stepExecutor: mockExecutor });

    assert.equal(completedTask.milestones[0].status, "completed", "M1 must leave pending and transition to completed");
    assert.ok((completedTask.milestones[0].builderIterations ?? 0) > 0, "M1 builderIterations must be > 0");
  });

  it("Case 3: Does not stall with all milestones pending and zero builder iterations", async () => {
    const supervisor = new OvernightSupervisor();
    const manifest: TaskManifest = {
      taskId: `test-weather-nostall-${Date.now()}`,
      goal: "Create a svg of the weather tomorrow",
      toolchain: "node:22",
      status: "active",
      currentMilestoneIndex: 0,
      milestones: [
        {
          id: "M1",
          title: "Create weather SVG markup",
          dependencies: [],
          acceptanceCriteria: [{ id: "c1", assertion: "SVG exists" }],
          status: "pending"
        }
      ],
      checkpoints: [],
      ambiguityFlags: [],
      journal: []
    };

    supervisor.saveCheckpoint(manifest);

    const mockExecutor = async (milestone: any, attempt: number) => {
      return {
        status: "completed" as const,
        gitSha: "f00d123",
        diff: "+ <svg>weather</svg>",
        diffSummary: "Created weather SVG",
        builderIterations: 2,
        criticRounds: 1
      };
    };

    const result = await supervisor.executeTaskWithRecovery(manifest, { stepExecutor: mockExecutor });

    const allPending = result.milestones.every((m) => m.status === "pending");
    const zeroIterations = result.milestones.every((m) => (m.builderIterations ?? 0) === 0);

    assert.ok(!allPending, "Task must not remain with all milestones pending");
    assert.ok(!zeroIterations, "Task must not have zero builder iterations");
  });

  it("Case 4: Executor failure parks the task with ambiguity flag set", async () => {
    const supervisor = new OvernightSupervisor();
    const manifest: TaskManifest = {
      taskId: `test-weather-park-${Date.now()}`,
      goal: "Create a svg of the weather tomorrow",
      toolchain: "node:22",
      status: "active",
      currentMilestoneIndex: 0,
      milestones: [
        {
          id: "M1",
          title: "Scaffold weather SVG",
          dependencies: [],
          acceptanceCriteria: [{ id: "c1", assertion: "SVG canvas defined" }],
          status: "pending"
        }
      ],
      checkpoints: [],
      ambiguityFlags: [],
      journal: []
    };

    supervisor.saveCheckpoint(manifest);

    const failingExecutor = async (milestone: any, attempt: number) => {
      throw new Error("Unrecoverable worker execution failure");
    };

    const parkedTask = await supervisor.executeTaskWithRecovery(manifest, { stepExecutor: failingExecutor });

    assert.equal(parkedTask.status, "parked", "Task must transition to parked on repeated failures");
    assert.ok(parkedTask.parkedReason && parkedTask.parkedReason.includes("M1"), "Parked reason must identify failing milestone");
    assert.ok(parkedTask.ambiguityFlags.length > 0, "Ambiguity flag must be recorded for human review");
    assert.equal(parkedTask.ambiguityFlags[0].milestoneId, "M1");
  });
});
