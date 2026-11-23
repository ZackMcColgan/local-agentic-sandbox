/**
 * Context Budget Enforcer & Token Estimator
 *
 * Prevents context exhaustion incidents where unbounded tool outputs accumulate
 * across iterative tool rounds, forcing model context drops of system prompts and user queries.
 */

import { computeModelOptions } from "./chatUtils";
import { compactConversationHistory } from "./conversationCompaction";
import { COMPACTION_THRESHOLD_RATIO, ROUND_MAX_TOKENS } from "./modelLimits";

export { compactConversationHistory } from "./conversationCompaction";

export const CHAT_CONTEXT_BUDGET_TOKENS = 100000;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 131072;

export const EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER =
  "[Earlier tool output truncated to fit the context window]";

export const TOOL_TRUNCATION_MARKER = "...[truncated]";
export const MAX_TOOL_OUTPUT_CHARS = 64000;

export const FINAL_ROUND_SYNTHESIS_DIRECTIVE =
  "You have gathered enough information. Synthesize your final answer now using only the tool results above. Do not call more tools.";

export const HIGH_WATER_BANKING_DIRECTIVE =
  "[CONTEXT BUDGET HIGH-WATER WARNING]: Context window utilization has exceeded 90%. Bank your intermediate progress and key deliverables now using workspace_write_file or finalize your answer before context limits are reached.";

export const MAX_WEB_RESEARCH_CALLS = 100;

/**
 * CHAT-7: rounds are governed by remaining context headroom, not a fixed ceiling.
 * TOOL_ROUND_BACKSTOP is the runaway-guard: an absolute round limit that exists
 * only to stop a pathological loop, never as a normal work ceiling.
 */
export const TOOL_ROUND_BACKSTOP = 1000;

/**
 * ROUND-DEADLINES: wall-clock leashes on a single model round. A runaway round
 * (a huge tool call streamed as one generation, or a silent stream) previously
 * had no deadline at all — the per-round AbortController only fired on an
 * explicit stop, so the turn held the single engine slot looking frozen until a
 * human pressed stop. Two leashes:
 *  - ROUND_INACTIVITY_DEADLINE_MS: silence since the LAST chunk (re-armed per
 *    chunk) — catches a stream that stalls mid-generation.
 *  - ROUND_TOTAL_DEADLINE_MS: elapsed since round start regardless of activity
 *    — catches a round that keeps streaming forever (the critical case).
 * Env overrides exist for tests and tuning; defaults are the pinned values.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const ROUND_INACTIVITY_DEADLINE_MS = envInt("ROUND_INACTIVITY_DEADLINE_MS", 180_000);
export const ROUND_TOTAL_DEADLINE_MS = envInt("ROUND_TOTAL_DEADLINE_MS", 900_000);

/**
 * Resolve the active deadline values at round time. The exported constants are
 * pinned defaults computed at module load; tests (and ops tuning) override via
 * env AFTER the module graph is cached, so the route must re-read env per round.
 */
export function resolveRoundDeadlineMs(): { inactivityMs: number; totalMs: number } {
  return {
    inactivityMs: envInt("ROUND_INACTIVITY_DEADLINE_MS", ROUND_INACTIVITY_DEADLINE_MS),
    totalMs: envInt("ROUND_TOTAL_DEADLINE_MS", ROUND_TOTAL_DEADLINE_MS),
  };
}

/** Honest end marker when two consecutive rounds die at a deadline. */
export const TURN_TIMEOUT_MARKER = "Turn ended: generation timed out.";

/** Honest end marker when a length-truncated tool call cannot be parsed/executed. */
export const TURN_SIZE_LIMIT_MARKER =
  "Turn ended: a tool call exceeded the per-message size limit.";

/** Honest end marker after a second consecutive length-truncated text round. */
export const TURN_TRUNCATION_MARKER =
  "Turn ended: generation truncated at the per-message size limit.";

/** Directive for the single auto-continue round after a length-truncated text round. */
export const LENGTH_CONTINUATION_DIRECTIVE = `[LENGTH CONTINUATION]: Your previous answer was cut off at the per-message size limit. Continue exactly where you stopped — output ONLY the remaining continuation, starting from the exact point you stopped, without repeating anything already produced.`;

/** Directive injected after a deadline abort so the next round avoids repeating the runaway. */
export const ROUND_TIMEOUT_DIRECTIVE = `[ROUND DEADLINE]: The previous round was aborted by the round deadline while still generating (likely an oversized single generation or a stalled stream). Do NOT attempt the same oversized output again. Break the work into smaller steps (e.g. patch_file instead of one giant write_file, or a shorter answer), or synthesize from what already exists.`;

/** Hard cap on persisted/streamed turn content: a runaway generation is clamped. */
export const MAX_STREAMED_CONTENT_CHARS = 64_000;

export type ToolLoopStopReason =
  "completed" | "budget" | "backstop" | "web-research-cap" | "round-timeout";

export interface ToolLoopDecision {
  canContinue: boolean;
  /** Set when canContinue is false — why the loop stopped (CHAT-7 honest pause markers). */
  stopReason?: ToolLoopStopReason;
  /**
   * Set when canContinue is true but this is the last permitted round:
   * tools must be omitted from the payload and synthesis forced.
   */
  forceSynthesis?: boolean;
}

export const WEB_RESEARCH_TOOL_NAMES = new Set(["search_web", "fetch_webpage_markdown"]);

export const WEB_BUDGET_EXHAUSTED_DIRECTIVE = `[ACTION DISCIPLINE]: You have reached the maximum of ${MAX_WEB_RESEARCH_CALLS} web research calls for this turn. Web search tools are now disabled. Immediately use the gathered facts to produce the user's requested deliverable (e.g. call workspace_write_file or output the requested SVG/code artifact) or synthesize your final answer.`;

export function isWebResearchTool(toolName: string, tier?: string): boolean {
  return WEB_RESEARCH_TOOL_NAMES.has(toolName) || tier === "browser";
}

export interface ContextToolCall {
  id?: string;
  type?: string;
  name?: string;
  arguments?: unknown;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

export interface ContextMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ContextToolCall[];
  [key: string]: unknown;
}

