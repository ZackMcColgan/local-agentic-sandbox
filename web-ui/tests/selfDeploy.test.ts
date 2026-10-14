import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

describe("Sprint 12 Phase 10 — Self-Deploy Pipeline (selfDeploy.test.ts)", () => {
  it("Self-deploy rebuilds image from repo root, deploys with rolling update, verifies health, and logs all fields", async () => {
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
        commandRunner: async (file: string, args: string[]) => {
          executedCommands.push([file, ...args].join(" "));
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

      // Verify default image name format: local-agentic-sandbox-web-ui:<shortSha>
      const setImageCmd = executedCommands.find((c) => c.includes("set image"));
      assert.ok(setImageCmd, "Must run kubectl set image");
      assert.ok(
        setImageCmd.includes(`web-ui=local-agentic-sandbox-web-ui:${"sha-new-002".slice(0, 8)}`),
        `Expected image local-agentic-sandbox-web-ui:sha-new- but got: ${setImageCmd}`
      );

      // Verify rollout status wait command executed
      const rolloutStatusCmd = executedCommands.find((c) => c.includes("rollout status"));
      assert.ok(rolloutStatusCmd, "Must run kubectl rollout status");
      assert.ok(
        rolloutStatusCmd.includes("rollout status deployment/web-ui --timeout=90s"),
        `Expected rollout status with --timeout=90s, got: ${rolloutStatusCmd}`
      );

      // Fix 7.2: Verify build command executed with Dockerfile from repo root
      const buildCmd = executedCommands.find((c) => c.startsWith("docker build"));
      assert.ok(buildCmd, "Must run docker build");
      assert.ok(buildCmd.includes("-f web-ui/Dockerfile"), "Must specify explicit Dockerfile path");
      assert.ok(buildCmd.endsWith("."), "Must build from repo root context");

      // Fix 7.5: Verify SQLite log history in pipeline
      const history = pipeline.getDeployHistory();
      assert.equal(history.length, 1);
      assert.equal(history[0].newSha, "sha-new-002");
      assert.equal(history[0].rollbackStatus, "none");
      assert.equal(history[0].status, "deployed");

      ledger.close();
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignored on Windows EBUSY
      }
    }
  });

  it("Rollout status failure triggers automatic rollback and returns rolled_back", async () => {
    const { SelfDeployPipeline } = await import("../lib/deploy/selfDeploy.js");
    const executedCommands: string[] = [];

    const pipeline = new SelfDeployPipeline({
      enabled: true,
      commandRunner: async (file: string, args: string[]) => {
        const fullCmd = [file, ...args].join(" ");
        executedCommands.push(fullCmd);
        if (fullCmd.includes("rollout status")) {
          return { exitCode: 1, stdout: "", stderr: "error: deployment timed out\n" };
        }
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
      healthChecker: async () => ({ status: 200, ok: true })
    });

    const result = await pipeline.executeSelfDeploy({
      branchName: "feature/rollout-timeout",
      previousSha: "sha-prev-111",
      newSha: "sha-new-222",
      deploymentName: "web-ui",
      namespace: "local-agentic-sandbox"
    });

    assert.equal(result.status, "rolled_back");
    assert.equal(result.rollbackStatus, "rolled_back");
    assert.ok(
      executedCommands.some((c) => c.includes("rollout undo")),
      "Must trigger kubectl rollout undo when rollout status fails"
    );
  });

  it("Failed health check triggers automatic rollback to previous image and verifies rollback health", async () => {
    const { SelfDeployPipeline } = await import("../lib/deploy/selfDeploy.js");
    const executedCommands: string[] = [];

    let healthCallCount = 0;
    const pipeline = new SelfDeployPipeline({
      enabled: true,
      commandRunner: async (file: string, args: string[]) => {
        executedCommands.push([file, ...args].join(" "));
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
      healthChecker: async () => {
        healthCallCount++;
        // First check (new deploy): fails 503
        // Second check (after rollback): succeeds 200
        return healthCallCount === 1
          ? { status: 503, ok: false }
          : { status: 200, ok: true };
      }
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
    assert.equal(healthCallCount, 2, "Must run health check again to verify rollback");
    assert.ok(
      executedCommands.some((c) => c.includes("rollout undo")),
      "Must trigger kubectl rollout undo on health failure"
    );
  });

  it("Fix 7.4: Failed rollback health check records status: rollback_failed as critical alert", async () => {
    const { SelfDeployPipeline } = await import("../lib/deploy/selfDeploy.js");

    const pipeline = new SelfDeployPipeline({
      enabled: true,
      commandRunner: async (file: string, args: string[]) => ({
        exitCode: 0,
        stdout: "ok\n",
        stderr: ""
      }),
      // Both initial check and rollback check fail
      healthChecker: async () => ({ status: 503, ok: false })
    });

    const result = await pipeline.executeSelfDeploy({
      branchName: "feature/critical-failure",
      previousSha: "sha-good",
      newSha: "sha-broken"
    });

    assert.equal(result.status, "rollback_failed");
    assert.equal(result.rollbackStatus, "failed");
    assert.ok(result.errorMessage?.includes("CRITICAL: Deployment rolled back but health check still failing"));
  });

  it("Fix 7.1: Rejects command injection in namespace or deploymentName and prevents command execution", async () => {
    const { SelfDeployPipeline } = await import("../lib/deploy/selfDeploy.js");
    let commandsRan = 0;

    const pipeline = new SelfDeployPipeline({
      enabled: true,
      commandRunner: async () => {
        commandsRan++;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });

    // Malicious namespace
    await assert.rejects(
      async () => {
        await pipeline.executeSelfDeploy({
          branchName: "feature/test-inject",
          previousSha: "sha1",
          newSha: "sha2",
          namespace: "evil; rm -rf /"
        });
      },
      /Invalid Kubernetes namespace/i,
      "Must reject malicious namespace string"
    );

    // Malicious deploymentName
    await assert.rejects(
      async () => {
        await pipeline.executeSelfDeploy({
          branchName: "feature/test-inject",
          previousSha: "sha1",
          newSha: "sha2",
          deploymentName: "deploy$(touch /tmp/pwned)"
        });
      },
      /Invalid Kubernetes deployment/i,
      "Must reject malicious deploymentName string"
    );

    assert.equal(commandsRan, 0, "No commands must be executed when validation fails");
  });

  it("Fix 7.1: Command injection payload in newSha is passed literally without shell execution", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-deploy-inject-"));
    const pwnedFile = path.join(tmpDir, "pwned.txt");

    try {
      const { SelfDeployPipeline } = await import("../lib/deploy/selfDeploy.js");
      const executedArgs: { file: string; args: string[] }[] = [];

      const pipeline = new SelfDeployPipeline({
        enabled: true,
        commandRunner: async (file: string, args: string[]) => {
          executedArgs.push({ file, args });
          return { exitCode: 0, stdout: "ok\n", stderr: "" };
        },
        healthChecker: async () => ({ status: 200, ok: true })
      });

      const maliciousSha = `abc$(touch "${pwnedFile}")`;
      await pipeline.executeSelfDeploy({
        branchName: "feature/sha-test",
        previousSha: "sha1",
        newSha: maliciousSha
      });

      assert.equal(fs.existsSync(pwnedFile), false, "Shell payload in SHA must NEVER execute");
      const buildCall = executedArgs.find((e) => e.file === "docker" && e.args[0] === "build");
      assert.ok(buildCall);
      assert.ok(buildCall.args.some((a) => a.includes(maliciousSha.slice(0, 8))));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Fix 7.3: Supports hostAddress parameter for health check probe", async () => {
    const { SelfDeployPipeline } = await import("../lib/deploy/selfDeploy.js");
    let probedUrl = "";

    const pipeline = new SelfDeployPipeline({
      enabled: true,
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      healthChecker: async (url) => {
        probedUrl = url;
        return { status: 200, ok: true };
      }
    });

    await pipeline.executeSelfDeploy({
      branchName: "feature/host-test",
      previousSha: "sha-1",
      newSha: "sha-2",
      hostAddress: "192.168.1.50"
    });

    assert.equal(probedUrl, "http://192.168.1.50:3001/api/sandbox-status");
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
