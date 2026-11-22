import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadStore, activeExecutionSet } from "../lib/threads/threadStore";

describe("listThreadSummaries avoids re-reading full thread bodies", () => {
  let tmpDir: string;
  let store: ThreadStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-summaries-cache-"));
    store = new ThreadStore(tmpDir);
    const t = await store.createThread({
      title: "Cached summary test",
      model: "test-model",
    });
    store.addMessage(t.id, {
      id: "u1",
      role: "user",
      content: "Hello world",
      timestamp: new Date().toISOString(),
    });
    store.addMessage(t.id, {
      id: "a1",
      role: "assistant",
      content: "Hi there!",
      timestamp: new Date().toISOString(),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns identical summary shape without reading full thread JSON on subsequent calls", async () => {
    const first = await store.listThreadSummaries();
    assert.equal(first.length, 1);
    assert.equal(first[0].title, "Cached summary test");

    let threadFileReads = 0;
    const origReadFile = fs.promises.readFile;
    const promisesMutable = fs.promises as unknown as { readFile: typeof fs.promises.readFile };
    promisesMutable.readFile = (async (
      p: Parameters<typeof fs.promises.readFile>[0],
      options?: Parameters<typeof fs.promises.readFile>[1]
    ) => {
      if (String(p).endsWith(".json") && !String(p).includes(".summaries-cache")) {
        threadFileReads++;
      }
      return origReadFile.call(fs.promises, p, options);
    }) as typeof fs.promises.readFile;

    try {
      const second = await store.listThreadSummaries();
      assert.deepEqual(second, first);
      assert.equal(
        threadFileReads,
        0,
        `Expected 0 full thread file reads on cached listThreadSummaries(), got ${threadFileReads}`
      );
    } finally {
      promisesMutable.readFile = origReadFile;
    }
  });

  it("FP1(a): sorts threads with different ISO updatedAt timestamps newest-first", async () => {
    const older = await store.createThread({
      title: "Older thread",
      model: "test-model",
    });
    store.addMessage(older.id, {
      id: "u1",
      role: "user",
      content: "old",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const newer = await store.createThread({
      title: "Newer thread",
      model: "test-model",
    });
    store.addMessage(newer.id, {
      id: "u2",
      role: "user",
      content: "new",
      timestamp: "2026-01-02T00:00:00.000Z",
    });

    // Manually set distinct updatedAt timestamps in the thread files
    for (const [t, ts] of [
      [older, "2026-01-01T10:00:00.000Z"],
      [newer, "2026-01-02T10:00:00.000Z"],
    ] as const) {
      const fp = path.join(tmpDir, `${t.id}.json`);
      const data = JSON.parse(fs.readFileSync(fp, "utf8"));
      data.updatedAt = ts;
      fs.writeFileSync(fp, JSON.stringify(data));
    }

    const list = await store.listThreadSummaries();
    const titles = list.map((s) => s.title);
    assert.ok(
      titles.indexOf("Newer thread") < titles.indexOf("Older thread"),
      `Expected Newer before Older, got ${titles.join(", ")}`
    );
  });

  it("FP1(b): a fresh ThreadStore instance serves listThreadSummaries from .summaries-index.json with 0 full thread reads", async () => {
    const first = await store.listThreadSummaries();
    assert.equal(first.length, 1);
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".summaries-index.json")),
      "Expected .summaries-index.json to be created"
    );

    const freshStore = new ThreadStore(tmpDir);
    let threadFileReads = 0;
    const origReadFile = fs.promises.readFile;
    const promisesMutable = fs.promises as unknown as { readFile: typeof fs.promises.readFile };
    promisesMutable.readFile = (async (
      p: Parameters<typeof fs.promises.readFile>[0],
      options?: Parameters<typeof fs.promises.readFile>[1]
    ) => {
      const s = String(p);
      if (
        s.endsWith(".json") &&
        !s.endsWith(".summaries-index.json") &&
        !s.includes(".summaries-cache")
      ) {
        threadFileReads++;
      }
      return origReadFile.call(fs.promises, p, options);
    }) as typeof fs.promises.readFile;

    try {
      const second = await freshStore.listThreadSummaries();
      assert.deepEqual(second, first);
      assert.equal(
        threadFileReads,
        0,
        `Expected 0 full thread reads on fresh store, got ${threadFileReads}`
      );
    } finally {
      promisesMutable.readFile = origReadFile;
    }
  });

  it("FP1(c): cached path still reconciles live status when activeExecutionSet changes without file mtime changing", async () => {
    const runningThread = await store.createThread({
      title: "Running thread",
      model: "test-model",
    });
    store.addMessage(runningThread.id, {
      id: "u1",
      role: "user",
      content: "run",
      timestamp: new Date().toISOString(),
    });

    activeExecutionSet.add(runningThread.id);
    try {
      const first = await store.listThreadSummaries();
      const found1 = first.find((s) => s.id === runningThread.id);
      assert.equal(found1?.status, "running");
    } finally {
      activeExecutionSet.delete(runningThread.id);
    }

    // Now activeExecutionSet no longer has runningThread.id, and file mtime did NOT change.
    const second = await store.listThreadSummaries();
    const found2 = second.find((s) => s.id === runningThread.id);
    assert.notEqual(
      found2?.status,
      "running",
      "Expected cached summary to reconcile status when execution is no longer active"
    );
  });
});

