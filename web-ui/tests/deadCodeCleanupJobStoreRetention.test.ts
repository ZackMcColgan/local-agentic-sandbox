import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JobStore,
  MAX_COMPLETED_JOB_RECORDS,
  COMPLETED_JOB_RETENTION_MS,
} from "../../host-bridge/jobStore";

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
}

describe("dead code removal (Phase 1.2 census)", () => {
  it("web-ui/lib/visionProcessor.ts is removed", () => {
    const visionPath = path.resolve(__dirname, "../lib/visionProcessor.ts");
    assert.ok(!fs.existsSync(visionPath), "visionProcessor.ts must be deleted (0 importers)");
  });

  it("no production or gate references to visionProcessor remain", () => {
    const gate = read("lib/testGate.ts");
    // The old fileParser/visionProcessor coupling must be gone; the only remaining
    // gate reference is the dedicated #62 dead-code rule mapping to this suite.
    assert.ok(
      !gate.includes('p.includes("lib/fileParser") || p.includes("lib/visionProcessor")'),
      "testGate.ts must not couple fileParser to visionProcessor"
    );
    assert.ok(
      gate.includes('p.includes("lib/visionProcessor")'),
      "testGate.ts must map the deleted visionProcessor.ts to the #62 suite"
    );
    assert.ok(
      gate.includes("tests/deadCodeCleanupJobStoreRetention.test.ts"),
      "testGate.ts must map #62 changes to the dead-code/retention suite"
    );
    const llmTest = read("tests/llmProvider.test.ts");
    assert.ok(
      !llmTest.includes("visionProcessor"),
      "llmProvider.test.ts must not reference visionProcessor"
    );
  });

  it("the 10 zero-caller exports are removed", () => {
    const svg = read("components/SvgViewer.tsx");
    assert.ok(!svg.includes("export function SvgFileCard"), "SvgFileCard must be removed");

    const control = read("lib/board/boardControl.ts");
    assert.ok(
      !control.includes("createBoardControlReader"),
      "createBoardControlReader must be removed"
    );
    assert.ok(
      !control.includes("BoardControlReader"),
      "BoardControlReader interface must be removed"
    );

    const orch = read("lib/board/boardOrchestrator.ts");
    assert.ok(
      !orch.includes("export async function runBoardDrain("),
      "runBoardDrain must be removed"
    );
    assert.ok(orch.includes("runBoardDrainWithMutex"), "runBoardDrainWithMutex must stay");

    const chat = read("lib/chatUtils.ts");
    assert.ok(!chat.includes("bufferSentenceStream"), "bufferSentenceStream must be removed");

    const host = read("lib/hostMode.ts");
    assert.ok(
      !host.includes("export function resolvePendingApproval"),
      "resolvePendingApproval must be removed"
    );
    assert.ok(!host.includes("HOST_RUNNER_BASE_URL"), "HOST_RUNNER_BASE_URL must be removed");
    assert.ok(host.includes("getHostRunnerBaseUrl"), "getHostRunnerBaseUrl must stay");
    // stripQuotedStrings re-export removed; classifier-backed exports stay.
    assert.ok(!host.includes("stripQuotedStrings"), "stripQuotedStrings re-export must be removed");
    assert.ok(
      host.includes("isDestructiveHostAction"),
      "isDestructiveHostAction re-export must stay"
    );

    const morning = read("lib/subagents/morningReport.ts");
    assert.ok(
      !morning.includes("resetCanonicalCheckpointDirCache"),
      "resetCanonicalCheckpointDirCache must be removed"
    );
    assert.ok(morning.includes("getCanonicalCheckpointDir"), "getCanonicalCheckpointDir must stay");

    const residency = read("lib/subagents/residency.ts");
    assert.ok(
      !residency.includes("resolveVramBudgetBytes"),
      "resolveVramBudgetBytes must be removed"
    );

    const pool = read("lib/subagents/workerPool.ts");
    assert.ok(!pool.includes("singleFlightSemaphore"), "singleFlightSemaphore must be removed");
    assert.ok(pool.includes("class Semaphore"), "Semaphore class must stay");
  });
});

