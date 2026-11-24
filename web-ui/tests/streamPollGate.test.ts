import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import {
  STREAM_POLL_QUIET_WINDOW_MS,
  isSseStreamDelivering,
  shouldPollLiveThread,
} from "../lib/streamPollGate";
import { STREAM_POLL_INTERVAL_MS } from "../lib/streamSnapshot";

/**
 * PERF-P4 (#128): during a live turn the page poll fetched the FULL thread JSON
 * every 1,500 ms while the SSE stream was already delivering every chunk to the
 * same `messages` state on the same 1-vCPU event loop. The poll must be
 * suppressed while the stream is actively delivering chunks and resume once the
 * stream goes quiet or ends. The gate predicate is extracted to
 * lib/streamPollGate.ts so the arithmetic is testable without a browser; wiring
 * is asserted against source (same pattern as reconcilePollBackoff.test.ts).
 */
test("quiet window equals the existing poll interval constant", () => {
  assert.equal(STREAM_POLL_QUIET_WINDOW_MS, STREAM_POLL_INTERVAL_MS);
});

test("stream is delivering while chunks landed inside the quiet window", () => {
  const now = 100_000;
  assert.equal(
    isSseStreamDelivering(now - 1, now),
    true,
    "a chunk 1ms ago means the stream is delivering"
  );
  assert.equal(
    isSseStreamDelivering(now - STREAM_POLL_QUIET_WINDOW_MS + 1, now),
    true,
    "a chunk just inside the window still counts as delivering"
  );
});

test("stream is quiet once no chunk landed for the full quiet window", () => {
  const now = 100_000;
  assert.equal(
    isSseStreamDelivering(now - STREAM_POLL_QUIET_WINDOW_MS, now),
    false,
    "exactly at the window boundary the stream counts as quiet"
  );
  assert.equal(
    isSseStreamDelivering(now - STREAM_POLL_QUIET_WINDOW_MS - 5000, now),
    false,
    "a stalled stream must fall back to polling"
  );
  assert.equal(isSseStreamDelivering(0, now), false, "no chunks ever recorded means quiet");
  assert.equal(isSseStreamDelivering(NaN, now), false, "non-finite clock means quiet");
});

test("poll runs only when the thread is live AND the stream is quiet", () => {
  assert.equal(
    shouldPollLiveThread({ threadLiveStreaming: true, sseStreamDelivering: true }),
    false,
    "full-thread poll must be suppressed while SSE delivers chunks"
  );
  assert.equal(
    shouldPollLiveThread({ threadLiveStreaming: true, sseStreamDelivering: false }),
    true,
    "poll must resume when the stream goes quiet mid-turn"
  );
  assert.equal(
    shouldPollLiveThread({ threadLiveStreaming: false, sseStreamDelivering: false }),
    false,
    "poll must stay off once the stream ends and the thread settles"
  );
  assert.equal(
    shouldPollLiveThread({ threadLiveStreaming: false, sseStreamDelivering: true }),
    false,
    "poll must stay off when the thread is not live even if chunks arrive"
  );
});

const pageSrc = fs.readFileSync(path.resolve(__dirname, "../app/page.tsx"), "utf8");

test("page.tsx gates the poll on the extracted predicate, no new state channel", () => {
  assert.match(pageSrc, /shouldPollLiveThread/, "poll loop must consult shouldPollLiveThread");
  assert.match(pageSrc, /isSseStreamDelivering/, "poll loop must derive delivery from the clock");
  assert.match(
    pageSrc,
    /lastStreamChunkAtRef/,
    "loop must track last chunk time from the existing messages state channel"
  );
  assert.doesNotMatch(
    pageSrc,
    /useState<[^>]*streamActive|setStreamActive/,
    "no new stream-active state channel may be invented"
  );
});

test("P-F3: shouldPollLiveThread stays false across a 45s prefill while isLocalSseOpen === true and resumes when false", () => {
  const gate = shouldPollLiveThread as (state: {
    threadLiveStreaming: boolean;
    sseStreamDelivering: boolean;
    isLocalSseOpen?: boolean;
  }) => boolean;

  for (const elapsedMs of [0, 1_500, 10_000, 25_000, 45_000]) {
    const delivering = isSseStreamDelivering(0, elapsedMs);
    assert.equal(delivering, false, `no chunk recorded at ${elapsedMs}ms during prefill`);
    assert.equal(
      gate({ threadLiveStreaming: true, sseStreamDelivering: delivering, isLocalSseOpen: true }),
      false,
      `poll must stay suppressed at ${elapsedMs}ms while local SSE stream is open`
    );
  }

  assert.equal(
    gate({ threadLiveStreaming: true, sseStreamDelivering: false, isLocalSseOpen: false }),
    true,
    "poll must resume once isLocalSseOpen becomes false and stream is quiet"
  );
});

