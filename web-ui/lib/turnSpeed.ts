/**
 * Pure generation timing, tok/s math, and header now-line state derivation.
 */

import { formatElapsedDuration } from "./chatUtils";
import { traceToTimelineRow, type TimelineTraceInput } from "./activityTimeline";

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
  return Math.round(rate * 10) / 10;
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

  const elapsedMs = input.isStreaming
    ? typeof input.startedAtMs === "number" && input.nowMs >= input.startedAtMs
      ? input.nowMs - input.startedAtMs
      : 0
    : (input.totalDurationMs ?? 0);

  const elapsedLabel =
    elapsedMs > 0 ? formatElapsedDuration(Math.max(1, Math.round(elapsedMs / 1000))) : null;

  const tokensLabel = formatTokenCount(input.outputTokens);

  let tokPerSec: number | null = null;
  if (input.isStreaming) {
    tokPerSec =
      typeof input.liveTokPerSec === "number" && input.liveTokPerSec > 0
        ? input.liveTokPerSec
        : computeAverageTokPerSec(input.outputTokens, elapsedMs);
  } else {
    const genMs = sumRoundGenerationMs(input.roundGenerationMs);
    tokPerSec = computeAverageTokPerSec(input.outputTokens, genMs > 0 ? genMs : elapsedMs);
  }

  const tokPerSecLabel = tokPerSec !== null ? `${tokPerSec.toFixed(1)} tok/s` : null;

  return {
    visible: true,
    isStreaming: input.isStreaming,
    actionLabel,
    elapsedLabel,
    tokensLabel,
    tokPerSecLabel,
  };
}
