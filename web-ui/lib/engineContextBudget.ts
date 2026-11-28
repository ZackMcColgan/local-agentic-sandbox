/**
 * Runtime Engine Context Budget Derivation (#140)
 *
 * Reads the engine's configured max-context at runtime (GET /health max_context,
 * falling back to GET /slots[0].n_ctx) and derives the thread token budget,
 * compaction trigger (0.85 ratio), and hybrid escalation point (0.65 ratio)
 * from that single source of truth.
 *
 * Derivation rule:
 *   budget = engine max_context - CONTEXT_BUDGET_HEADROOM_TOKENS
 * where CONTEXT_BUDGET_HEADROOM_TOKENS is the fixed sum of:
 *   - ROUND_MAX_TOKENS (16,384): per-round reply reserve (Directive #16)
 *   - MEASURED_SYSTEM_TOOLS_FOOTPRINT_TOKENS (3,054): measured from a fresh
 *     thread's actual prompt on the live engine (system prompt + profile/memory
 *     + host directive + layer-1 tool schemas)
 *   - CONTEXT_SAFETY_MARGIN_TOKENS (11,634): tokenization variance & mid-turn
 *     directive/tool-schema growth cushion (anchoring 131,072 -> 100,000)
 *   Total fixed headroom = 31,072 tokens.
 *
 * If the engine is unreachable or reports an invalid context size, falls back
 * to CHAT_CONTEXT_BUDGET_TOKENS (100,000) / DEFAULT_CONTEXT_WINDOW_TOKENS (131,072)
 * and logs a warning.
 */

import { CHAT_CONTEXT_BUDGET_TOKENS, DEFAULT_CONTEXT_WINDOW_TOKENS } from "./contextBudget";
import { resolveLLMEngine, type LLMEngine } from "./llm/provider";
import {
  COMPACTION_THRESHOLD_RATIO,
  HYBRID_ESCALATION_RATIO,
  ROUND_MAX_TOKENS,
} from "./modelLimits";

/** Measured fresh-thread system prompt + layer-1 tool definitions footprint (live /slots n_prompt_tokens). */
export const MEASURED_SYSTEM_TOOLS_FOOTPRINT_TOKENS = 3054;

/** Safety cushion for tokenizer variance and mid-turn directive growth (anchors 131072 -> 100000). */
export const CONTEXT_SAFETY_MARGIN_TOKENS = 11634;

/** Fixed headroom subtracted from engine max_context to obtain the thread token budget. */
export const CONTEXT_BUDGET_HEADROOM_TOKENS =
  ROUND_MAX_TOKENS + MEASURED_SYSTEM_TOOLS_FOOTPRINT_TOKENS + CONTEXT_SAFETY_MARGIN_TOKENS;

/** Minimum engine context window considered sane; values below this fall back to 100K. */
export const MIN_SANE_ENGINE_CONTEXT_TOKENS = 8192;

/** Floor on derived thread budget when engine context is small but sane. */
export const MIN_DERIVED_BUDGET_TOKENS = 4096;

/** Short TTL so engine restarts with a new context size propagate promptly without per-round probes. */
export const ENGINE_CONTEXT_CACHE_TTL_MS = 15_000;

const MAX_CACHE_ENTRIES = 16;

export interface DerivedContextBudget {
  /** Physical engine context window (n_ctx / max_context). */
  contextWindowTokens: number;
  /** Derived thread token budget = contextWindowTokens - fixed headroom (or 100K fallback). */
  budgetTokens: number;
  /** Compaction trigger = Math.floor(budgetTokens * COMPACTION_THRESHOLD_RATIO). */
  compactionTriggerTokens: number;
  /** Hybrid second-pass escalation = Math.floor(budgetTokens * HYBRID_ESCALATION_RATIO). */
  hybridEscalationTokens: number;
  /** Per-round output reserve (ROUND_MAX_TOKENS). */
  outputReserveTokens: number;
  /** Whether the budget came from the live engine or the 100K fallback. */
  source: "engine" | "fallback";
  /** Reason string when source === "fallback". */
  fallbackReason?: string;
}

/**
 * Pure derivation: maps an engine max_context reading (or null/invalid) to the
 * thread token budget and ratio-derived compaction points.
 */
export function deriveContextBudget(
  engineMaxContext: number | null | undefined,
  fallbackReason?: string
): DerivedContextBudget {
  if (
    typeof engineMaxContext !== "number" ||
    !Number.isFinite(engineMaxContext) ||
    engineMaxContext < MIN_SANE_ENGINE_CONTEXT_TOKENS
  ) {
    const budgetTokens = CHAT_CONTEXT_BUDGET_TOKENS;
    return {
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      budgetTokens,
      compactionTriggerTokens: Math.floor(budgetTokens * COMPACTION_THRESHOLD_RATIO),
      hybridEscalationTokens: Math.floor(budgetTokens * HYBRID_ESCALATION_RATIO),
      outputReserveTokens: ROUND_MAX_TOKENS,
      source: "fallback",
      fallbackReason:
        fallbackReason ||
        (engineMaxContext == null
          ? "engine max_context unavailable"
          : `invalid engine max_context (${String(engineMaxContext)})`),
    };
  }

  const contextWindowTokens = Math.floor(engineMaxContext);
  const effectiveInputCeiling = Math.max(0, contextWindowTokens - ROUND_MAX_TOKENS);
  const rawBudget = contextWindowTokens - CONTEXT_BUDGET_HEADROOM_TOKENS;
  const budgetTokens = Math.min(
    effectiveInputCeiling,
    Math.max(MIN_DERIVED_BUDGET_TOKENS, rawBudget)
  );

  return {
    contextWindowTokens,
    budgetTokens,
    compactionTriggerTokens: Math.floor(budgetTokens * COMPACTION_THRESHOLD_RATIO),
    hybridEscalationTokens: Math.floor(budgetTokens * HYBRID_ESCALATION_RATIO),
    outputReserveTokens: ROUND_MAX_TOKENS,
    source: "engine",
  };
}