export type FittedMessages = ContextMessage[] & {
  evictedCount?: number;
  estimatedTokens?: number;
};

export function filterToolsForWebBudget<T extends { name?: string; function?: { name?: string } }>(
  llmTools: T[],
  webResearchCallsUsed: number,
  maxWebCalls: number = MAX_WEB_RESEARCH_CALLS
): T[] {
  if (webResearchCallsUsed < maxWebCalls) {
    return llmTools;
  }
  return llmTools.filter((t) => {
    const name = t.function?.name || t.name || "";
    return !WEB_RESEARCH_TOOL_NAMES.has(name);
  });
}

export function hasArtifactCreationIntent(userPrompt: string): {
  isArtifactRequest: boolean;
  wantsSvg: boolean;
} {
  const wantsSvg =
    /\b(svg|vector\s+diagram|vector\s+graphic|drawio|flowchart|architecture\s+diagram)\b/i.test(
      userPrompt
    ) ||
    (/\b(create|draw|generate|build|make|design|render|sketch)\b/i.test(userPrompt) &&
      /\b(diagram|chart|visual|graphic|card|infographic|illustration)\b/i.test(userPrompt));

  const isArtifactRequest =
    wantsSvg ||
    (/\b(create|write|generate|build|make|save|produce)\b/i.test(userPrompt) &&
      /\b(file|script|code|module|component|html|artifact|report)\b/i.test(userPrompt));

  return { isArtifactRequest, wantsSvg };
}

export function buildSynthesisDirective(
  userPrompt: string,
  isFinalRoundSystemPrompt: boolean = false
): string {
  const { isArtifactRequest, wantsSvg } = hasArtifactCreationIntent(userPrompt);

  if (wantsSvg) {
    return 'You have gathered the required information from the tool results above. Now produce the complete, self-contained, valid <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">...</svg> deliverable inside a ```svg code block using the real facts from the tool results above, followed by a brief summary. Do not invoke any more tools and do not reply with a text-only summary.';
  }

  if (isArtifactRequest) {
    return "You have gathered the required information from the tool results above. Now produce the complete requested code or file artifact directly in a fenced code block, followed by a brief summary. Do not invoke any more tools.";
  }

  if (isFinalRoundSystemPrompt) {
    return FINAL_ROUND_SYNTHESIS_DIRECTIVE;
  }

  return "Now synthesize all the tool results above into a complete, clear, direct Markdown answer for the user. Do not invoke any more tools.";
}

export function shouldRunPostToolSynthesis(params: {
  userPrompt: string;
  assistantContent: string;
  lingeringToolCallsCount: number;
  traces: Array<{ tool: string; args?: Record<string, unknown>; result?: unknown }>;
}): boolean {
  if (
    (params.traces.length > 0 && params.lingeringToolCallsCount > 0) ||
    !params.assistantContent?.trim()
  ) {
    return true;
  }

  const { wantsSvg } = hasArtifactCreationIntent(params.userPrompt);
  if (wantsSvg && params.traces.length > 0) {
    const hasSvgContent =
      /<svg[\s>][\s\S]*?<\/svg>/i.test(params.assistantContent) ||
      /<mxfile|<mxGraphModel/i.test(params.assistantContent);

    const hasSvgTrace = params.traces.some((t) => {
      const p = String(t.args?.path || t.args?.file || "");
      const c = String(t.args?.content || "");
      return /\.(svg|drawio)(\.xml)?$/i.test(p) || c.includes("<svg");
    });

    if (!hasSvgContent && !hasSvgTrace) {
      return true;
    }
  }

  return false;
}

/**
 * Estimates tokens consumed by the serialized tool-schema block sent to the model.
 */
export function estimateToolSchemaTokens(tools?: unknown[]): number {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return estimateTokens(JSON.stringify(tools));
}

/**
 * Effective input ceiling reserving per-round output headroom:
 * effectiveInputCeiling = max(0, contextWindowTokens - outputReserveTokens).
 */
export function computeEffectiveInputCeiling(
  contextWindowTokens: number = DEFAULT_CONTEXT_WINDOW_TOKENS,
  outputReserveTokens: number = ROUND_MAX_TOKENS
): number {
  return Math.max(0, contextWindowTokens - outputReserveTokens);
}

export interface PromptTokenCalibration {
  /** Last real prompt_tokens reading reported by the provider. */
  lastMeasuredPromptTokens?: number;
  /** Estimator reading (messages + tool schemas) corresponding to lastMeasuredPromptTokens. */
  lastMeasuredEstimateTokens?: number;
  /** Pre-computed tool-schema token count for the current round. */
  toolSchemaTokens?: number;
  /** Tool-schema array for the current round (used if toolSchemaTokens is omitted). */
  tools?: unknown[];
}

/**
 * Estimates effective prompt tokens by combining:
 * 1. Messages + tool-schema block (from round 0), and
 * 2. Provider-measured prompt truth calibrated by the estimator's delta once a
 *    real promptTokens reading exists.
 */
export function estimateEffectivePromptTokens(
  messages: unknown,
  calibration?: PromptTokenCalibration & {
    /** Pre-computed estimateTokens(messages) to reuse instead of re-stringifying (Perf P6). */
    precomputedRawMessageTokens?: number;
  }
): number {
  const rawMessageTokens =
    typeof calibration?.precomputedRawMessageTokens === "number"
      ? calibration.precomputedRawMessageTokens
      : estimateTokens(messages);
  const schemaTokens =
    calibration?.toolSchemaTokens ?? estimateToolSchemaTokens(calibration?.tools);
  const rawTotal = rawMessageTokens + schemaTokens;

  const measured = calibration?.lastMeasuredPromptTokens;
  if (typeof measured === "number" && Number.isFinite(measured) && measured > 0) {
    const baseline = calibration?.lastMeasuredEstimateTokens;
    if (typeof baseline === "number" && Number.isFinite(baseline) && baseline > 0) {
      const delta = rawTotal - baseline;
      return Math.max(rawTotal, Math.max(0, Math.round(measured + delta)));
    }
    return Math.max(rawTotal, Math.round(measured));
  }

  return rawTotal;
}

