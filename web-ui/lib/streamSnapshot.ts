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
import type { ThinkingSegment } from "./activityTimeline";

export const STREAM_SNAPSHOT_INTERVAL_MS = 1000;
export const STREAM_POLL_INTERVAL_MS = 1500;

export interface StreamingSnapshotMessage {
  id: string;
  role: "assistant";
  content: string;
  thought?: string;
  thinkingSegments?: ThinkingSegment[];
  traces?: ExecutionTraceItem[];
  /** qa-7: per-round prompt tokens so far, so watching clients can show the
   * live context meter mid-turn instead of waiting for the turn to settle. */
  roundPromptTokens?: number[];
  /** Per-round generation durations (ms) so far for live tok/s on observed turns. */
  roundGenerationMs?: number[];
  /** Cumulative output tokens across completed rounds so far. */
  outputTokens?: number;
  status: "streaming";
  timestamp: string;
}

export interface StreamingSnapshotSink {
  addMessage(threadId: string, message: StreamingSnapshotMessage): unknown;
}

export class ThrottledStreamSnapshot {
  private lastWriteMs = -Infinity;
  private lastRoundPromptTokens: number[] | undefined;
  private lastRoundGenerationMs: number[] | undefined;
  private lastOutputTokens: number | undefined;
  private lastThinkingSegments: ThinkingSegment[] | undefined;

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
    opts?: {
      force?: boolean;
      roundPromptTokens?: number[];
      roundGenerationMs?: number[];
      outputTokens?: number;
      thinkingSegments?: ThinkingSegment[];
    }
  ): boolean {
    if (!this.threadId) return false;
    // qa-7: cache the round token record the moment a caller supplies it, so
    // every later snapshot carries it even when the caller passes content only.
    if (Array.isArray(opts?.roundPromptTokens) && opts.roundPromptTokens.length > 0) {
      this.lastRoundPromptTokens = [...opts.roundPromptTokens];
    }
    if (Array.isArray(opts?.roundGenerationMs) && opts.roundGenerationMs.length > 0) {
      this.lastRoundGenerationMs = [...opts.roundGenerationMs];
    }
    if (
      typeof opts?.outputTokens === "number" &&
      Number.isFinite(opts.outputTokens) &&
      opts.outputTokens > 0
    ) {
      this.lastOutputTokens = opts.outputTokens;
    }
    if (Array.isArray(opts?.thinkingSegments) && opts.thinkingSegments.length > 0) {
      this.lastThinkingSegments = [...opts.thinkingSegments];
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
      thinkingSegments: this.lastThinkingSegments,
      traces: hasTraces ? traces : undefined,
      roundPromptTokens: this.lastRoundPromptTokens,
      roundGenerationMs: this.lastRoundGenerationMs,
      outputTokens: this.lastOutputTokens,
      status: "streaming",
      timestamp: new Date().toISOString(),
    });
    return true;
  }
}

/** True when a message is a mid-turn streaming assistant snapshot (client poll gate). */
export function isLiveStreamingMessage(
  msg: { role?: string; status?: string } | null | undefined
): boolean {
  return Boolean(msg && msg.role === "assistant" && msg.status === "streaming");
}
