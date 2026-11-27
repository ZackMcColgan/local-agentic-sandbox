// Composer slash command: /compact (industry-standard manual compaction, as in
// Claude Code and peers). When a submitted message's trimmed text is exactly
// /compact (case-insensitive), the composer runs manual compaction for the
// current thread through the same path as the Compact history now action
// (POST /api/threads/<id>/compact) INSTEAD of sending a chat turn: no user
// message is appended and no turn starts. Any other input — including messages
// that merely contain /compact as part of longer text — sends normally.
//
// Mid-turn refusal mirrors the manual compact path's unavailable-mid-turn
// copy (web-ui/components/ContextSheet.tsx:79-83).

export type CompactCommandResult =
  | { kind: "success"; tokensBefore: number; tokensAfter: number }
  | { kind: "nothing-to-compact" }
  | { kind: "unavailable-mid-turn"; message: string }
  | { kind: "error"; message: string };

export interface CompactCommandDeps {
  threadId: string | null;
  isStreaming: boolean;
  isCompacting: boolean;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Exact-match detection: trimmed text equals /compact, case-insensitive. */
export function isCompactSlashCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/compact";
}

/** Same unavailable-mid-turn copy the manual Compact action uses. */
export const COMPACT_MID_TURN_MESSAGE = "A turn is streaming — wait for it to finish.";

export function formatCompactNotice(result: CompactCommandResult): string {
  switch (result.kind) {
    case "success":
      return `Compacted ${result.tokensBefore} → ${result.tokensAfter} tokens`;
    case "nothing-to-compact":
      return "Nothing to compact yet";
    case "unavailable-mid-turn":
      return result.message;
    case "error":
      return result.message;
  }
}

/**
 * Run manual compaction for the current thread. Never posts a chat message and
 * never creates a thread: with no thread yet, returns nothing-to-compact.
 */
export async function runCompactCommand(deps: CompactCommandDeps): Promise<CompactCommandResult> {
  if (deps.isStreaming) {
    return { kind: "unavailable-mid-turn", message: COMPACT_MID_TURN_MESSAGE };
  }
  if (deps.isCompacting) {
    return { kind: "error", message: "Compaction in flight." };
  }
  if (!deps.threadId) {
    return { kind: "nothing-to-compact" };
  }
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(
      `/api/threads/${encodeURIComponent(deps.threadId)}/compact`,
      { method: "POST" }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail =
        typeof body?.error === "string" ? body.error : `Compaction failed (${res.status})`;
      return { kind: "error", message: detail };
    }
    const data = await res.json().catch(() => ({}));
    const before = Number(data?.tokensBefore ?? 0);
    const after = Number(data?.tokensAfter ?? 0);
    return { kind: "success", tokensBefore: before, tokensAfter: after };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Compaction failed",
    };
  }
}