/**
 * Conservative token estimator: Math.ceil(text.length / 4).
 * Handles string, message object, or message arrays.
 *
 * Perf P6 (#130): an optional observer seam records every invocation so tests can
 * prove full-history (array) scans are measured once per round rather than
 * re-stringified across the fit ladder, continuation check, and provider payload.
 */
let estimateTokensObserver: ((input: unknown) => void) | null = null;

/** Install (or clear) a counting observer for estimateTokens. Test-only seam. */
export function setEstimateTokensObserver(fn: ((input: unknown) => void) | null): void {
  estimateTokensObserver = fn;
}

export function estimateTokens(input: unknown): number {
  if (estimateTokensObserver) estimateTokensObserver(input);
  if (!input) return 0;
  if (typeof input === "string") {
    return Math.ceil(input.length / 4);
  }
  if (Array.isArray(input)) {
    let chars = 0;
    for (const rawMsg of input) {
      if (!rawMsg || typeof rawMsg !== "object") continue;
      const msg = rawMsg as Record<string, unknown>;
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else if (msg.content) {
        chars += JSON.stringify(msg.content).length;
      }
      if (msg.role) chars += String(msg.role).length;
      if (msg.name) chars += String(msg.name).length;
      if (msg.tool_calls) chars += JSON.stringify(msg.tool_calls).length;
    }
    return Math.ceil(chars / 4);
  }
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    let chars = 0;
    if (typeof obj.content === "string") {
      chars += obj.content.length;
    } else if (obj.content) {
      chars += JSON.stringify(obj.content).length;
    }
    if (obj.role) chars += String(obj.role).length;
    if (obj.name) chars += String(obj.name).length;
    if (obj.tool_calls) chars += JSON.stringify(obj.tool_calls).length;
    return Math.ceil(chars / 4);
  }
  return Math.ceil(String(input).length / 4);
}

/**
 * Appends a dynamic mid-turn directive as a trailing user message after the
 * cached prefix without mutating messages[0] (preserving the engine KV/SSM
 * system+tools prefix cache). Idempotent for identical directive strings.
 */
export function appendTrailingDirective<T extends { role?: string; content?: unknown }>(
  messages: T[],
  directive: string
): T[] {
  if (!directive || !directive.trim()) {
    return messages;
  }
  const trimmed = directive.trim();
  for (let i = 1; i < messages.length; i++) {
    const content =
      typeof messages[i]?.content === "string"
        ? (messages[i].content as string)
        : JSON.stringify(messages[i]?.content || "");
    if (content.includes(trimmed)) {
      return messages;
    }
  }
  messages.push({
    role: "user",
    content: trimmed,
  } as unknown as T);
  return messages;
}

/**
 * Merges a system directive into messages[0] if it is a system message,
 * or inserts a system message at index 0 if not present.
 * Guarantees role === "system" never appears at index > 0.
 */
export function mergeSystemDirective<T extends { role?: string; content?: unknown }>(
  messages: T[],
  directive: string
): T[] {
  if (!directive || !directive.trim()) {
    return messages;
  }
  const trimmed = directive.trim();

  if (messages.length > 0 && messages[0]?.role === "system") {
    const existing =
      typeof messages[0].content === "string"
        ? messages[0].content
        : JSON.stringify(messages[0].content || "");
    if (!existing.includes(trimmed)) {
      messages[0] = {
        ...messages[0],
        content: existing ? `${existing}\n\n${trimmed}` : trimmed,
      };
    }
  } else {
    messages.unshift({
      role: "system",
      content: trimmed,
    } as unknown as T);
  }

  return messages;
}

export const ARTIFACT_OUTPUT_HEADROOM_TOKENS = 3000;
export const ARTIFACT_OUTPUT_HEADROOM_TOKENS_WEB = 4000;

export function isLiveRealTimeIntent(userPrompt: string): boolean {
  if (!userPrompt || typeof userPrompt !== "string") return false;
  const p = userPrompt.toLowerCase();
  return (
    /\b(weather|forecast|temperature|humidity|precipitation|wind\s+speed)\b/i.test(p) ||
    /\b(current\s+(price|stock|crypto|rate|news|version|status))\b/i.test(p) ||
    /\b(today('?s)?\s+(news|headlines|weather|forecast))\b/i.test(p) ||
    /\b(breaking\s+news|live\s+updates|latest\s+news)\b/i.test(p)
  );
}

export function hasWebResearchResults(messages: ContextMessage[]): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => {
    if (m?.role === "tool" && (m?.name === "search_web" || m?.name === "fetch_webpage_markdown")) {
      return true;
    }
    if (m?.tool_calls && Array.isArray(m.tool_calls)) {
      return m.tool_calls.some((tc) =>
        WEB_RESEARCH_TOOL_NAMES.has(tc?.function?.name || tc?.name || "")
      );
    }
    return false;
  });
}

export const OUTPUT_HEADROOM_THINKING_DIRECTIVE =
  "[OUTPUT HEADROOM]: Keep <think> reasoning under 2 sentences so the full context window remains available for the complete deliverable.";

export function resolveRoundModelOptions(params: {
  model: string;
  requestedEffort?: "low" | "medium" | "xhigh";
  userPrompt?: string;
  isSynthesisOrFinalRound?: boolean;
  hasCompletedToolCalls?: boolean;
  round?: number;
  isArtifactTurn?: boolean;
  numKeep?: number;
  [key: string]: unknown;
}): {
  num_ctx: number;
  num_predict?: number;
  temperature: number;
  reasoning_effort?: "low" | "medium" | "xhigh";
  n_keep?: number;
  numKeep?: number;
} {
  const isArtifact =
    params.isArtifactTurn ??
    (params.userPrompt ? hasArtifactCreationIntent(params.userPrompt).isArtifactRequest : false);
  const shouldUseFastSynthesis =
    isArtifact || params.isSynthesisOrFinalRound || params.hasCompletedToolCalls;
  const effectiveEffort = shouldUseFastSynthesis ? "low" : params.requestedEffort || "medium";
  const baseOpts = computeModelOptions(params.model, effectiveEffort);
  const result: {
    num_ctx: number;
    num_predict?: number;
    temperature: number;
    reasoning_effort?: "low" | "medium" | "xhigh";
    n_keep?: number;
    numKeep?: number;
  } = {
    num_ctx: baseOpts.num_ctx || DEFAULT_CONTEXT_WINDOW_TOKENS,
    temperature: shouldUseFastSynthesis ? 0.2 : (baseOpts.temperature ?? 0.5),
    reasoning_effort: effectiveEffort,
  };
  if (params.numKeep !== undefined) {
    result.num_predict = 2048 + params.numKeep;
    result.n_keep = params.numKeep;
    result.numKeep = params.numKeep;
  } else {
    result.num_predict = baseOpts.num_predict || ROUND_MAX_TOKENS;
  }
  return result;
}

