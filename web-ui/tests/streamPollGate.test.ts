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
