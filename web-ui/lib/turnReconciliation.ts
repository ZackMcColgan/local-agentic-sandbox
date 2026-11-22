/**
 * Helper for formatting caught SSE writer error with name, message, and first stack line.
 */
export function formatSseWriterError(err: unknown): string {
  if (!err) return "UnknownError";
  const e = err as { name?: string; message?: string; stack?: string };
  const name = e.name || "Error";
  const message = e.message || String(err);
  let stackLine = "";
  if (typeof e.stack === "string") {
    const lines = e.stack.split("\n");
    const found = lines.find((l: string) => l.trim().startsWith("at "));
    if (found) {
      stackLine = ` | ${found.trim()}`;
    }
  }
  return `${name}: ${message}${stackLine}`;
}

export type TurnDeliveryState =
  | { state: "idle" }
  | { state: "streaming"; content: string }
  | { state: "transient_disconnected"; partialContent: string; threadId: string }
  | {
      state: "resolved_reconciled";
      finalContent: string;
      finish_reason?: string;
      outputTokens?: number;
    }
  | { state: "aborted"; content: string }
  | { state: "error"; message: string };

/**
 * Pure state reducer mapping stream disconnects and detached turn resolutions.
 */
export function transitionOnStreamDisconnect(
  currentState: TurnDeliveryState,
  threadId: string,
  partialContent: string
): TurnDeliveryState {
  if (currentState.state === "streaming" || currentState.state === "idle") {
    return {
      state: "transient_disconnected",
      partialContent,
      threadId,
    };
  }
  return currentState;
}

export function transitionOnDetachedTurnReconciliation(
  currentState: TurnDeliveryState,
  persistedMessage: {
    content: string;
    status?: string;
    finish_reason?: string;
    outputTokens?: number;
  }
): TurnDeliveryState {
  if (currentState.state === "transient_disconnected") {
    if (persistedMessage.status !== "streaming") {
      return {
        state: "resolved_reconciled",
        finalContent: persistedMessage.content,
        finish_reason: persistedMessage.finish_reason,
        outputTokens: persistedMessage.outputTokens,
      };
    }
  }
  return currentState;
}
