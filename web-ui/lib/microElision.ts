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

/**
 * Fraction of effective input budget at which batch micro-elision fires.
 * Keeping prompts append-only below this watermark preserves engine KV/SSM
 * prefix-cache reuse (avoiding per-round checkpoint collapse on hybrid models)
 * while still reclaiming superseded payloads well before the 85% compaction trigger.
 */
export const MICRO_ELISION_PRESSURE_RATIO = 0.7;

/**
 * Minimum additional prompt tokens required after a batch elision fires before
 * another batch elision may run, preventing round-by-round oscillation when
 * post-elision prompt size stays near or above the base pressure threshold.
 */
export const MICRO_ELISION_REARM_DELTA_TOKENS = 10_000;

/** Metadata preserved on every stub (audit identity of the elided result). */
export interface ElisionMeta {
  /** Tool that produced the result or received the arguments. */
  tool: string;
  /** Round the result belongs to (1-based assistant-message count preceding it). */
  round: number;
  /** Path / command / URL the tool was pointed at, recovered from the paired tool call. */
  target?: string;
  /** Which kind of target was recovered. */
  targetKind: "path" | "command" | "url" | "query" | "none";
  /** Character size of the original (full-size) result content or arguments payload. */
  originalChars: number;
  /** Optional discriminator between elided tool results and superseded tool_call arguments. */
  kind?: "tool_result" | "tool_call_args";
}

/** Optional prefix-cache gating inputs for batch micro-elision. */
export interface MicroElisionOptions {
  /** Current effective prompt size (including tool schemas) before elision. */
  currentPromptTokens?: number;
  /** Minimum prompt tokens required before mutating earlier messages in-place. */
  minPromptTokens?: number;
}

/** Inputs for computing the batch micro-elision pressure threshold. */
export interface MicroElisionTriggerInput {
  budgetTokens: number;
  contextWindowTokens: number;
  outputReserveTokens: number;
  pressureRatio?: number;
  rearmFloorTokens?: number;
}

/** Elision pass result: how many results/payloads were stubbed and their metadata. */
export interface MicroElisionResult {
  stubbed: number;
  elisions: ElisionMeta[];
  /** True when elision was deferred below minPromptTokens to preserve engine prefix reuse. */
  deferredForPrefixCache?: boolean;
}

/**
 * Computes the effective prompt token threshold at which batch micro-elision
 * should fire, honoring output headroom and any post-sweep rearm floor.
 */
export function computeMicroElisionTriggerTokens(input: MicroElisionTriggerInput): number {
  const effectiveInputCeiling = Math.max(0, input.contextWindowTokens - input.outputReserveTokens);
  const effectiveBudget = Math.min(input.budgetTokens, effectiveInputCeiling);
  const ratio = input.pressureRatio ?? MICRO_ELISION_PRESSURE_RATIO;
  const baseTrigger = Math.floor(effectiveBudget * ratio);
  const rearmFloor =
    typeof input.rearmFloorTokens === "number" && Number.isFinite(input.rearmFloorTokens)
      ? Math.max(0, Math.floor(input.rearmFloorTokens))
      : 0;
  return Math.max(baseTrigger, rearmFloor);
}

/**
 * Returns true when micro-elision should defer in-place history mutation to
 * preserve the engine's KV/SSM prefix cache. When options are omitted, returns
 * false so direct callers retain unconditional elision semantics.
 */
export function shouldDeferMicroElisionForPrefixCache(options?: MicroElisionOptions): boolean {
  if (!options) return false;
  const { currentPromptTokens, minPromptTokens } = options;
  if (
    typeof currentPromptTokens !== "number" ||
    !Number.isFinite(currentPromptTokens) ||
    typeof minPromptTokens !== "number" ||
    !Number.isFinite(minPromptTokens) ||
    minPromptTokens <= 0
  ) {
    return false;
  }
  return currentPromptTokens < minPromptTokens;
}

/** Renders the stub text for an elided tool result (metadata verbatim). */
export function buildToolResultStub(meta: ElisionMeta): string {
  const target = meta.target ? ` target=${meta.target}` : "";
  return `[Micro-elision: superseded tool result. tool=${meta.tool} round=${meta.round}${target} originalChars=${meta.originalChars}. The full result is preserved in the thread trace record — re-invoke the tool if you need the content again.]`;
}

