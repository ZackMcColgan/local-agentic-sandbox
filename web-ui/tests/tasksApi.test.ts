import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { POST, GET, DELETE } from "../app/api/tasks/route.js";

describe("Phase 1 — Tasks API Route Suite", () => {
  process.env.FAST_GRAPH_TEST = "1";
  let createdTaskId: string;

  it("POST /api/tasks creates task manifest with SPEC.md milestones", async () => {
    const req = new Request("http://localhost:3000/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: "Build a draw.io architecture diagram of this repo's current state, README-ready",
        toolchain: "node:22"
      })
    });

    const res = await POST(req);
    assert.equal(res.status, 201);
    const data = await res.json();

    assert.ok(data.taskId);
    createdTaskId = data.taskId;
    assert.equal(data.manifest.goal.includes("draw.io architecture diagram"), true);
    assert.ok(data.manifest.milestones.length >= 3);
    assert.equal(data.manifest.toolchain, "node:22");
  });

  it("GET /api/tasks retrieves task status, journal, and checkpoints", async () => {
    const req = new Request(`http://localhost:3000/api/tasks?taskId=${createdTaskId}`);
    const res = await GET(req);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.task.taskId, createdTaskId);
    assert.ok(Array.isArray(data.task.milestones));
    assert.ok(Array.isArray(data.task.journal));
  });

  it("DELETE /api/tasks triggers cancellation token and marks status cancelled", async () => {
    const req = new Request(`http://localhost:3000/api/tasks?taskId=${createdTaskId}`, {
      method: "DELETE"
    });
    const res = await DELETE(req);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.status, "cancelled");
    assert.equal(data.activeWorkers, 0);

    // Verify subsequent GET reflects cancelled state
    const verifyReq = new Request(`http://localhost:3000/api/tasks?taskId=${createdTaskId}`);
    const verifyRes = await GET(verifyReq);
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.task.status, "cancelled");
  });

  it("GET /api/tasks?taskId=<id> returns latest disk state when task transitions to paused on disk", async () => {
    const { OvernightSupervisor } = await import("../lib/subagents/supervisor.js");
    const supervisor = new OvernightSupervisor();

    const diskTaskId = `task-disk-refresh-${Date.now()}`;
    const testManifest = {
      taskId: diskTaskId,
      goal: "Test disk refresh",
      branchName: "feat/test",
      toolchain: "node:22",
      status: "active",
      milestones: [{ id: "M1", title: "Milestone 1", status: "pending" }],
      currentMilestoneIndex: 0,
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    supervisor.saveCheckpoint(testManifest as any);

    // Initial GET caches the task in tasksRegistry as "active"
    const req1 = new Request(`http://localhost:3000/api/tasks?taskId=${diskTaskId}`);
    const res1 = await GET(req1);
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.task.status, "active");

    // Outside route, task is paused on disk
    testManifest.status = "paused";
    testManifest.updatedAt = new Date().toISOString();
    supervisor.saveCheckpoint(testManifest as any);

    // If supervisor.listAllTasks() was skipped or if tasksRegistry held onto stale state,
    // let's verify resumeTaskFromCheckpoint overrides tasksRegistry cache:
    const req2 = new Request(`http://localhost:3000/api/tasks?taskId=${diskTaskId}`);
    const res2 = await GET(req2);
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.task.status, "paused");
  });
});


