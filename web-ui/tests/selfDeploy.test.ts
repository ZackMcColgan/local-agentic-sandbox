import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

describe("Sprint 12 Phase 10 — Self-Deploy Pipeline (selfDeploy.test.ts)", () => {
  it("Self-deploy rebuilds image, deploys with rolling update, verifies health, and logs all fields", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-deploy-test-"));
    const dbPath = path.join(tmpDir, "runs.db");

    try {
      const { SelfDeployPipeline } = await import("../lib/deploy/selfDeploy.js");
      const { RunLedger } = await import("../lib/ledger/runLedger.js");

      const ledger = new RunLedger(dbPath);
      const executedCommands: string[] = [];

      const pipeline = new SelfDeployPipeline({
        enabled: true,
        ledger,
        commandRunner: async (cmd: string) => {
          executedCommands.push(cmd);
          return { exitCode: 0, stdout: "ok\n", stderr: "" };
        },
        healthChecker: async () => ({ status: 200, ok: true })
      });

      const result = await pipeline.executeSelfDeploy({
        branchName: "feature/self-deploy",
        previousSha: "sha-prev-001",
        newSha: "sha-new-002",
        deploymentName: "web-ui",
        namespace: "local-agentic-sandbox"
      });

      assert.equal(result.status, "deployed");
      assert.equal(result.rollbackStatus, "none");
      assert.equal(result.previousSha, "sha-prev-001");
      assert.equal(result.newSha, "sha-new-002");
      assert.equal(result.healthCheckResult.ok, true);
      assert.ok(result.timeline.some((t) => t.stage === "rebuild_image" && t.status === "completed"));
      assert.ok(result.timeline.some((t) => t.stage === "rolling_update" && t.status === "completed"));
      assert.ok(result.timeline.some((t) => t.stage === "health_check" && t.status === "completed"));

      // Verify log history in pipeline
      const history = pipeline.getDeployHistory();
      assert.equal(history.length, 1);
      assert.equal(history[0].newSha, "sha-new-002");
      assert.equal(history[0].rollbackStatus, "none");

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Failed health check triggers automatic rollback to previous image and logs LOUD rollback status", async () => {
    const { SelfDeployPipeline } = await import("../lib/deploy/selfDeploy.js");
    const executedCommands: string[] = [];

    const pipeline = new SelfDeployPipeline({
      enabled: true,
      commandRunner: async (cmd: string) => {
        executedCommands.push(cmd);
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
      healthChecker: async () => ({ status: 503, ok: false })
    });

    const result = await pipeline.executeSelfDeploy({
      branchName: "feature/unhealthy-change",
      previousSha: "sha-good-111",
      newSha: "sha-bad-222",
      deploymentName: "web-ui",
      namespace: "local-agentic-sandbox"
    });

    assert.equal(result.status, "rolled_back");
    assert.equal(result.rollbackStatus, "rolled_back");
    assert.equal(result.healthCheckResult.ok, false);
    assert.ok(result.errorMessage?.includes("Health check failed"));
    assert.ok(
      executedCommands.some((c) => c.includes("rollout undo")),
      "Must trigger kubectl rollout undo on health failure"
    );
  });

  it("Kill switch OFF strictly blocks self-deploy", async () => {
    const { SelfDeployPipeline } = await import("../lib/deploy/selfDeploy.js");

    const pipeline = new SelfDeployPipeline({ enabled: false });

    await assert.rejects(
      async () => {
        await pipeline.executeSelfDeploy({
          branchName: "feature/feature-x",
          previousSha: "sha-1",
          newSha: "sha-2"
        });
      },
      /Self-deploy is disabled by kill switch/i,
      "Must block when kill switch is off"
    );
  });

  it("Self-deploy from main is strictly blocked", async () => {
    const { SelfDeployPipeline } = await import("../lib/deploy/selfDeploy.js");

    const pipeline = new SelfDeployPipeline({ enabled: true });

    await assert.rejects(
      async () => {
        await pipeline.executeSelfDeploy({
          branchName: "main",
          previousSha: "sha-1",
          newSha: "sha-2"
        });
      },
      /Self-deploy directly from main is strictly blocked/i,
      "Must block self-deploy from main"
    );
  });

  it("SettingsView renders Kill Switch toggle (default OFF) and Deploy History with LOUD rollback alert", async () => {
    const { SettingsView } = await import("../components/SettingsView.js");

    const html = renderToStaticMarkup(
      React.createElement(SettingsView, {
        onClose: () => {},
        theme: "light",
        onThemeChange: () => {},
        models: ["swift-27b-mtp"],
        defaultModel: "swift-27b-mtp",
        onDefaultModelChange: () => {},
        reasoningEffort: "medium",
        onReasoningEffortChange: () => {},
        selfDeployEnabled: false,
        onToggleSelfDeploy: () => {},
        deployHistory: [
          {
            deployId: "dep-101",
            timestamp: new Date().toISOString(),
            branchName: "feature/bad-build",
            previousSha: "sha-111",
            newSha: "sha-222",
            status: "rolled_back",
            rollbackStatus: "rolled_back",
            healthCheckStatus: 503,
            errorMessage: "HTTP 503 CrashLoopBackOff"
          }
        ]
      })
    );

    assert.ok(html.includes("Self-Deploy Pipeline"), "Must render Self-Deploy Pipeline heading");
    assert.ok(html.includes("Kill switch"), "Must mention kill switch");
    assert.ok(html.includes("ROLLED BACK"), "Must show LOUD rollback alert in deploy history");
    assert.ok(html.includes("HTTP 503 CrashLoopBackOff"), "Must render failure error message");
  });
});
