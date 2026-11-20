import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadStore, markTurnActive, type Thread } from "../lib/threads/threadStore";
import { MAX_AUTO_RESUMES, STALL_WINDOW_MS } from "../lib/threads/inAppSupervisor";

function makeTempStore(): { dir: string; store: ThreadStore; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-wiring-"));
  const store = new ThreadStore(dir);
  return {
    dir,
    store,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    },
  };
}

function makeStalledThread(overrides: Partial<Thread> = {}): Thread {
  const staleIso = new Date(Date.now() - STALL_WINDOW_MS - 60_000).toISOString();
  return {
    id: `thread-${Math.random().toString(36).slice(2, 8)}`,
    title: "Stalled session",
    createdAt: staleIso,
    updatedAt: staleIso,
    status: "active",
    model: "test-model",
    reasoningEffort: "low",
    messages: [
      { id: "m1", role: "user", content: "Do the work", timestamp: staleIso },
      {
        id: "m2",
        role: "assistant",
        content: "Working on it...",
        timestamp: staleIso,
        status: "streaming",
      },
    ],
    ...overrides,
  };
}

describe("inAppSupervisor production wiring (ThreadStore.sweepStalledThreads)", () => {
  it("ends a stalled interactive streaming thread honestly via sweepStalledThreads", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      const thread = makeStalledThread();
      store.saveThread(thread);
      markTurnActive(thread.id);

      const acted = await store.sweepStalledThreads(Date.now() + STALL_WINDOW_MS + 60_000);
      assert.equal(acted, 1);
      const updated = (await store.getThread(thread.id))!;
      assert.equal(updated.status, "stopped");
      assert.match(updated.stalledReason || "", /Turn stalled:/);
      const assistant = updated.messages.find((m) => m.role === "assistant");
      assert.equal(assistant?.status, "incomplete");
      assert.equal(assistant?.isStopped, true);
      assert.match(assistant?.content || "", /Turn stalled:/);
    } finally {
      store.stopSupervisorSweep();
      cleanup();
    }
  });

  it("marks needsAttention when a stalled job thread has no banked state", async () => {
    const { store, cleanup } = makeTempStore();
    try {
      const thread = makeStalledThread({ taskId: "job-no-banked" });
      store.saveThread(thread);
      markTurnActive(thread.id);

      const acted = await store.sweepStalledThreads(Date.now() + STALL_WINDOW_MS + 60_000);
      assert.equal(acted, 1);
      const updated = (await store.getThread(thread.id))!;
      assert.equal(updated.status, "stopped");
      assert.equal(updated.needsAttention, true);
      assert.equal(updated.resumedToThreadId, undefined);
    } finally {
      store.stopSupervisorSweep();
      cleanup();
    }
  });

  it("marks needsAttention when a stalled job thread is at MAX_AUTO_RESUMES", async () => {
    const { dir, store, cleanup } = makeTempStore();
    try {
      const jobId = "job-at-cap";
      // Create banked runlog evidence in the store's workspace
      const runlogDir = path.join(dir, "tasks", jobId);
      fs.mkdirSync(runlogDir, { recursive: true });
      fs.writeFileSync(path.join(runlogDir, "runlog.md"), "# Banked progress\n", "utf8");

      const thread = makeStalledThread({
        taskId: jobId,
        autoResumeCount: MAX_AUTO_RESUMES,
      });
      store.saveThread(thread);
      markTurnActive(thread.id);

      const acted = await store.sweepStalledThreads(Date.now() + STALL_WINDOW_MS + 60_000);
      assert.equal(acted, 1);
      const updated = (await store.getThread(thread.id))!;
      assert.equal(updated.status, "stopped");
      assert.equal(updated.needsAttention, true);
      assert.equal(updated.resumedToThreadId, undefined);
    } finally {
      store.stopSupervisorSweep();
      cleanup();
    }
  });

  it("auto-resumes a stalled job thread with banked state into a fresh thread", async () => {
    const { dir, store, cleanup } = makeTempStore();
    try {
      const jobId = "job-with-banked";
      const runlogDir = path.join(dir, "tasks", jobId);
      fs.mkdirSync(runlogDir, { recursive: true });
      fs.writeFileSync(path.join(runlogDir, "runlog.md"), "# Banked progress\n", "utf8");

      const dispatched: Array<{ threadId: string; prompt: string }> = [];
      store.setSupervisorDispatchTurn((threadId, prompt) => {
        dispatched.push({ threadId, prompt });
      });

      const thread = makeStalledThread({ taskId: jobId, autoResumeCount: 0 });
      store.saveThread(thread);
      markTurnActive(thread.id);

      const acted = await store.sweepStalledThreads(Date.now() + STALL_WINDOW_MS + 60_000);
      assert.equal(acted, 1);
      const updated = (await store.getThread(thread.id))!;
      assert.equal(updated.status, "stopped");
      assert.equal(updated.autoResumeCount, 1);
      assert.ok(updated.resumedToThreadId, "expected resumedToThreadId to be set");
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].threadId, updated.resumedToThreadId);
      assert.match(dispatched[0].prompt, /read the job runlog and `git log`/i);
    } finally {
      store.stopSupervisorSweep();
      cleanup();
    }
  });

  it("dispatches auto-resume to /api/chat with { threadId, messages: [{ role: 'user', content }] }", async () => {
    const { dir, store, cleanup } = makeTempStore();
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const jobId = "job-fetch-contract";
      const runlogDir = path.join(dir, "tasks", jobId);
      fs.mkdirSync(runlogDir, { recursive: true });
      fs.writeFileSync(path.join(runlogDir, "runlog.md"), "# Banked progress\n", "utf8");

      const thread = makeStalledThread({ taskId: jobId, autoResumeCount: 0 });
      store.saveThread(thread);
      markTurnActive(thread.id);

      const acted = await store.sweepStalledThreads(Date.now() + STALL_WINDOW_MS + 60_000);
      assert.equal(acted, 1);
      await new Promise((r) => setTimeout(r, 25));

      const updated = (await store.getThread(thread.id))!;
      assert.ok(updated.resumedToThreadId, "expected resumedToThreadId to be set");
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/api\/chat$/);
      assert.equal(calls[0].init?.method, "POST");

      const parsed = JSON.parse(String(calls[0].init?.body ?? "{}"));
      assert.equal(parsed.threadId, updated.resumedToThreadId);
      assert.equal(parsed.message, undefined);
      assert.ok(Array.isArray(parsed.messages), "expected messages array in /api/chat payload");
      assert.equal(parsed.messages.length, 1);
      assert.equal(parsed.messages[0].role, "user");
      assert.match(parsed.messages[0].content, /read the job runlog and `git log`/i);
    } finally {
      globalThis.fetch = originalFetch;
      store.stopSupervisorSweep();
      cleanup();
    }
  });

  it("surfaces a 400 response from /api/chat on the resumed thread instead of swallowing it", async () => {
    const { dir, store, cleanup } = makeTempStore();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: "Invalid messages payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const jobId = "job-fetch-400";
      const runlogDir = path.join(dir, "tasks", jobId);
      fs.mkdirSync(runlogDir, { recursive: true });
      fs.writeFileSync(path.join(runlogDir, "runlog.md"), "# Banked progress\n", "utf8");

      const thread = makeStalledThread({ taskId: jobId, autoResumeCount: 0 });
      store.saveThread(thread);
      markTurnActive(thread.id);

      const acted = await store.sweepStalledThreads(Date.now() + STALL_WINDOW_MS + 60_000);
      assert.equal(acted, 1);
      await new Promise((r) => setTimeout(r, 25));

      const updated = (await store.getThread(thread.id))!;
      assert.ok(updated.resumedToThreadId, "expected resumedToThreadId to be set");
      const resumed = (await store.getThread(updated.resumedToThreadId!))!;
      assert.equal(resumed.status, "failed");
      assert.equal(resumed.needsAttention, true);
      assert.match(resumed.error || "", /400/);
      assert.match(resumed.error || "", /Invalid messages payload/);
    } finally {
      globalThis.fetch = originalFetch;
      store.stopSupervisorSweep();
      cleanup();
    }
  });
});
