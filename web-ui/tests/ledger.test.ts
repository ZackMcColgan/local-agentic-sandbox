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
        milestoneSummary: [{ id: "M1", title: "Create checklist", status: "in_progress" }],
        deploymentRef: "local-dev",
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
            deploymentRef: "none",
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
            model: undefined as unknown as string, // missing model
            gitShas: [],
            milestoneSummary: [],
            deploymentRef: "none",
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
          { id: "M2", title: "Step 2", status: "pending" },
        ],
        deploymentRef: "pending",
      });

      // Mid-run update after M1 completes
      ledger.updateRunProgress("run-midflight-1", {
        gitShas: ["a111111", "b222222"],
        milestoneSummary: [
          { id: "M1", title: "Step 1", status: "completed", commitSha: "b222222" },
          { id: "M2", title: "Step 2", status: "in_progress" },
        ],
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

  it("Task 2: pauseRun writes checkpoints into supervisor.checkpointDirectory when initialized without overrides", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-chk-unify-"));
    const dbPath = path.join(tmpDir, "runs.db");
    let ledger: InstanceType<(typeof import("../lib/ledger/runLedger.js"))["RunLedger"]> | null =
      null;
    let expectedCheckpointPath = "";

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");
      const { OvernightSupervisor } = await import("../lib/subagents/supervisor.js");

      const supervisor = new OvernightSupervisor();
      ledger = new RunLedger(dbPath);

      const runId = `run-unify-${Date.now()}`;
      ledger.recordRunStart({
        runId,
        threadId: "thread-unify",
        prompt: "Verify unified checkpoint directory",
        status: "running",
        startedAt: new Date().toISOString(),
        model: "swift-15-27b-mtp",
        gitShas: [],
        milestoneSummary: [{ id: "M1", title: "M1", status: "in_progress" }],
        deploymentRef: "local",
      });

      const pausedEntry = ledger.pauseRun(runId);
      assert.ok(pausedEntry.checkpointPath, "Must have checkpointPath");

      expectedCheckpointPath = path.join(
        supervisor.checkpointDirectory,
        `${runId}.checkpoint.json`
      );
      assert.equal(
        pausedEntry.checkpointPath,
        expectedCheckpointPath,
        "Checkpoint path must match supervisor.checkpointDirectory"
      );
      assert.ok(
        fs.existsSync(expectedCheckpointPath),
        "Checkpoint file must exist in supervisor.checkpointDirectory"
      );
    } finally {
      if (expectedCheckpointPath) {
        try {
          fs.unlinkSync(expectedCheckpointPath);
        } catch {}
      }
      if (ledger) {
        try {
          ledger.close();
        } catch {}
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("Task 2.1: OvernightSupervisor and RunLedger checkpoint directories remain strictly unified without drift", async () => {
    const { RunLedger, getDefaultCheckpointDir } = await import("../lib/ledger/runLedger.js");
    const { OvernightSupervisor } = await import("../lib/subagents/supervisor.js");

    const supervisor = new OvernightSupervisor();
    const ledger = new RunLedger();

    try {
      assert.equal(
        supervisor.checkpointDirectory,
        getDefaultCheckpointDir(),
        "supervisor.checkpointDirectory must strictly match getDefaultCheckpointDir()"
      );
      assert.equal(
        (ledger as unknown as { checkpointDir: string }).checkpointDir,
        supervisor.checkpointDirectory,
        "RunLedger default checkpointDir must match supervisor.checkpointDirectory"
      );
    } finally {
      ledger.close();
    }
  });

  it("getDefaultLedgerDbPath prefers WORKSPACE_DIR/.agent/runs.db when RUN_LEDGER_DB_PATH is unset", async () => {
    const origDbPath = process.env.RUN_LEDGER_DB_PATH;
    const origWorkspace = process.env.WORKSPACE_DIR;
    const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-ws-test-"));

    try {
      delete process.env.RUN_LEDGER_DB_PATH;
      process.env.WORKSPACE_DIR = tmpWorkspace;

      const { getDefaultLedgerDbPath } = await import("../lib/ledger/runLedger.js");
      assert.equal(
        getDefaultLedgerDbPath(),
        path.join(path.resolve(tmpWorkspace), ".agent", "runs.db")
      );
    } finally {
      if (origDbPath !== undefined) process.env.RUN_LEDGER_DB_PATH = origDbPath;
      else delete process.env.RUN_LEDGER_DB_PATH;
      if (origWorkspace !== undefined) process.env.WORKSPACE_DIR = origWorkspace;
      else delete process.env.WORKSPACE_DIR;
      fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    }
  });

  it("startup migration copies legacy runs.db (and -wal/-shm sidecars) to persistent target when missing, and does not overwrite existing target", async () => {
    const origDbPath = process.env.RUN_LEDGER_DB_PATH;
    const origWorkspace = process.env.WORKSPACE_DIR;
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-migrate-test-"));
    const fakeHome = path.join(tmpRoot, "home");
    const fakeWorkspace = path.join(tmpRoot, "workspace");
    const legacyDir = path.join(fakeHome, ".local-agentic-sandbox");
    const legacyDbPath = path.join(legacyDir, "runs.db");
    const targetDbPath = path.join(fakeWorkspace, ".agent", "runs.db");

    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(fakeWorkspace, { recursive: true });

    try {
      const { RunLedger } = await import("../lib/ledger/runLedger.js");

      // Seed legacy DB with a run record and close it cleanly
      const legacyLedger = new RunLedger(legacyDbPath);
      legacyLedger.recordRunStart({
        runId: "legacy-run-1",
        threadId: "thread-legacy",
        prompt: "Legacy persistent run",
        status: "completed",
        startedAt: new Date().toISOString(),
        model: "test-model",
        gitShas: [],
        milestoneSummary: [],
        deploymentRef: "local",
      });
      legacyLedger.close();

      // Create -wal and -shm sidecar files alongside legacy runs.db
      fs.writeFileSync(`${legacyDbPath}-wal`, Buffer.from("wal-sidecar-bytes"));
      fs.writeFileSync(`${legacyDbPath}-shm`, Buffer.from("shm-sidecar-bytes"));

      // Seed an independent existing target DB BEFORE pointing HOME/USERPROFILE at fakeHome
      const secondTarget = path.join(tmpRoot, "existing-workspace", ".agent", "runs.db");
      const existingLedger = new RunLedger(secondTarget);
      existingLedger.recordRunStart({
        runId: "target-only-run",
        threadId: "thread-target",
        prompt: "Existing target run",
        status: "completed",
        startedAt: new Date().toISOString(),
        model: "test-model",
        gitShas: [],
        milestoneSummary: [],
        deploymentRef: "local",
      });
      existingLedger.close();

      delete process.env.RUN_LEDGER_DB_PATH;
      process.env.WORKSPACE_DIR = fakeWorkspace;
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;

      // Opening default RunLedger with missing target must migrate legacy runs.db + sidecars
      const migratedLedger = new RunLedger();
      try {
        assert.ok(fs.existsSync(targetDbPath), "Target runs.db must be created by migration");
        assert.ok(
          fs.existsSync(`${targetDbPath}-wal`),
          "Target runs.db-wal sidecar must be copied"
        );
        assert.ok(
          fs.existsSync(`${targetDbPath}-shm`),
          "Target runs.db-shm sidecar must be copied"
        );
        assert.ok(
          fs.existsSync(legacyDbPath),
          "Legacy source runs.db must remain non-destructively"
        );

        const migratedRun = migratedLedger.getRun("legacy-run-1");
        assert.ok(migratedRun, "Legacy run record must exist in migrated target database");
        assert.equal(migratedRun.prompt, "Legacy persistent run");
      } finally {
        migratedLedger.close();
      }

      // Now verify idempotency / no-overwrite on existing secondTarget
      process.env.RUN_LEDGER_DB_PATH = secondTarget;
      const reopenedLedger = new RunLedger();
      try {
        assert.ok(
          reopenedLedger.getRun("target-only-run"),
          "Existing target run must be preserved"
        );
        assert.equal(
          reopenedLedger.getRun("legacy-run-1"),
          null,
          "Migration must NOT overwrite an already-existing target database"
        );
      } finally {
        reopenedLedger.close();
      }
    } finally {
      if (origDbPath !== undefined) process.env.RUN_LEDGER_DB_PATH = origDbPath;
      else delete process.env.RUN_LEDGER_DB_PATH;
      if (origWorkspace !== undefined) process.env.WORKSPACE_DIR = origWorkspace;
      else delete process.env.WORKSPACE_DIR;
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
      else delete process.env.USERPROFILE;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