describe("JobStore spawn error cleanup and bounded retention", () => {
  it("spawn error handler unregisters the kill fn", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../host-bridge/jobStore.ts"), "utf8");
    const errBlock = src.slice(src.indexOf('proc.on("error"'));
    assert.ok(
      errBlock.includes("store.unregisterKill(rec.id)"),
      "proc error handler must call unregisterKill"
    );
  });

  it("pruneCompleted drops terminal records past retention and deletes spool files", () => {
    const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobstore-prune-"));
    try {
      const store = new JobStore(jobsDir);
      const old = Date.now() - COMPLETED_JOB_RETENTION_MS - 1000;
      const fresh = Date.now();

      const stale = store.create("host_run_powershell", { command: "echo x" }, 1000);
      store.appendSpool(stale.id, "stdout", "hello");
      store.appendSpool(stale.id, "stderr", "oops");
      store.update(stale.id, { status: "done", finishedAt: old });

      const recent = store.create("host_run_powershell", { command: "echo y" }, 1000);
      store.appendSpool(recent.id, "stdout", "keep");
      store.update(recent.id, { status: "failed", finishedAt: fresh });

      const running = store.create("host_run_powershell", { command: "echo z" }, 1000);
      store.update(running.id, { status: "running", startedAt: fresh });

      const pruned = store.pruneCompleted();
      assert.equal(pruned, 1, "only the stale terminal record is pruned");
      assert.equal(store.get(stale.id), undefined, "stale record must be gone");
      assert.ok(store.get(recent.id), "recent terminal record must be kept");
      assert.ok(store.get(running.id), "running record must never be pruned");
      assert.ok(
        !fs.existsSync(store.spoolPath(stale.id, "stdout")),
        "stale stdout spool must be deleted"
      );
      assert.ok(
        !fs.existsSync(store.spoolPath(stale.id, "stderr")),
        "stale stderr spool must be deleted"
      );
      assert.ok(fs.existsSync(store.spoolPath(recent.id, "stdout")), "kept record keeps its spool");

      const persisted = JSON.parse(fs.readFileSync(path.join(jobsDir, "jobs.json"), "utf8"));
      assert.equal(persisted.length, 2, "index must shrink to kept records");
    } finally {
      fs.rmSync(jobsDir, { recursive: true, force: true });
    }
  });

  it("pruneCompleted caps retained terminal records at MAX_COMPLETED_JOB_RECORDS", () => {
    const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobstore-cap-"));
    try {
      const store = new JobStore(jobsDir);
      const now = Date.now();
      for (let i = 0; i < MAX_COMPLETED_JOB_RECORDS + 5; i++) {
        const rec = store.create("host_run_powershell", { command: `echo ${i}` }, 1000);
        store.update(rec.id, {
          status: "done",
          finishedAt: now - (MAX_COMPLETED_JOB_RECORDS + 5 - i) * 1000,
        });
      }
      store.pruneCompleted(now);
      const persisted = JSON.parse(fs.readFileSync(path.join(jobsDir, "jobs.json"), "utf8"));
      assert.ok(
        persisted.length <= MAX_COMPLETED_JOB_RECORDS,
        `index must be capped at ${MAX_COMPLETED_JOB_RECORDS}`
      );
      // Newest records survive the cap.
      const newest = persisted[persisted.length - 1];
      assert.ok(newest.finishedAt >= now - 2000, "newest terminal record must survive the cap");
    } finally {
      fs.rmSync(jobsDir, { recursive: true, force: true });
    }
  });

  it("constructor prunes stale terminal records on daemon restart", () => {
    const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobstore-boot-"));
    try {
      const store = new JobStore(jobsDir);
      const stale = store.create("host_run_powershell", { command: "echo x" }, 1000);
      store.appendSpool(stale.id, "stdout", "x");
      store.update(stale.id, {
        status: "done",
        finishedAt: Date.now() - COMPLETED_JOB_RETENTION_MS - 1000,
      });
      const store2 = new JobStore(jobsDir);
      assert.equal(store2.get(stale.id), undefined, "restart must prune stale terminal records");
      assert.ok(
        !fs.existsSync(store2.spoolPath(stale.id, "stdout")),
        "restart must delete stale spool files"
      );
    } finally {
      fs.rmSync(jobsDir, { recursive: true, force: true });
    }
  });
});
