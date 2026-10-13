import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

describe("Sprint 12 Phase 4 — Run Ledger (ledger.test.ts)", () => {
  it("writes a run to SQLite on start with all required fields and queries it back", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
    const dbPath = path.join(tmpDir, "runs.db");

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");
      const ledger = new RunLedger(dbPath);

      const startedAt = new Date().toISOString();
      const record = ledger.recordRunStart({
        runId: "run-001",
        threadId: "thread-abc",
        prompt: "Create a markdown checklist for a weekend camping trip",
        status: "running",
        startedAt,
        model: "swift-27b-mtp",
        gitShas: ["db75d01"],
        milestoneSummary: [
          { id: "M1", title: "Create checklist", status: "in_progress" }
        ],
        deploymentRef: "local-dev"
      });

      assert.equal(record.runId, "run-001");
      assert.equal(record.threadId, "thread-abc");
      assert.equal(record.prompt, "Create a markdown checklist for a weekend camping trip");
      assert.equal(record.status, "running");
      assert.equal(record.model, "swift-27b-mtp");
      assert.deepEqual(record.gitShas, ["db75d01"]);
      assert.equal(record.milestoneSummary.length, 1);
      assert.equal(record.deploymentRef, "local-dev");

      const queried = ledger.getRun("run-001");
      assert.ok(queried, "Run must be persisted in SQLite and queryable");
      assert.equal(queried.runId, "run-001");
      assert.equal(queried.threadId, "thread-abc");
      assert.equal(queried.model, "swift-27b-mtp");

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws an explicit error when a required field is missing on ledger write (no silent null)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-missing-test-"));
    const dbPath = path.join(tmpDir, "runs.db");

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");
      const ledger = new RunLedger(dbPath);

      assert.throws(
        () => {
          ledger.recordRunStart({
            runId: "run-bad-1",
            threadId: "", // missing threadId
            prompt: "Valid prompt",
            status: "running",
            startedAt: new Date().toISOString(),
            model: "swift-27b-mtp",
            gitShas: [],
            milestoneSummary: [],
            deploymentRef: "none"
          });
        },
        /Missing required ledger field/i,
        "Must throw explicit error when threadId is empty/missing"
      );

      assert.throws(
        () => {
          ledger.recordRunStart({
            runId: "run-bad-2",
            threadId: "thread-1",
            prompt: "Valid prompt",
            status: "running",
            startedAt: new Date().toISOString(),
            model: undefined as any, // missing model
            gitShas: [],
            milestoneSummary: [],
            deploymentRef: "none"
          });
        },
        /Missing required ledger field/i,
        "Must throw explicit error when model is missing"
      );

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("updates ledger progressively mid-flight and records 'stopped' with partial milestones when killed", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-midflight-test-"));
    const dbPath = path.join(tmpDir, "runs.db");

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");
      const ledger = new RunLedger(dbPath);

      ledger.recordRunStart({
        runId: "run-midflight-1",
        threadId: "thread-mid",
        prompt: "Build multi-step pipeline",
        status: "running",
        startedAt: new Date().toISOString(),
        model: "swift-27b-mtp",
        gitShas: ["a111111"],
        milestoneSummary: [
          { id: "M1", title: "Step 1", status: "pending" },
          { id: "M2", title: "Step 2", status: "pending" }
        ],
        deploymentRef: "pending"
      });

      // Mid-run update after M1 completes
      ledger.updateRunProgress("run-midflight-1", {
        gitShas: ["a111111", "b222222"],
        milestoneSummary: [
          { id: "M1", title: "Step 1", status: "completed", commitSha: "b222222" },
          { id: "M2", title: "Step 2", status: "in_progress" }
        ]
      });

      // Kill mid-flight
      const stopped = ledger.markStoppedMidFlight("run-midflight-1");
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.milestoneSummary.length, 2);
      assert.equal(stopped.milestoneSummary[0].status, "completed");
      assert.equal(stopped.milestoneSummary[1].status, "in_progress");

      const fromDb = ledger.getRun("run-midflight-1");
      assert.ok(fromDb);
      assert.equal(fromDb.status, "stopped");
      assert.equal(fromDb.milestoneSummary[0].status, "completed");

      ledger.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
