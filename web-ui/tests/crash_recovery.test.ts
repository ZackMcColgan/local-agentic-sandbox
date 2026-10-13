import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

describe("Sprint 12 Phase 4 — Crash Recovery (crash_recovery.test.ts)", () => {
  it("simulate crash (write a running ledger entry with stale heartbeat) → run startup scan → assert status=crashed, resume offered", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-recovery-test-"));
    const dbPath = path.join(tmpDir, "runs.db");

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");
      const ledger = new RunLedger(dbPath);

      const twoMinutesAgo = new Date(Date.now() - 120 * 1000).toISOString();
      ledger.recordRunStart({
        runId: "run-crash-1",
        threadId: "thread-c1",
        prompt: "Long running build that crashed",
        status: "running",
        startedAt: twoMinutesAgo,
        lastHeartbeatAt: twoMinutesAgo,
        model: "swift-27b-mtp",
        gitShas: ["sha-c1"],
        milestoneSummary: [
          { id: "M1", title: "Step 1", status: "completed", commitSha: "sha-c1" },
          { id: "M2", title: "Step 2", status: "in_progress" }
        ],
        deploymentRef: "pending"
      });

      const crashedRuns = ledger.scanAndMarkCrashedRuns({ staleThresholdSeconds: 60 });
      assert.equal(crashedRuns.length, 1, "Must detect 1 crashed run");
      assert.equal(crashedRuns[0].runId, "run-crash-1");
      assert.equal(crashedRuns[0].status, "crashed");
      assert.equal(crashedRuns[0].resumable, true, "Crashed run must offer resume (resumable=true)");

      const fromDb = ledger.getRun("run-crash-1");
      assert.ok(fromDb);
      assert.equal(fromDb.status, "crashed");
      assert.equal(fromDb.resumable, true);

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("heartbeat timeout threshold is configurable, stale = no heartbeat for >N seconds", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-threshold-test-"));
    const dbPath = path.join(tmpDir, "runs.db");

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");
      const ledger = new RunLedger(dbPath);

      const now = Date.now();
      const fortySecondsAgo = new Date(now - 40 * 1000).toISOString();
      const tenSecondsAgo = new Date(now - 10 * 1000).toISOString();

      ledger.recordRunStart({
        runId: "run-stale-40s",
        threadId: "thread-t1",
        prompt: "40s stale run",
        status: "running",
        startedAt: fortySecondsAgo,
        lastHeartbeatAt: fortySecondsAgo,
        model: "swift-27b-mtp",
        gitShas: [],
        milestoneSummary: [{ id: "M1", title: "Work", status: "in_progress" }],
        deploymentRef: "none"
      });

      ledger.recordRunStart({
        runId: "run-fresh-10s",
        threadId: "thread-t2",
        prompt: "10s fresh run",
        status: "running",
        startedAt: tenSecondsAgo,
        lastHeartbeatAt: tenSecondsAgo,
        model: "swift-27b-mtp",
        gitShas: [],
        milestoneSummary: [{ id: "M1", title: "Work", status: "in_progress" }],
        deploymentRef: "none"
      });

      // With threshold=30s, only the 40s-old run is stale (>30s)
      const crashed = ledger.scanAndMarkCrashedRuns({ staleThresholdSeconds: 30, nowMs: now });
      assert.equal(crashed.length, 1);
      assert.equal(crashed[0].runId, "run-stale-40s");

      const freshRun = ledger.getRun("run-fresh-10s");
      assert.ok(freshRun);
      assert.equal(freshRun.status, "running", "Fresh run within threshold must remain running");

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("multiple crashed runs → all detected, none silently dropped", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-multiple-test-"));
    const dbPath = path.join(tmpDir, "runs.db");

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");
      const ledger = new RunLedger(dbPath);

      const fiveMinutesAgo = new Date(Date.now() - 300 * 1000).toISOString();

      for (const id of ["run-m1", "run-m2", "run-m3"]) {
        ledger.recordRunStart({
          runId: id,
          threadId: `thread-${id}`,
          prompt: `Task ${id}`,
          status: "running",
          startedAt: fiveMinutesAgo,
          lastHeartbeatAt: fiveMinutesAgo,
          model: "swift-27b-mtp",
          gitShas: [],
          milestoneSummary: [{ id: "M1", title: "Task", status: "in_progress" }],
          deploymentRef: "none"
        });
      }

      const crashed = ledger.scanAndMarkCrashedRuns({ staleThresholdSeconds: 60 });
      assert.equal(crashed.length, 3, "All 3 crashed runs must be detected");
      assert.deepEqual(
        crashed.map((r) => r.runId).sort(),
        ["run-m1", "run-m2", "run-m3"]
      );
      assert.ok(crashed.every((r) => r.status === "crashed" && r.resumable === true));

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