/** Renders the stub text for elided superseded tool_call argument bodies (metadata verbatim). */
export function buildToolCallArgsStub(meta: ElisionMeta): string {
  const target = meta.target ? ` target=${meta.target}` : "";
  return `[Micro-elision: superseded tool_call arguments. tool=${meta.tool} round=${meta.round}${target} originalChars=${meta.originalChars}. The full arguments are preserved in the thread trace record.]`;
}

const FILE_WRITE_TOOLS = new Set(["workspace_write_file", "host_write_file", "write_file"]);

const FILE_PATCH_TOOLS = new Set([
  "workspace_patch_file",
  "host_patch_file",
  "host_replace_string",
  "workspace_replace_string",
  "patch_file",
  "replace_string",
]);

const FILE_MUTATION_TOOLS = new Set([...FILE_WRITE_TOOLS, ...FILE_PATCH_TOOLS]);

const FILE_READ_TOOLS = new Set(["workspace_read_file", "host_read_file", "read_file"]);

const PATH_ARG_KEYS = ["path", "file", "filepath", "filename", "target_path"] as const;

const MUTATION_BODY_KEYS = [
  "content",
  "contents",
  "text",
  "data",
  "body",
  "new_string",
  "newString",
  "new_text",
  "replace",
  "patch",
  "patches",
  "diff",
  "hunks",
  "edits",
  "replacements",
] as const;

const MUTATION_OLD_BODY_KEYS = ["old_string", "oldString", "old_text", "search"] as const;

function normalizeFileTarget(rawPath: string): string {
  const unified = rawPath.trim().replace(/\\/g, "/");
  const stripped = unified.replace(/^\.\//, "");
  return stripped.replace(/\/{2,}/g, "/");
}

function parseToolCallArgs(raw: string | Record<string, unknown> | undefined): {
  args: Record<string, unknown> | null;
  wasString: boolean;
  originalChars: number;
} {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          args: parsed as Record<string, unknown>,
          wasString: true,
          originalChars: raw.length,
        };
      }
    } catch {}
    return { args: null, wasString: true, originalChars: raw.length };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const serialized = JSON.stringify(raw);
    return {
      args: raw as Record<string, unknown>,
      wasString: false,
      originalChars: serialized.length,
    };
  }
  return { args: null, wasString: false, originalChars: 0 };
}

function extractPathFromArgs(args: Record<string, unknown>): string | undefined {
  for (const k of PATH_ARG_KEYS) {
    const val = args[k];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return undefined;
}

function isToolCallArgsAlreadyElided(args: Record<string, unknown>): boolean {
  for (const k of [...MUTATION_BODY_KEYS, "stub"]) {
    const val = args[k];
    if (typeof val === "string" && val.startsWith("[Micro-elision:")) {
      return true;
    }
  }
  return false;
}

function isPairedToolResultError(
  messages: ElisionMessage[],
  assistantIdx: number,
  callId: string | undefined,
  callIdx: number
): boolean {
  let toolOffset = 0;
  for (let i = assistantIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "assistant" || m?.role === "user") break;
    if (m?.role !== "tool") continue;
    const matches = callId
      ? m.tool_call_id === callId || (!m.tool_call_id && toolOffset === callIdx)
      : toolOffset === callIdx;
    toolOffset++;
    if (!matches) continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (!content) return false;
    if (
      content.includes('"status":"EXECUTION_ERROR"') ||
      content.includes('"isError":true') ||
      content.includes('"success":false')
    ) {
      return true;
    }
    return false;
  }
  return false;
}

interface ElisionToolCall {
  id?: string;
  type?: string;
  elided?: boolean;
  elidedFrom?: ElisionMeta;
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
  [key: string]: unknown;
}

interface ElisionMessage {
  role?: string;
  name?: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: ElisionToolCall[];
  elided?: boolean;
  elidedFrom?: ElisionMeta;
  [key: string]: unknown;
}

