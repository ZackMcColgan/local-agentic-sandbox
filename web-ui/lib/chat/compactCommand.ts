/**
 * Composer slash command: /compact
 *
 * When a submitted message's trimmed text is exactly `/compact`
 * (case-insensitive), the composer runs manual compaction for the current
 * thread through the same path as the "Compact history now" action
 * (POST /api/threads/<id>/compact) INSTEAD of sending a chat turn.
 *
 * Any other input — including messages that merely contain /compact as part
 * of longer text ("/compact please", "run /compact now") — sends normally.
 */

export const COMPACT_COMMAND_TOKEN = "/compact";

export const COMPACT_NOTHING_TO_COMPACT = "Nothing to compact yet";
export const COMPACT_MID_TURN_MESSAGE =
  "Compaction is unavailable while a turn is streaming — wait for it to finish.";

/** True only when the trimmed text is exactly /compact, case-insensitive. */
export function parseCompactCommand(text: string): boolean {
  return text.trim().toLowerCase() === COMPACT_COMMAND_TOKEN;
}

export type CompactCommandResult =
  | { kind: "success"; message: string; tokensBefore: number; tokensAfter: number }
  | { kind: "error"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "no-thread"; message: string };

export interface CompactCommandDeps {
  isStreaming: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Runs manual compaction for `threadId` via POST /api/threads/<id>/compact.
 * Never creates a thread: an empty new thread yields the nothing-to-compact
 * notice. Refused mid-turn with the same unavailable-mid-turn behavior the
 * manual compact path uses.
 */
export async function runCompactCommand(
  threadId: string | undefined,
  deps: CompactCommandDeps
): Promise<CompactCommandResult> {
  if (deps.isStreaming) {
    return { kind: "refused", message: COMPACT_MID_TURN_MESSAGE };
  }
  if (!threadId) {
    return { kind: "no-thread", message: COMPACT_NOTHING_TO_COMPACT };
  }

  const doFetch = deps.fetchImpl || fetch;
  try {
    const res = await doFetch(
      `/api/threads/${encodeURIComponent(threadId)}/compact`,
      { method: "POST" }
    );
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        if (typeof body?.error === "string") detail = body.error;
      } catch {
        // Non-JSON error body: fall back to status text below.
      }
      return {
        kind: "error",
        message: detail || `Compaction failed (HTTP ${res.status})`,
      };
    }
    const data = await res.json().catch(() => ({}));
    const before = typeof data.tokensBefore === "number" ? data.tokensBefore : undefined;
    const after = typeof data.tokensAfter === "number" ? data.tokensAfter : undefined;
    if (before !== undefined && after !== undefined) {
      return {
        kind: "success",
        message: `History compacted: ${before} → ${after} tokens`,
        tokensBefore: before,
        tokensAfter: after,
      };
    }
    return { kind: "success", message: "History compacted", tokensBefore: 0, tokensAfter: 0 };
  } catch (err: unknown) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
