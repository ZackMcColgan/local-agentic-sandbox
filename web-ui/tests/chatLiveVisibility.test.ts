import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadStore, activeExecutionSet } from "../lib/threads/threadStore";
import {
  ThrottledStreamSnapshot,
  STREAM_SNAPSHOT_INTERVAL_MS,
  STREAM_POLL_INTERVAL_MS,
  isLiveStreamingMessage
} from "../lib/streamSnapshot";

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat8-live-test-"));
  return { store: new ThreadStore(dir), dir };
}

describe("CHAT-8 — live mid-turn streaming visibility", () => {
  it("snapshot writes are throttled to at most one per interval", () => {
    const { store, dir } = makeStore();
    const thread = store.createThread({ id: "t-throttle", title: "throttle test" });
    let fakeNow = 1000;
    const snap = new ThrottledStreamSnapshot(store, thread.id, "msg-a", STREAM_SNAPSHOT_INTERVAL_MS, () => fakeNow);
    assert.equal(snap.maybeWrite("first"), true, "first write must land immediately");
    fakeNow += 500;
    assert.equal(snap.maybeWrite("first second"), false, "write inside the 1s window must be skipped");
    fakeNow += 501;
    assert.equal(snap.maybeWrite("first second third"), true, "write past the window must land");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mid-turn partial content is visible to a second client, then converges on terminal status", async () => {
    const { store, dir } = makeStore();
    const thread = store.createThread({ id: "t-live", title: "two-client test" });
    activeExecutionSet.add(thread.id); // CHAT-8: the running turn registers the thread as live

    let fakeNow = 0;
    const snap = new ThrottledStreamSnapshot(store, thread.id, "msg-a", STREAM_SNAPSHOT_INTERVAL_MS, () => fakeNow);
    fakeNow = 1000;
    snap.maybeWrite("alpha");
    fakeNow = 2000;
    snap.maybeWrite("alpha beta");

    // Client B: independent ThreadStore instance against the same directory.
    const reader = new ThreadStore(dir);
    const mid = await reader.getThread(thread.id);
    assert.ok(mid, "thread must exist for client B");
    const last = mid.messages[mid.messages.length - 1];
    assert.equal(last.role, "assistant");
    assert.equal(last.status, "streaming", "mid-turn snapshot must carry streaming status");
    assert.equal(last.content, "alpha beta", "partial content must be visible mid-turn");
    assert.notEqual(last.isStopped, true, "live registration must protect the message from stop-reconciliation");
    assert.equal(mid.status, "active", "live registration must keep the thread honestly active");

    fakeNow = 3000;
    snap.maybeWrite("alpha beta gamma");
    const mid2 = await reader.getThread(thread.id);
    assert.equal(mid2!.messages[mid2!.messages.length - 1].content, "alpha beta gamma", "partial content must grow");

    // Terminal persistence upserts the same message id -> convergence.
    store.addMessage(thread.id, {
      id: "msg-a",
      role: "assistant",
      content: "alpha beta gamma — final answer",
      status: "completed",
      timestamp: new Date().toISOString()
    });
    activeExecutionSet.delete(thread.id);
    const final = await reader.getThread(thread.id);
    const assistantMsgs = final!.messages.filter((m) => m.role === "assistant");
    assert.equal(assistantMsgs.length, 1, "snapshot and final answer must be one message (upsert by id)");
    assert.equal(assistantMsgs[0].status, "completed", "status must flip from streaming to completed");
    assert.equal(assistantMsgs[0].content, "alpha beta gamma — final answer", "final content must replace partial content");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("unregistered active thread reconciles to stopped (why live registration is required)", async () => {
    const { store, dir } = makeStore();
    const thread = store.createThread({ id: "t-orphan", title: "orphan test" });
    store.addMessage(thread.id, {
      id: "msg-a",
      role: "assistant",
      content: "partial without registration",
      status: "streaming",
      timestamp: new Date().toISOString()
    });
    const reader = new ThreadStore(dir);
    const t = await reader.getThread(thread.id);
    assert.equal(t!.status, "stopped", "an active thread with no live execution must honestly read stopped");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("isLiveStreamingMessage gates client polling", () => {
    assert.equal(isLiveStreamingMessage({ role: "assistant", status: "streaming" }), true);
    assert.equal(isLiveStreamingMessage({ role: "assistant", status: "completed" }), false);
    assert.equal(isLiveStreamingMessage({ role: "assistant", status: "error" }), false);
    assert.equal(isLiveStreamingMessage({ role: "user", status: "streaming" }), false);
    assert.equal(isLiveStreamingMessage(undefined), false);
    assert.equal(isLiveStreamingMessage(null), false);
  });

  it("intervals match the brief: ~1s server snapshot, ~1.5s client poll", () => {
    assert.equal(STREAM_SNAPSHOT_INTERVAL_MS, 1000);
    assert.equal(STREAM_POLL_INTERVAL_MS, 1500);
  });

  it("server wiring: /api/chat registers the thread live and snapshots both token loops", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../app/api/chat/route.ts"), "utf8");
    assert.match(src, /activeExecutionSet\.add\(activeThreadId\)/, "route must register the thread id as live execution");
    assert.match(src, /activeExecutionSet\.delete\(activeThreadId\)/, "route must unregister in cleanup");
    const writes = src.match(/streamSnapshot\.maybeWrite\(/g);
    assert.ok(writes && writes.length >= 2, "both the tool-round loop and the synthesis loop must snapshot");
  });

  it("client wiring: page.tsx polls the thread while the latest assistant message is streaming", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../app/page.tsx"), "utf8");
    assert.match(src, /STREAM_POLL_INTERVAL_MS/, "page must use the shared poll interval constant");
    assert.match(src, /isLiveStreamingMessage/, "page must gate polling on streaming status");
    assert.match(src, /\/api\/threads\/\$\{selectedThreadId\}/, "page must poll the selected thread endpoint");
  });

  it("status unions include streaming and the badge renders it honestly", () => {
    const storeSrc = fs.readFileSync(path.resolve(__dirname, "../lib/threads/threadStore.ts"), "utf8");
    assert.match(storeSrc, /status\?: "completed" \| "incomplete" \| "error" \| "streaming"/, "ThreadMessage.status must allow streaming");
    const streamSrc = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
    assert.match(streamSrc, /status\?: "completed" \| "incomplete" \| "error" \| "streaming"/, "ChatMessage.status must allow streaming");
    assert.match(streamSrc, /m\.status === "streaming"/, "a streaming badge must render");
  });
});
