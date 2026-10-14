import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { OvernightSupervisor } from "../lib/subagents/supervisor.js";
import { TaskManifest } from "../lib/subagents/types.js";
import { GET, POST } from "../app/api/deploy/route.js";
import { NextRequest } from "next/server";

describe("Sprint 7 — Ledger Deploy Flow (/api/deploy)", () => {
  it("GET /api/deploy returns selfDeployEnabled and deployHistory", async () => {
    const original = process.env.SELF_DEPLOY_ENABLED;
    process.env.SELF_DEPLOY_ENABLED = "true";

    try {
      const req = new NextRequest("http://localhost:3000/api/deploy");
      const res = await GET(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(typeof data.selfDeployEnabled, "boolean");
      assert.equal(data.selfDeployEnabled, true);
      assert.ok(Array.isArray(data.deployHistory));
    } finally {
      process.env.SELF_DEPLOY_ENABLED = original;
    }
  });

  it("POST /api/deploy toggleKillSwitch updates process.env.SELF_DEPLOY_ENABLED", async () => {
    const original = process.env.SELF_DEPLOY_ENABLED;
    process.env.SELF_DEPLOY_ENABLED = "false";

    try {
      const req = new NextRequest("http://localhost:3000/api/deploy", {
        method: "POST",
        body: JSON.stringify({ action: "toggleKillSwitch", enabled: true })
      });
      const res = await POST(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.selfDeployEnabled, true);
      assert.equal(process.env.SELF_DEPLOY_ENABLED, "true");
    } finally {
      process.env.SELF_DEPLOY_ENABLED = original;
    }
  });

  it("POST /api/deploy deployBuild updates task checkpoint with deploymentUrl and deploymentNamespace", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-checkpoint-test-"));
    const supervisor = new OvernightSupervisor({ checkpointDirectory: tmpDir });

    const task: TaskManifest = {
      taskId: "task-deploy-verify-1",
      goal: "Test deploy preview endpoint",
      toolchain: "node:22",
      branchName: "feat/deploy-test",
      status: "completed",
      currentMilestoneIndex: 1,
      milestones: [
        {
          id: "M1",
          title: "Setup preview",
          description: "Initialize test preview artifact",
          status: "completed",
          builderIterations: 1,
          criticRounds: 1,
          acceptanceCriteria: []
        }
      ],
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };

    supervisor.saveCheckpoint(task);

    const originalCheckDir = process.env.CHECKPOINT_DIR;
    process.env.CHECKPOINT_DIR = tmpDir;

    try {
      const req = new NextRequest("http://localhost:3000/api/deploy", {
        method: "POST",
        body: JSON.stringify({
          action: "deployBuild",
          taskId: task.taskId,
          threadId: "t-1",
          dryRunUrl: "http://localhost:30123",
          dryRunNamespace: "build-test0001"
        })
      });

      const res = await POST(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.deploymentUrl, "http://localhost:30123");
      assert.equal(data.deploymentNamespace, "build-test0001");

      const checkpointFile = supervisor.getCheckpointFilePath(task.taskId);
      const updated = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
      assert.equal(updated.deploymentUrl, "http://localhost:30123");
      assert.equal(updated.deploymentNamespace, "build-test0001");
    } finally {
      process.env.CHECKPOINT_DIR = originalCheckDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