export interface FitContextOptions {
  maxContentTokens?: number;
  contextWindowTokens?: number;
  tools?: unknown[];
  isArtifactTurn?: boolean;
  reserveOutputTokens?: number;
  outputHeadroomTokens?: number;
  toolSchemaTokens?: number;
  compactHistory?: boolean;
  /**
   * Pre-computed estimateTokens(messages) to reuse instead of re-stringifying the
   * full history (Perf P6 #130). Used only when the consolidation pass is a no-op
   * (no compaction, no stray-system merge), so the fitted array has identical tokens.
   */
  precomputedRawMessageTokens?: number;
}

/**
 * Enforces the context window budget by returning a NEW array with older
 * non-protected messages evicted or replaced with truncation markers.
 * Canonical message history is never mutated.
 *
 * Protected (never evicted):
 * - The first message if role === "system"
 * - The last message with role === "user"
 */
export function fitContextWindow(
  messages: ContextMessage[],
  options?: FitContextOptions
): FittedMessages {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const source = options?.compactHistory
    ? compactConversationHistory(messages, {
        maxContentTokens: options?.maxContentTokens ?? CHAT_CONTEXT_BUDGET_TOKENS,
      }).messages
    : messages;

  // 1. Enforce invariant: role === "system" ONLY exists at index 0.
  // Consolidate any stray system messages at index > 0 into index 0.
  let consolidatedSystemContent = "";
  const hasLeadingSystem = source[0]?.role === "system";
  if (hasLeadingSystem) {
    consolidatedSystemContent =
      typeof source[0].content === "string"
        ? source[0].content
        : JSON.stringify(source[0].content || "");
  }

  const nonSystemMessages: ContextMessage[] = [];
  let straySystemMerged = false;
  for (let i = 0; i < source.length; i++) {
    const m = source[i];
    if (i === 0 && hasLeadingSystem) {
      continue;
    }
    if (m?.role === "system") {
      const extra = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      if (extra.trim() && !consolidatedSystemContent.includes(extra.trim())) {
        consolidatedSystemContent = consolidatedSystemContent
          ? `${consolidatedSystemContent}\n\n${extra.trim()}`
          : extra.trim();
        straySystemMerged = true;
      }
    } else {
      nonSystemMessages.push({ ...m });
    }
  }

  const working: ContextMessage[] = [];
  if (hasLeadingSystem || consolidatedSystemContent) {
    working.push({
      role: "system",
      content: consolidatedSystemContent,
    });
  }
  working.push(...nonSystemMessages);

  // Perf P6 (#130): reuse the precomputed raw-message estimate when the
  // consolidation pass produced an identical token count (no compaction, no
  // stray-system merge). This avoids re-stringifying the full history.
  const consolidationWasNoop =
    !options?.compactHistory &&
    options?.precomputedRawMessageTokens !== undefined &&
    !straySystemMerged;
  const rawTokens = consolidationWasNoop
    ? options!.precomputedRawMessageTokens!
    : estimateTokens(working);

  // Detect whether this turn is an artifact-creation request
  let lastUserContent = "";
  for (let j = working.length - 1; j >= 0; j--) {
    if (working[j]?.role === "user" && typeof working[j]?.content === "string") {
      lastUserContent = working[j].content;
      break;
    }
  }
  const isArtifact =
    options?.isArtifactTurn ?? hasArtifactCreationIntent(lastUserContent).isArtifactRequest;

  // 2. Budget reservation for output headroom (window - ROUND_MAX_TOKENS) and tool schemas
  const windowCeiling = computeEffectiveInputCeiling(
    options?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    options?.reserveOutputTokens ?? ROUND_MAX_TOKENS
  );
  let maxTokens = Math.min(options?.maxContentTokens ?? CHAT_CONTEXT_BUDGET_TOKENS, windowCeiling);
  const rawToolTokens = options?.toolSchemaTokens ?? estimateToolSchemaTokens(options?.tools);
  const toolSchemaTokens = rawToolTokens;

  if (toolSchemaTokens > 0) {
    maxTokens = Math.max(1200, maxTokens - toolSchemaTokens);
  }

  const hasWebResults = hasWebResearchResults(working);
  if (
    isArtifact ||
    options?.reserveOutputTokens !== undefined ||
    options?.outputHeadroomTokens !== undefined ||
    hasWebResults
  ) {
    const headroom =
      options?.outputHeadroomTokens ??
      options?.reserveOutputTokens ??
      (hasWebResults ? ARTIFACT_OUTPUT_HEADROOM_TOKENS_WEB : ARTIFACT_OUTPUT_HEADROOM_TOKENS);
    const windowBudget = Math.min(
      options?.maxContentTokens ?? CHAT_CONTEXT_BUDGET_TOKENS,
      windowCeiling
    );
    const artifactCeiling = windowBudget - headroom - rawToolTokens;
    maxTokens = Math.min(maxTokens, Math.max(1200, artifactCeiling));
  }

  let evictedCount = 0;

  if (rawTokens <= maxTokens) {
    const res: FittedMessages = working;
    res.evictedCount = 0;
    res.estimatedTokens = rawTokens;
    return res;
  }

  // Identify protected indices
  const isProtected = (idx: number, arr: ContextMessage[]): boolean => {
    if (idx === 0 && arr[0]?.role === "system") {
      return true;
    }
    // Protect the original user query (first user message) so intent & prompt are never lost
    const firstUserIdx = arr.findIndex((m) => m?.role === "user");
    if (idx === firstUserIdx && firstUserIdx !== -1) {
      return true;
    }
    let lastUserIdx = -1;
    for (let j = arr.length - 1; j >= 0; j--) {
      if (arr[j]?.role === "user") {
        lastUserIdx = j;
        break;
      }
    }
    return idx === lastUserIdx;
  };

  // Pass 1: Evict oldest non-protected messages.
  // For tool outputs (role === "tool"): replace content with truncation placeholder.
  // For other non-protected messages: remove them from array.
  let safetyCounter = working.length * 3;
  while (estimateTokens(working) > maxTokens && safetyCounter-- > 0) {
    let candidateIdx = -1;
    for (let i = 0; i < working.length; i++) {
      if (isProtected(i, working)) continue;

      if (working[i].role === "tool") {
        if (working[i].content !== EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER) {
          candidateIdx = i;
          break;
        }
      } else {
        candidateIdx = i;
        break;
      }
    }

    if (candidateIdx === -1) {
      break;
    }

    if (working[candidateIdx].role === "tool") {
      working[candidateIdx] = {
        ...working[candidateIdx],
        content: EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER,
      };
      evictedCount++;
    } else {
      working.splice(candidateIdx, 1);
      evictedCount++;
    }
  }

  // Pass 2: If still over budget, remove remaining non-protected tool placeholders
  safetyCounter = working.length * 2;
  while (estimateTokens(working) > maxTokens && safetyCounter-- > 0) {
    let candidateIdx = -1;
    for (let i = 0; i < working.length; i++) {
      if (!isProtected(i, working)) {
        candidateIdx = i;
        break;
      }
    }

    if (candidateIdx === -1) {
      break;
    }

    working.splice(candidateIdx, 1);
    evictedCount++;
  }

  // Pass 3 (Pathological): If still over budget with only protected messages left,
  // truncate the longest remaining content string to fit
  safetyCounter = 50;
  while (estimateTokens(working) > maxTokens && safetyCounter-- > 0) {
    let longestIdx = -1;
    let maxLen = 0;

    for (let i = 0; i < working.length; i++) {
      const len = typeof working[i].content === "string" ? working[i].content.length : 0;
      if (len > maxLen) {
        maxLen = len;
        longestIdx = i;
      }
    }

    if (longestIdx === -1 || maxLen <= TOOL_TRUNCATION_MARKER.length) {
      break;
    }

    const currentTokens = estimateTokens(working);
    const excessTokens = currentTokens - maxTokens;
    const excessChars = Math.max(1, excessTokens * 4);

    const targetChars = Math.max(0, maxLen - excessChars - TOOL_TRUNCATION_MARKER.length);
    const originalContent = working[longestIdx].content;
    working[longestIdx] = {
      ...working[longestIdx],
      content: originalContent.slice(0, targetChars) + TOOL_TRUNCATION_MARKER,
    };
    evictedCount++;
  }

  const result: FittedMessages = working;
  result.evictedCount = evictedCount;
  result.estimatedTokens = estimateTokens(working);
  return result;
}

