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

  describe("Sprint U4 — Real Deploy Status Wiring & BuildsView Hub Suite", () => {
    it("POST /api/deploy deployBuild without dryRunUrl does NOT use fake charCode hash port (30100 + hash)", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-nohash-test-"));
      const supervisor = new OvernightSupervisor({ checkpointDirectory: tmpDir });

      const task: TaskManifest = {
        taskId: "task-nohash-1",
        goal: "No hash deploy",
        toolchain: "node:22",
        branchName: "feat/nohash",
        status: "completed",
        currentMilestoneIndex: 0,
        milestones: [],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      supervisor.saveCheckpoint(task);
      const originalCheckDir = process.env.CHECKPOINT_DIR;
      process.env.CHECKPOINT_DIR = tmpDir;

      try {
        const req = new NextRequest("http://localhost:3000/api/deploy", {
          method: "POST",
          body: JSON.stringify({
            action: "deployBuild",
            taskId: task.taskId
          })
        });

        const res = await POST(req);
        assert.equal(res.status, 200);
        const data = await res.json();
        // Must NOT match fake 30100+ port pattern or 192.168.50.254 fake IP
        assert.ok(!data.deploymentUrl.includes("192.168.50.254"), "Must not use hardcoded fake IP 192.168.50.254");
        assert.ok(!data.deploymentUrl.match(/:30[1-9]\d{2}/), "Must not use fake charCode hash port");
      } finally {
        process.env.CHECKPOINT_DIR = originalCheckDir;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("BuildsView renders SelfDeployPipeline card matching Mockup 04", async () => {
      const { BuildsView } = await import("../components/BuildsView.js");
      const React = (await import("react")).default;
      const { renderToString } = await import("react-dom/server");
      const { Window } = await import("happy-dom");

      const html = renderToString(
        React.createElement(BuildsView, {
          onOpenDrawer: () => {},
          activeTask: null,
          onSelectThread: () => {}
        })
      );

      const window = new Window();
      window.document.body.innerHTML = html;

      assert.ok(html.includes("Self-Deploy Pipeline"), "Must render Self-Deploy Pipeline card");
      assert.ok(html.includes("Rollback"), "Must render rollback button");
      assert.ok(
        window.document.body.textContent?.includes("Merge to `develop` & Deploy") ||
        html.includes("Merge to `develop` &amp; Deploy") ||
        html.includes("Merge to `develop` & Deploy"),
        "Must render 1-click merge to develop & deploy button"
      );
      assert.ok(html.includes("Isolated Branch"), "Must render Isolated Branch pipeline step");
      assert.ok(html.includes("Pre-Deploy Gate"), "Must render Pre-Deploy Gate pipeline step");
    });
  });
});
