import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { POST, GET, DELETE } from "../app/api/tasks/route.js";
import { closeSharedRunLedger } from "../lib/ledger/runLedger";

describe("Phase 1 — Tasks API Route Suite", () => {
  const prevWorkspaceDir = process.env.WORKSPACE_DIR;
  const prevCheckpointDir = process.env.AGENT_CHECKPOINT_DIR;
  const prevFastGraph = process.env.FAST_GRAPH_TEST;
  let tmpRepo = "";
  let tmpCheckpoints = "";
  let createdTaskId: string;

  before(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-api-repo-"));
    tmpCheckpoints = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-api-ckpt-"));
    execFileSync("git", ["init"], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tmpRepo,
      stdio: "ignore",
    });
    fs.writeFileSync(path.join(tmpRepo, "README.md"), "# Tasks API Temp Repo\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: init"], { cwd: tmpRepo, stdio: "ignore" });

    process.env.WORKSPACE_DIR = tmpRepo;
    process.env.AGENT_CHECKPOINT_DIR = tmpCheckpoints;
    process.env.FAST_GRAPH_TEST = "1";
  });

  after(() => {
    closeSharedRunLedger();
    if (prevWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = prevWorkspaceDir;
    if (prevCheckpointDir === undefined) delete process.env.AGENT_CHECKPOINT_DIR;
    else process.env.AGENT_CHECKPOINT_DIR = prevCheckpointDir;
    if (prevFastGraph === undefined) delete process.env.FAST_GRAPH_TEST;
    else process.env.FAST_GRAPH_TEST = prevFastGraph;

    if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
    if (tmpCheckpoints) fs.rmSync(tmpCheckpoints, { recursive: true, force: true });
  });

  it("POST /api/tasks creates task manifest with SPEC.md milestones", async () => {
    const req = new Request("http://localhost:3000/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: "Build a draw.io architecture diagram of this repo's current state, README-ready",
        toolchain: "node:22",
      }),
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
      method: "DELETE",
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
      updatedAt: new Date().toISOString(),
    };

    supervisor.saveCheckpoint(
      testManifest as unknown as Parameters<typeof supervisor.saveCheckpoint>[0]
    );

    // Initial GET caches the task in tasksRegistry as "active"
    const req1 = new Request(`http://localhost:3000/api/tasks?taskId=${diskTaskId}`);
    const res1 = await GET(req1);
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.task.status, "active");

    // Outside route, task is paused on disk
    testManifest.status = "paused";
    testManifest.updatedAt = new Date().toISOString();
    supervisor.saveCheckpoint(
      testManifest as unknown as Parameters<typeof supervisor.saveCheckpoint>[0]
    );

    // If supervisor.listAllTasks() was skipped or if tasksRegistry held onto stale state,
    // let's verify resumeTaskFromCheckpoint overrides tasksRegistry cache:
    const req2 = new Request(`http://localhost:3000/api/tasks?taskId=${diskTaskId}`);
    const res2 = await GET(req2);
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.task.status, "paused");
  });
});
