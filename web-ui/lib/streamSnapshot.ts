/**
 * CHAT-8: live mid-turn visibility.
 *
 * Server side: ThrottledStreamSnapshot writes partial streaming assistant
 * content into the ThreadStore at most once per STREAM_SNAPSHOT_INTERVAL_MS
 * with message status "streaming", keyed by the turn's assistant message id
 * so terminal persistence (done / error / abort) upserts the same message.
 *
 * Client side: isLiveStreamingMessage + STREAM_POLL_INTERVAL_MS drive the
 * page.tsx poll loop that re-renders partial content until status flips.
 */

import type { ExecutionTraceItem } from "@/components/ExecutionTrace";

export const STREAM_SNAPSHOT_INTERVAL_MS = 1000;
export const STREAM_POLL_INTERVAL_MS = 1500;

export interface StreamingSnapshotMessage {
  id: string;
  role: "assistant";
  content: string;
  thought?: string;
  traces?: ExecutionTraceItem[];
  /** qa-7: per-round prompt tokens so far, so watching clients can show the
   * live context meter mid-turn instead of waiting for the turn to settle. */
  roundPromptTokens?: number[];
  status: "streaming";
  timestamp: string;
}

export interface StreamingSnapshotSink {
  addMessage(threadId: string, message: StreamingSnapshotMessage): unknown;
}

export class ThrottledStreamSnapshot {
  private lastWriteMs = -Infinity;
  private lastRoundPromptTokens: number[] | undefined;

  constructor(
    private sink: StreamingSnapshotSink,
    private threadId: string | null,
    private messageId: string,
    private intervalMs: number = STREAM_SNAPSHOT_INTERVAL_MS,
    private clock: () => number = () => Date.now()
  ) {}

  /**
   * Writes a snapshot of the accumulated streamed content, thinking, and executed tool
   * traces, throttled to at most one write per interval. Returns true when a write landed.
   *
   * TURN-LIVENESS: round boundaries are discrete progress events (a tool round completed),
   * not token churn, so callers pass the accumulated traces with { force: true } to bypass
   * the throttle and persist real in-flight work to the thread record immediately.
   */
  maybeWrite(
    content: string,
    thought?: string,
    traces?: ExecutionTraceItem[],
    opts?: { force?: boolean; roundPromptTokens?: number[] }
  ): boolean {
    if (!this.threadId) return false;
    // qa-7: cache the round token record the moment a caller supplies it, so
    // every later snapshot carries it even when the caller passes content only.
    if (Array.isArray(opts?.roundPromptTokens) && opts.roundPromptTokens.length > 0) {
      this.lastRoundPromptTokens = [...opts.roundPromptTokens];
    }
    const hasContent = Boolean(content && content.trim());
    const hasThought = Boolean(thought && thought.trim());
    const hasTraces = Array.isArray(traces) && traces.length > 0;
    if (!hasContent && !hasThought && !hasTraces) return false;
    const now = this.clock();
    if (!opts?.force && now - this.lastWriteMs < this.intervalMs) return false;
    this.lastWriteMs = now;
    this.sink.addMessage(this.threadId, {
      id: this.messageId,
      role: "assistant",
      content: content || "",
      thought: hasThought ? thought : undefined,
      traces: hasTraces ? traces : undefined,
      roundPromptTokens: this.lastRoundPromptTokens,
      status: "streaming",
      timestamp: new Date().toISOString()
    });
    return true;
  }
}

/** True when a message is a mid-turn streaming assistant snapshot (client poll gate). */
export function isLiveStreamingMessage(msg: { role?: string; status?: string } | null | undefined): boolean {
  return Boolean(msg && msg.role === "assistant" && msg.status === "streaming");
}
