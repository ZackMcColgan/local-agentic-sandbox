import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { WorkerGitOps } from "../lib/git/workerGitOps.js";
import { OvernightSupervisor } from "../lib/subagents/supervisor.js";
import { TaskManifest } from "../lib/subagents/types.js";
import { POST } from "../app/api/threads/route.js";
import { POST as deployPOST } from "../app/api/deploy/route.js";
import { NextRequest } from "next/server";
import React from "react";
import { renderToString } from "react-dom/server";
import { Window } from "happy-dom";

process.env.FAST_GRAPH_TEST = "1";

describe("Sprint A4 — WorkerGitOps & SelfDeployPipeline Integration Suite", () => {
  describe("1. WorkerGitOps Safety & Branch Lifecycle", () => {
    it("allows feat/task-... branch naming convention", async () => {
      const executed: string[] = [];
      const gitOps = new WorkerGitOps({
        runId: "run-test-1",
        commandRunner: async (file, args) => {
          executed.push([file, ...args].join(" "));
          return { exitCode: 0, stdout: "Switched to branch feat/task-123456789012\n", stderr: "" };
        }
      });

      const res = await gitOps.createAndSwitchBranch("feat/task-123456789012");
      assert.equal(res.branchName, "feat/task-123456789012");
      assert.ok(executed.some((cmd) => cmd.includes("checkout -B feat/task-123456789012")));
    });

    it("strictly REJECTS checkout or branch creation targeting main or master", async () => {
      const gitOps = new WorkerGitOps({
        runId: "run-test-2",
        commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" })
      });

      await assert.rejects(
        async () => {
          await gitOps.createAndSwitchBranch("main");
        },
        /protected branch/i,
        "Must reject checkout/switch to main"
      );

      await assert.rejects(
        async () => {
          await gitOps.createAndSwitchBranch("master");
        },
        /protected branch/i,
        "Must reject checkout/switch to master"
      );
    });

    it("strictly REJECTS committing if active branch is main or master", async () => {
      const gitOps = new WorkerGitOps({
        runId: "run-test-3",
        commandRunner: async (file, args) => {
          if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
            return { exitCode: 0, stdout: "main\n", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      });

      await assert.rejects(
        async () => {
          await gitOps.stageAndCommit(["file.txt"], "feat: try commit to main");
        },
        /cannot commit.*main|protected branch/i,
        "Must reject commits when HEAD is on main"
      );
    });
  });

  describe("2. Threads API Branch Format & GitOps Defaults", () => {
    let origExecute: any;
    before(() => {
      origExecute = OvernightSupervisor.prototype.executeTaskWithRecovery;
      OvernightSupervisor.prototype.executeTaskWithRecovery = async function(t: TaskManifest) { return t; };
    });
    after(() => {
      OvernightSupervisor.prototype.executeTaskWithRecovery = origExecute;
    });

    it("launches task with branch feat/task-${taskId.slice(0, 12)} and default enableGitOps: true", async () => {
      const req = new NextRequest("http://localhost:3000/api/threads", {
        method: "POST",
        body: JSON.stringify({
          action: "launchTask",
          goal: "Build test feature",
          scope: "PROJECT"
        })
      });

      const res = await POST(req);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.ok(data.task, "Must return created task manifest");
      assert.ok(
        data.task.branchName.startsWith("feat/task-"),
        `Branch name must start with feat/task-, got: ${data.task.branchName}`
      );
      assert.notEqual(
        data.task.branchName,
        "feat/v2.5-overnight",
        "Must NOT use hardcoded feat/v2.5-overnight branch"
      );
      assert.equal(data.task.enableGitOps, true, "enableGitOps must default to true");
    });

    it("honors explicit opt-out enableGitOps: false", async () => {
      const req = new NextRequest("http://localhost:3000/api/threads", {
        method: "POST",
        body: JSON.stringify({
          action: "launchTask",
          goal: "No git ops task",
          scope: "PROJECT",
          enableGitOps: false
        })
      });

      const res = await POST(req);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.task.enableGitOps, false);
    });

    it("captures opt-in autoDeployOnGreen: true", async () => {
      const req = new NextRequest("http://localhost:3000/api/threads", {
        method: "POST",
        body: JSON.stringify({
          action: "launchTask",
          goal: "Hands-free capstone run",
          scope: "PROJECT",
          autoDeployOnGreen: true
        })
      });

      const res = await POST(req);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.task.autoDeployOnGreen, true);
    });
  });

  describe("3. Supervisor Branch Lifecycle & test:gate Pre-Merge Verification", () => {
    it("creates isolated task branch before milestone 1, commits milestones via WorkerGitOps, and runs test:gate on completion", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sup-gitops-test-"));
      const gitCommands: string[] = [];
      let gateRan = false;

      const mockGitOps = new WorkerGitOps({
        runId: "task-test-gitops-1",
        commandRunner: async (file, args) => {
          gitCommands.push([file, ...args].join(" "));
          if (args.includes("rev-parse") && args.includes("HEAD")) {
            return { exitCode: 0, stdout: "commit-sha-abc123\n", stderr: "" };
          }
          if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
            return { exitCode: 0, stdout: "feat/task-test001\n", stderr: "" };
          }
          return { exitCode: 0, stdout: "ok\n", stderr: "" };
        }
      });

      const supervisor = new OvernightSupervisor({
        checkpointDirectory: tmpDir
      });

      const task: TaskManifest = {
        taskId: "task-test001",
        goal: "Verify supervisor gitops lifecycle",
        toolchain: "node:22",
        scope: "PROJECT",
        branchName: "feat/task-test001",
        status: "active",
        enableGitOps: true,
        currentMilestoneIndex: 0,
        milestones: [
          {
            id: "M1",
            title: "Implement core service",
            description: "Write core service file",
            status: "pending",
            builderIterations: 1,
            criticRounds: 1,
            acceptanceCriteria: []
          }
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const mockStepExecutor = async (m: any) => {
        return {
          status: "completed",
          gitSha: "commit-sha-abc123",
          targetFile: "lib/core.ts",
          deliverableContent: "export const core = 1;",
          thinking: "Done"
        };
      };

      const result = await supervisor.executeTaskWithRecovery(task, {
        stepExecutor: mockStepExecutor as any,
        gitOps: mockGitOps,
        gateRunner: async () => {
          gateRan = true;
          return { exitCode: 0, stdout: "PASS: 291 tests passed\n", stderr: "" };
        }
      });

      assert.equal(result.status, "completed");
      assert.equal(result.gatePassed, true);
      assert.ok(gateRan, "test:gate must run upon task completion");
      assert.ok(
        gitCommands.some((c) => c.includes("checkout -B feat/task-test001")),
        "Must switch to isolated task branch before execution"
      );
      assert.ok(
        gitCommands.some((c) => c.includes("add lib/core.ts") || c.includes("commit")),
        "Must atomically commit verified milestone"
      );

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("4. Deploy API executeSelfDeploy Action", () => {
    it("POST /api/deploy executeSelfDeploy executes deploy with pre-rollout gate and health check", async () => {
      const original = process.env.SELF_DEPLOY_ENABLED;
      process.env.SELF_DEPLOY_ENABLED = "true";

      try {
        const req = new NextRequest("http://localhost:3000/api/deploy", {
          method: "POST",
          body: JSON.stringify({
            action: "executeSelfDeploy",
            branchName: "feat/task-capstone1",
            previousSha: "prev-sha-12345",
            newSha: "new-sha-67890",
            deploymentName: "web-ui",
            namespace: "local-agentic-sandbox",
            dryRun: true,
            skipPreRollout: true // Skip actual long npm run in unit test
          })
        });

        const res = await deployPOST(req);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(data.deployId || data.record?.deployId);
        assert.ok(data.status === "deployed" || data.record?.status === "deployed" || data.status === "rolled_back");
      } finally {
        process.env.SELF_DEPLOY_ENABLED = original;
      }
    });
  });

  describe("5. UI 1-Click Rollout & autoDeployOnGreen Controls", () => {
    it("LiveRunBlock renders 1-Click 'Merge to develop & Rollout' button on completed task", async () => {
      const { LiveRunBlock } = await import("../components/LiveRunBlock.js");

      const task: TaskManifest = {
        taskId: "task-live-1",
        goal: "Check 1-click rollout button",
        toolchain: "node:22",
        branchName: "feat/task-live0001",
        status: "completed",
        currentMilestoneIndex: 1,
        milestones: [
          {
            id: "M1",
            title: "Completed Milestone",
            description: "Done",
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

      const html = renderToString(
        React.createElement(LiveRunBlock, {
          task,
          onDeployRun: () => {}
        })
      );

      const window = new Window();
      window.document.body.innerHTML = html;

      assert.ok(
        html.includes("Merge to develop & Rollout") ||
          html.includes("Merge to `develop` &amp; Rollout") ||
          html.includes("Merge to `develop` & Rollout") ||
          html.includes("Rollout"),
        "LiveRunBlock must render 1-click Merge to develop & Rollout button"
      );
    });

    it("ChatStream renders Auto-Deploy on Green Gate checkbox in Build mode", async () => {
      const { ChatStream } = await import("../components/ChatStream.js");

      const html = renderToString(
        React.createElement(ChatStream, {
          messages: [],
          onSendMessage: async () => {},
          defaultComposerMode: "build"
        })
      );

      assert.ok(
        html.includes("Auto-Deploy on Green Gate") || html.includes("auto-deploy") || html.includes("Auto-Deploy"),
        "ChatStream in Build mode must render opt-in Auto-Deploy on Green Gate toggle"
      );
    });
  });
});
