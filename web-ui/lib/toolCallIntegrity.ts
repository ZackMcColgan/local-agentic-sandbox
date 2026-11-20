import type { CompletionStamp } from "./finishVerification";

export const TURN_TOOL_MARKUP_MARKER = "⚠️ [Turn ended: tool calls were not executable.]";

export const TOOL_MARKUP_REPAIR_DIRECTIVE =
  "[SYSTEM CORRECTION]: Your previous response emitted raw tool-call markup as text instead of an executable tool call. Do not narrate or print tool-call XML/markup. Re-issue the tool call using the proper tool-calling interface now.";

const TOOL_CALL_MARKUP_PATTERNS: RegExp[] = [
  /<tool_call>/i,
  /<\/tool_call>/i,
  /<function=[a-zA-Z0-9_.-]+>/i,
  /<\|tool_call\|>/i,
  /<\|tool_calls_section_begin\|>/i,
  /<\|im_start\|>/i,
  /function_calls>/i,
  /<parameter=[a-zA-Z0-9_.-]+>/i,
];

const TOOL_WORK_CLAIM_PATTERNS: RegExp[] = [
  /\b(i|we)\s+(ran|executed|edited|modified|updated|created|wrote|deleted|committed|pushed|tested|checked|read)\b/i,
  /\b(ran|executed)\s+`[^`]+`/i,
  /\b(edited|modified|updated|created|wrote)\s+`[^`]+`/i,
  /\bcommitted\s+[0-9a-f]{7,40}\b/i,
  /⚠️ \[Turn ended: tool calls were not executable\.\]/,
  /\b(?:i|we)\s+(?:couldn['’]?t|could\s+not|(?:was|were|am|are)\s+unable\s+to)\s+(?:pull|fetch|search|look\s+up|access|run|retrieve)\b/i,
  /\bwas\s+unable\s+to\s+(?:pull|fetch|search|look\s+up|access|run|retrieve)\b/i,
  /\b(?:the|my|our)\s+(?:[a-z0-9_-]+\s+)?(?:tool|search|lookup)\s+(?:(?:is|was|got)\s+)?(?:blocked|failed|unavailable|timed\s+out|rejected)\b/i,
];

/**
 * Returns true if the round text contains raw tool-call markup syntax.
 */
export function containsToolCallMarkup(text: string): boolean {
  if (!text) return false;
  return TOOL_CALL_MARKUP_PATTERNS.some((re) => re.test(text));
}

/**
 * Returns true if a stored assistant message is markup-only (begins with
 * `<tool_call>` or `<|im_start|>function_calls>` with no leading prose).
 */
export function isMarkupOnlyToolCall(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /^(?:<tool_call>\s*)?(?:<\|im_start\|>function_calls>|<tool_call>)/i.test(trimmed);
}

export interface MarkupRoundEvaluation {
  action: "pass" | "reprompt" | "end_turn";
  consecutiveMarkupFailures: number;
  directive?: string;
  marker?: string;
}

/**
 * Evaluates a completed round for unexecuted tool-call markup or phantom tool_calls rounds.
 * - Normal tool rounds (executedToolCallsCount > 0) or clean text rounds pass.
 * - A round with 0 executed calls fails if markup appears in content or thinking,
 *   or if roundFinishReason === "tool_calls".
 * - First failed round triggers a single corrective re-prompt.
 * - Second consecutive failed round ends the turn with TURN_TOOL_MARKUP_MARKER.
 */
export function evaluateMarkupRound(params: {
  roundContent: string;
  executedToolCallsCount: number;
  consecutiveMarkupFailures: number;
  roundFinishReason?: string;
  roundThinking?: string;
}): MarkupRoundEvaluation {
  const hasMarkup =
    containsToolCallMarkup(params.roundContent) ||
    (params.roundThinking ? containsToolCallMarkup(params.roundThinking) : false);
  const isPhantomToolRound = params.roundFinishReason === "tool_calls";

  if (params.executedToolCallsCount > 0 || (!hasMarkup && !isPhantomToolRound)) {
    return {
      action: "pass",
      consecutiveMarkupFailures: 0,
    };
  }

  const nextFailures = params.consecutiveMarkupFailures + 1;
  if (nextFailures >= 2) {
    return {
      action: "end_turn",
      consecutiveMarkupFailures: nextFailures,
      marker: TURN_TOOL_MARKUP_MARKER,
    };
  }

  return {
    action: "reprompt",
    consecutiveMarkupFailures: nextFailures,
    directive: TOOL_MARKUP_REPAIR_DIRECTIVE,
  };
}

export interface ZeroTraceGap {
  kind: "zero_traces";
  claim: string;
  found: string;
}

export interface ZeroTraceTripwireResult {
  completionStamp?: CompletionStamp;
  gaps: ZeroTraceGap[];
}

/**
 * Stamps a turn as `completed-unverified` when its final text claims tool work
 * but zero tool traces were recorded.
 */
export function evaluateZeroTraceTripwire(params: {
  content: string;
  tracesCount: number;
}): ZeroTraceTripwireResult {
  if (params.tracesCount > 0 || !params.content) {
    return { gaps: [] };
  }

  const claimsToolWork = TOOL_WORK_CLAIM_PATTERNS.some((re) => re.test(params.content));
  if (!claimsToolWork) {
    return { gaps: [] };
  }

  return {
    completionStamp: "completed-unverified",
    gaps: [
      {
        kind: "zero_traces",
        claim: "Tool work claimed",
        found: "0 tool traces recorded",
      },
    ],
  };
}
