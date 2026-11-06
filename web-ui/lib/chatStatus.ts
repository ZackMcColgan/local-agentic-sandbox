import { cleanResidualToolTags } from "./toolParser";

export const TURN_PHASE_PREPARING = "Preparing context & tools" as const;
export const TURN_PHASE_REASONING = "Reasoning" as const;
export const TURN_PHASE_WRITING = "Writing answer" as const;

export interface TurnStatusInput {
  isStreaming: boolean;
  streamStatus?: string | null;
  activeTool?: string | null;
  hasThought?: boolean;
  hasContent?: boolean;
}

/**
 * Pure phase reducer for the single turn status slot.
 * Phases:
 * - "Preparing context & tools"
 * - "Reasoning"
 * - "Running <tool>"
 * - "Writing answer"
 */
export function resolveTurnStatusPhase(input: TurnStatusInput): string | null {
  if (!input.isStreaming) return null;

  if (input.activeTool && input.activeTool.trim()) {
    return `Running ${input.activeTool.trim()}`;
  }

  const raw = (input.streamStatus || "").trim();
  if (raw) {
    const runningMatch = raw.match(/^(?:Running|Executing|Invoking)\s+([a-zA-Z0-9_.\-]+?)(?:\.+)?$/i);
    if (runningMatch) {
      return `Running ${runningMatch[1].replace(/\.+$/, "")}`;
    }
    if (/preparing context/i.test(raw)) {
      return TURN_PHASE_PREPARING;
    }
    if (/synthesizing|writing answer/i.test(raw)) {
      return TURN_PHASE_WRITING;
    }
    if (/reasoning|thinking|analyzing/i.test(raw)) {
      return TURN_PHASE_REASONING;
    }
  }

  if (input.hasContent) {
    return TURN_PHASE_WRITING;
  }
  if (input.hasThought) {
    return TURN_PHASE_REASONING;
  }
  return TURN_PHASE_PREPARING;
}

export interface TurnCompletionResult {
  cleanedContent: string;
  turnStatus: "completed" | "incomplete" | undefined;
  isIncomplete: boolean | undefined;
}

/**
 * Pure turn completion evaluator implementing Never-Silent Turns (CHAT-1)
 * and message incomplete status flagging (CHAT-3).
 */
export function evaluateTurnCompletion({
  content,
  round,
  maxToolRounds,
  tracesCount
}: {
  content?: string;
  round: number;
  maxToolRounds: number;
  tracesCount: number;
}): TurnCompletionResult {
  let cleanedContent = cleanResidualToolTags(content || "");
  let turnStatus: "completed" | "incomplete" | undefined = undefined;

  if (!cleanedContent) {
    turnStatus = "incomplete";
    if (round >= maxToolRounds) {
      cleanedContent = `⚠️ [Turn paused: Tool execution limit reached (${round} rounds). Traces captured above; synthesis returned no text.]`;
    } else if (tracesCount > 0) {
      cleanedContent = `⚠️ [Turn incomplete: Tool execution concluded without synthesis text. Traces captured above.]`;
    } else if (content?.trim()) {
      cleanedContent = content.trim();
      turnStatus = undefined;
    } else {
      cleanedContent = "I am ready to assist you. What would you like to build or explore?";
      turnStatus = undefined;
    }
  } else if (round >= maxToolRounds) {
    turnStatus = "incomplete";
    cleanedContent = `${cleanedContent}\n\n⚠️ [Turn paused: Tool execution limit reached (${round} rounds).]`;
  }

  return {
    cleanedContent,
    turnStatus,
    isIncomplete: turnStatus === "incomplete" ? true : undefined
  };
}

/**
 * Extracts turn status from SSE done event fields or content markers.
 */
export function extractDoneTurnStatus(event: {
  status?: "completed" | "incomplete" | "error";
  isIncomplete?: boolean;
  content?: string;
}): "completed" | "incomplete" | "error" | undefined {
  return (
    event.status ||
    (event.isIncomplete ? "incomplete" : undefined) ||
    (event.content?.includes("⚠️ [Turn paused:") || event.content?.includes("⚠️ [Turn incomplete:")
      ? "incomplete"
      : undefined)
  );
}

/**
 * Merges accumulated streamed tokens with server final event content,
 * ensuring tokens streamed during prior rounds are never discarded (CHAT-5).
 */
export function mergeStreamedTokens(accumulatedRaw: string, eventContent?: string): string {
  const acc = (accumulatedRaw || "").trim();
  const evt = (eventContent || "").trim();

  if (!evt) return acc;
  if (!acc) return evt;
  if (acc === evt) return evt;

  // If one is already a complete superset of the other, return the superset
  if (evt.includes(acc)) return evt;
  if (acc.includes(evt)) return acc;

  // If eventContent is an incomplete/pause banner, append it
  if (evt.startsWith("⚠️ [Turn")) {
    return `${acc}\n\n${evt}`;
  }

  // Check if evt overlaps with the end of acc
  const maxOverlap = Math.min(acc.length, evt.length);
  for (let len = maxOverlap; len > 0; len--) {
    if (acc.endsWith(evt.slice(0, len))) {
      return acc + evt.slice(len);
    }
  }

  // Otherwise, join them cleanly with a double newline
  return `${acc}\n\n${evt}`;
}
