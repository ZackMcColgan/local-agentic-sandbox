import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/threads/[id]/route";
import { OvernightSupervisor } from "../lib/subagents/supervisor";
import { ThreadStore } from "../lib/threads/threadStore";
import { TaskManifest } from "../lib/subagents/types";

describe("Fix 2.1 & 2.2: POST /api/threads/[id] resume & restart triggers executeTaskWithRecovery", () => {
  it("Fix 2.1: resume calls executeTaskWithRecovery in background", async () => {
    let executeCalled = false;
    let receivedTaskId = "";

    const originalExecute = OvernightSupervisor.prototype.executeTaskWithRecovery;
    OvernightSupervisor.prototype.executeTaskWithRecovery = async function(task: TaskManifest, options?: any) {
      executeCalled = true;
      receivedTaskId = task.taskId;
      return task;
    };

    const threadStore = new ThreadStore();
    const supervisor = new OvernightSupervisor();
    const taskId = `task-resume-test-${Date.now()}`;
    const manifest: TaskManifest = {
      taskId,
      goal: "Test resume execution trigger",
      branchName: "feat/test",
      toolchain: "node:22",
      status: "paused",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentMilestoneIndex: 0,
      milestones: [{ id: "M1", title: "M1", status: "pending", description: "M1", acceptanceCriteria: [], builderIterations: 0, criticRounds: 0 }],
      checkpoints: [],
      ambiguityFlags: [],
      journal: []
    };
    supervisor.saveCheckpoint(manifest);

    const thread = threadStore.createThread({
      title: "Test Resume Thread",
      model: "swift-27b-mtp",
      taskId
    });

    try {
      const req = new Request(`http://localhost:3000/api/threads/${thread.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume" })
      });

      const res = await POST(req, { params: Promise.resolve({ id: thread.id }) });
      assert.equal(res.status, 200);

      const start = Date.now();
      while (!executeCalled && Date.now() - start < 1500) {
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(executeCalled, "executeTaskWithRecovery must be invoked on resume");
      assert.equal(receivedTaskId, taskId);
    } finally {
      OvernightSupervisor.prototype.executeTaskWithRecovery = originalExecute;
    }
  });

  it("Fix 2.2: restart calls executeTaskWithRecovery in background", async () => {
    let executeCalled = false;
    let receivedTaskId = "";

    const originalExecute = OvernightSupervisor.prototype.executeTaskWithRecovery;
    OvernightSupervisor.prototype.executeTaskWithRecovery = async function(task: TaskManifest, options?: any) {
      executeCalled = true;
      receivedTaskId = task.taskId;
      return task;
    };

    const threadStore = new ThreadStore();
    const supervisor = new OvernightSupervisor();
    const taskId = `task-restart-test-${Date.now()}`;
    const manifest: TaskManifest = {
      taskId,
      goal: "Test restart execution trigger",
      branchName: "feat/test",
      toolchain: "node:22",
      status: "completed",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentMilestoneIndex: 1,
      milestones: [{ id: "M1", title: "M1", status: "completed", description: "M1", acceptanceCriteria: [], builderIterations: 1, criticRounds: 1 }],
      checkpoints: [],
      ambiguityFlags: [],
      journal: []
    };
    supervisor.saveCheckpoint(manifest);

    const thread = threadStore.createThread({
      title: "Test Restart Thread",
      model: "swift-27b-mtp",
      taskId
    });

    try {
      const req = new Request(`http://localhost:3000/api/threads/${thread.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart" })
      });

      const res = await POST(req, { params: Promise.resolve({ id: thread.id }) });
      assert.equal(res.status, 200);

      const start = Date.now();
      while (!executeCalled && Date.now() - start < 1500) {
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(executeCalled, "executeTaskWithRecovery must be invoked on restart");
      assert.notEqual(receivedTaskId, taskId, "Restart must create a new taskId");
    } finally {
      OvernightSupervisor.prototype.executeTaskWithRecovery = originalExecute;
    }
  });
});