/**
 * Clamps raw tool output to maxChars (default 64000) ending with structured paging metadata.
 */
export function clampToolOutput(raw: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (typeof raw !== "string") {
    raw = JSON.stringify(raw);
  }
  if (raw.length <= maxChars) {
    return raw;
  }
  const totalChars = raw.length;
  const marker = `\n...[TRUNCATED: Output was ${totalChars} chars, showing first ${maxChars} chars. Use start_line/end_line or offset/limit to read remaining chunks.]`;
  const keepChars = Math.max(0, maxChars - marker.length);
  return raw.slice(0, keepChars) + marker;
}

export interface RunChatToolLoopOptions {
  conversationMessages: ContextMessage[];
  activeModel?: string;
  effectiveReasoningEffort?: "low" | "medium" | "xhigh";
  llmTools?: Array<{ name?: string; function?: { name?: string }; [key: string]: unknown }>;
  /** @deprecated backward-compat alias */
  ollamaTools?: Array<{ name?: string; function?: { name?: string }; [key: string]: unknown }>;
  maxToolRounds?: number;
  maxContentTokens?: number;
  streamLlmChat?: (payload: Record<string, unknown>) => AsyncIterable<{
    message?: {
      content?: string;
      thinking?: string;
      tool_calls?: ContextToolCall[];
    };
  }>;
  /** @deprecated backward-compat alias */
  streamOllamaChat?: (payload: Record<string, unknown>) => AsyncIterable<{
    message?: {
      content?: string;
      thinking?: string;
      tool_calls?: ContextToolCall[];
    };
  }>;
  executeTool: (toolCall: ContextToolCall) => Promise<unknown>;
}

/**
 * Runs iterative chat tool rounds with per-round context window fitting,
 * tool-output clamping, and forced final-round synthesis.
 */
