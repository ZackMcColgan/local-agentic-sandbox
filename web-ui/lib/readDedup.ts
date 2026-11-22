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
export function extractReadPath(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const k of PATH_KEYS) {
    const val = args[k];
    if (typeof val === "string" && val.trim()) return val.trim();
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultContent);
  } catch {
    return typeof resultContent === "string" && resultContent.length > 0 ? resultContent : null;
  }
  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as { content?: unknown };
    if (typeof obj.content === "string") return obj.content;
    if (Array.isArray(obj.content)) {
      const texts = obj.content
        .filter((part: unknown): part is { text: string } =>
          Boolean(part && typeof (part as { text?: unknown }).text === "string")
        )
        .map((part) => part.text);
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
  const messageRef =
    typeof meta.messageIndex === "number" ? ` firstReadMessage=${meta.messageIndex}` : "";
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

/** Shape of an individual file entry inside a multi-file read result. */
export interface MultiReadFileItem {
  path: string;
  content: string;
  total_lines?: number;
  total_bytes?: number;
  showing_lines?: string;
  truncated?: boolean;
  deduplicated?: boolean;
  [key: string]: unknown;
}

/** Shape of a multi-file read result returned by host_read_file(paths: [...]). */
export interface MultiReadResultShape {
  success?: boolean;
  multi: true;
  files: MultiReadFileItem[];
  [key: string]: unknown;
}

/** Type guard recognizing a multi-file read payload. */
export function isMultiReadResult(value: unknown): value is MultiReadResultShape {
  if (!value || typeof value !== "object") return false;
  const obj = value as { multi?: unknown; files?: unknown };
  return obj.multi === true && Array.isArray(obj.files);
}

/** Canonicalizes path separators for registry lookup while keeping original path in metadata. */
function normalizeDedupPathKey(rawPath: string): string {
  return rawPath.trim().replace(/\\/g, "/");
}

/**
 * Per-thread dedup registry. Seeded from the thread's prior conversation
 * messages (earlier turns) so a re-read in a later turn stubs against the
 * earlier turn's read; new reads in the current turn are recorded live.
 */
interface DedupToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
}

interface DedupMessage {
  role?: string;
  name?: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: DedupToolCall[];
}

export class ReadDedupRegistry {
  private entries = new Map<string, ReadDedupMeta>();

  constructor(priorMessages: DedupMessage[] = []) {
    let assistantCount = 0;
    let toolCount = 0;
    for (let i = 0; i < priorMessages.length; i++) {
      const msg = priorMessages[i];
      if (msg?.role === "assistant") {
        assistantCount++;
        continue;
      }
      if (
        msg?.role !== "tool" ||
        !msg.name ||
        !READ_DEDUP_TOOLS.includes(msg.name as (typeof READ_DEDUP_TOOLS)[number])
      ) {
        continue;
      }
      const traceIndex = toolCount++;
      const round = assistantCount;
      const rawContent = typeof msg.content === "string" ? msg.content : "";

      // Seed per-file entries from prior multi-read results
      let parsedPrior: unknown = null;
      try {
        parsedPrior = rawContent ? JSON.parse(rawContent) : null;
      } catch {}
      if (isMultiReadResult(parsedPrior)) {
        for (const file of parsedPrior.files) {
          if (
            !file ||
            typeof file.path !== "string" ||
            !file.path.trim() ||
            typeof file.content !== "string" ||
            file.deduplicated === true ||
            file.truncated === true
          ) {
            continue;
          }
          const key = normalizeDedupPathKey(file.path);
          this.entries.set(key, {
            path: file.path,
            contentHash: computeContentHash(file.content),
            round,
            traceIndex,
            messageIndex: i,
            originalChars: file.content.length,
          });
        }
        continue;
      }

      const pairedCall = Array.isArray(msg.tool_calls)
        ? msg.tool_calls[0]
        : this.findPairedCall(priorMessages, msg.tool_call_id);
      const path = extractReadPath(this.parseArgs(pairedCall));
      if (!path) continue;
      const content = extractReadContent(rawContent);
      if (content === null) continue;
      this.entries.set(normalizeDedupPathKey(path), {
        path,
        contentHash: computeContentHash(content),
        round,
        traceIndex,
        messageIndex: i,
        originalChars: rawContent.length,
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
    args: Record<string, unknown>,
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

    const key = normalizeDedupPathKey(path);
    const contentHash = computeContentHash(content);
    const existing = this.entries.get(key);
    if (existing && existing.contentHash === contentHash) {
      return { deduplicated: true, stub: buildReadDedupStub(existing), meta: existing };
    }

    const meta: ReadDedupMeta = {
      path,
      contentHash,
      round,
      traceIndex,
      originalChars: resultContent.length,
    };
    this.entries.set(key, meta);
    return { deduplicated: false, meta };
  }

  /**
   * Applies per-file read dedup across a multi-file read result without mutating
   * the input audit object. Unchanged files have ONLY their own section stubbed;
   * new or modified siblings keep their full content and anchor/re-anchor the registry.
   */
  checkAndRecordMultiRead<T extends MultiReadResultShape>(
    toolName: string,
    result: T,
    round: number,
    traceIndex: number
  ): { result: T; dedupedMetas: ReadDedupMeta[] } {
    if (
      !READ_DEDUP_TOOLS.includes(toolName as (typeof READ_DEDUP_TOOLS)[number]) ||
      !isMultiReadResult(result)
    ) {
      return { result, dedupedMetas: [] };
    }

    const dedupedMetas: ReadDedupMeta[] = [];
    const nextFiles: MultiReadFileItem[] = result.files.map((file) => {
      if (
        !file ||
        typeof file.path !== "string" ||
        !file.path.trim() ||
        typeof file.content !== "string" ||
        file.truncated === true
      ) {
        return file;
      }

      const key = normalizeDedupPathKey(file.path);
      const contentHash = computeContentHash(file.content);
      const existing = this.entries.get(key);
      if (existing && existing.contentHash === contentHash) {
        dedupedMetas.push(existing);
        return {
          ...file,
          content: buildReadDedupStub(existing),
          deduplicated: true,
        };
      }

      this.entries.set(key, {
        path: file.path,
        contentHash,
        round,
        traceIndex,
        originalChars: file.content.length,
      });
      return file;
    });

    if (dedupedMetas.length === 0) {
      return { result, dedupedMetas };
    }

    return {
      result: {
        ...result,
        files: nextFiles,
      },
      dedupedMetas,
    };
  }

  private parseArgs(pairedCall: DedupToolCall | undefined): Record<string, unknown> | undefined {
    const raw = pairedCall?.function?.arguments;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    }
    if (raw && typeof raw === "object") return raw as Record<string, unknown>;
    return undefined;
  }

  private findPairedCall(
    messages: DedupMessage[],
    toolCallId: string | undefined
  ): DedupToolCall | undefined {
    if (!toolCallId) return undefined;
    for (const msg of messages) {
      if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const call = msg.tool_calls.find((tc) => tc?.id === toolCallId);
        if (call) return call;
      }
    }
    return undefined;
  }
}
