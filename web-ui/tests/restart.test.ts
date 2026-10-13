import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

describe("Sprint 12 Phase 4 — Restart Controls (restart.test.ts)", () => {
  it("restart a completed task → assert new run id, parent_run_id links to original, original untouched", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-completed-test-"));
    const dbPath = path.join(tmpDir, "runs.db");

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");
      const ledger = new RunLedger(dbPath);

      const original = ledger.recordRunStart({
        runId: "run-orig-1",
        threadId: "thread-r1",
        prompt: "Build markdown renderer",
        status: "completed",
        startedAt: "2026-10-13T01:00:00.000Z",
        completedAt: "2026-10-13T01:02:00.000Z",
        model: "swift-27b-mtp",
        gitShas: ["sha-orig-1"],
        milestoneSummary: [
          { id: "M1", title: "Implement renderer", status: "completed", commitSha: "sha-orig-1" }
        ],
        deploymentRef: "deploy-orig"
      });

      const restarted = ledger.restartRun("run-orig-1");

      assert.notEqual(restarted.runId, original.runId, "Restarted run must have a new runId");
      assert.equal(restarted.parentRunId, "run-orig-1", "parent_run_id must link to the original run");
      assert.equal(restarted.threadId, "thread-r1", "Thread ID should carry over");
      assert.equal(restarted.prompt, "Build markdown renderer");
      assert.equal(restarted.status, "running");

      // Verify original run is completely untouched in the DB
      const checkOrig = ledger.getRun("run-orig-1");
      assert.ok(checkOrig);
      assert.equal(checkOrig.status, "completed");
      assert.deepEqual(checkOrig.gitShas, ["sha-orig-1"]);
      assert.equal(checkOrig.milestoneSummary[0].status, "completed");

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("restart a failed task → assert fresh milestone state", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-failed-test-"));
    const dbPath = path.join(tmpDir, "runs.db");

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");
      const ledger = new RunLedger(dbPath);

      ledger.recordRunStart({
        runId: "run-failed-1",
        threadId: "thread-r2",
        prompt: "Build k8s operator",
        status: "failed",
        startedAt: "2026-10-13T01:10:00.000Z",
        model: "swift-27b-mtp",
        gitShas: ["sha-f1"],
        milestoneSummary: [
          { id: "M1", title: "Scaffold operator", status: "completed", commitSha: "sha-f1" },
          { id: "M2", title: "Deploy CRD", status: "failed" }
        ],
        deploymentRef: "failed"
      });

      const restarted = ledger.restartRun("run-failed-1");

      assert.notEqual(restarted.runId, "run-failed-1");
      assert.equal(restarted.parentRunId, "run-failed-1");
      assert.equal(restarted.status, "running");
      assert.deepEqual(restarted.gitShas, [], "Restarted run must start with fresh gitShas list");
      assert.equal(restarted.milestoneSummary.length, 2);
      assert.ok(
        restarted.milestoneSummary.every((m) => m.status === "pending" && !m.commitSha),
        "All milestones on a restarted failed task must be reset to fresh pending state"
      );

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