export async function runChatToolLoop(
  options: RunChatToolLoopOptions
): Promise<{ finalContent: string; roundsCompleted: number }> {
  const {
    conversationMessages,
    activeModel = "qwen3.8:27b-q3_k_m",
    effectiveReasoningEffort = "medium",
    maxToolRounds = TOOL_ROUND_BACKSTOP,
    maxContentTokens = CHAT_CONTEXT_BUDGET_TOKENS,
    executeTool,
  } = options;
  const llmTools = options.llmTools || options.ollamaTools || [];
  const streamChatFn = options.streamLlmChat || options.streamOllamaChat;
  if (!streamChatFn) {
    throw new Error("runChatToolLoop requires streamLlmChat");
  }

  let round = 0;
  let finalContent = "";
  let hasExecutedWebSearch = false;
  let lastRoundTools: string[] = [];
  let webResearchCalls = 0;
  let groundingRoundPending = false;
  const initialUserMsg = [...conversationMessages].reverse().find((m) => m?.role === "user");
  const userPrompt = typeof initialUserMsg?.content === "string" ? initialUserMsg.content : "";
  const { isArtifactRequest } = hasArtifactCreationIntent(userPrompt);

  while (true) {
    // Perf P6 (#130): measure the raw full-history estimate ONCE per round and
    // thread it through the fit ladder, continuation check, and provider payload
    // fit so those helpers reuse it instead of re-stringifying the history.
    const rawRoundTokens = estimateTokens(conversationMessages);

    // Fit conversation to budget first through the compaction/elision ladder
    const fitResult = fitConversationToBudget(conversationMessages, {
      budgetTokens: maxContentTokens,
      precomputedRawMessageTokens: rawRoundTokens,
    });
    if (fitResult.compacted) {
      conversationMessages.length = 0;
      conversationMessages.push(...fitResult.messages);
    }
    if (fitResult.highWater) {
      appendTrailingDirective(conversationMessages, HIGH_WATER_BANKING_DIRECTIVE);
    }

    // After a no-op fit the raw estimate is still valid; after compaction/elision
    // the history changed, so re-measure once.
    const contextTokens = fitResult.compacted
      ? estimateTokens(conversationMessages)
      : rawRoundTokens;

    // CHAT-7: continuation is governed by context headroom, with maxToolRounds acting
    // as an explicit (optional) backstop override rather than a normal work ceiling.
    const decision = canContinueToolLoop({
      round,
      contextTokens,
      budgetTokens: maxContentTokens,
      lastRoundTools,
      webResearchCalls,
      roundBackstop: maxToolRounds,
      awaitingToolRound: groundingRoundPending,
    });
    if (!decision.canContinue) break;
    groundingRoundPending = false;

    const isFinalRound = decision.forceSynthesis === true;
    if (isFinalRound) {
      appendTrailingDirective(conversationMessages, FINAL_ROUND_SYNTHESIS_DIRECTIVE);
    }
    if (isArtifactRequest) {
      appendTrailingDirective(conversationMessages, OUTPUT_HEADROOM_THINKING_DIRECTIVE);
    }

    const roundTools = llmTools;
    const payload: Record<string, unknown> = {
      model: activeModel,
      messages: fitContextWindow(conversationMessages, {
        maxContentTokens,
        tools: roundTools,
        isArtifactTurn: isArtifactRequest,
        precomputedRawMessageTokens: contextTokens,
      }),
      keep_alive: -1,
      options: resolveRoundModelOptions({
        model: activeModel,
        requestedEffort: effectiveReasoningEffort,
        userPrompt,
        isSynthesisOrFinalRound: isFinalRound,
        hasCompletedToolCalls: round > 0,
      }),
    };

    if (roundTools.length > 0) {
      payload.tools = roundTools;
      if (isFinalRound) {
        payload.tool_choice = "none";
      }
    }

    let fullRoundContent = "";
    const toolCallsFromMessage: ContextToolCall[] = [];

    for await (const chunk of streamChatFn(payload)) {
      if (chunk.message?.content) {
        fullRoundContent += chunk.message.content;
      }
      if (chunk.message?.tool_calls && Array.isArray(chunk.message.tool_calls)) {
        toolCallsFromMessage.push(...chunk.message.tool_calls);
      }
    }

    if (toolCallsFromMessage.length === 0 || isFinalRound) {
      if (
        !isFinalRound &&
        isLiveRealTimeIntent(userPrompt) &&
        !hasExecutedWebSearch &&
        round < maxToolRounds - 1
      ) {
        hasExecutedWebSearch = true;
        groundingRoundPending = true;
        appendTrailingDirective(
          conversationMessages,
          "[GROUNDING ENFORCEMENT]: You must use 'search_web' to check current/real-time information before answering this question. Invoke 'search_web' now."
        );
        round++;
        continue;
      }
      finalContent = fullRoundContent;
      conversationMessages.push({
        role: "assistant",
        content: fullRoundContent,
      });
      round++;
      break;
    }

    conversationMessages.push({
      role: "assistant",
      content: fullRoundContent,
      tool_calls: toolCallsFromMessage,
    });

    for (const toolCall of toolCallsFromMessage) {
      const toolName = toolCall.function?.name || toolCall.name || "";
      if (isWebResearchTool(toolName)) {
        if (webResearchCalls >= MAX_WEB_RESEARCH_CALLS) {
          conversationMessages.push({
            role: "tool",
            name: toolName,
            content: WEB_BUDGET_EXHAUSTED_DIRECTIVE,
          });
          appendTrailingDirective(conversationMessages, WEB_BUDGET_EXHAUSTED_DIRECTIVE);
          continue;
        }
        webResearchCalls++;
      }
      const toolResult = await executeTool(toolCall);
      const isFileReadTool = toolName === "workspace_read_file" || toolName === "host_read_file";
      conversationMessages.push({
        role: "tool",
        name: toolName,
        content: isFileReadTool
          ? JSON.stringify(toolResult)
          : clampToolOutput(JSON.stringify(toolResult)),
      });
    }

    lastRoundTools = toolCallsFromMessage.map((tc) => tc.function?.name || tc.name || "");
    round++;
  }

  return { finalContent, roundsCompleted: round };
}

/**
 * CHAT-7: budget-governed tool-round continuation.
 *
 * Rounds continue while the conversation still fits the context budget. When headroom
 * is gone, the loop stops and synthesis is handed to the route's post-tool synthesis
 * pass — except for exclusively web-research rounds, which may keep extending while
 * the web-research call budget (MAX_WEB_RESEARCH_CALLS) still has room (Round-1 item 2
 * semantics preserved). TOOL_ROUND_BACKSTOP is the runaway guard.
 *
 * "completed" means the previous round produced no tool calls, so the turn is done.
 * It must NEVER fire on round 0: route.ts starts with lastRoundTools = [] before any
 * round has run, and stopping there would execute zero tool rounds.
 */