/** Recovers the path/command/url/query target from the paired tool call args. */
function recoverTarget(
  msg: ElisionMessage,
  pairedCall: ElisionToolCall | undefined
): { target?: string; targetKind: ElisionMeta["targetKind"] } {
  let args: Record<string, unknown> = {};
  const raw = pairedCall?.function?.arguments;
  if (typeof raw === "string") {
    try {
      args = JSON.parse(raw);
    } catch {
      args = {};
    }
  } else if (raw && typeof raw === "object") {
    args = raw as Record<string, unknown>;
  }

  const pathKeys = ["path", "file", "filepath", "filename", "target_path"];
  const commandKeys = ["command", "cmd", "exec", "code", "script"];
  const urlKeys = ["url", "link", "uri"];
  const queryKeys = ["query", "q", "search_query"];

  for (const k of pathKeys) {
    const val = args[k];
    if (typeof val === "string" && val.trim()) return { target: val.trim(), targetKind: "path" };
  }
  if (Array.isArray(args.paths) && args.paths.length > 0) {
    const firstPaths = args.paths
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      .map((p) => p.trim());
    if (firstPaths.length > 0) {
      return {
        target:
          firstPaths.length === 1
            ? firstPaths[0]
            : `${firstPaths[0]} (+${firstPaths.length - 1} more)`,
        targetKind: "path",
      };
    }
  }
  for (const k of commandKeys) {
    const val = args[k];
    if (typeof val === "string" && val.trim()) return { target: val.trim(), targetKind: "command" };
  }
  for (const k of urlKeys) {
    const val = args[k];
    if (typeof val === "string" && val.trim()) return { target: val.trim(), targetKind: "url" };
  }
  for (const k of queryKeys) {
    const val = args[k];
    if (typeof val === "string" && val.trim()) return { target: val.trim(), targetKind: "query" };
  }
  return { targetKind: "none" };
}

/** Finds the assistant tool_call paired with a tool result message. */
function findPairedCall(messages: ElisionMessage[], toolIdx: number): ElisionToolCall | undefined {
  const toolMsg = messages[toolIdx];
  if (toolMsg?.tool_call_id) {
    for (let i = toolIdx - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
      const match = m.tool_calls.find((tc) => tc?.id === toolMsg.tool_call_id);
      if (match) return match;
    }
  }

  // Fallback when tool_call_id is absent: track ordinal offset among contiguous
  // role: "tool" messages following the preceding assistant.tool_calls message.
  let toolOffset = 0;
  for (let i = toolIdx - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "tool") {
      toolOffset++;
      continue;
    }
    if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      return m.tool_calls[toolOffset];
    }
    break;
  }
  return undefined;
}

/**
 * Stubs superseded tool payloads in-place inside the conversation array:
 *
 * 1. Superseded write/patch tool_call argument bodies: when a file is re-written
 *    or re-patched, earlier write/patch argument bodies for that same file elide
 *    to a metadata-bearing stub (path + size + round preserved); the latest
 *    write/patch stays byte-identical and assistant prose is never touched.
 * 2. Superseded file reads: a file read whose content a later write/patch has
 *    superseded elides to a metadata-bearing stub regardless of window/size;
 *    post-write reads stay byte-identical.
 * 3. Recent-window micro-elision: tool results past MICRO_ELISION_RECENT_WINDOW
 *    and >= MICRO_ELISION_MIN_RESULT_CHARS elide to a metadata-bearing stub.
 * - Idempotent: already-stubbed results and tool_call arguments are never
 *   re-elided or restored to full size.
 */
