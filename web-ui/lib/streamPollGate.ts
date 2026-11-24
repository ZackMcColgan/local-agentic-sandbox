/**
 * PERF-P4 (#128): full-thread poll gate for app/page.tsx live visibility.
 *
 * During a live turn the page poll fetched the FULL thread JSON every
 * STREAM_POLL_INTERVAL_MS (1,500 ms) while the SSE stream was already pushing
 * every chunk into the same `messages` state on the same 1-vCPU event loop —
 * duplicated work. The poll is suppressed while the stream is actively
 * delivering chunks and resumes once the stream goes quiet (or ends, which
 * tears the effect down via the existing streaming/activeTurn gate).
 *
 * Extracted as pure functions so the arithmetic is testable without a browser
 * (same pattern as lib/reconcilePollPolicy.ts).
 */
import { STREAM_POLL_INTERVAL_MS } from "./streamSnapshot";

/** How recently a chunk must have landed to count as "the stream is delivering". */
export const STREAM_POLL_QUIET_WINDOW_MS = STREAM_POLL_INTERVAL_MS;

/**
 * True when an SSE chunk landed within the quiet window. A non-finite or
 * never-set clock (no chunks ever recorded) counts as quiet so a turn that
 * never streamed still polls.
 */
export function isSseStreamDelivering(lastChunkAtMs: number, nowMs: number): boolean {
  if (!Number.isFinite(lastChunkAtMs) || !Number.isFinite(nowMs)) return false;
  if (lastChunkAtMs <= 0) return false;
  return nowMs - lastChunkAtMs < STREAM_POLL_QUIET_WINDOW_MS;
}

/**
 * The poll gate: poll the full thread only when the turn is live, no local SSE
 * stream is currently open, AND the SSE stream is not actively delivering.
 * While a local SSE response is open (including long prefills and tool waits),
 * or while chunks are arriving, the poll is redundant churn.
 */
export function shouldPollLiveThread(state: {
  threadLiveStreaming: boolean;
  sseStreamDelivering: boolean;
  isLocalSseOpen?: boolean;
}): boolean {
  if (state.isLocalSseOpen === true) return false;
  return state.threadLiveStreaming && !state.sseStreamDelivering;
}