export function canContinueToolLoop(options: {
  round: number;
  contextTokens: number;
  /** Measured/calibrated prompt tokens (includes provider truth + tool schemas, Fix D1). */
  measuredPromptTokens?: number;
  budgetTokens?: number;
  /** Physical model context window (defaults to DEFAULT_CONTEXT_WINDOW_TOKENS, Fix D2). */
  contextWindowTokens?: number;
  /** Per-round output reserve (defaults to ROUND_MAX_TOKENS, Fix D2). */
  outputReserveTokens?: number;
  lastRoundTools?: string[];
  webResearchCalls: number;
  roundBackstop?: number;
  /**
   * A directive (e.g. grounding enforcement) was injected demanding a tool round next.
   * While set, an empty lastRoundTools must NOT be read as "turn completed".
   */
  awaitingToolRound?: boolean;
}): ToolLoopDecision {
  const { round, contextTokens, lastRoundTools = [], webResearchCalls } = options;
  const budgetTokens = options.budgetTokens ?? CHAT_CONTEXT_BUDGET_TOKENS;
  const backstop = options.roundBackstop ?? TOOL_ROUND_BACKSTOP;
  const effectiveInputCeiling = computeEffectiveInputCeiling(
    options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    options.outputReserveTokens ?? ROUND_MAX_TOKENS
  );
  const effectiveContextTokens =
    typeof options.measuredPromptTokens === "number" &&
    Number.isFinite(options.measuredPromptTokens) &&
    options.measuredPromptTokens > 0
      ? Math.max(contextTokens, options.measuredPromptTokens)
      : contextTokens;

  if (round >= backstop) {
    return { canContinue: false, stopReason: "backstop" };
  }

  // A round that ran and produced no tool calls => the turn has completed.
  if (round > 0 && lastRoundTools.length === 0 && !options.awaitingToolRound) {
    return { canContinue: false, stopReason: "completed" };
  }

  // Fix D2 (F8b): hard output-headroom guard — a round must never START when
  // measured input already leaves no room for ROUND_MAX_TOKENS of output.
  if (effectiveContextTokens > effectiveInputCeiling) {
    return {
      canContinue: false,
      stopReason: "budget",
    };
  }

  const effectiveBudget = Math.min(budgetTokens, effectiveInputCeiling);
  if (effectiveContextTokens > effectiveBudget) {
    const allResearch =
      lastRoundTools.length > 0 && lastRoundTools.every((t) => isWebResearchTool(t));
    if (allResearch && webResearchCalls < MAX_WEB_RESEARCH_CALLS) {
      return { canContinue: true, forceSynthesis: false };
    }
    return {
      canContinue: false,
      stopReason: webResearchCalls >= MAX_WEB_RESEARCH_CALLS ? "web-research-cap" : "budget",
    };
  }

  // Headroom remains: keep gathering. The last permitted round under an explicit
  // (tight) backstop is a synthesis round with tools omitted.
  return { canContinue: true, forceSynthesis: round >= backstop - 1 };
}

export type CompactionAction =
  "compaction" | "elide_tool_outputs" | "drop_old_turns" | "truncate_oversize";

export interface FitConversationResult {
  messages: ContextMessage[];
  compacted: boolean;
  actions: CompactionAction[];
  tokensBefore: number;
  tokensAfter: number;
  highWater: boolean;
}

/**
 * Ladder fitting for active tool loops:
 * - Rung (a): Compaction alone if above 85% threshold or budget
 * - Rung (b): Older tool outputs elided to EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER
 * - Rung (c): Oldest non-system turns dropped (preserving system prompt, leading user brief, and latest user query)
 * - Rung (d): Truncate oversize payload (preserving system prompt and leading user brief first)
 */
