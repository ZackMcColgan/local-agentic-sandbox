/**
 * Model Limits — single source of truth for the chat-round generation cap and
 * the compaction ratios.
 *
 * Leaf module by design: it imports nothing from the chat route, contextBudget,
 * conversationCompaction, chatUtils, or threadStore, so any of those modules
 * can consume it without creating an import cycle. One parameter change here
 * propagates through the whole system:
 *   - ROUND_MAX_TOKENS feeds computeModelOptions (every effort tier) and the
 *     resolveRoundModelOptions fallback, so every round is capped.
 *   - COMPACTION_THRESHOLD_RATIO feeds the threadStore COMPACTION_TRIGGER_TOKENS
 *     derivation, the contextBudget fit default, and conversationCompaction's
 *     DEFAULT_COMPACTION_THRESHOLD — so a context-budget change moves the
 *     trigger dynamically instead of via scattered literals.
 *   - HYBRID_ESCALATION_THRESHOLD feeds conversationCompaction's
 *     HYBRID_ESCALATION_THRESHOLD.
 *
 * NOT here on purpose: SUMMARIZATION_MAX_TOKENS (8192) in conversationCompaction
 * is summary-output size, a different meaning pinned by the hybrid-compaction
 * guardrails; thinking budgets and provider num_ctx are not chat-round caps.
 */

/** Per-round generation cap (num_predict) on EVERY chat round. With the
 * per-round wall-clock deadlines armed, the wall clock — not the token count —
 * is the binding runaway leash; 16384 at local decode speeds is ~5-7 min worst
 * case, comfortably under the 15-min round total deadline. */
export const ROUND_MAX_TOKENS = 16384;

/** Fraction of the context budget at which compaction triggers. */
export const COMPACTION_THRESHOLD_RATIO = 0.85;

/** Fraction of the context budget above which extraction-compaction escalates
 * to the single hybrid summarization pass. */
export const HYBRID_ESCALATION_RATIO = 0.65;