/**
 * Pure parser: extracts a positive finite max_context / n_ctx integer from
 * engine /health, /control/status, or /slots payloads.
 */
export function parseEngineMaxContext(healthData: unknown, slotsData?: unknown): number | null {
  if (healthData && typeof healthData === "object") {
    const record = healthData as Record<string, unknown>;
    for (const key of ["max_context", "n_ctx", "context_window", "contextWindowTokens"]) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
      }
    }
  }

  if (Array.isArray(slotsData)) {
    for (const slot of slotsData) {
      if (slot && typeof slot === "object") {
        const nCtx = (slot as Record<string, unknown>).n_ctx;
        if (typeof nCtx === "number" && Number.isFinite(nCtx) && nCtx > 0) {
          return Math.floor(nCtx);
        }
      }
    }
  }

  return null;
}

interface CacheEntry {
  budget: DerivedContextBudget;
  expiresAt: number;
}

const budgetCache = new Map<string, CacheEntry>();

export function clearEngineContextBudgetCache(): void {
  budgetCache.clear();
}

function getDefaultEngineBaseUrl(): string {
  return (
    process.env.LLM_BASE_URL ||
    process.env.LLAMACPP_BASE_URL ||
    process.env.OLLAMA_BASE_URL ||
    "http://127.0.0.1:8080"
  ).replace(/\/$/, "");
}

function writeCache(key: string, budget: DerivedContextBudget, nowMs: number, ttlMs: number): void {
  if (budgetCache.size >= MAX_CACHE_ENTRIES && !budgetCache.has(key)) {
    const oldestKey = budgetCache.keys().next().value;
    if (oldestKey !== undefined) {
      budgetCache.delete(oldestKey);
    }
  }
  budgetCache.set(key, { budget, expiresAt: nowMs + ttlMs });
}

export interface ResolveEngineContextBudgetOptions {
  baseUrl?: string;
  engine?: LLMEngine;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  bypassCache?: boolean;
  cacheTtlMs?: number;
  now?: () => number;
  logger?: (message: string) => void;
}

/**
 * Runtime effectful resolver: probes the engine's /health (and /slots if /health
 * omits max_context), caches valid results for a short TTL, and falls back to
 * 100K with a warning log if the engine is unreachable or returns invalid data.
 */
export async function resolveEngineContextBudget(
  options: ResolveEngineContextBudgetOptions = {}
): Promise<DerivedContextBudget> {
  const engine = options.engine ?? resolveLLMEngine();
  // Ollama does not serve /health max_context or /slots n_ctx; avoid spurious
  // probes unless a caller explicitly injects fetchImpl (e.g. unit tests).
  if (!options.fetchImpl && engine === "ollama") {
    return deriveContextBudget(null, "ollama engine does not expose /health max_context");
  }

  const effectiveBaseUrl =
    engine !== "ollama" && !options.fetchImpl
      ? process.env.LLAMACPP_BASE_URL || options.baseUrl || getDefaultEngineBaseUrl()
      : options.baseUrl || getDefaultEngineBaseUrl();
  const baseUrl = effectiveBaseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 2500;
  const cacheTtlMs = options.cacheTtlMs ?? ENGINE_CONTEXT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? ((msg: string) => console.warn(msg));
  const nowMs = now();

  if (!options.bypassCache) {
    const cached = budgetCache.get(baseUrl);
    if (cached && cached.expiresAt > nowMs) {
      return cached.budget;
    }
  }

  let healthData: unknown = null;
  let failureReason: string | undefined;

  try {
    const healthRes = await fetchImpl(`${baseUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (healthRes.ok) {
      healthData = await healthRes.json().catch(() => null);
      const fromHealth = parseEngineMaxContext(healthData);
      if (fromHealth !== null && fromHealth >= MIN_SANE_ENGINE_CONTEXT_TOKENS) {
        const derived = deriveContextBudget(fromHealth);
        writeCache(baseUrl, derived, nowMs, cacheTtlMs);
        return derived;
      }
      // /health succeeded without a sane max_context: probe /slots for per-slot n_ctx
      try {
        const slotsRes = await fetchImpl(`${baseUrl}/slots`, {
          method: "GET",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (slotsRes.ok) {
          const slotsData = await slotsRes.json().catch(() => null);
          const fromSlots = parseEngineMaxContext(healthData, slotsData);
          if (fromSlots !== null && fromSlots >= MIN_SANE_ENGINE_CONTEXT_TOKENS) {
            const derived = deriveContextBudget(fromSlots);
            writeCache(baseUrl, derived, nowMs, cacheTtlMs);
            return derived;
          }
          failureReason = `engine /health and /slots reported no valid max_context`;
        } else {
          failureReason = `engine /health omitted max_context and /slots returned HTTP ${slotsRes.status}`;
        }
      } catch (slotsErr) {
        failureReason = `engine /health omitted max_context and /slots probe failed: ${
          slotsErr instanceof Error ? slotsErr.message : String(slotsErr)
        }`;
      }
    } else {
      failureReason = `engine /health returned HTTP ${healthRes.status}`;
    }
  } catch (err) {
    failureReason = `engine unreachable at ${baseUrl}/health: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  const fallback = deriveContextBudget(null, failureReason);
  logger(
    `[EngineContextBudget] ${fallback.fallbackReason}; falling back to ${fallback.budgetTokens} token budget (${fallback.contextWindowTokens} window).`
  );
  return fallback;
}