export function fitConversationToBudget(
  messages: ContextMessage[],
  options?: {
    budgetTokens?: number;
    compactionThreshold?: number;
    preserveRecentMessages?: number;
    /** Provider-measured / calibrated prompt tokens (Fix D1). */
    measuredPromptTokens?: number;
    /** Estimator baseline matching measuredPromptTokens (Fix D1). */
    lastMeasuredEstimateTokens?: number;
    /** Tool-schema block sent to the model (Fix D1). */
    tools?: unknown[];
    /** Pre-computed tool-schema token count (Fix D1). */
    toolSchemaTokens?: number;
    /** Physical context window size (Fix D2). */
    contextWindowTokens?: number;
    /** Per-round output reserve (defaults to ROUND_MAX_TOKENS, Fix D2). */
    outputReserveTokens?: number;
    /**
     * Pre-computed estimateTokens(messages) to reuse instead of re-stringifying the
     * full history (Perf P6 #130). Valid only when the caller measured the exact
     * messages array passed in; the ladder's working copies diverge after compaction.
     */
    precomputedRawMessageTokens?: number;
  }
): FitConversationResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messages: [],
      compacted: false,
      actions: [],
      tokensBefore: 0,
      tokensAfter: 0,
      highWater: false,
    };
  }

  const effectiveInputCeiling = computeEffectiveInputCeiling(
    options?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    options?.outputReserveTokens ?? ROUND_MAX_TOKENS
  );
  const budgetTokens = Math.min(
    options?.budgetTokens ?? CHAT_CONTEXT_BUDGET_TOKENS,
    effectiveInputCeiling
  );
  const thresholdRatio = options?.compactionThreshold ?? COMPACTION_THRESHOLD_RATIO;
  const thresholdTokens = Math.floor(budgetTokens * thresholdRatio);
  const schemaTokens = options?.toolSchemaTokens ?? estimateToolSchemaTokens(options?.tools);
  const rawInitialMessageTokens =
    typeof options?.precomputedRawMessageTokens === "number"
      ? options.precomputedRawMessageTokens
      : estimateTokens(messages);
  const rawInitialTotal = rawInitialMessageTokens + schemaTokens;
  const baselineEstimate = options?.lastMeasuredEstimateTokens ?? rawInitialTotal;
  const initialTokens = estimateEffectivePromptTokens(messages, {
    lastMeasuredPromptTokens: options?.measuredPromptTokens,
    lastMeasuredEstimateTokens: options?.lastMeasuredEstimateTokens,
    toolSchemaTokens: schemaTokens,
    precomputedRawMessageTokens: rawInitialMessageTokens,
  });

  let workingMessages = messages.map((m) => ({ ...m }));
  const actions: CompactionAction[] = [];

  // Perf P6 (#130): memoize the raw message-token estimate for the working array.
  // The ladder mutates workingMessages in place (splice / content replace); those
  // mutations mark the cache dirty so the next measure re-scans exactly once. On a
  // standard round (no compaction, no elision, no drop) the array never changes, so
  // the whole ladder reuses the single raw estimate instead of re-stringifying.
  let rawWorkingTokens = rawInitialMessageTokens;
  let rawWorkingDirty = false;
  const markDirty = () => {
    rawWorkingDirty = true;
  };

  const measureWorking = (msgs: ContextMessage[]): number => {
    if (rawWorkingDirty) {
      rawWorkingTokens = estimateTokens(msgs);
      rawWorkingDirty = false;
    }
    return estimateEffectivePromptTokens(msgs, {
      lastMeasuredPromptTokens: options?.measuredPromptTokens,
      lastMeasuredEstimateTokens:
        options?.measuredPromptTokens !== undefined ? baselineEstimate : undefined,
      toolSchemaTokens: schemaTokens,
      precomputedRawMessageTokens: rawWorkingTokens,
    });
  };

  // Rung (a): Compaction alone if above threshold or budget
  if (initialTokens >= thresholdTokens) {
    const compactRes = compactConversationHistory(workingMessages, {
      maxContentTokens: budgetTokens,
      compactionThreshold: thresholdRatio,
      preserveRecentMessages: options?.preserveRecentMessages ?? 4,
      measuredPromptTokens: initialTokens,
      toolSchemaTokens: schemaTokens,
      contextWindowTokens: options?.contextWindowTokens,
      outputReserveTokens: options?.outputReserveTokens,
    });
    if (compactRes.compacted) {
      workingMessages = compactRes.messages.map((m) => ({ ...m }));
      actions.push("compaction");
      markDirty();
    }
  }

  const hasLeadingSystem = workingMessages[0]?.role === "system";

  // Rung (b): Older tool outputs elided if still > budgetTokens
  if (measureWorking(workingMessages) > budgetTokens) {
    let anyElided = false;
    const lastToolIdx = workingMessages.map((m) => m.role).lastIndexOf("tool");
    for (let i = hasLeadingSystem ? 1 : 0; i < workingMessages.length; i++) {
      if (workingMessages[i]?.role === "tool" && i !== lastToolIdx) {
        if (workingMessages[i].content !== EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER) {
          workingMessages[i] = {
            ...workingMessages[i],
            content: EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER,
          };
          anyElided = true;
          markDirty();
          if (measureWorking(workingMessages) <= budgetTokens) {
            break;
          }
        }
      }
    }
    if (anyElided) {
      actions.push("elide_tool_outputs");
    }
  }

  // Rung (c): Drop oldest non-system turns if still > budgetTokens
  // Fix D5 (F8e): protect BOTH the leading user brief AND the latest user message.
  if (measureWorking(workingMessages) > budgetTokens) {
    let anyDropped = false;
    const findProtectedUserIndices = (arr: ContextMessage[]) => {
      const firstUserIdx = arr.findIndex((m) => m?.role === "user");
      let latestUserIdx = -1;
      for (let j = arr.length - 1; j >= 0; j--) {
        if (arr[j]?.role === "user") {
          latestUserIdx = j;
          break;
        }
      }
      return { firstUserIdx, latestUserIdx };
    };

    let { firstUserIdx, latestUserIdx } = findProtectedUserIndices(workingMessages);

    let safety = workingMessages.length * 2;
    while (measureWorking(workingMessages) > budgetTokens && safety-- > 0) {
      let candidateIdx = -1;
      for (let i = hasLeadingSystem ? 1 : 0; i < workingMessages.length; i++) {
        if (i === firstUserIdx || i === latestUserIdx) continue;
        candidateIdx = i;
        break;
      }
      if (candidateIdx === -1) break;
      workingMessages.splice(candidateIdx, 1);
      anyDropped = true;
      markDirty();

      ({ firstUserIdx, latestUserIdx } = findProtectedUserIndices(workingMessages));
    }
    if (anyDropped) {
      actions.push("drop_old_turns");
    }
  }

  // Rung (d): Truncate oversize message if still > budgetTokens (e.g. 64K-char payload)
  // Fix D5 (F8e): preserve system prompt and leading user brief verbatim whenever any
  // other truncatable message exists.
  let safetyD = 20;
  while (measureWorking(workingMessages) > budgetTokens && safetyD-- > 0) {
    const firstUserIdx = workingMessages.findIndex((m) => m?.role === "user");
    let longestIdx = -1;
    let maxLen = 0;
    for (let i = 0; i < workingMessages.length; i++) {
      if (i === 0 && hasLeadingSystem && workingMessages.length > 1) continue;
      if (i === firstUserIdx && workingMessages.length > (hasLeadingSystem ? 2 : 1)) continue;
      const len =
        typeof workingMessages[i].content === "string" ? workingMessages[i].content.length : 0;
      if (len > maxLen) {
        maxLen = len;
        longestIdx = i;
      }
    }

    if (longestIdx === -1 || maxLen <= TOOL_TRUNCATION_MARKER.length) {
      break;
    }

    const currentTokens = measureWorking(workingMessages);
    const excessTokens = currentTokens - budgetTokens;
    const excessChars = Math.max(1, excessTokens * 4);
    const targetChars = Math.max(0, maxLen - excessChars - TOOL_TRUNCATION_MARKER.length);
    const orig = workingMessages[longestIdx].content;
    workingMessages[longestIdx] = {
      ...workingMessages[longestIdx],
      content: orig.slice(0, targetChars) + TOOL_TRUNCATION_MARKER,
    };
    markDirty();
    if (!actions.includes("truncate_oversize")) {
      actions.push("truncate_oversize");
    }
  }

  const finalTokens = measureWorking(workingMessages);
  const highWater =
    actions.includes("elide_tool_outputs") ||
    actions.includes("drop_old_turns") ||
    actions.includes("truncate_oversize") ||
    finalTokens >= budgetTokens * 0.9;

  return {
    messages: workingMessages,
    compacted: actions.length > 0,
    actions,
    tokensBefore: initialTokens,
    tokensAfter: finalTokens,
    highWater,
  };
}