export function applyMicroElision(
  messages: ElisionMessage[],
  currentRound: number,
  options?: MicroElisionOptions
): MicroElisionResult {
  const elisions: ElisionMeta[] = [];
  if (!Array.isArray(messages)) return { stubbed: 0, elisions, deferredForPrefixCache: false };
  if (shouldDeferMicroElisionForPrefixCache(options)) {
    return { stubbed: 0, elisions, deferredForPrefixCache: true };
  }

  // Pass 1: Track file write/patch mutations across assistant tool_calls.
  interface MutationRef {
    msgIdx: number;
    callIdx: number;
    round: number;
    toolName: string;
    rawPath: string;
    normPath: string;
  }
  const mutationsByPath = new Map<string, MutationRef[]>();
  const latestMutationMsgIdx = new Map<string, number>();

  let assistantRound = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    assistantRound++;
    if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) continue;

    for (let c = 0; c < msg.tool_calls.length; c++) {
      const tc = msg.tool_calls[c];
      const toolName = tc?.function?.name || "";
      if (!FILE_MUTATION_TOOLS.has(toolName)) continue;
      if (isPairedToolResultError(messages, i, tc.id, c)) continue;

      const parsed = parseToolCallArgs(tc.function?.arguments);
      if (!parsed.args) continue;
      const rawPath = extractPathFromArgs(parsed.args);
      if (!rawPath) continue;

      const normPath = normalizeFileTarget(rawPath);
      const ref: MutationRef = {
        msgIdx: i,
        callIdx: c,
        round: assistantRound,
        toolName,
        rawPath,
        normPath,
      };
      const existing = mutationsByPath.get(normPath) ?? [];
      existing.push(ref);
      mutationsByPath.set(normPath, existing);
      latestMutationMsgIdx.set(normPath, i);
    }
  }

  // Elide all superseded write/patch argument bodies (every mutation except the latest per path).
  for (const refs of mutationsByPath.values()) {
    if (refs.length < 2) continue;
    for (let k = 0; k < refs.length - 1; k++) {
      const ref = refs[k];
      const msg = messages[ref.msgIdx];
      if (!Array.isArray(msg.tool_calls)) continue;
      const tc = msg.tool_calls[ref.callIdx];
      if (!tc || tc.elided) continue;

      const parsed = parseToolCallArgs(tc.function?.arguments);
      if (!parsed.args || isToolCallArgsAlreadyElided(parsed.args)) continue;

      const meta: ElisionMeta = {
        tool: ref.toolName,
        round: ref.round > 0 ? ref.round : currentRound,
        target: ref.rawPath,
        targetKind: "path",
        originalChars: parsed.originalChars,
        kind: "tool_call_args",
      };
      const stubText = buildToolCallArgsStub(meta);

      const stubbedArgs: Record<string, unknown> = {};
      let placedStub = false;
      for (const [key, value] of Object.entries(parsed.args)) {
        if ((MUTATION_OLD_BODY_KEYS as readonly string[]).includes(key)) {
          continue;
        }
        if ((MUTATION_BODY_KEYS as readonly string[]).includes(key)) {
          stubbedArgs[key] = stubText;
          placedStub = true;
        } else {
          stubbedArgs[key] = value;
        }
      }
      if (!placedStub) {
        stubbedArgs.stub = stubText;
      }

      // Copy tool_calls and the target tool_call so external trace objects are never mutated.
      const updatedToolCalls = msg.tool_calls.slice();
      updatedToolCalls[ref.callIdx] = {
        ...tc,
        elided: true,
        elidedFrom: meta,
        function: {
          ...tc.function,
          arguments: parsed.wasString ? JSON.stringify(stubbedArgs) : stubbedArgs,
        },
      };
      msg.tool_calls = updatedToolCalls;
      elisions.push(meta);
    }
  }

  // Pass 2: Elide file reads superseded by a later write/patch to the same file.
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "tool") toolIndices.push(i);
  }

  if (latestMutationMsgIdx.size > 0) {
    for (const idx of toolIndices) {
      const msg = messages[idx];
      if (msg.elided) continue;
      const content = typeof msg.content === "string" ? msg.content : "";
      if (!content || content.startsWith("[Micro-elision:")) continue;

      const pairedCall = findPairedCall(messages, idx);
      const toolName = msg.name || pairedCall?.function?.name || "";
      if (!FILE_READ_TOOLS.has(toolName)) continue;

      let { target, targetKind } = recoverTarget(msg, pairedCall);
      if (!target) {
        try {
          const parsedContent = JSON.parse(content);
          if (parsedContent && typeof parsedContent === "object") {
            const recovered = extractPathFromArgs(parsedContent as Record<string, unknown>);
            if (recovered) {
              target = recovered;
              targetKind = "path";
            }
          }
        } catch {}
      }
      if (!target) continue;

      const normPath = normalizeFileTarget(target);
      const mutIdx = latestMutationMsgIdx.get(normPath);
      if (mutIdx === undefined || mutIdx <= idx) continue;

      let precedingAssistantRounds = 0;
      for (let i = 0; i < idx; i++) {
        if (messages[i]?.role === "assistant") precedingAssistantRounds++;
      }
      const meta: ElisionMeta = {
        tool: toolName || "unknown_tool",
        round: precedingAssistantRounds > 0 ? precedingAssistantRounds : currentRound,
        target,
        targetKind,
        originalChars: content.length,
        kind: "tool_result",
      };

      msg.content = buildToolResultStub(meta);
      msg.elided = true;
      msg.elidedFrom = meta;
      elisions.push(meta);
    }
  }

  // Pass 3: Existing recent-window micro-elision for older large tool results.
  if (toolIndices.length <= MICRO_ELISION_RECENT_WINDOW) {
    return { stubbed: elisions.length, elisions, deferredForPrefixCache: false };
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
      originalChars: content.length,
    };

    msg.content = buildToolResultStub(meta);
    msg.elided = true;
    msg.elidedFrom = meta;
    elisions.push(meta);
  }

  return { stubbed: elisions.length, elisions, deferredForPrefixCache: false };
}
