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
import type { RoundNarrationSegment, ThinkingSegment } from "./activityTimeline";

// PERF-P4 (#128): each snapshot write stringifies + persists the full thread
// JSON (1.0-1.6 MB per write), so a 1s cadence produced >2.2 GB of writes over
// a long job on the 1-vCPU event loop. The cadence is raised to 5s; round
// boundaries still bypass the throttle via { force: true } (TURN-LIVENESS).
export const STREAM_SNAPSHOT_INTERVAL_MS = 5000;
export const STREAM_POLL_INTERVAL_MS = 1500;

export interface StreamingSnapshotMessage {
  id: string;
  role: "assistant";
  content: string;
  thought?: string;
  thinkingSegments?: ThinkingSegment[];
  roundNarrations?: RoundNarrationSegment[];
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
  private lastContent = "";
  private lastRoundPromptTokens: number[] | undefined;
  private lastRoundGenerationMs: number[] | undefined;
  private lastOutputTokens: number | undefined;
  private lastThinkingSegments: ThinkingSegment[] | undefined;
  private lastRoundNarrations: RoundNarrationSegment[] | undefined;

  constructor(
    private sink: StreamingSnapshotSink,
    private threadId: string | null,
    private messageId: string,
    private intervalMs: number = STREAM_SNAPSHOT_INTERVAL_MS,
    private clock: () => number = () => Date.now()
  ) {}

  /**
   * Returns true when a snapshot write is due (either forced or the throttle
   * interval has elapsed). Callers check this before constructing cumulative
   * thought strings or cloning segment arrays on hot token paths.
   */
  isDue(force?: boolean): boolean {
    if (!this.threadId) return false;
    return Boolean(force) || this.clock() - this.lastWriteMs >= this.intervalMs;
  }

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
      roundNarrations?: RoundNarrationSegment[];
    }
  ): boolean {
    if (!this.threadId) return false;
    const now = this.clock();
    if (!opts?.force && now - this.lastWriteMs < this.intervalMs) return false;
    // qa-7: cache the round token record the moment a caller supplies it, so
    // every later snapshot carries it even when the caller passes content only.
    const roundPromptTokens = opts?.roundPromptTokens;
    if (Array.isArray(roundPromptTokens) && roundPromptTokens.length > 0) {
      this.lastRoundPromptTokens = [...roundPromptTokens];
    }
    const roundGenerationMs = opts?.roundGenerationMs;
    if (Array.isArray(roundGenerationMs) && roundGenerationMs.length > 0) {
      this.lastRoundGenerationMs = [...roundGenerationMs];
    }
    const outputTokens = opts?.outputTokens;
    if (typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens > 0) {
      this.lastOutputTokens = outputTokens;
    }
    const thinkingSegments = opts?.thinkingSegments;
    if (Array.isArray(thinkingSegments) && thinkingSegments.length > 0) {
      this.lastThinkingSegments = [...thinkingSegments];
    }
    const roundNarrations = opts?.roundNarrations;
    if (Array.isArray(roundNarrations) && roundNarrations.length > 0) {
      this.lastRoundNarrations = [...roundNarrations];
    }
    const hasContent = Boolean(content && content.trim());
    if (hasContent) {
      this.lastContent = content;
    }
    const effectiveContent = hasContent ? content : this.lastContent;
    const hasEffectiveContent = Boolean(effectiveContent && effectiveContent.trim());
    const hasThought = Boolean(thought && thought.trim());
    const hasTraces = Array.isArray(traces) && traces.length > 0;
    const hasNarrations = Boolean(this.lastRoundNarrations && this.lastRoundNarrations.length > 0);
    if (!hasEffectiveContent && !hasThought && !hasTraces && !hasNarrations) return false;
    this.lastWriteMs = now;
    this.sink.addMessage(this.threadId, {
      id: this.messageId,
      role: "assistant",
      content: effectiveContent || "",
      thought: hasThought ? thought : undefined,
      thinkingSegments: this.lastThinkingSegments,
      roundNarrations: this.lastRoundNarrations,
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
