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
