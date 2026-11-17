/**
 * TOKEN ECONOMICS — PART (d): WITHIN-THREAD READ DEDUP.
 *
 * A file read whose path + content hash matches an earlier read in the same
 * thread is answered with a short stub referencing the earlier trace/round
 * instead of re-emitting the full content. A file whose content CHANGED
 * re-reads normally (full content) and re-anchors the registry so later
 * identical reads dedup against the changed read, not the stale one.
 *
 * Every stub carries path + content hash + the earlier trace/round reference,
 * so the read stays recoverable from the thread record: the full result of
 * the first (unchanged) read remains in ThreadMessage.traces, and the dedup
 * log rides on the assistant message (ThreadMessage.readDedups).
 *
 * Leaf module by design (imports nothing from the chat route or threadStore),
 * matching lib/tokenEconomics.ts and lib/microElision.ts.
 */

import { createHash } from "node:crypto";

/** Tools whose results participate in path+hash dedup. */
export const READ_DEDUP_TOOLS = ["workspace_read_file", "host_read_file"] as const;

/** Args keys that identify the file a read was pointed at. */
const PATH_KEYS = ["path", "file", "filepath", "filename", "target_path"];

/** Deterministic content fingerprint (sha256 hex digest). */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Recovers the read target path from tool args; null when no path key exists. */
export function extractReadPath(args: Record<string, any> | undefined): string | null {
  if (!args) return null;
  for (const k of PATH_KEYS) {
    if (typeof args[k] === "string" && args[k].trim()) return args[k].trim();
  }
  return null;
}

/**
 * Pulls the content payload out of a read result. Handles both the host/sandbox
 * JSON shape ({ content: string }) and the MCP text-part shape
 * ({ content: [{ type: "text", text: string }] }). Returns null when no
 * content payload is recoverable (error results are never deduped).
 */
export function extractReadContent(resultContent: string): string | null {
  let parsed: any;
  try {
    parsed = JSON.parse(resultContent);
  } catch {
    return typeof resultContent === "string" && resultContent.length > 0 ? resultContent : null;
  }
  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.content === "string") return parsed.content;
    if (Array.isArray(parsed.content)) {
      const texts = parsed.content
        .filter((part: any) => part && typeof part.text === "string")
        .map((part: any) => part.text);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return null;
}

/** Audit identity of the FIRST (full-content) read a later stub points at. */
export interface ReadDedupMeta {
  /** File path the read was pointed at. */
  path: string;
  /** sha256 hex digest of the first read's content payload. */
  contentHash: string;
  /** Round (1-based) of the first read. */
  round: number;
  /** Index of the first read's trace in the turn/thread trace array. */
  traceIndex: number;
  /** Message index of the first read (present for cross-turn references). */
  messageIndex?: number;
  /** Character size of the first read's full result content. */
  originalChars: number;
  /** Round of the re-read that was stubbed (recorded on the turn's dedup log). */
  reReadRound?: number;
}

/** Renders the stub text for a deduped re-read (reference fields verbatim).
 * The hash is truncated to its first 16 hex chars so the stub stays smaller
 * than even a small read payload; the FULL digest rides on the audit meta
 * (ThreadMessage.readDedups), so recoverability is not weakened. */
export function buildReadDedupStub(meta: ReadDedupMeta): string {
  const messageRef = typeof meta.messageIndex === "number" ? ` firstReadMessage=${meta.messageIndex}` : "";
  return `[Read dedup: path=${meta.path} contentHash=${meta.contentHash.slice(0, 16)} firstReadRound=${meta.round} firstReadTrace=${meta.traceIndex}${messageRef}. Full content in thread trace record.]`;
}

/** Decision returned by the registry for one read result. */
export interface ReadDedupDecision {
  deduplicated: boolean;
  /** Stub text when deduplicated; undefined for a full-content read. */
  stub?: string;
  /** Registry entry: the first read on record for this path+hash. */
  meta?: ReadDedupMeta;
}

/**
 * Per-thread dedup registry. Seeded from the thread's prior conversation
 * messages (earlier turns) so a re-read in a later turn stubs against the
 * earlier turn's read; new reads in the current turn are recorded live.
 */
export class ReadDedupRegistry {
  private entries = new Map<string, ReadDedupMeta>();

  constructor(priorMessages: any[] = []) {
    let assistantCount = 0;
    let toolCount = 0;
    for (let i = 0; i < priorMessages.length; i++) {
      const msg = priorMessages[i];
      if (msg?.role === "assistant") {
        assistantCount++;
        continue;
      }
      if (msg?.role !== "tool" || !READ_DEDUP_TOOLS.includes(msg.name)) {
        continue;
      }
      const traceIndex = toolCount++;
      const round = assistantCount;
      const pairedCall = Array.isArray(msg.tool_calls)
        ? msg.tool_calls[0]
        : this.findPairedCall(priorMessages, msg.tool_call_id);
      const path = extractReadPath(this.parseArgs(pairedCall));
      if (!path) continue;
      const content = extractReadContent(typeof msg.content === "string" ? msg.content : "");
      if (content === null) continue;
      this.entries.set(path, {
        path,
        contentHash: computeContentHash(content),
        round,
        traceIndex,
        messageIndex: i,
        originalChars: typeof msg.content === "string" ? msg.content.length : 0
      });
    }
  }

  /**
   * Consults the registry for one read result and records it when the content
   * is new (first read or changed re-read). Unchanged re-reads return a stub
   * pointing at the FIRST read on record for that path.
   */
  checkAndRecord(
    toolName: string,
    args: Record<string, any>,
    resultContent: string,
    round: number,
    traceIndex: number
  ): ReadDedupDecision {
    if (!READ_DEDUP_TOOLS.includes(toolName as (typeof READ_DEDUP_TOOLS)[number])) {
      return { deduplicated: false };
    }
    const path = extractReadPath(args);
    if (!path) return { deduplicated: false };
    const content = extractReadContent(resultContent);
    if (content === null) return { deduplicated: false };

    const contentHash = computeContentHash(content);
    const existing = this.entries.get(path);
    if (existing && existing.contentHash === contentHash) {
      return { deduplicated: true, stub: buildReadDedupStub(existing), meta: existing };
    }

    const meta: ReadDedupMeta = {
      path,
      contentHash,
      round,
      traceIndex,
      originalChars: resultContent.length
    };
    this.entries.set(path, meta);
    return { deduplicated: false, meta };
  }

  private parseArgs(pairedCall: any): Record<string, any> | undefined {
    const raw = pairedCall?.function?.arguments;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    }
    if (raw && typeof raw === "object") return raw as Record<string, any>;
    return undefined;
  }

  private findPairedCall(messages: any[], toolCallId: any): any {
    if (!toolCallId) return undefined;
    for (const msg of messages) {
      if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const call = msg.tool_calls.find((tc: any) => tc?.id === toolCallId);
        if (call) return call;
      }
    }
    return undefined;
  }
}
