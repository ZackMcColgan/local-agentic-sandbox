import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import ReactDOMServer from "react-dom/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ThreadStore,
  activeExecutionSet,
  markTurnActive,
  TURN_STALL_WINDOW_MS,
  computeTurnLiveness
} from "../lib/threads/threadStore";
import { ThrottledStreamSnapshot, STREAM_SNAPSHOT_INTERVAL_MS } from "../lib/streamSnapshot";
import { ThreadsSidebar } from "../components/ThreadsSidebar";
import type { Thread } from "../lib/threads/threadStore";

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-liveness-test-"));
  return { store: new ThreadStore(dir), dir };
}

/**
 * The stale window must be a real finite constant before any test rewinds
 * updatedAt against it. Without the feature this fails as a clean assertion
 * instead of an opaque `RangeError: Invalid time value` from NaN arithmetic.
 */
function assertStallWindowDefined(): void {
  assert.ok(
    Number.isFinite(TURN_STALL_WINDOW_MS),
    `TURN_STALL_WINDOW_MS must be a finite number (got ${String(TURN_STALL_WINDOW_MS)})`
  );
}

/**
 * TURN-LIVENESS: in-flight turn progress must reach the thread record per round,
 * and the thread list must distinguish ALIVE (fresh heartbeat) from STALLED
 * (no activity past the stale window) from settled states. A live, working turn
 * must never read as 0 chars / 0 traces, and stalled must never read as completed.
 */