test("P-F3: page.tsx wires isLocalSseOpen from ChatStream and eliminates duplicate compaction fetch", () => {
  const chatStreamSrc = fs.readFileSync(
    path.resolve(__dirname, "../components/ChatStream.tsx"),
    "utf8"
  );
  const viewShellSrc = fs.readFileSync(
    path.resolve(__dirname, "../components/ViewShell.tsx"),
    "utf8"
  );

  assert.match(
    chatStreamSrc,
    /onLocalSseOpenChange/,
    "ChatStream.tsx must expose onLocalSseOpenChange callback"
  );
  assert.match(
    viewShellSrc,
    /onLocalSseOpenChange/,
    "ViewShell.tsx must forward onLocalSseOpenChange"
  );
  assert.match(
    pageSrc,
    /isLocalSseOpen/,
    "page.tsx must track isLocalSseOpen and pass it to shouldPollLiveThread"
  );
  assert.match(
    chatStreamSrc,
    /threadCompaction/,
    "ChatStream.tsx must accept threadCompaction from page.tsx/ViewShell to avoid duplicate GET /api/threads/[id]"
  );
  assert.match(
    viewShellSrc,
    /threadCompaction/,
    "ViewShell.tsx must pass threadCompaction to ChatStream"
  );
});

test("P-F3: GET /api/threads/[id] returns deterministic ETag, 304 on matching If-None-Match, and strips heavy trace results with ?omitHeavyTraceResults=1", async () => {
  const os = await import("node:os");
  const { ThreadStore } = await import("../lib/threads/threadStore");
  const { GET } = await import("../app/api/threads/[id]/route");

  const tmpDir = fs.mkdtempSync(path.join(os.default.tmpdir(), "pf3-etag-route-"));
  const prevThreadsDir = process.env.THREADS_DIR;
  process.env.THREADS_DIR = tmpDir;

  try {
    const store = new ThreadStore(tmpDir);
    const thread = store.createThread({ title: "ETag Test Thread", model: "test-model" });
    const heavyPayload = "H".repeat(8192);
    thread.messages = [
      { id: "u1", role: "user", content: "Run tool", timestamp: new Date().toISOString() },
      {
        id: "a1",
        role: "assistant",
        content: "Done",
        status: "completed",
        timestamp: new Date().toISOString(),
        traces: [
          {
            tool: "workspace_read_file",
            args: { path: "big.txt" },
            result: { output: heavyPayload },
            durationMs: 25,
            timestamp: new Date().toISOString(),
          },
          {
            tool: "workspace_list_dir",
            args: { path: "." },
            result: "small ok",
            durationMs: 5,
            timestamp: new Date().toISOString(),
          },
        ],
      },
    ];
    store.saveThread(thread);

    const ctx = { params: Promise.resolve({ id: thread.id }) };
    const res1 = await GET(new Request(`http://localhost:3000/api/threads/${thread.id}`), ctx);
    assert.equal(res1.status, 200);
    const etagFull = res1.headers.get("etag");
    assert.ok(etagFull && etagFull.length > 0, `Expected ETag header on GET, got: ${etagFull}`);
    const body1 = (await res1.json()) as {
      thread: { messages: Array<{ traces?: Array<{ result?: unknown }> }> };
    };
    assert.deepEqual(body1.thread.messages[1].traces?.[0].result, { output: heavyPayload });

    const res304 = await GET(
      new Request(`http://localhost:3000/api/threads/${thread.id}`, {
        headers: { "If-None-Match": etagFull },
      }),
      ctx
    );
    assert.equal(res304.status, 304, "Matching If-None-Match must return 304 Not Modified");

    const resCompact = await GET(
      new Request(`http://localhost:3000/api/threads/${thread.id}?omitHeavyTraceResults=1`),
      ctx
    );
    assert.equal(resCompact.status, 200);
    const etagCompact = resCompact.headers.get("etag");
    assert.ok(etagCompact && etagCompact.length > 0, "Expected ETag header on compact GET");
    assert.notEqual(
      etagCompact,
      etagFull,
      "Compact mode ETag must differ from full mode ETag"
    );
    const bodyCompact = (await resCompact.json()) as {
      thread: { messages: Array<{ traces?: Array<{ result?: unknown }> }> };
    };
    assert.equal(
      bodyCompact.thread.messages[1].traces?.[0].result,
      undefined,
      "Heavy trace.result must be omitted when ?omitHeavyTraceResults=1"
    );
    assert.equal(
      bodyCompact.thread.messages[1].traces?.[1].result,
      "small ok",
      "Small trace.result should still be preserved"
    );

    const resCompact304 = await GET(
      new Request(`http://localhost:3000/api/threads/${thread.id}?omitHeavyTraceResults=1`, {
        headers: { "If-None-Match": etagCompact },
      }),
      ctx
    );
    assert.equal(
      resCompact304.status,
      304,
      "Matching If-None-Match in compact mode must return 304 Not Modified"
    );
  } finally {
    if (prevThreadsDir === undefined) {
      delete process.env.THREADS_DIR;
    } else {
      process.env.THREADS_DIR = prevThreadsDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
