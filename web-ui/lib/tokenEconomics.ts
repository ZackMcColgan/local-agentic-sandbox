/**
 * TOKEN ECONOMICS — per-round prompt-token recording + per-job rollup.
 *
 * Leaf module by design (imports nothing from the chat route or threadStore),
 * so threadStore and route.ts can both consume it without an import cycle.
 *
 * The provider usage plumbing (PR #63, lib/llm/provider.ts) exposes per-round
 * usage on stream chunks; the chat route records prompt tokens per round in
 * the thread record (ThreadMessage.roundPromptTokens) and rolls up per job:
 * rounds, prompt-token integral, output tokens, compaction count. The rollup
 * rides on the thread record (Thread.tokenEconomics, aggregated across turns)
 * so the board item can surface it without a new UI surface.
 */

/** Per-job rollup: the four numbers a job's token economics reduce to. */
export interface JobTokenRollup {
  /** Model rounds dispatched in the turn. */
  rounds: number;
  /** Integral of per-round prompt tokens over the turn. */
  promptTokens: number;
  /** Output tokens for the turn (provider usage when available). */
  outputTokens: number;
  /** Compactions applied during the turn (turn-start + mid-turn fits). */
  compactions: number;
}

/** Per-round prompt-token record persisted on an assistant thread message. */
export interface RoundPromptRecord {
  round: number;
  promptTokens: number;
}

/**
 * Builds the per-job rollup from the turn's accumulators. Pure and total-safe:
 * missing/undefined inputs contribute zero.
 */
export function buildJobTokenRollup(input: {
  rounds: number;
  promptTokens: number;
  outputTokens: number;
  compactions: number;
}): JobTokenRollup {
  return {
    rounds: input.rounds || 0,
    promptTokens: input.promptTokens || 0,
    outputTokens: input.outputTokens || 0,
    compactions: input.compactions || 0
  };
}

/** Sum of a per-round prompt-token array (integral over the turn). */
export function sumRoundPromptTokens(rounds: number[] | undefined): number {
  if (!Array.isArray(rounds)) return 0;
  let total = 0;
  for (const t of rounds) {
    if (typeof t === "number" && Number.isFinite(t) && t > 0) total += t;
  }
  return total;
}

/**
 * The live context size for the header meter (qa-7 / UI-013): the LAST round's
 * actual prompt tokens, read from the per-round records persisted on the
 * thread's assistant messages. Scans from the newest message backwards and
 * returns the last valid entry of the first non-empty round array; 0 when the
 * record holds no round data yet. Pure — safe for render paths.
 */
export function latestRoundPromptTokens(
  messages: Array<{ roundPromptTokens?: number[] }> | undefined
): number {
  if (!Array.isArray(messages)) return 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const rounds = messages[i]?.roundPromptTokens;
    if (!Array.isArray(rounds)) continue;
    for (let j = rounds.length - 1; j >= 0; j--) {
      const v = rounds[j];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    }
  }
  return 0;
}

/**
 * Board format for the header context meter (FINAL-DESIGN): one decimal
 * place, e.g. 72400 -> "72.4K", 3000 -> "3.0K". The budget side of the
 * meter stays whole-K ("100K"). Pure — safe for render paths.
 */
export function formatContextK(tokens: number): string {
  return `${(tokens / 1000).toFixed(1)}K`;
}

/**
 * Aggregates the per-turn rollups recorded on a thread's assistant messages
 * into the thread-level economics (the board-item read path).
 */
export function computeThreadTokenEconomics(thread: {
  messages?: Array<{ role: string; tokenEconomics?: JobTokenRollup }>;
}): JobTokenRollup {
  const agg: JobTokenRollup = { rounds: 0, promptTokens: 0, outputTokens: 0, compactions: 0 };
  for (const m of thread.messages || []) {
    if (m.role !== "assistant" || !m.tokenEconomics) continue;
    agg.rounds += m.tokenEconomics.rounds || 0;
    agg.promptTokens += m.tokenEconomics.promptTokens || 0;
    agg.outputTokens += m.tokenEconomics.outputTokens || 0;
    agg.compactions += m.tokenEconomics.compactions || 0;
  }
  return agg;
}
