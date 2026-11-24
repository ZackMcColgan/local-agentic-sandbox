import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
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

  it("POST /api/deploy toggleKillSwitch updates process.env.SELF_DEPLOY_ENABLED for same-origin requests", async () => {
    const original = process.env.SELF_DEPLOY_ENABLED;
    process.env.SELF_DEPLOY_ENABLED = "false";

    try {
      const req = new NextRequest("http://localhost:3000/api/deploy", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ action: "toggleKillSwitch", enabled: true }),
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

  it("POST /api/deploy toggleKillSwitch rejects cross-origin and missing-origin requests with 403 without changing state", async () => {
    const original = process.env.SELF_DEPLOY_ENABLED;
    process.env.SELF_DEPLOY_ENABLED = "false";

    try {
      // Cross-origin Origin header
      const crossOriginReq = new NextRequest("http://localhost:3000/api/deploy", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://evil.example.com",
        },
        body: JSON.stringify({ action: "toggleKillSwitch", enabled: true }),
      });
      const crossRes = await POST(crossOriginReq);
      assert.equal(crossRes.status, 403);
      assert.equal(process.env.SELF_DEPLOY_ENABLED, "false");

      // Missing Origin and Referer headers
      const noOriginReq = new NextRequest("http://localhost:3000/api/deploy", {
        method: "POST",
        headers: {
          host: "localhost:3000",
        },
        body: JSON.stringify({ action: "toggleKillSwitch", enabled: true }),
      });
      const noOriginRes = await POST(noOriginReq);
      assert.equal(noOriginRes.status, 403);
      assert.equal(process.env.SELF_DEPLOY_ENABLED, "false");

      // Same-origin Referer fallback works when Origin is absent
      const refererReq = new NextRequest("http://localhost:3000/api/deploy", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          referer: "http://localhost:3000/settings",
        },
        body: JSON.stringify({ action: "toggleKillSwitch", enabled: true }),
      });
      const refererRes = await POST(refererReq);
      assert.equal(refererRes.status, 200);
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
          acceptanceCriteria: [],
        },
      ],
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    supervisor.saveCheckpoint(task);

    const originalCheckDir = process.env.CHECKPOINT_DIR;
    process.env.CHECKPOINT_DIR = tmpDir;

    const healthyServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => healthyServer.listen(0, "127.0.0.1", resolve));
    const healthyAddr = healthyServer.address();
    assert.ok(healthyAddr && typeof healthyAddr === "object");
    const healthyUrl = `http://127.0.0.1:${healthyAddr.port}`;

    try {
      const req = new NextRequest("http://localhost:3000/api/deploy", {
        method: "POST",
        body: JSON.stringify({
          action: "deployBuild",
          taskId: task.taskId,
          threadId: "t-1",
          dryRunUrl: healthyUrl,
          dryRunNamespace: "build-test0001",
        }),
      });

      const res = await POST(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.deployStatus, "deployed");
      assert.equal(data.healthStatus, 200);
      assert.equal(data.deploymentUrl, healthyUrl);
      assert.equal(data.deploymentNamespace, "build-test0001");

      const checkpointFile = supervisor.getCheckpointFilePath(task.taskId);
      const updated = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
      assert.equal(updated.deploymentUrl, healthyUrl);
      assert.equal(updated.deploymentNamespace, "build-test0001");
    } finally {
      await new Promise<void>((resolve) => healthyServer.close(() => resolve()));
      process.env.CHECKPOINT_DIR = originalCheckDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("POST /api/deploy deployBuild honestly reports failure when preview endpoint is unhealthy or unreachable", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-honest-fail-"));
    const supervisor = new OvernightSupervisor({ checkpointDirectory: tmpDir });

    const task: TaskManifest = {
      taskId: "task-deploy-fail-1",
      goal: "Test honest deploy failure reporting",
      toolchain: "node:22",
      branchName: "feat/deploy-fail",
      status: "completed",
      currentMilestoneIndex: 1,
      milestones: [],
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    supervisor.saveCheckpoint(task);

    const originalCheckDir = process.env.CHECKPOINT_DIR;
    process.env.CHECKPOINT_DIR = tmpDir;

    // 1. Unhealthy preview server returning HTTP 503
    const unhealthyServer = http.createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("Service Unavailable");
    });
    await new Promise<void>((resolve) => unhealthyServer.listen(0, "127.0.0.1", resolve));
    const unhealthyAddr = unhealthyServer.address();
    assert.ok(unhealthyAddr && typeof unhealthyAddr === "object");
    const unhealthyUrl = `http://127.0.0.1:${unhealthyAddr.port}`;

    // 2. Closed port (unreachable preview endpoint)
    const tempServer = http.createServer();
    await new Promise<void>((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
    const closedAddr = tempServer.address();
    assert.ok(closedAddr && typeof closedAddr === "object");
    const closedPort = closedAddr.port;
    await new Promise<void>((resolve) => tempServer.close(() => resolve()));
    const unreachableUrl = `http://127.0.0.1:${closedPort}`;

    try {
      const res503 = await POST(
        new NextRequest("http://localhost:3000/api/deploy", {
          method: "POST",
          body: JSON.stringify({
            action: "deployBuild",
            taskId: task.taskId,
            dryRunUrl: unhealthyUrl,
            dryRunNamespace: "build-fail503",
          }),
        })
      );
      assert.equal(res503.status, 502, "Unhealthy deploy preview must return HTTP 502");
      const data503 = await res503.json();
      assert.equal(data503.success, false, "Unhealthy deploy preview must report success: false");
      assert.equal(
        data503.deployStatus,
        "failed",
        "Unhealthy deploy preview must report deployStatus: 'failed'"
      );
      assert.equal(data503.healthStatus, 503);
      assert.ok(data503.error, "Failure response must include an error message");

      const checkpointAfter503 = JSON.parse(
        fs.readFileSync(supervisor.getCheckpointFilePath(task.taskId), "utf8")
      );
      assert.equal(
        checkpointAfter503.deploymentUrl,
        undefined,
        "Failed deploy must not record a fake deploymentUrl in task checkpoint"
      );

      const resUnreachable = await POST(
        new NextRequest("http://localhost:3000/api/deploy", {
          method: "POST",
          body: JSON.stringify({
            action: "deployBuild",
            taskId: task.taskId,
            dryRunUrl: unreachableUrl,
            dryRunNamespace: "build-unreachable",
          }),
        })
      );
      assert.equal(resUnreachable.status, 502, "Unreachable deploy preview must return HTTP 502");
      const dataUnreachable = await resUnreachable.json();
      assert.equal(
        dataUnreachable.success,
        false,
        "Unreachable deploy preview must report success: false"
      );
      assert.equal(dataUnreachable.deployStatus, "failed");
      assert.ok(dataUnreachable.error);
    } finally {
      await new Promise<void>((resolve) => unhealthyServer.close(() => resolve()));
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
        updatedAt: new Date().toISOString(),
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
          }),
        });

        const res = await POST(req);
        assert.ok(
          res.status === 200 || res.status === 502,
          `Expected 200 (if preview live) or 502 (if preview unreachable), got ${res.status}`
        );
        const data = await res.json();
        if (res.status === 502) {
          assert.equal(data.success, false);
          assert.equal(data.deployStatus, "failed");
        }
        // Must NOT match fake 30100+ port pattern or 192.168.50.254 fake IP
        assert.ok(
          !data.deploymentUrl.includes("192.168.50.254"),
          "Must not use hardcoded fake IP 192.168.50.254"
        );
        assert.ok(
          !data.deploymentUrl.match(/:30[1-9]\d{2}/),
          "Must not use fake charCode hash port"
        );
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
          onSelectThread: () => {},
        })
      );

      const window = new Window();
      window.document.body.innerHTML = html;

      assert.ok(html.includes("Self-Deploy Pipeline"), "Must render Self-Deploy Pipeline card");
      assert.ok(html.includes("Rollback"), "Must render rollback button");
      assert.ok(
        window.document.body.textContent?.includes("Merge to develop & Deploy") ||
          window.document.body.textContent?.includes("Merge to `develop` & Deploy"),
        "Must render 1-click merge to develop & deploy button"
      );
      assert.ok(html.includes("Isolated Branch"), "Must render Isolated Branch pipeline step");
      assert.ok(html.includes("Pre-Deploy Gate"), "Must render Pre-Deploy Gate pipeline step");
    });
  });
});
