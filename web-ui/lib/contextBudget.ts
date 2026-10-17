/**
 * Context Budget Enforcer & Token Estimator
 *
 * Prevents context exhaustion incidents where unbounded tool outputs accumulate
 * across iterative tool rounds, forcing model context drops of system prompts and user queries.
 */

export const EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER =
  "[Earlier tool output truncated to fit the 8192-token context window]";

export const TOOL_TRUNCATION_MARKER = "...[truncated]";
export const MAX_TOOL_OUTPUT_CHARS = 2000;

export const FINAL_ROUND_SYNTHESIS_DIRECTIVE =
  "You have gathered enough information. Synthesize your final answer now using only the tool results above. Do not call more tools.";

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

export interface FitContextOptions {
  maxContentTokens?: number;
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

  const maxTokens = options?.maxContentTokens ?? 6000;

  // Clone messages so canonical history is never mutated
  const working: any[] = messages.map((m) => ({ ...m }));

  if (estimateTokens(working) <= maxTokens) {
    return working;
  }

  // Identify protected indices
  const isProtected = (idx: number, arr: any[]): boolean => {
    if (idx === 0 && arr[0]?.role === "system") {
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
    } else {
      working.splice(candidateIdx, 1);
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
  }

  return working;
}

/**
 * Clamps raw tool output to maxChars (default 2000) ending with a truncation marker.
 */
export function clampToolOutput(raw: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (typeof raw !== "string") {
    raw = JSON.stringify(raw);
  }
  if (raw.length <= maxChars) {
    return raw;
  }
  const keepChars = Math.max(0, maxChars - TOOL_TRUNCATION_MARKER.length);
  return raw.slice(0, keepChars) + TOOL_TRUNCATION_MARKER;
}
