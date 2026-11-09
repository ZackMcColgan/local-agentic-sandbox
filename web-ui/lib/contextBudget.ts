/**
 * Context Budget Enforcer & Token Estimator
 *
 * Prevents context exhaustion incidents where unbounded tool outputs accumulate
 * across iterative tool rounds, forcing model context drops of system prompts and user queries.
 */

import { computeModelOptions } from "./chatUtils";
import { compactConversationHistory } from "./conversationCompaction";

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

export type ToolLoopStopReason = "completed" | "budget" | "backstop" | "web-research-cap";

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

export const WEB_BUDGET_EXHAUSTED_DIRECTIVE =
  `[ACTION DISCIPLINE]: You have reached the maximum of ${MAX_WEB_RESEARCH_CALLS} web research calls for this turn. Web search tools are now disabled. Immediately use the gathered facts to produce the user's requested deliverable (e.g. call workspace_write_file or output the requested SVG/code artifact) or synthesize your final answer.`;

export function isWebResearchTool(toolName: string, tier?: string): boolean {
  return WEB_RESEARCH_TOOL_NAMES.has(toolName) || tier === "browser";
}

export function filterToolsForWebBudget(
  llmTools: any[],
  webResearchCallsUsed: number,
  maxWebCalls: number = MAX_WEB_RESEARCH_CALLS
): any[] {
  if (webResearchCallsUsed < maxWebCalls) {
    return llmTools;
  }
  return llmTools.filter((t) => {
    const name = t.function?.name || t.name;
    return !WEB_RESEARCH_TOOL_NAMES.has(name);
  });
}

export function hasArtifactCreationIntent(userPrompt: string): { isArtifactRequest: boolean; wantsSvg: boolean } {
  const wantsSvg =
    /\b(svg|vector\s+diagram|vector\s+graphic|drawio|flowchart|architecture\s+diagram)\b/i.test(userPrompt) ||
    (/\b(create|draw|generate|build|make|design|render|sketch)\b/i.test(userPrompt) &&
      /\b(diagram|chart|visual|graphic|card|infographic|illustration)\b/i.test(userPrompt));

  const isArtifactRequest =
    wantsSvg ||
    (/\b(create|write|generate|build|make|save|produce)\b/i.test(userPrompt) &&
      /\b(file|script|code|module|component|html|artifact|report)\b/i.test(userPrompt));

  return { isArtifactRequest, wantsSvg };
}

