import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadStore, markTurnActive, clearTurnActive } from "../lib/threads/threadStore";
import { mergeThreadsIntoBoard } from "../lib/board/mergeThreadsIntoBoard";
import { STALL_WINDOW_MS } from "../lib/threads/inAppSupervisor";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeThreadFile(dir: string, thread: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${thread.id}.json`), JSON.stringify(thread), "utf8");
}

test("A1: sweepStalledThreads with no candidates does not call listThreads or getThread", async () => {
  const dir = makeTempDir("sweep-a1-");
  try {
    const now = Date.now();
    const oldIso = new Date(now - STALL_WINDOW_MS - 60_000).toISOString();
    writeThreadFile(dir, {
      id: "t-settled-1",
      title: "Settled 1",
      status: "completed",
      createdAt: oldIso,
      updatedAt: oldIso,
      messages: [{ id: "m1", role: "user", content: "hi", createdAt: oldIso }],
    });
    writeThreadFile(dir, {
      id: "t-settled-2",
      title: "Settled 2",
      status: "stopped",
      createdAt: oldIso,
      updatedAt: oldIso,
      messages: [{ id: "m2", role: "assistant", content: "done", status: "complete", createdAt: oldIso }],
    });

    const store = new ThreadStore(dir);
    // Warm summary cache
    await store.listThreadSummaries();

    let listCalls = 0;
    let getCalls = 0;
    store.listThreads = async () => {
      listCalls += 1;
      return [];
    };
    const origGet = store.getThread.bind(store);
    store.getThread = async (id: string) => {
      getCalls += 1;
      return origGet(id);
    };

    const acted = await store.sweepStalledThreads(now + STALL_WINDOW_MS + 60_000);
    assert.equal(acted, 0);
    assert.equal(listCalls, 0, "sweepStalledThreads must not call listThreads");
    assert.equal(getCalls, 0, "sweepStalledThreads must not call getThread when there are no candidates");
  } finally {
    clearTurnActive("t-stale-active");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A2: sweepStalledThreads with one stale active candidate loads only that candidate via getThread", async () => {
  const dir = makeTempDir("sweep-a2-");
  try {
    const now = Date.now();
    const staleIso = new Date(now - STALL_WINDOW_MS - 60_000).toISOString();
    writeThreadFile(dir, {
      id: "t-settled",
      title: "Settled",
      status: "completed",
      createdAt: staleIso,
      updatedAt: staleIso,
      messages: [{ id: "m1", role: "user", content: "hi", createdAt: staleIso }],
    });
    writeThreadFile(dir, {
      id: "t-stale-active",
      title: "Stale Active",
      status: "active",
      createdAt: staleIso,
      updatedAt: staleIso,
      messages: [
        { id: "m1", role: "user", content: "run", createdAt: staleIso },
        { id: "m2", role: "assistant", content: "working...", status: "streaming", createdAt: staleIso },
      ],
    });

    const store = new ThreadStore(dir);
    await store.listThreadSummaries();
    markTurnActive("t-job-stale");
    markTurnActive("t-msg-streaming");
    markTurnActive("t-stale-active");

    let listCalls = 0;
    const getIds: string[] = [];
    store.listThreads = async () => {
      listCalls += 1;
      return [];
    };
    const origGet = store.getThread.bind(store);
    store.getThread = async (id: string) => {
      getIds.push(id);
      return origGet(id);
    };

    const acted = await store.sweepStalledThreads(now + STALL_WINDOW_MS + 60_000);
    assert.equal(acted, 1);
    assert.equal(listCalls, 0, "sweepStalledThreads must not call listThreads");
    assert.deepEqual(getIds, ["t-stale-active"]);

    const updated = await origGet("t-stale-active");
    assert.ok(updated);
    assert.equal(updated.status, "stopped");
    assert.ok(updated.stalledReason);
    assert.equal(updated.messages[1].status, "incomplete");
  } finally {
    clearTurnActive("t-stale-active");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A3: message-level streaming on a non-active thread is still detected and ended honestly", async () => {
  const dir = makeTempDir("sweep-a3-");
  try {
    const now = Date.now();
    const staleIso = new Date(now - STALL_WINDOW_MS - 60_000).toISOString();
    writeThreadFile(dir, {
      id: "t-msg-streaming",
      title: "Msg Streaming",
      status: "completed",
      createdAt: staleIso,
      updatedAt: staleIso,
      messages: [
        { id: "m1", role: "user", content: "hello", createdAt: staleIso },
        { id: "m2", role: "assistant", content: "partial...", status: "streaming", createdAt: staleIso },
      ],
    });

    const store = new ThreadStore(dir);
    await store.listThreadSummaries();
    markTurnActive("t-job-stale");
    markTurnActive("t-msg-streaming");
    markTurnActive("t-stale-active");

    let listCalls = 0;
    store.listThreads = async () => {
      listCalls += 1;
      return [];
    };

    const acted = await store.sweepStalledThreads(now + STALL_WINDOW_MS + 60_000);
    assert.equal(acted, 1);
    assert.equal(listCalls, 0);

    const updated = await store.getThread("t-msg-streaming");
    assert.ok(updated);
    assert.equal(updated.status, "stopped");
    assert.ok(updated.stalledReason);
    assert.equal(updated.messages[1].status, "incomplete");
  } finally {
    clearTurnActive("t-stale-active");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A4: mergeThreadsIntoBoard uses summaries, never calls listThreads, and handles ghost tasks", async () => {
  const dir = makeTempDir("sweep-a4-");
  const checkpointDir = path.join(dir, "checkpoints");
  fs.mkdirSync(checkpointDir, { recursive: true });
  const prevEnv = process.env.THREADS_DIR;
  const prevCheckpointEnv = process.env.AGENT_CHECKPOINT_DIR;
  process.env.THREADS_DIR = dir;
  process.env.AGENT_CHECKPOINT_DIR = checkpointDir;
  const origListThreads = ThreadStore.prototype.listThreads;
  try {
    const nowIso = new Date().toISOString();
    writeThreadFile(dir, {
      id: "t-board-1",
      title: "Board Thread",
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
      messages: [{ id: "m1", role: "user", content: "hi", createdAt: nowIso }],
    });

    // Checkpoint-task ghost fixture (supervisor task with no thread file)
    fs.writeFileSync(
      path.join(checkpointDir, "ghost-task-1-checkpoint.json"),
      JSON.stringify({
        taskId: "ghost-task-1",
        goal: "Ghost supervisor task goal",
        status: "running",
        startedAt: nowIso,
        updatedAt: nowIso,
      }),
      "utf8",
    );

    ThreadStore.prototype.listThreads = async () => {
      throw new Error("listThreads must not be called by mergeThreadsIntoBoard");
    };

    const merged = await mergeThreadsIntoBoard([]);
    const ids = merged.map((i) => i.id);
    assert.ok(ids.includes("t-board-1"));
    const item = merged.find((i) => i.id === "t-board-1");
    assert.equal(item?.status, "working");
    assert.equal(item?.title, "Board Thread");

    assert.ok(ids.includes("thread-ghost-task-1"), "ghost task must be synthesized into board");
    const ghostItem = merged.find((i) => i.id === "thread-ghost-task-1");
    assert.equal(ghostItem?.title, "Ghost supervisor task goal");
    assert.equal(ghostItem?.status, "queued");
  } finally {
    ThreadStore.prototype.listThreads = origListThreads;
    if (prevEnv === undefined) delete process.env.THREADS_DIR;
    else process.env.THREADS_DIR = prevEnv;
    if (prevCheckpointEnv === undefined) delete process.env.AGENT_CHECKPOINT_DIR;
    else process.env.AGENT_CHECKPOINT_DIR = prevCheckpointEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A5: listThreadSummaries(query) matches title, preview, and body without calling listThreads", async () => {
  const dir = makeTempDir("sweep-a5-");
  try {
    const t1 = "2026-11-17T00:01:00.000Z";
    const t2 = "2026-11-17T00:02:00.000Z";
    const t3 = "2026-11-17T00:03:00.000Z";

    writeThreadFile(dir, {
      id: "t-title",
      title: "Quantum Needle",
      status: "completed",
      createdAt: t3,
      updatedAt: t3,
      messages: [{ id: "m1", role: "user", content: "unrelated text", createdAt: t3 }],
    });
    writeThreadFile(dir, {
      id: "t-preview",
      title: "Normal Title",
      status: "completed",
      createdAt: t2,
      updatedAt: t2,
      messages: [{ id: "m1", role: "assistant", content: "last message has needle here", createdAt: t2 }],
    });
    writeThreadFile(dir, {
      id: "t-body",
      title: "Another Title",
      status: "completed",
      createdAt: t1,
      updatedAt: t1,
      messages: [
        { id: "m1", role: "user", content: "early message with needle inside body", createdAt: t1 },
        { id: "m2", role: "assistant", content: "final reply without keyword", createdAt: t1 },
      ],
    });
    writeThreadFile(dir, {
      id: "t-miss",
      title: "Unrelated",
      status: "completed",
      createdAt: t1,
      updatedAt: t1,
      messages: [{ id: "m1", role: "user", content: "nothing here", createdAt: t1 }],
    });

    const store = new ThreadStore(dir);
    let listCalls = 0;
    store.listThreads = async () => {
      listCalls += 1;
      return [];
    };

    const results = await store.listThreadSummaries("needle");
    assert.equal(listCalls, 0, "listThreadSummaries(query) must not call listThreads");
    assert.deepEqual(
      results.map((r) => r.id),
      ["t-title", "t-preview", "t-body"],
    );
    assert.equal(results[0].matchSnippet, undefined);
    assert.equal(results[1].matchSnippet, "last message has needle here");
    assert.equal(results[2].matchSnippet, "early message with needle inside body");
  } finally {
    clearTurnActive("t-stale-active");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A6: sweepStalledThreads does not block the event loop (>1000ms) on large store", async () => {
  const dir = makeTempDir("sweep-a6-");
  try {
    const now = Date.now();
    const oldIso = new Date(now - STALL_WINDOW_MS - 60_000).toISOString();
    const bigContent = "x".repeat(400_000);
    for (let i = 0; i < 40; i++) {
      writeThreadFile(dir, {
        id: `t-big-${i}`,
        title: `Big ${i}`,
        status: "completed",
        createdAt: oldIso,
        updatedAt: oldIso,
        messages: [{ id: "m1", role: "assistant", content: bigContent, status: "complete", createdAt: oldIso }],
      });
    }

    const store = new ThreadStore(dir);
    await store.listThreadSummaries();
    markTurnActive("t-job-stale");
    markTurnActive("t-msg-streaming");
    markTurnActive("t-stale-active");

    let timerLagMs = 0;
    const start = Date.now();
    const timerPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerLagMs = Date.now() - start;
        resolve();
      }, 25);
    });

    const sweepPromise = store.sweepStalledThreads(now);
    await Promise.all([timerPromise, sweepPromise]);
    assert.ok(timerLagMs < 1000, `Expected event-loop timer lag < 1000ms, got ${timerLagMs}ms`);
  } finally {
    clearTurnActive("t-stale-active");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A7: auto-resume for stale streaming JOB thread is preserved", async () => {
  const dir = makeTempDir("sweep-a7-");
  try {
    const now = Date.now();
    const staleIso = new Date(now - STALL_WINDOW_MS - 60_000).toISOString();
    const jobId = "job-auto-1";
    const taskDir = path.join(dir, "tasks", jobId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "runlog.md"), "# Runlog\nStep 1 done.\n", "utf8");

    writeThreadFile(dir, {
      id: "t-job-stale",
      title: "Job Thread",
      status: "active",
      taskId: jobId,
      autoResumeCount: 0,
      createdAt: staleIso,
      updatedAt: staleIso,
      messages: [
        { id: "m1", role: "user", content: "do job", createdAt: staleIso },
        { id: "m2", role: "assistant", content: "working...", status: "streaming", createdAt: staleIso },
      ],
    });

    const store = new ThreadStore(dir);
    await store.listThreadSummaries();
    markTurnActive("t-job-stale");
    markTurnActive("t-msg-streaming");
    markTurnActive("t-stale-active");

    const acted = await store.sweepStalledThreads(now + STALL_WINDOW_MS + 60_000);
    assert.equal(acted, 1);

    const oldThread = await store.getThread("t-job-stale");
    assert.ok(oldThread);
    assert.equal(oldThread.status, "stopped");

    const allSummaries = await store.listThreadSummaries();
    assert.equal(allSummaries.length, 2, "auto-resume should have created a fresh thread");
  } finally {
    clearTurnActive("t-stale-active");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