describe("TURN-LIVENESS — per-round progress persistence", () => {
  it("(a) mid-turn record read shows non-zero content and traces after a round completes", async () => {
    const { store, dir } = makeStore();
    const thread = store.createThread({ id: "t-round", title: "round progress" });
    activeExecutionSet.add(thread.id);
    markTurnActive(thread.id);
    store.addMessage(thread.id, {
      id: "msg-a",
      role: "assistant",
      content: "",
      status: "streaming",
      timestamp: new Date().toISOString()
    });

    let fakeNow = Date.now();
    const snap = new ThrottledStreamSnapshot(store, thread.id, "msg-a", STREAM_SNAPSHOT_INTERVAL_MS, () => fakeNow);

    // Round 1: model streamed a little text, then executed two tools.
    snap.maybeWrite("Planning the fix. ", undefined, [
      { tool: "workspace_read_file", args: { path: "lib/a.ts" }, result: "ok", durationMs: 12, timestamp: new Date().toISOString() },
      { tool: "workspace_write_file", args: { path: "lib/b.ts" }, result: "written", durationMs: 30, timestamp: new Date().toISOString() }
    ]);

    // Round boundary write must land even inside the throttle window: rounds are
    // discrete progress events, not token churn.
    fakeNow += 10;
    const forced = snap.maybeWrite(
      "Planning the fix. Patch applied to lib/b.ts. ",
      undefined,
      [
        { tool: "workspace_read_file", args: { path: "lib/a.ts" }, result: "ok", durationMs: 12, timestamp: new Date().toISOString() },
        { tool: "workspace_write_file", args: { path: "lib/b.ts" }, result: "written", durationMs: 30, timestamp: new Date().toISOString() },
        { tool: "workspace_run_command", args: { command: "npm run test:gate" }, result: "green", durationMs: 4000, timestamp: new Date().toISOString() }
      ],
      { force: true }
    );
    assert.equal(forced, true, "round-boundary snapshot must bypass the token throttle");

    // Independent reader (second client / driver zombie-check path): must see real work.
    const reader = new ThreadStore(dir);
    const mid = await reader.getThread(thread.id);
    assert.ok(mid, "thread must exist for the reader");
    const last = mid.messages[mid.messages.length - 1];
    assert.equal(last.role, "assistant");
    assert.equal(last.status, "streaming", "in-flight message must still read streaming");
    assert.ok(last.content.length > 0, "mid-turn read must show non-zero content");
    assert.ok(Array.isArray(last.traces) && last.traces!.length === 3, "mid-turn read must show accumulated traces");
    assert.equal(mid.status, "active", "live turn must read active, not stopped");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(b) a fresh streaming turn reads ALIVE", async () => {
    const { store, dir } = makeStore();
    const thread = store.createThread({ id: "t-alive", title: "fresh heartbeat" });
    activeExecutionSet.add(thread.id);
    markTurnActive(thread.id);
    store.addMessage(thread.id, {
      id: "msg-a",
      role: "assistant",
      content: "working...",
      status: "streaming",
      timestamp: new Date().toISOString()
    });

    const reader = new ThreadStore(dir);
    const t = await reader.getThread(thread.id);
    assert.ok(t);
    assert.equal(t.liveness, "alive", "fresh streaming turn must carry liveness=alive on the record");
    assert.equal(computeTurnLiveness(t, Date.now()), "alive");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(c) a stale streaming turn reads STALLED, never completed", async () => {
    assertStallWindowDefined();
    const { store, dir } = makeStore();
    const thread = store.createThread({ id: "t-stalled", title: "stale heartbeat" });
    activeExecutionSet.add(thread.id);
    markTurnActive(thread.id);
    store.addMessage(thread.id, {
      id: "msg-a",
      role: "assistant",
      content: "partial work",
      status: "streaming",
      timestamp: new Date().toISOString()
    });

    // Rewind updatedAt past the stale window while the turn is still registered live.
    const file = store.getFilePath(thread.id);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.updatedAt = new Date(Date.now() - TURN_STALL_WINDOW_MS - 5000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));

    const reader = new ThreadStore(dir);
    const t = await reader.getThread(thread.id);
    assert.ok(t);
    assert.equal(t.status, "active", "a live-but-stale turn must stay active (not reconciled to stopped/completed)");
    assert.equal(t.liveness, "stalled", "stale streaming turn must carry liveness=stalled");
    assert.equal(computeTurnLiveness(t, Date.now()), "stalled");

    // A settled completed thread is never stalled/alive.
    const done = store.createThread({ id: "t-done", title: "done" });
    store.addMessage(done.id, {
      id: "msg-b",
      role: "assistant",
      content: "final",
      status: "completed",
      timestamp: new Date().toISOString()
    });
    const tDone = await reader.getThread(done.id);
    assert.equal(tDone!.liveness, "settled", "completed turn must read settled");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(d) LIVE CLIENT end-state: thread list renders in-flight progress + liveness badge", async () => {
    assertStallWindowDefined();
    const { store, dir } = makeStore();
    const alive = store.createThread({ id: "t-ui-alive", title: "alive session" });
    activeExecutionSet.add(alive.id);
    store.addMessage(alive.id, {
      id: "msg-a",
      role: "assistant",
      content: "accumulated work text",
      status: "streaming",
      timestamp: new Date().toISOString(),
      traces: [{ tool: "workspace_write_file", args: { path: "x.ts" }, result: "ok", durationMs: 5, timestamp: new Date().toISOString() }]
    });

    const stalled = store.createThread({ id: "t-ui-stalled", title: "stalled session" });
    activeExecutionSet.add(stalled.id);
    store.addMessage(stalled.id, {
      id: "msg-b",
      role: "assistant",
      content: "older work",
      status: "streaming",
      timestamp: new Date().toISOString()
    });
    const stalledFile = store.getFilePath(stalled.id);
    const raw = JSON.parse(fs.readFileSync(stalledFile, "utf8"));
    raw.updatedAt = new Date(Date.now() - TURN_STALL_WINDOW_MS - 5000).toISOString();
    fs.writeFileSync(stalledFile, JSON.stringify(raw, null, 2));

    const completed = store.createThread({ id: "t-ui-done", title: "completed session" });
    store.addMessage(completed.id, {
      id: "msg-c",
      role: "assistant",
      content: "finished",
      status: "completed",
      timestamp: new Date().toISOString()
    });

    // Exactly the payload shape GET /api/threads returns (listThreads reconciles + stamps liveness).
    const threads: Thread[] = await new ThreadStore(dir).listThreads();
    const html = ReactDOMServer.renderToString(
      React.createElement(ThreadsSidebar, {
        threads,
        selectedThreadId: null,
        onSelectThread: () => {},
        onNewThread: () => {},
        onDeleteThread: () => {}
      })
    );

    assert.match(html, /data-testid="thread-liveness-t-ui-alive"[^>]*>.*Alive/, "alive streaming row must render an Alive badge");
    assert.match(html, /data-testid="thread-liveness-t-ui-stalled"[^>]*>.*Stalled/, "stale streaming row must render a Stalled badge");
    assert.match(html, /data-testid="thread-progress-t-ui-alive"[^>]*>.*19 chars/, "alive row must render real in-flight char count");
    assert.match(html, /data-testid="thread-progress-t-ui-alive"[^>]*>.*1 traces/, "alive row must render real trace count");
    assert.doesNotMatch(html, /thread-liveness-t-ui-done/, "settled rows must not carry a liveness badge");
    assert.match(html, /Completed/, "completed row still reads Completed (stalled must not conflate with completed)");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("server wiring: chat route persists traces at round boundaries and touches the heartbeat", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../app/api/chat/route.ts"), "utf8");
    // Loose call-shape assertions: the call may wrap across lines, the traces
    // accumulator may be camelCased (accumulatedTraces / roundTraces), and the
    // options object may carry extra keys. Intent asserted unchanged:
    // a traces argument plus force: true on a maybeWrite call.
    assert.match(
      src,
      /streamSnapshot\s*\.\s*maybeWrite\s*\([^)]*[Tt]races[^)]*\{[^}]*\bforce\s*:\s*true\b[^}]*\}/,
      "round boundary must force-persist accumulated traces"
    );
    assert.match(
      src,
      /touchActiveTurn\s*\(\s*activeThreadId\s*\)/,
      "round boundary must refresh the turn heartbeat"
    );
    const storeSrc = fs.readFileSync(path.resolve(__dirname, "../lib/threads/threadStore.ts"), "utf8");
    assert.match(storeSrc, /export\s+const\s+TURN_STALL_WINDOW_MS\b/, "store must export the stale window constant");
    // Accepts either export form (function declaration or arrow const).
    assert.match(
      storeSrc,
      /export\s+(?:const|function)\s+computeTurnLiveness\b/,
      "store must export the liveness derivation"
    );
    // Thread record carries a liveness field; the alive/stalled/settled union may
    // be expressed inline or via a named type alias, so the members are matched
    // across the file rather than against one exact literal layout.
    assert.match(storeSrc, /\bliveness\?\s*:/, "Thread record must carry a liveness field");
    assert.match(storeSrc, /"alive"[\s\S]*"stalled"[\s\S]*"settled"/, "liveness must be the alive/stalled/settled union");
  });
});