export function buildSynthesisDirective(userPrompt: string, isFinalRoundSystemPrompt: boolean = false): string {
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
  traces: Array<{ tool: string; args?: any; result?: any }>;
}): boolean {
  if ((params.traces.length > 0 && params.lingeringToolCallsCount > 0) || !params.assistantContent?.trim()) {
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
 * Conservative token estimator: Math.ceil(text.length / 4).
 * Handles string, message object, or message arrays.
 */
export function estimateTokens(input: any): number {
  if (!input) return 0;
  if (typeof input === "string") {
    return Math.ceil(input.length / 4);
  }
  if (Array.isArray(input)) {
    let chars = 0;
    for (const msg of input) {
      if (!msg) continue;
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
    let chars = 0;
    if (typeof input.content === "string") {
      chars += input.content.length;
    } else if (input.content) {
      chars += JSON.stringify(input.content).length;
    }
    if (input.role) chars += String(input.role).length;
    if (input.name) chars += String(input.name).length;
    if (input.tool_calls) chars += JSON.stringify(input.tool_calls).length;
    return Math.ceil(chars / 4);
  }
  return Math.ceil(String(input).length / 4);
}

/**
 * Merges a system directive into messages[0] if it is a system message,
 * or inserts a system message at index 0 if not present.
 * Guarantees role === "system" never appears at index > 0.
 */
export function mergeSystemDirective<T extends { role?: string; content?: any }>(
  messages: T[],
  directive: string
): T[] {
  if (!directive || !directive.trim()) {
    return messages;
  }
  const trimmed = directive.trim();

  if (messages.length > 0 && messages[0]?.role === "system") {
    const existing = typeof messages[0].content === "string" ? messages[0].content : JSON.stringify(messages[0].content || "");
    if (!existing.includes(trimmed)) {
      messages[0] = {
        ...messages[0],
        content: existing ? `${existing}\n\n${trimmed}` : trimmed
      };
    }
  } else {
    messages.unshift({
      role: "system",
      content: trimmed
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

export function hasWebResearchResults(messages: any[]): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => {
    if (m?.role === "tool" && (m?.name === "search_web" || m?.name === "fetch_webpage_markdown")) {
      return true;
    }
    if (m?.tool_calls && Array.isArray(m.tool_calls)) {
      return m.tool_calls.some((tc: any) =>
        WEB_RESEARCH_TOOL_NAMES.has(tc?.function?.name || tc?.name)
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
  [key: string]: any;
}): {
  num_ctx: number;
  num_predict?: number;
  temperature: number;
  reasoning_effort?: "low" | "medium" | "xhigh";
  n_keep?: number;
  numKeep?: number;
} {
  const isArtifact =
    params.isArtifactTurn ?? (params.userPrompt ? hasArtifactCreationIntent(params.userPrompt).isArtifactRequest : false);
  const shouldUseFastSynthesis =
    isArtifact || params.isSynthesisOrFinalRound || params.hasCompletedToolCalls;
  const effectiveEffort = shouldUseFastSynthesis ? "low" : (params.requestedEffort || "medium");
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
    reasoning_effort: effectiveEffort
  };
  if (params.numKeep !== undefined) {
    result.num_predict = 2048 + params.numKeep;
    result.n_keep = params.numKeep;
    result.numKeep = params.numKeep;
  } else {
    result.num_predict = baseOpts.num_predict || 8192;
  }
  return result;
}

export interface FitContextOptions {
  maxContentTokens?: number;
  tools?: any[];
  isArtifactTurn?: boolean;
  reserveOutputTokens?: number;
  outputHeadroomTokens?: number;
  toolSchemaTokens?: number;
  compactHistory?: boolean;
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
  messages: any[],
  options?: FitContextOptions
): any[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const source = options?.compactHistory
    ? compactConversationHistory(messages, { maxContentTokens: options?.maxContentTokens ?? CHAT_CONTEXT_BUDGET_TOKENS }).messages
    : messages;

  // 1. Enforce invariant: role === "system" ONLY exists at index 0.
  // Consolidate any stray system messages at index > 0 into index 0.
  let consolidatedSystemContent = "";
  const hasLeadingSystem = source[0]?.role === "system";
  if (hasLeadingSystem) {
    consolidatedSystemContent = typeof source[0].content === "string" ? source[0].content : JSON.stringify(source[0].content || "");
  }

  const nonSystemMessages: any[] = [];
  for (let i = 0; i < source.length; i++) {
    const m = source[i];
    if (i === 0 && hasLeadingSystem) {
      continue;
    }
    if (m?.role === "system") {
      const extra = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      if (extra.trim() && !consolidatedSystemContent.includes(extra.trim())) {
        consolidatedSystemContent = consolidatedSystemContent ? `${consolidatedSystemContent}\n\n${extra.trim()}` : extra.trim();
      }
    } else {
      nonSystemMessages.push({ ...m });
    }
  }

  const working: any[] = [];
  if (hasLeadingSystem || consolidatedSystemContent) {
    working.push({
      role: "system",
      content: consolidatedSystemContent
    });
  }
  working.push(...nonSystemMessages);

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

  // 2. Budget reservation for tool schemas and artifact output headroom
  let maxTokens = options?.maxContentTokens ?? CHAT_CONTEXT_BUDGET_TOKENS;
  const rawToolTokens =
    options?.toolSchemaTokens ??
    (options?.tools && Array.isArray(options.tools) && options.tools.length > 0
      ? estimateTokens(JSON.stringify(options.tools))
      : 0);
  const toolSchemaTokens = Math.min(2500, rawToolTokens);

  if (toolSchemaTokens > 0) {
    maxTokens = Math.max(2000, maxTokens - toolSchemaTokens);
  }

  const hasWebResults = hasWebResearchResults(working);
  if (isArtifact || options?.reserveOutputTokens !== undefined || options?.outputHeadroomTokens !== undefined || hasWebResults) {
    const headroom =
      options?.outputHeadroomTokens ??
      options?.reserveOutputTokens ??
      (hasWebResults ? ARTIFACT_OUTPUT_HEADROOM_TOKENS_WEB : ARTIFACT_OUTPUT_HEADROOM_TOKENS);
    const windowBudget = options?.maxContentTokens ?? CHAT_CONTEXT_BUDGET_TOKENS;
    const artifactCeiling = windowBudget - headroom - rawToolTokens;
    maxTokens = Math.min(maxTokens, Math.max(1200, artifactCeiling));
  }

  let evictedCount = 0;

  if (estimateTokens(working) <= maxTokens) {
    const res: any = working;
    res.evictedCount = 0;
    res.estimatedTokens = estimateTokens(working);
    return res;
  }

  // Identify protected indices
  const isProtected = (idx: number, arr: any[]): boolean => {
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
        content: EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER
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
      content: originalContent.slice(0, targetChars) + TOOL_TRUNCATION_MARKER
    };
    evictedCount++;
  }

  const result: any = working;
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
  conversationMessages: any[];
  activeModel?: string;
  effectiveReasoningEffort?: "low" | "medium" | "xhigh";
  llmTools?: any[];
  /** @deprecated backward-compat alias */
  ollamaTools?: any[];
  maxToolRounds?: number;
  maxContentTokens?: number;
  streamLlmChat?: (payload: any) => AsyncIterable<{
    message?: {
      content?: string;
      thinking?: string;
      tool_calls?: any[];
    };
  }>;
  /** @deprecated backward-compat alias */
  streamOllamaChat?: (payload: any) => AsyncIterable<{
    message?: {
      content?: string;
      thinking?: string;
      tool_calls?: any[];
    };
  }>;
  executeTool: (toolCall: any) => Promise<any>;
}

/**
 * Runs iterative chat tool rounds with per-round context window fitting,
 * tool-output clamping, and forced final-round synthesis.
 */
export async function runChatToolLoop(options: RunChatToolLoopOptions): Promise<{ finalContent: string; roundsCompleted: number }> {
  const {
    conversationMessages,
    activeModel = "qwen3.8:27b-q3_k_m",
    effectiveReasoningEffort = "medium",
    maxToolRounds = TOOL_ROUND_BACKSTOP,
    maxContentTokens = CHAT_CONTEXT_BUDGET_TOKENS,
    executeTool
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
    // Fit conversation to budget first through the compaction/elision ladder
    const fitResult = fitConversationToBudget(conversationMessages, {
      budgetTokens: maxContentTokens
    });
    if (fitResult.compacted) {
      conversationMessages.length = 0;
      conversationMessages.push(...fitResult.messages);
    }
    if (fitResult.highWater) {
      mergeSystemDirective(conversationMessages, HIGH_WATER_BANKING_DIRECTIVE);
    }

    // CHAT-7: continuation is governed by context headroom, with maxToolRounds acting
    // as an explicit (optional) backstop override rather than a normal work ceiling.
    const decision = canContinueToolLoop({
      round,
      contextTokens: estimateTokens(conversationMessages),
      budgetTokens: maxContentTokens,
      lastRoundTools,
      webResearchCalls,
      roundBackstop: maxToolRounds,
      awaitingToolRound: groundingRoundPending
    });
    if (!decision.canContinue) break;
    groundingRoundPending = false;

    const isFinalRound = decision.forceSynthesis === true;
    if (isFinalRound) {
      mergeSystemDirective(conversationMessages, FINAL_ROUND_SYNTHESIS_DIRECTIVE);
    }
    if (isArtifactRequest) {
      mergeSystemDirective(conversationMessages, OUTPUT_HEADROOM_THINKING_DIRECTIVE);
    }

    const payload: any = {
      model: activeModel,
      messages: fitContextWindow(conversationMessages, {
        maxContentTokens,
        tools: isFinalRound ? undefined : llmTools,
        isArtifactTurn: isArtifactRequest
      }),
      keep_alive: -1,
      options: resolveRoundModelOptions({
        model: activeModel,
        requestedEffort: effectiveReasoningEffort,
        userPrompt,
        isSynthesisOrFinalRound: isFinalRound,
        hasCompletedToolCalls: round > 0
      })
    };

    if (llmTools.length > 0 && !isFinalRound) {
      payload.tools = llmTools;
    }

    let fullRoundContent = "";
    let toolCallsFromMessage: any[] = [];

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
        mergeSystemDirective(
          conversationMessages,
          "[GROUNDING ENFORCEMENT]: You must use 'search_web' to check current/real-time information before answering this question. Invoke 'search_web' now."
        );
        round++;
        continue;
      }
      finalContent = fullRoundContent;
      conversationMessages.push({
        role: "assistant",
        content: fullRoundContent
      });
      round++;
      break;
    }

    conversationMessages.push({
      role: "assistant",
      content: fullRoundContent,
      tool_calls: toolCallsFromMessage
    });

    for (const toolCall of toolCallsFromMessage) {
      const toolResult = await executeTool(toolCall);
      const toolName = toolCall.function?.name || toolCall.name;
      if (isWebResearchTool(toolName)) webResearchCalls++;
      const isFileReadTool = toolName === "workspace_read_file" || toolName === "host_read_file";
      conversationMessages.push({
        role: "tool",
        name: toolName,
        content: isFileReadTool ? JSON.stringify(toolResult) : clampToolOutput(JSON.stringify(toolResult))
      });
    }

    lastRoundTools = toolCallsFromMessage.map((tc: any) => tc.function?.name || tc.name || "");
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
  budgetTokens?: number;
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

  if (round >= backstop) {
    return { canContinue: false, stopReason: "backstop" };
  }

  // A round that ran and produced no tool calls => the turn has completed.
  if (round > 0 && lastRoundTools.length === 0 && !options.awaitingToolRound) {
    return { canContinue: false, stopReason: "completed" };
  }

  if (contextTokens > budgetTokens) {
    const allResearch = lastRoundTools.length > 0 && lastRoundTools.every((t) => isWebResearchTool(t));
    if (allResearch && webResearchCalls < MAX_WEB_RESEARCH_CALLS) {
      return { canContinue: true, forceSynthesis: false };
    }
    return {
      canContinue: false,
      stopReason: webResearchCalls >= MAX_WEB_RESEARCH_CALLS ? "web-research-cap" : "budget"
    };
  }

  // Headroom remains: keep gathering. The last permitted round under an explicit
  // (tight) backstop is a synthesis round with tools omitted.
  return { canContinue: true, forceSynthesis: round >= backstop - 1 };
}

export type CompactionAction =
  | "compaction"
  | "elide_tool_outputs"
  | "drop_old_turns"
  | "truncate_oversize";

export interface FitConversationResult {
  messages: any[];
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
 * - Rung (c): Oldest non-system turns dropped (preserving system prompt and latest user query)
 * - Rung (d): Truncate oversize payload (preserving system prompt)
 */
export function fitConversationToBudget(
  messages: any[],
  options?: {
    budgetTokens?: number;
    compactionThreshold?: number;
    preserveRecentMessages?: number;
  }
): FitConversationResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messages: [],
      compacted: false,
      actions: [],
      tokensBefore: 0,
      tokensAfter: 0,
      highWater: false
    };
  }

  const budgetTokens = options?.budgetTokens ?? CHAT_CONTEXT_BUDGET_TOKENS;
  const thresholdRatio = options?.compactionThreshold ?? 0.85;
  const thresholdTokens = Math.floor(budgetTokens * thresholdRatio);
  const initialTokens = estimateTokens(messages);
  let workingMessages = messages.map((m) => ({ ...m }));
  const actions: CompactionAction[] = [];

  // Rung (a): Compaction alone if above threshold or budget
  if (initialTokens >= thresholdTokens) {
    const compactRes = compactConversationHistory(workingMessages, {
      maxContentTokens: budgetTokens,
      compactionThreshold: thresholdRatio,
      preserveRecentMessages: options?.preserveRecentMessages ?? 4
    });
    if (compactRes.compacted) {
      workingMessages = compactRes.messages;
      actions.push("compaction");
    }
  }

  const hasLeadingSystem = workingMessages[0]?.role === "system";

  // Rung (b): Older tool outputs elided if still > budgetTokens
  if (estimateTokens(workingMessages) > budgetTokens) {
    let anyElided = false;
    const lastToolIdx = workingMessages.map((m) => m.role).lastIndexOf("tool");
    for (let i = hasLeadingSystem ? 1 : 0; i < workingMessages.length; i++) {
      if (workingMessages[i]?.role === "tool" && i !== lastToolIdx) {
        if (workingMessages[i].content !== EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER) {
          workingMessages[i] = {
            ...workingMessages[i],
            content: EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER
          };
          anyElided = true;
          if (estimateTokens(workingMessages) <= budgetTokens) {
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
  if (estimateTokens(workingMessages) > budgetTokens) {
    let anyDropped = false;
    let latestUserIdx = -1;
    for (let j = workingMessages.length - 1; j >= 0; j--) {
      if (workingMessages[j]?.role === "user") {
        latestUserIdx = j;
        break;
      }
    }

    let safety = workingMessages.length * 2;
    while (estimateTokens(workingMessages) > budgetTokens && safety-- > 0) {
      let candidateIdx = -1;
      for (let i = hasLeadingSystem ? 1 : 0; i < workingMessages.length; i++) {
        if (i === latestUserIdx) continue;
        candidateIdx = i;
        break;
      }
      if (candidateIdx === -1) break;
      workingMessages.splice(candidateIdx, 1);
      anyDropped = true;

      latestUserIdx = -1;
      for (let j = workingMessages.length - 1; j >= 0; j--) {
        if (workingMessages[j]?.role === "user") {
          latestUserIdx = j;
          break;
        }
      }
    }
    if (anyDropped) {
      actions.push("drop_old_turns");
    }
  }

  // Rung (d): Truncate oversize message if still > budgetTokens (e.g. 64K-char payload)
  let safetyD = 20;
  while (estimateTokens(workingMessages) > budgetTokens && safetyD-- > 0) {
    let longestIdx = -1;
    let maxLen = 0;
    for (let i = 0; i < workingMessages.length; i++) {
      if (i === 0 && hasLeadingSystem && workingMessages.length > 1) continue;
      const len = typeof workingMessages[i].content === "string" ? workingMessages[i].content.length : 0;
      if (len > maxLen) {
        maxLen = len;
        longestIdx = i;
      }
    }

    if (longestIdx === -1 || maxLen <= TOOL_TRUNCATION_MARKER.length) {
      break;
    }

    const currentTokens = estimateTokens(workingMessages);
    const excessTokens = currentTokens - budgetTokens;
    const excessChars = Math.max(1, excessTokens * 4);
    const targetChars = Math.max(0, maxLen - excessChars - TOOL_TRUNCATION_MARKER.length);
    const orig = workingMessages[longestIdx].content;
    workingMessages[longestIdx] = {
      ...workingMessages[longestIdx],
      content: orig.slice(0, targetChars) + TOOL_TRUNCATION_MARKER
    };
    if (!actions.includes("truncate_oversize")) {
      actions.push("truncate_oversize");
    }
  }

  const finalTokens = estimateTokens(workingMessages);
  const highWater =
    actions.includes("elide_tool_outputs") ||
    actions.includes("drop_old_turns") ||
    actions.includes("truncate_oversize") ||
    finalTokens >= budgetTokens * 0.90;

  return {
    messages: workingMessages,
    compacted: actions.length > 0,
    actions,
    tokensBefore: initialTokens,
    tokensAfter: finalTokens,
    highWater
  };
}
