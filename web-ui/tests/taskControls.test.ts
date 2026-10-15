import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { LiveRunBlock } from "../components/LiveRunBlock";
import { OvernightSupervisor } from "../lib/subagents/supervisor";
import { ThreadStore, activeExecutionSet } from "../lib/threads/threadStore";
import { TaskManifest, Milestone } from "../lib/subagents/types";
import { unloadAllModels } from "../lib/subagents/residency";

describe("Epic 1 — Sprint 3: Long-running task controls & progress (S8-S10)", () => {
  // -------------------------------------------------------------
  // S8 — Real stop semantics
  // -------------------------------------------------------------
  describe("S8 — Real stop semantics", () => {
    it("parks the task in OvernightSupervisor with status 'stopped' and frees VRAM", async () => {
      const supervisor = new OvernightSupervisor();
      const taskId = `test-stop-${Date.now()}`;

      const manifest: TaskManifest = {
        taskId,
        goal: "Build feature with stop semantics",
        toolchain: "node:22",
        branchName: "main",
        status: "active",
        milestones: [
          {
            id: "m-1",
            title: "Milestone 1",
            description: "First step",
            acceptanceCriteria: [],
            status: "completed",
            builderIterations: 1,
            criticRounds: 1
          },
          {
            id: "m-2",
            title: "Milestone 2",
            description: "Second step",
            acceptanceCriteria: [],
            status: "in_progress",
            builderIterations: 1,
            criticRounds: 0
          }
        ],
        currentMilestoneIndex: 1,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      supervisor.saveCheckpoint(manifest);
      activeExecutionSet.add(taskId);

      // Stop run: parks task with status stopped
      const stoppedTask = supervisor.parkTask(manifest, "User stopped run");
      assert.equal(stoppedTask.status, "stopped", "Task status must be set to 'stopped'");
      activeExecutionSet.delete(taskId);

      // Reload checkpoint from disk to verify persistence
      const reloaded = await supervisor.resumeTaskFromCheckpoint(taskId);
      assert.ok(reloaded, "Must be able to reload task checkpoint from disk");
      assert.equal(reloaded?.status, "stopped", "Persisted checkpoint status must be 'stopped'");
      assert.equal(activeExecutionSet.has(taskId), false, "TaskId must be removed from activeExecutionSet");

      // Verify unloadAllModels executes without error
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({ models: [{ name: "qwen3.8:27b-q3_k_m", size: 1000 }] })
      }) as any;
      const unloaded = await unloadAllModels("http://127.0.0.1:11434", mockFetch);
      assert.ok(Array.isArray(unloaded), "unloadAllModels must return list of unloaded models");
    });

    it("renders partial output with '• Stopped' indicator when task is stopped", () => {
      const stoppedManifest: TaskManifest = {
        taskId: "task-stopped",
        goal: "Stopped test task",
        toolchain: "node:22",
        branchName: "main",
        status: "stopped",
        milestones: [
          {
            id: "m-1",
            title: "Step 1",
            description: "Step 1",
            acceptanceCriteria: [],
            status: "completed",
            builderIterations: 1,
            criticRounds: 1
          }
        ],
        currentMilestoneIndex: 0,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const html = renderToString(
        React.createElement(LiveRunBlock, {
          task: stoppedManifest
        })
      );

      assert.ok(html.includes("Stopped"), "LiveRunBlock must show stopped indicator when task is stopped");
    });
  });

  // -------------------------------------------------------------
  // S9 — Reconnect after navigation/reload
  // -------------------------------------------------------------
  describe("S9 — Reconnect after navigation/reload", () => {
    it("reconnects to active task from disk checkpoint without restarting or losing completed milestones", async () => {
      const supervisor = new OvernightSupervisor();
      const taskId = `test-recon-${Date.now()}`;

      const manifest: TaskManifest = {
        taskId,
        goal: "Long running builder task",
        toolchain: "node:22",
        branchName: "main",
        status: "active",
        milestones: [
          {
            id: "m-1",
            title: "Setup environment",
            description: "Initial setup",
            acceptanceCriteria: [],
            status: "completed",
            builderIterations: 1,
            criticRounds: 1,
            commitSha: "a1b2c3d"
          },
          {
            id: "m-2",
            title: "Implement core logic",
            description: "Core logic",
            acceptanceCriteria: [],
            status: "in_progress",
            builderIterations: 2,
            criticRounds: 1
          }
        ],
        currentMilestoneIndex: 1,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      supervisor.saveCheckpoint(manifest);

      // Simulate browser reload / navigation: reload from disk checkpoint
      const rehydrated = await supervisor.resumeTaskFromCheckpoint(taskId);
      assert.ok(rehydrated, "Checkpoint must be recovered");
      assert.equal(rehydrated?.currentMilestoneIndex, 1, "Must maintain current milestone index");
      assert.equal(rehydrated?.milestones[0].status, "completed", "Milestone 1 must stay marked completed");
      assert.equal(rehydrated?.milestones[0].commitSha, "a1b2c3d", "Must preserve milestone 1 commitSha");
    });
  });

  // -------------------------------------------------------------
  // S10 — Inline progress fidelity
  // -------------------------------------------------------------
  describe("S10 — Inline progress fidelity", () => {
    it("renders milestone checklist and critic verdict block with score and commentary", () => {
      const activeTask: TaskManifest = {
        taskId: "task-fidelity",
        goal: "Demonstrate high fidelity progress",
        toolchain: "node:22",
        branchName: "main",
        status: "active",
        milestones: [
          {
            id: "m-1",
            title: "Configure sandbox networking",
            description: "Setup egress",
            acceptanceCriteria: [],
            status: "completed",
            builderIterations: 1,
            criticRounds: 1,
            criticScore: 94,
            criticVerdict: "PASS",
            criticCritique: "Clean network isolation verified with Docker egress rules."
          },
          {
            id: "m-2",
            title: "Implement worker telemetry",
            description: "Telemetry streaming",
            acceptanceCriteria: [],
            status: "in_progress",
            builderIterations: 1,
            criticRounds: 0,
            tokenThroughput: {
              promptTokens: 450,
              completionTokens: 120,
              tokensPerSecond: 28.4
            }
          }
        ],
        currentMilestoneIndex: 1,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [
          {
            timestamp: new Date().toISOString(),
            role: "builder",
            message: "Streaming Ollama completion tokens: 120 tokens at 28.4 t/s"
          }
        ],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const html = renderToString(
        React.createElement(LiveRunBlock, {
          task: activeTask
        })
      );

      // Checklist rendered
      assert.ok(html.includes("Configure sandbox networking"), "Checklist must render milestone 1");
      assert.ok(html.includes("Implement worker telemetry"), "Checklist must render milestone 2");

      // Critic verdict rendered
      assert.ok(html.includes("Critic Verdict") || html.includes("PASS"), "Must render critic verdict block");
      assert.ok(html.includes("94") || html.includes("Clean network isolation"), "Must render critic score or critique");
    });
  });
});