describe("AUD-12: reconcileSummaryStatus honest status reconciliation", () => {
  let tmpDir: string;
  let store: ThreadStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-reconcile-status-"));
    store = new ThreadStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFixtureThread(id: string, overrides: Record<string, unknown> = {}): void {
    const now = new Date().toISOString();
    const data = {
      id,
      title: `Fixture ${id}`,
      status: "running",
      createdAt: now,
      updatedAt: now,
      model: "test-model",
      reasoningEffort: "medium",
      messages: [
        { id: "u1", role: "user", content: "Do work", timestamp: now },
        { id: "a1", role: "assistant", content: "Working...", timestamp: now },
      ],
      ...overrides,
    };
    fs.writeFileSync(path.join(tmpDir, `${id}.json`), JSON.stringify(data), "utf8");
  }

  function writeCheckpoint(taskId: string, status: string): void {
    const cpPath = (
      store as unknown as { supervisor: { getCheckpointFilePath: (id: string) => string } }
    ).supervisor.getCheckpointFilePath(taskId);
    fs.mkdirSync(path.dirname(cpPath), { recursive: true });
    fs.writeFileSync(cpPath, JSON.stringify({ taskId, status }), "utf8");
  }

  it("maps dead running thread with messages and no error/checkpoint to stopped, never completed", async () => {
    writeFixtureThread("dead-running-no-evidence", { status: "running" });
    const summaries = await store.listThreadSummaries();
    const found = summaries.find((s) => s.id === "dead-running-no-evidence");
    assert.equal(found?.status, "stopped");
  });

  it("maps dead running thread with error set to failed", async () => {
    writeFixtureThread("dead-running-error", { status: "running", error: "Process crashed" });
    const summaries = await store.listThreadSummaries();
    const found = summaries.find((s) => s.id === "dead-running-error");
    assert.equal(found?.status, "failed");
  });

  it("maps dead running task thread with paused checkpoint to paused", async () => {
    const taskId = "task-paused-1";
    writeFixtureThread("dead-running-paused", { status: "running", taskId });
    writeCheckpoint(taskId, "paused");
    const summaries = await store.listThreadSummaries();
    const found = summaries.find((s) => s.id === "dead-running-paused");
    assert.equal(found?.status, "paused");
  });

  it("maps dead running task thread with completed checkpoint to completed", async () => {
    const taskId = "task-completed-1";
    writeFixtureThread("dead-running-completed-cp", { status: "running", taskId });
    writeCheckpoint(taskId, "completed");
    const summaries = await store.listThreadSummaries();
    const found = summaries.find((s) => s.id === "dead-running-completed-cp");
    assert.equal(found?.status, "completed");
  });

  it("keeps actively-running thread in activeExecutionSet as running", async () => {
    writeFixtureThread("live-running", { status: "running" });
    activeExecutionSet.add("live-running");
    try {
      const summaries = await store.listThreadSummaries();
      const found = summaries.find((s) => s.id === "live-running");
      assert.equal(found?.status, "running");
    } finally {
      activeExecutionSet.delete("live-running");
    }
  });

  it("keeps genuinely completed thread as completed", async () => {
    writeFixtureThread("genuinely-completed", { status: "completed" });
    const summaries = await store.listThreadSummaries();
    const found = summaries.find((s) => s.id === "genuinely-completed");
    assert.equal(found?.status, "completed");
  });

  it("does not persist fabricated completed status into .summaries-index.json for dead running thread", async () => {
    writeFixtureThread("dead-running-persist-check", { status: "running" });
    await store.listThreadSummaries();
    const indexPath = path.join(tmpDir, ".summaries-index.json");
    assert.ok(fs.existsSync(indexPath), "Expected .summaries-index.json to exist");
    const indexData = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const entry = indexData["dead-running-persist-check.json"];
    assert.ok(entry, "Expected dead-running-persist-check.json in .summaries-index.json");
    assert.notEqual(entry.summary?.status, "completed");
  });
});
