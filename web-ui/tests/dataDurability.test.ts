import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";
import { BoardStore } from "../lib/board/boardStore";
import { AgreementLedgerStore } from "../lib/board/agreementLedger";
import { RunLedger } from "../lib/ledger/runLedger";
import { FlywheelSkillsStore } from "../lib/flywheel/skillsStore";
import { ThreadStore } from "../lib/threads/threadStore";
import { atomicWriteFileSync } from "../lib/fsAtomic";
import { FileCheckpointSaver } from "../lib/subagents/checkpointSaver";

describe("Data Durability — Atomic Writes, Quarantine, SQLite WAL, and Summary Index Serialization (Batch 3)", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("DUR-1: atomicWriteFileSync leaves original intact when a stray .tmp exists and writes atomically", () => {
    const dir = makeTempDir("dur-atomic-");
    const target = path.join(dir, "store.json");
    const strayTmp = path.join(dir, ".store.json.99999.tmp");

    atomicWriteFileSync(target, JSON.stringify({ version: 1 }));
    // Simulate a crash-mid-write leaving a partial temp file behind
    fs.writeFileSync(strayTmp, '{"version": 2, "truncated', "utf8");

    // Original file must remain intact
    const parsedBefore = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(parsedBefore.version, 1);

    // Subsequent atomic write succeeds cleanly
    atomicWriteFileSync(target, JSON.stringify({ version: 3 }));
    const parsedAfter = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(parsedAfter.version, 3);
  });

  it("DUR-5: BoardStore.readAll quarantines corrupt board.json instead of throwing 500 and keeps serving", () => {
    const dir = makeTempDir("dur-board-");
    const boardPath = path.join(dir, "board.json");
    const corruptPayload = "{ this is truncated json !!!";
    fs.writeFileSync(boardPath, corruptPayload, "utf8");

    const store = new BoardStore(dir);
    // Must not throw on corrupt file
    const items = store.list();
    assert.deepEqual(items, []);

    // Corrupt file must be quarantined (preserved on disk, not wiped)
    const files = fs.readdirSync(dir);
    const quarantined = files.find((f) => f.startsWith("board.json.corrupt."));
    assert.ok(
      quarantined,
      `Expected quarantined board.json.corrupt.* file, found: ${files.join(", ")}`
    );
    assert.equal(fs.readFileSync(path.join(dir, quarantined!), "utf8"), corruptPayload);
    assert.ok(store.getLastQuarantinePath()?.includes("board.json.corrupt."));

    // Store keeps serving new writes cleanly
    const created = store.create({
      title: "Recovered item",
      brief: "Works after quarantine",
      author: "Owner",
      source: "manual",
    });
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].id, created.id);
  });

  it("DUR-5: AgreementLedgerStore quarantines corrupt ledger file instead of silently wiping", () => {
    const dir = makeTempDir("dur-ledger-");
    const store = new AgreementLedgerStore(dir);
    const ledgerPath = store.getFilePath();
    const corruptPayload = '{"entries": [BROKEN';
    fs.writeFileSync(ledgerPath, corruptPayload, "utf8");

    const ledger = store.read();
    assert.deepEqual(ledger.entries, []);

    const files = fs.readdirSync(dir);
    const base = path.basename(ledgerPath);
    const quarantined = files.find((f) => f.startsWith(`${base}.corrupt.`));
    assert.ok(
      quarantined,
      `Expected quarantined ${base}.corrupt.* file, found: ${files.join(", ")}`
    );
    assert.equal(fs.readFileSync(path.join(dir, quarantined!), "utf8"), corruptPayload);
  });

  it("DUR-3/DUR-4: RunLedger and FlywheelSkillsStore enable WAL mode and busy_timeout=5000", () => {
    const dir = makeTempDir("dur-sqlite-");
    const dbPath = path.join(dir, "runs.db");

    const ledger = new RunLedger(dbPath);
    try {
      const db = ledger.getDatabase() as {
        prepare: (sql: string) => { get: () => Record<string, unknown> };
      };
      const journalRow = db.prepare("PRAGMA journal_mode").get();
      const timeoutRow = db.prepare("PRAGMA busy_timeout").get();
      assert.equal(
        String(journalRow.journal_mode).toLowerCase(),
        "wal",
        `Expected WAL mode on RunLedger, got ${JSON.stringify(journalRow)}`
      );
      assert.equal(
        Number(timeoutRow.timeout ?? timeoutRow.busy_timeout),
        5000,
        `Expected busy_timeout=5000 on RunLedger, got ${JSON.stringify(timeoutRow)}`
      );
    } finally {
      ledger.close();
    }

    const skillsDbPath = path.join(dir, "skills.db");
    const skills = new FlywheelSkillsStore(skillsDbPath);
    try {
      const db = (
        skills as unknown as {
          db: { prepare: (sql: string) => { get: () => Record<string, unknown> } };
        }
      ).db;
      const journalRow = db.prepare("PRAGMA journal_mode").get();
      const timeoutRow = db.prepare("PRAGMA busy_timeout").get();
      assert.equal(
        String(journalRow.journal_mode).toLowerCase(),
        "wal",
        `Expected WAL mode on FlywheelSkillsStore, got ${JSON.stringify(journalRow)}`
      );
      assert.equal(
        Number(timeoutRow.timeout ?? timeoutRow.busy_timeout),
        5000,
        `Expected busy_timeout=5000 on FlywheelSkillsStore, got ${JSON.stringify(timeoutRow)}`
      );
    } finally {
      skills.close();
    }
  });

  it("DUR-6: ThreadStore serializes concurrent saveSummaryIndex writes without corruption", async () => {
    const dir = makeTempDir("dur-threads-");
    const store = new ThreadStore(dir);

    // Trigger many rapid concurrent saves that all schedule saveSummaryIndex()
    for (let i = 0; i < 15; i++) {
      store.saveThread({
        id: `thr-dur-${i}`,
        title: `Thread ${i}`,
        status: "completed",
        model: "test-model",
        reasoningEffort: "medium",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      });
    }

    await store.flushSummaryIndexForTest();

    const indexPath = path.join(dir, ".summaries-index.json");
    assert.ok(fs.existsSync(indexPath), "Summary index file must exist after flush");
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, unknown>;
    assert.equal(Object.keys(parsed).length, 15, "All 15 threads must be present in summary index");
  });

  it("DUR-1: FileCheckpointSaver quarantines one corrupt checkpoint without aborting valid siblings", () => {
    const dir = makeTempDir("dur-ckpt-");
    const validPath = path.join(dir, "thread-ok-lg-checkpoint.json");
    const corruptPath = path.join(dir, "thread-bad-lg-checkpoint.json");
    fs.writeFileSync(
      validPath,
      JSON.stringify({ storage: { ns: { id: "ok" } }, writes: {} }),
      "utf8"
    );
    fs.writeFileSync(corruptPath, "{ truncated checkpoint", "utf8");

    const saver = new FileCheckpointSaver(dir);
    assert.ok(
      (saver as unknown as { storage: Record<string, unknown> }).storage["thread-ok"],
      "Valid sibling checkpoint must still load when another checkpoint is corrupt"
    );
    const files = fs.readdirSync(dir);
    assert.ok(
      files.some((f) => f.startsWith("thread-bad-lg-checkpoint.json.corrupt.")),
      `Expected corrupt checkpoint to be quarantined, found: ${files.join(", ")}`
    );
  });
});
