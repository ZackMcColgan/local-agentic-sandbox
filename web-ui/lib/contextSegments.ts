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

interface SegmentMessageLike {
  role?: string;
  content?: unknown;
  traces?: Array<{ result?: unknown }> | undefined;
  compactedThisTurn?: boolean;
  tokenEconomics?: JobTokenRollup;
}

/**
 * Derives the three segment bars from the thread's messages and traces.
 * Trace result payloads count as tool results; user/assistant text counts as
 * conversation; system-role content counts as system. Pure; safe for render.
 */
export function deriveContextSegments(
  messages: SegmentMessageLike[] | undefined,
  liveTraces?: Array<{ result?: unknown }> | undefined
): ContextSegments {
  const seg: ContextSegments = { toolResults: 0, conversation: 0, system: 0 };
  for (const m of messages || []) {
    if (m.role === "system") {
      seg.system += estimateTokens(m.content ?? "");
    } else if (m.role === "user" || m.role === "assistant") {
      seg.conversation += estimateTokens(m.content ?? "");
    }
    for (const t of m.traces || []) {
      seg.toolResults += estimateTokens(t.result ?? "");
    }
  }
  for (const t of liveTraces || []) {
    seg.toolResults += estimateTokens(t.result ?? "");
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
  let remainder = usedTokens - (fitted.toolResults + fitted.conversation + fitted.system);
  const largest = (Object.keys(fitted) as Array<keyof ContextSegments>).sort(
    (a, b) => fitted[b] - fitted[a]
  )[0];
  fitted[largest] += remainder;
  return fitted;
}

/**
 * Compaction count from the records the client already holds: per-message
 * compactedThisTurn flags plus the per-turn tokenEconomics rollups.
 */
export function countCompactions(messages: SegmentMessageLike[] | undefined): number {
  let count = 0;
  for (const m of messages || []) {
    if (m.compactedThisTurn) count += 1;
    if (m.tokenEconomics?.compactions) count += m.tokenEconomics.compactions;
  }
  return count;
}
