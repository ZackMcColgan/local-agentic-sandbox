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
