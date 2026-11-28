/**
 * #138 Context sheet segment derivation.
 *
 * Reuses the existing per-message and per-trace token estimates (estimateTokens
 * from lib/contextBudget) — no new accounting system. Splits the context into
 * three segments for the sheet's segment rows: tool results (trace result
 * payloads), conversation (user + assistant text), and system messages.
 */

import { estimateTokens } from "./contextBudget";
import type { JobTokenRollup } from "./tokenEconomics";

export interface ContextSegments {
  toolResults: number;
  conversation: number;
  system: number;
}

interface SegmentTraceLike {
  id?: string;
  tool?: string;
  timestamp?: string;
  result?: unknown;
}

interface SegmentMessageLike {
  role?: string;
  content?: unknown;
  traces?: SegmentTraceLike[] | undefined;
  compactedThisTurn?: boolean;
  tokenEconomics?: JobTokenRollup;
}

function traceDedupeKey(t: SegmentTraceLike): string | null {
  if (typeof t.id === "string" && t.id.length > 0) {
    return `id:${t.id}`;
  }
  if (t.tool || t.timestamp) {
    const resLen =
      typeof t.result === "string"
        ? t.result.length
        : t.result != null
          ? JSON.stringify(t.result).length
          : 0;
    return `meta:${t.tool ?? ""}|${t.timestamp ?? ""}|${resLen}`;
  }
  return null;
}

/**
 * Derives the three segment bars from the thread's messages and traces.
 * Trace result payloads count as tool results; user/assistant text counts as
 * conversation; system-role content counts as system. Pure; safe for render.
 *
 * Traces present in both `m.traces` and `liveTraces` are deduplicated so live
 * streaming traces are never double-counted.
 */
export function deriveContextSegments(
  messages: SegmentMessageLike[] | undefined,
  liveTraces?: SegmentTraceLike[] | undefined
): ContextSegments {
  const seg: ContextSegments = { toolResults: 0, conversation: 0, system: 0 };
  const seenRefs = new Set<object>();
  const seenKeys = new Set<string>();

  const countTrace = (t: SegmentTraceLike | null | undefined) => {
    if (!t || typeof t !== "object") return;
    if (seenRefs.has(t)) return;
    const key = traceDedupeKey(t);
    if (key && seenKeys.has(key)) return;
    seenRefs.add(t);
    if (key) seenKeys.add(key);
    seg.toolResults += estimateTokens(t.result ?? "");
  };

  for (const m of messages || []) {
    if (m.role === "system") {
      seg.system += estimateTokens(m.content ?? "");
    } else if (m.role === "user" || m.role === "assistant") {
      seg.conversation += estimateTokens(m.content ?? "");
    }
    for (const t of m.traces || []) {
      countTrace(t);
    }
  }
  for (const t of liveTraces || []) {
    countTrace(t);
  }
  return seg;
}

/**
 * Fits the raw segments to the displayed context total so the sheet's
 * breakdown always sums to the number at the top (owner ruling, Nov 25
 * 2026: the total must match the sub-sections). Two directions:
 * - Raw sum BELOW the total (fresh chats): the meter total includes the
 *   system prompt + tool definitions, which never appear as messages; the
 *   unaccounted residual belongs to System.
 * - Raw sum ABOVE the total (long threads): the raw per-message estimates
 *   exceed the last round's actual prompt tokens (the served context is
 *   fitted/elided), so each segment scales down proportionally; rounding
 *   remainder lands on the largest segment so the fit is exact.
 */
export function fitSegmentsToTotal(segments: ContextSegments, usedTokens: number): ContextSegments {
  const rawSum = segments.toolResults + segments.conversation + segments.system;
  if (usedTokens <= 0 || rawSum === usedTokens) return { ...segments };
  if (rawSum < usedTokens) {
    return { ...segments, system: segments.system + (usedTokens - rawSum) };
  }
  const factor = usedTokens / rawSum;
  const fitted = {
    toolResults: Math.floor(segments.toolResults * factor),
    conversation: Math.floor(segments.conversation * factor),
    system: Math.floor(segments.system * factor),
  };
  const remainder = usedTokens - (fitted.toolResults + fitted.conversation + fitted.system);
  const largest = (Object.keys(fitted) as Array<keyof ContextSegments>).sort(
    (a, b) => fitted[b] - fitted[a]
  )[0];
  fitted[largest] += remainder;
  return fitted;
}

/**
 * Compaction count from the records the client already holds. A single turn
 * persists both `compactedThisTurn: true` and `tokenEconomics.compactions`, so
 * take the max per message rather than summing both fields.
 */
export function countCompactions(messages: SegmentMessageLike[] | undefined): number {
  let count = 0;
  for (const m of messages || []) {
    const rollupCount =
      typeof m.tokenEconomics?.compactions === "number" && m.tokenEconomics.compactions > 0
        ? m.tokenEconomics.compactions
        : 0;
    const flagCount = m.compactedThisTurn ? 1 : 0;
    count += Math.max(rollupCount, flagCount);
  }
  return count;
}

/**
 * Resolves the context meter's current token count.
 * Prefers the latest round's actual prompt tokens from persisted messages,
 * EXCEPT when a compaction occurred at or after the latest recorded round
 * (manual compaction or mid-turn compaction), in which case the post-compaction
 * token count wins until a newer round persists.
 */
export function resolveDisplayContextTokens(params: {
  messages: Array<{ roundPromptTokens?: number[]; timestamp?: string }> | undefined;
  estimatedTokens: number;
  compaction?: { compactedAt?: string; tokensAfter?: number } | null;
  compactedAtMs?: number | null;
}): number {
  let recordTokens = 0;
  let lastRecordMs: number | null = null;
  for (const m of params.messages || []) {
    const rounds = m.roundPromptTokens;
    if (!Array.isArray(rounds) || rounds.length === 0) continue;
    for (let i = rounds.length - 1; i >= 0; i--) {
      const v = rounds[i];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        recordTokens = v;
        const parsed = m.timestamp ? Date.parse(m.timestamp) : NaN;
        lastRecordMs = Number.isFinite(parsed) ? parsed : null;
        break;
      }
    }
  }

  // Mid-turn compaction SSE event (before the turn's new roundPromptTokens persists)
  if (
    typeof params.compactedAtMs === "number" &&
    Number.isFinite(params.compactedAtMs) &&
    params.estimatedTokens > 0 &&
    (lastRecordMs === null || params.compactedAtMs >= lastRecordMs)
  ) {
    return params.estimatedTokens;
  }

  // Persisted or just-applied manual compaction boundary newer than the last recorded round
  if (
    params.compaction &&
    typeof params.compaction.tokensAfter === "number" &&
    Number.isFinite(params.compaction.tokensAfter) &&
    params.compaction.tokensAfter >= 0
  ) {
    const compactedMs = params.compaction.compactedAt
      ? Date.parse(params.compaction.compactedAt)
      : NaN;
    if (Number.isFinite(compactedMs) && (lastRecordMs === null || compactedMs >= lastRecordMs)) {
      return params.compaction.tokensAfter;
    }
  }

  return recordTokens > 0 ? recordTokens : params.estimatedTokens;
}
