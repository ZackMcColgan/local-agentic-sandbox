/**
 * Pure generation timing, tok/s math, and header now-line state derivation.
 */

import { formatElapsedDuration } from "./chatUtils";
import { traceToTimelineRow, type TimelineTraceInput } from "./activityTimeline";
import { freshnessFor } from "./liveActivity";

/**
 * Sums positive finite per-round generation durations (ms).
 */
export function sumRoundGenerationMs(roundGenerationMs: number[] | undefined): number {
  if (!Array.isArray(roundGenerationMs)) return 0;
  let total = 0;
  for (const ms of roundGenerationMs) {
    if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
      total += ms;
    }
  }
  return total;
}

/**
 * Average generation speed = outputTokens / (generationDurationMs / 1000).
 * Returns null when either metric is missing or non-positive (never fabricated).
 */
export function computeAverageTokPerSec(
  outputTokens: number | undefined,
  generationDurationMs: number | undefined
): number | null {
  if (
    typeof outputTokens !== "number" ||
    !Number.isFinite(outputTokens) ||
    outputTokens <= 0 ||
    typeof generationDurationMs !== "number" ||
    !Number.isFinite(generationDurationMs) ||
    generationDurationMs <= 0
  ) {
    return null;
  }
  const rate = outputTokens / (generationDurationMs / 1000);
  const rounded = Math.round(rate * 10) / 10;
  return rounded > 0 ? rounded : null;
}

/**
 * Smoothed live tok/s over the current round using an EMA (alpha = 0.35).
 */
export function computeLiveTokPerSec(
  roundOutputTokens: number,
  roundElapsedMs: number,
  prevSmoothed?: number | null
): number | null {
  const current = computeAverageTokPerSec(roundOutputTokens, roundElapsedMs);
  if (current === null) return prevSmoothed ?? null;
  if (typeof prevSmoothed === "number" && Number.isFinite(prevSmoothed) && prevSmoothed > 0) {
    return Math.round((0.35 * current + 0.65 * prevSmoothed) * 10) / 10;
  }
  return current;
}

export function formatTokenCount(tokens: number | undefined): string | null {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tok`;
  return `${Math.round(tokens)} tok`;
}

export interface NowLineInput {
  hasRunTurn: boolean;
  isStreaming: boolean;
  streamStatus?: string | null;
  traces?: TimelineTraceInput[];
  startedAtMs?: number | null;
  lastActivityAtMs?: number | null;
  nowMs: number;
  totalDurationMs?: number;
  outputTokens?: number;
  roundGenerationMs?: number[];
  liveTokPerSec?: number | null;
}

export interface NowLineState {
  visible: boolean;
  isStreaming: boolean;
  actionLabel: string;
  elapsedLabel: string | null;
  tokensLabel: string | null;
  tokPerSecLabel: string | null;
  stallLabel: string | null;
}

function deriveObservedStartMs(traces?: TimelineTraceInput[]): number | null {
  if (!Array.isArray(traces) || traces.length === 0) return null;
  let earliest: number | null = null;
  for (const t of traces) {
    if (!t.timestamp) continue;
    const ms = Date.parse(t.timestamp);
    if (Number.isFinite(ms) && (earliest === null || ms < earliest)) {
      earliest = ms;
    }
  }
  return earliest;
}

/**
 * Pure derivation for the slim status bar under the app header.
 * Hides when no turn has run in the open thread.
 */
export function deriveNowLineState(input: NowLineInput): NowLineState {
  if (!input.hasRunTurn) {
    return {
      visible: false,
      isStreaming: false,
      actionLabel: "",
      elapsedLabel: null,
      tokensLabel: null,
      tokPerSecLabel: null,
      stallLabel: null,
    };
  }

  let actionLabel = input.isStreaming ? "Thinking…" : "Complete";
  if (input.isStreaming) {
    const traces = input.traces || [];
    const lastTrace = traces.length > 0 ? traces[traces.length - 1] : null;
    if (lastTrace) {
      const row = traceToTimelineRow(
        { ...lastTrace, status: lastTrace.status ?? "running" },
        traces.length - 1,
        input.nowMs
      );
      actionLabel = row.label.endsWith("…") ? row.label : `${row.label}…`;
    } else if (input.streamStatus && input.streamStatus.trim()) {
      const cleaned = input.streamStatus.trim();
      actionLabel = cleaned.endsWith("…") ? cleaned : `${cleaned}…`;
    }
  }

  const effectiveStartMs =
    typeof input.startedAtMs === "number" && Number.isFinite(input.startedAtMs)
      ? input.startedAtMs
      : deriveObservedStartMs(input.traces);

  const elapsedMs = input.isStreaming
    ? effectiveStartMs !== null && input.nowMs >= effectiveStartMs
      ? input.nowMs - effectiveStartMs
      : 0
    : (input.totalDurationMs ?? 0);

  const elapsedLabel =
    elapsedMs > 0 ? formatElapsedDuration(Math.max(1, Math.round(elapsedMs / 1000))) : null;

  const tokensLabel = formatTokenCount(input.outputTokens);

  let tokPerSec: number | null = null;
  const genMs = sumRoundGenerationMs(input.roundGenerationMs);
  if (input.isStreaming) {
    tokPerSec =
      typeof input.liveTokPerSec === "number" && input.liveTokPerSec > 0
        ? input.liveTokPerSec
        : genMs > 0
          ? computeAverageTokPerSec(input.outputTokens, genMs)
          : null;
  } else {
    tokPerSec = genMs > 0 ? computeAverageTokPerSec(input.outputTokens, genMs) : null;
  }

  const tokPerSecLabel =
    tokPerSec !== null && tokPerSec > 0 ? `${tokPerSec.toFixed(1)} tok/s` : null;

  let stallLabel: string | null = null;
  if (
    input.isStreaming &&
    typeof input.lastActivityAtMs === "number" &&
    Number.isFinite(input.lastActivityAtMs)
  ) {
    const freshness = freshnessFor(input.lastActivityAtMs, input.nowMs);
    if (freshness.state === "stalled") {
      stallLabel = `Stalled · no heartbeat ${freshness.secondsAgo}s`;
    }
  }

  return {
    visible: true,
    isStreaming: input.isStreaming,
    actionLabel,
    elapsedLabel,
    tokensLabel,
    tokPerSecLabel,
    stallLabel,
  };
}
