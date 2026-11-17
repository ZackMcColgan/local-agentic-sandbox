/**
 * TOKEN ECONOMICS — PART (c): MICRO-ELISION OF TOOL RESULTS.
 *
 * The prompt assembly path keeps the most recent MICRO_ELISION_RECENT_WINDOW
 * tool results full-size and stubs every OLDER (superseded) result as soon as
 * it falls out of that window — WITHOUT waiting for the 85K fit trigger. The
 * fit ladder (lib/contextBudget.ts) only elides at ~85% of the 100K budget;
 * micro-elision runs every round, so superseded bulk (file reads, command
 * stdout) stops paying prompt tokens immediately instead of riding the whole
 * turn.
 *
 * Every stub preserves trace metadata — tool name, path/command target,
 * original size, round number — so a stubbed result stays identifiable and
 * auditable: the full result still lives in the thread record's trace array
 * (ThreadMessage.traces), and the elision log rides on the assistant message.
 *
 * Leaf module by design (imports nothing from the chat route or threadStore),
 * matching lib/tokenEconomics.ts.
 */

/**
 * Number of most-recent tool results kept byte-identical (un-elided).
 * Standing default of 5: the part (b) fit-window experiment has not run yet,
 * so this constant is the tuning knob (b) will adjust later.
 */
export const MICRO_ELISION_RECENT_WINDOW = 5;

/**
 * Results shorter than this are never stubbed: stubbing a small result saves
 * nothing and destroys information the model may still need verbatim.
 */
export const MICRO_ELISION_MIN_RESULT_CHARS = 2000;

/** Metadata preserved on every stub (audit identity of the elided result). */
export interface ElisionMeta {
  /** Tool that produced the result. */
  tool: string;
  /** Round the result belongs to (1-based assistant-message count preceding it). */
  round: number;
  /** Path / command / URL the tool was pointed at, recovered from the paired tool call. */
  target?: string;
  /** Which kind of target was recovered. */
  targetKind: "path" | "command" | "url" | "query" | "none";
  /** Character size of the original (full-size) result content. */
  originalChars: number;
}

/** Elision pass result: how many results were stubbed and their metadata. */
export interface MicroElisionResult {
  stubbed: number;
  elisions: ElisionMeta[];
}

/** Renders the stub text for an elided tool result (metadata verbatim). */
export function buildToolResultStub(meta: ElisionMeta): string {
  const target = meta.target ? ` target=${meta.target}` : "";
  return `[Micro-elision: superseded tool result. tool=${meta.tool} round=${meta.round}${target} originalChars=${meta.originalChars}. The full result is preserved in the thread trace record — re-invoke the tool if you need the content again.]`;
}

/** Recovers the path/command/url/query target from the paired tool call args. */
function recoverTarget(msg: any, pairedCall: any): { target?: string; targetKind: ElisionMeta["targetKind"] } {
  let args: Record<string, any> = {};
  const raw = pairedCall?.function?.arguments;
  if (typeof raw === "string") {
    try {
      args = JSON.parse(raw);
    } catch {
      args = {};
    }
  } else if (raw && typeof raw === "object") {
    args = raw as Record<string, any>;
  }

  const pathKeys = ["path", "file", "filepath", "filename", "target_path"];
  const commandKeys = ["command", "cmd", "exec", "code", "script"];
  const urlKeys = ["url", "link", "uri"];
  const queryKeys = ["query", "q", "search_query"];

  for (const k of pathKeys) {
    if (typeof args[k] === "string" && args[k].trim()) return { target: args[k].trim(), targetKind: "path" };
  }
  for (const k of commandKeys) {
    if (typeof args[k] === "string" && args[k].trim()) return { target: args[k].trim(), targetKind: "command" };
  }
  for (const k of urlKeys) {
    if (typeof args[k] === "string" && args[k].trim()) return { target: args[k].trim(), targetKind: "url" };
  }
  for (const k of queryKeys) {
    if (typeof args[k] === "string" && args[k].trim()) return { target: args[k].trim(), targetKind: "query" };
  }
  return { targetKind: "none" };
}

/** Finds the assistant tool_call paired with a tool result message. */
function findPairedCall(messages: any[], toolIdx: number): any {
  const toolMsg = messages[toolIdx];
  // Scan backwards for the assistant message carrying this call id.
  for (let i = toolIdx - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    if (toolMsg?.tool_call_id) {
      const match = m.tool_calls.find((tc: any) => tc?.id === toolMsg.tool_call_id);
      if (match) return match;
    }
    if (m.tool_calls.length > 0) return m.tool_calls[0];
  }
  return undefined;
}

/**
 * Stubs superseded tool results in-place inside the conversation array.
 *
 * - The most recent MICRO_ELISION_RECENT_WINDOW tool results are left
 *   byte-identical to the un-elided content.
 * - Older results are replaced with a metadata-bearing stub and marked
 *   `elided` with `elidedFrom` metadata (tool, target, original size, round).
 * - Idempotent: an already-stubbed result is never restored to full size;
 *   only genuinely changed content (a re-read after an edit) is re-stubbed.
 * - Results under MICRO_ELISION_MIN_RESULT_CHARS are never stubbed.
 */
export function applyMicroElision(messages: any[], currentRound: number): MicroElisionResult {
  const elisions: ElisionMeta[] = [];
  if (!Array.isArray(messages)) return { stubbed: 0, elisions };

  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "tool") toolIndices.push(i);
  }
  if (toolIndices.length <= MICRO_ELISION_RECENT_WINDOW) {
    return { stubbed: 0, elisions };
  }

  const staleIndices = toolIndices.slice(0, toolIndices.length - MICRO_ELISION_RECENT_WINDOW);
  for (const idx of staleIndices) {
    const msg = messages[idx];
    if (msg.elided) continue; // already stubbed — never re-emitted full-size
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.length < MICRO_ELISION_MIN_RESULT_CHARS) continue;

    // Round identity: assistant rounds preceding this result (1-based),
    // falling back to the caller-supplied current round.
    let precedingAssistantRounds = 0;
    for (let i = 0; i < idx; i++) {
      if (messages[i]?.role === "assistant") precedingAssistantRounds++;
    }
    const pairedCall = findPairedCall(messages, idx);
    const { target, targetKind } = recoverTarget(msg, pairedCall);
    const meta: ElisionMeta = {
      tool: msg.name || pairedCall?.function?.name || "unknown_tool",
      round: precedingAssistantRounds > 0 ? precedingAssistantRounds : currentRound,
      target,
      targetKind,
      originalChars: content.length
    };

    msg.content = buildToolResultStub(meta);
    msg.elided = true;
    msg.elidedFrom = meta;
    elisions.push(meta);
  }

  return { stubbed: elisions.length, elisions };
}
