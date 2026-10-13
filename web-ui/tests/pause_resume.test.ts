import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

describe("Sprint 12 Phase 4 — Pause & Resume Controls (pause_resume.test.ts)", () => {
  it("start task → pause at milestone 2 → assert status=paused, checkpoint saved → resume → assert milestone 1 already complete (not re-executed), task completes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pause-resume-test-"));
    const dbPath = path.join(tmpDir, "runs.db");
    const checkpointDir = path.join(tmpDir, "checkpoints");

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");
      const ledger = new RunLedger(dbPath, { checkpointDir });

      const executionLog: string[] = [];

      // Start task with 2 milestones
      ledger.recordRunStart({
        runId: "run-pr-1",
        threadId: "thread-pr",
        prompt: "Build 2-milestone app",
        status: "running",
        startedAt: new Date().toISOString(),
        model: "swift-27b-mtp",
        gitShas: ["sha000"],
        milestoneSummary: [
          { id: "M1", title: "Milestone 1", status: "completed", commitSha: "sha111" },
          { id: "M2", title: "Milestone 2", status: "in_progress" }
        ],
        deploymentRef: "local"
      });
      executionLog.push("M1");

      // Pause at milestone 2
      const pausedRun = ledger.pauseRun("run-pr-1", {
        taskId: "run-pr-1",
        threadId: "thread-pr",
        completedMilestoneIds: ["M1"],
        currentMilestoneId: "M2"
      });

      assert.equal(pausedRun.status, "paused", "Run status must transition to paused");
      assert.ok(pausedRun.checkpointPath, "Checkpoint path must be saved when paused");
      assert.ok(fs.existsSync(pausedRun.checkpointPath!), "Checkpoint file must exist on disk");

      // Resume from checkpoint and execute remaining milestones
      const resumed = await ledger.resumeRun("run-pr-1", async (milestone) => {
        executionLog.push(milestone.id);
        return { commitSha: `sha-${milestone.id}` };
      });

      assert.equal(resumed.status, "completed", "Resumed task must complete");
      // M1 was already completed before pause, so only M2 should execute on resume
      assert.deepEqual(
        executionLog,
        ["M1", "M2"],
        "Milestone 1 must NOT be re-executed after resume"
      );
      assert.ok(
        resumed.milestoneSummary.every((m) => m.status === "completed"),
        "All milestones must be marked completed"
      );

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("pause with no checkpoint yet → assert graceful handling, no crash", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pause-nocheckpoint-test-"));
    const dbPath = path.join(tmpDir, "runs.db");
    const checkpointDir = path.join(tmpDir, "checkpoints");

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");
      const ledger = new RunLedger(dbPath, { checkpointDir });

      ledger.recordRunStart({
        runId: "run-pr-nockpt",
        threadId: "thread-pr-2",
        prompt: "Task paused immediately before any checkpoint",
        status: "running",
        startedAt: new Date().toISOString(),
        model: "swift-27b-mtp",
        gitShas: [],
        milestoneSummary: [
          { id: "M1", title: "Initial Setup", status: "pending" }
        ],
        deploymentRef: "none"
      });

      // Call pauseRun without a pre-existing checkpoint payload
      const paused = ledger.pauseRun("run-pr-nockpt");
      assert.equal(paused.status, "paused", "Status must be paused even without prior checkpoint");
      assert.ok(paused.checkpointPath, "Synthesized fallback checkpoint must be created gracefully");
      assert.equal(paused.milestoneSummary[0].status, "pending");

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
