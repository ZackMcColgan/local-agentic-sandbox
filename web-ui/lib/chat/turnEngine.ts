import { appendNarrationChunk } from "@/lib/liveActivity";
import {
  estimateTokens,
  fitContextWindow,
  resolveRoundDeadlineMs,
  MAX_STREAMED_CONTENT_CHARS,
  TURN_SIZE_LIMIT_MARKER,
} from "@/lib/contextBudget";
import type { ElisionMeta } from "@/lib/microElision";
import type { ReadDedupMeta } from "@/lib/readDedup";
import { collectTurnAttachments } from "@/lib/threadOutputs";
import { collectTurnModifiedFileDiffs, type TurnFileDiff } from "@/lib/chatDiffs";
import type { ThreadStore } from "@/lib/threads/threadStore";
import { formatSseWriterError } from "@/lib/turnReconciliation";
import type { getLLMProvider } from "@/lib/llm/provider";

export interface SseEventWriterOptions {
  stream: TransformStream<Uint8Array, Uint8Array>;
  signal: AbortSignal;
  activeThreadId: string | null;
  writerTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  /**
   * True when the stream consumer is an in-process caller (e.g. board drain)
   * rather than a live browser HTTP SSE response. On writer backpressure timeout,
   * in-process mode drops the write side only and never aborts stream.readable.
   */
  inProcessConsumer?: boolean;
  log?: (...args: unknown[]) => void;
}

const gTurnSettle = globalThis as {
  __sandboxTurnSettledPromises?: Map<string, Promise<void>>;
};
const turnSettledPromises: Map<string, Promise<void>> = gTurnSettle.__sandboxTurnSettledPromises ||
(gTurnSettle.__sandboxTurnSettledPromises = new Map<string, Promise<void>>());

/**
 * Registers the active turn's settle promise so in-process consumers (e.g. board drain)
 * can await the turn's own settlement rather than relying on SSE stream death.
 */
export function registerTurnSettledPromise(threadId: string, settled: Promise<void>): void {
  const tracked = settled.finally(() => {
    if (turnSettledPromises.get(threadId) === tracked) {
      turnSettledPromises.delete(threadId);
    }
  });
  turnSettledPromises.set(threadId, tracked);
}

/**
 * Awaits the currently registered turn's settle promise for a thread, if any.
 */
export async function waitForTurnSettled(threadId: string): Promise<void> {
  const pending = turnSettledPromises.get(threadId);
  if (pending) {
    await pending.catch(() => {});
  }
}

export interface SseEventWriter {
  sendEvent: (data: Record<string, unknown>) => Promise<void>;
  cleanupClientSignal: () => void;
  startReadableDrain: () => void;
  stopHeartbeat: () => void;
  isClientDisconnected: () => boolean;
  closeWriterWithTimeout: (timeoutMs?: number) => Promise<void>;
  closeWriterPreStart: (timeoutMs?: number) => void;
}

/**
 * Encapsulates SSE TransformStream writing, client disconnect draining,
 * 2s write-timeout backpressure handling, and 10s heartbeat pings.
 */
export function createSseEventWriter(options: SseEventWriterOptions): SseEventWriter {
  const {
    stream,
    signal,
    activeThreadId,
    writerTimeoutMs = 2000,
    heartbeatIntervalMs = 10_000,
    inProcessConsumer = false,
    log = console.log,
  } = options;

  const encoder = new TextEncoder();
  const writer = stream.writable.getWriter();
  let readableDrainStarted = false;
  let clientDisconnected = false;
  let writeSideDropped = false;

  const startReadableDrain = () => {
    if (readableDrainStarted) return;
    readableDrainStarted = true;
    (async () => {
      try {
        if (stream.readable.locked) return;
        const drainReader = stream.readable.getReader();
        while (true) {
          const { done } = await drainReader.read();
          if (done) break;
        }
      } catch {}
    })().catch(() => {});
  };

  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  const stopHeartbeat = () => {
    if (heartbeatInterval !== null) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  const cleanupClientSignal = () => {
    if (!clientDisconnected) {
      clientDisconnected = true;
      stopHeartbeat();
      log(
        `[ChatRoute] Client SSE connection disconnected for thread ${activeThreadId || "ephemeral"}. Turn continuing detached server-side.`
      );
      startReadableDrain();
    }
  };

  signal.addEventListener("abort", cleanupClientSignal);

  const sendEvent = async (data: Record<string, unknown>) => {
    if (clientDisconnected || writeSideDropped || signal.aborted) {
      stopHeartbeat();
      return;
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const writePromise = writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      writePromise.catch(() => {});
      await Promise.race([
        writePromise,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("writer timeout")), writerTimeoutMs);
        }),
        new Promise((_, reject) => {
          onAbort = () => reject(new Error("client aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch (err: unknown) {
      stopHeartbeat();
      const errMessage = err instanceof Error ? err.message : undefined;
      if (inProcessConsumer && !signal.aborted && errMessage === "writer timeout") {
        // In-process consumer (board drain): apply backpressure by dropping the
        // write side only. NEVER abort stream.readable — the turn's own settle
        // is the drain's completion signal.
        writeSideDropped = true;
        log(
          `[ChatRoute] In-process SSE writer backpressure timeout for thread ${activeThreadId || "ephemeral"}. Dropping write side; turn continuing cleanly.`
        );
        return;
      }
      clientDisconnected = true;
      if (!signal.aborted && errMessage === "writer timeout") {
        startReadableDrain();
        try {
          writer.abort(err).catch(() => {});
        } catch {}
      }
      log(
        `[ChatRoute] SSE writer failed for thread ${activeThreadId || "ephemeral"}: ${formatSseWriterError(err)}. Turn continuing detached server-side.`
      );
      try {
        writer.abort(err).catch(() => {});
      } catch {}
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  };

  heartbeatInterval = setInterval(() => {
    if (clientDisconnected || writeSideDropped || signal.aborted) {
      stopHeartbeat();
      return;
    }
    sendEvent({ type: "ping", ts: Date.now() }).catch(() => {
      stopHeartbeat();
    });
  }, heartbeatIntervalMs);
  if (typeof heartbeatInterval.unref === "function") {
    heartbeatInterval.unref();
  }

  const closeWriterPreStart = (timeoutMs = 1000) => {
    startReadableDrain();
    try {
      if (inProcessConsumer) {
        writer.close().catch(() => {});
        return;
      }
      if (clientDisconnected) {
        try {
          writer.abort(new Error("client disconnected")).catch(() => {});
        } catch {}
      } else {
        const closePromise = writer.close();
        closePromise.catch(() => {});
        setTimeout(() => {
          try {
            writer.abort(new Error("pre-start abort close timeout")).catch(() => {});
          } catch {}
        }, timeoutMs).unref?.();
      }
    } catch {}
  };

  const closeWriterWithTimeout = async (timeoutMs = 1000) => {
    startReadableDrain();
    if (inProcessConsumer) {
      try {
        const closePromise = writer.close();
        closePromise.catch(() => {});
        let closeTimeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            closePromise,
            new Promise<void>((resolve) => {
              closeTimeoutId = setTimeout(resolve, timeoutMs);
            }),
          ]);
        } finally {
          if (closeTimeoutId !== undefined) clearTimeout(closeTimeoutId);
        }
      } catch {}
      return;
    }
    try {
      if (clientDisconnected) {
        try {
          writer.abort(new Error("client disconnected")).catch(() => {});
        } catch {}
      } else {
        const closePromise = writer.close();
        closePromise.catch(() => {});
        let closeTimeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            closePromise,
            new Promise((_, reject) => {
              closeTimeoutId = setTimeout(
                () => reject(new Error("writer close timeout")),
                timeoutMs
              );
            }),
          ]);
        } finally {
          if (closeTimeoutId !== undefined) clearTimeout(closeTimeoutId);
        }
      }
    } catch {
      try {
        writer.abort(new Error("stream abandoned")).catch(() => {});
      } catch {}
    }
  };

  return {
    sendEvent,
    cleanupClientSignal,
    startReadableDrain,
    stopHeartbeat,
    isClientDisconnected: () => clientDisconnected,
    closeWriterWithTimeout,
    closeWriterPreStart,
  };
}

export interface RoundDeadlineController {
  inactivityMs: number;
  totalMs: number;
  arm: () => void;
  clear: () => void;
  getTimedOut: () => "inactivity" | "total" | null;
}

/**
 * Arms per-round inactivity (re-armed on every streamed chunk) and absolute total
 * wall-clock deadlines. Both abort only the round controller, never the turn.
 */
export function createRoundDeadline(
  abortController: AbortController,
  deadlines: { inactivityMs: number; totalMs: number } = resolveRoundDeadlineMs()
): RoundDeadlineController {
  const { inactivityMs, totalMs } = deadlines;
  let timedOut: "inactivity" | "total" | null = null;
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;

  const arm = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      timedOut = "inactivity";
      abortController.abort();
    }, inactivityMs);
    if (typeof inactivityTimer.unref === "function") inactivityTimer.unref();
  };

  arm();
  totalTimer = setTimeout(() => {
    timedOut = "total";
    abortController.abort();
  }, totalMs);
  if (typeof totalTimer.unref === "function") totalTimer.unref();

  const clear = () => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    if (totalTimer) {
      clearTimeout(totalTimer);
      totalTimer = null;
    }
  };

  return {
    inactivityMs,
    totalMs,
    arm,
    clear,
    getTimedOut: () => timedOut,
  };
}

export interface AbortedAssistantMessageInput {
  assistantMessageId: string;
  activeThreadId: string;
  threadsDir: string;
  turnCreatedFiles: string[];
  turnPreImages: Map<string, string>;
  turnHostDiffs: TurnFileDiff[];
  explicitStopped: boolean;
  turnSignalAborted: boolean;
  accumulatedStreamedTokens: string;
  accumulatedThoughts: string[];
  traces: unknown[];
  activeModel: string;
  requestedModel?: string;
  lastFinishReason?: string;
  turnOutputTokens?: number;
  turnStartMs?: number;
  turnMicroElisions: ElisionMeta[];
  turnReadDedups: ReadDedupMeta[];
  nowIso?: string;
}

export function buildAbortedAssistantMessage(input: AbortedAssistantMessageInput) {
  const turnAttachments = collectTurnAttachments(
    input.activeThreadId,
    input.threadsDir,
    input.turnCreatedFiles
  );
  const turnWorkspaceDiffs = collectTurnModifiedFileDiffs(input.turnPreImages);
  const turnDiffs = [...input.turnHostDiffs, ...turnWorkspaceDiffs];

  const isExplicit = input.explicitStopped || input.turnSignalAborted;
  const abortMarker = isExplicit
    ? "*[Stopped by user]*"
    : "⚠️ [Turn incomplete: Stream aborted or disconnected.]";
  const abortContent = input.accumulatedStreamedTokens.trim()
    ? `${input.accumulatedStreamedTokens}\n\n${abortMarker}`
    : abortMarker;

  const finalOutputTokens =
    input.turnOutputTokens ??
    (input.accumulatedStreamedTokens ? estimateTokens(input.accumulatedStreamedTokens) : 0);

  return {
    id: input.assistantMessageId,
    role: "assistant" as const,
    content: abortContent,
    thought:
      input.accumulatedThoughts.length > 0 ? input.accumulatedThoughts.join("\n\n") : undefined,
    traces:
      input.traces.length > 0
        ? (input.traces as unknown as Parameters<ThreadStore["addMessage"]>[1]["traces"])
        : undefined,
    attachments: turnAttachments.length > 0 ? turnAttachments : undefined,
    diffs: turnDiffs.length > 0 ? turnDiffs : undefined,
    modelUsed: input.activeModel,
    selectedModel: input.requestedModel || input.activeModel,
    turnStartMs: input.turnStartMs,
    durationMs:
      typeof input.turnStartMs === "number"
        ? Math.max(1, Date.now() - input.turnStartMs)
        : undefined,
    timestamp: input.nowIso ?? new Date().toISOString(),
    status: "incomplete" as const,
    isStopped: isExplicit ? true : undefined,
    finish_reason: input.lastFinishReason || "abort",
    outputTokens: finalOutputTokens,
    microElisions: input.turnMicroElisions.length > 0 ? input.turnMicroElisions : undefined,
    readDedups: input.turnReadDedups.length > 0 ? input.turnReadDedups : undefined,
  };
}

export interface SynthesisPassChunk {
  finish_reason?: string;
  promptTokens?: number;
  prompt_eval_count?: number;
  outputTokens?: number;
  eval_count?: number;
  message?: {
    thinking?: string;
    content?: string;
  };
}

export interface RunSynthesisPassParams {
  llmBaseUrl: string;
  activeModel: string;
  conversationMessages: Parameters<typeof fitContextWindow>[0];
  tools?: unknown[];
  isArtifactRequest: boolean;
  turnAbortSignal: AbortSignal;
  synthOptions: {
    reasoning_effort?: Parameters<
      ReturnType<typeof getLLMProvider>["streamChat"]
    >[1]["reasoning_effort"];
    [key: string]: unknown;
  };
  accumulatedThoughts: string[];
  getAccumulatedStreamedTokens: () => string;
  setAccumulatedStreamedTokens: (next: string) => void;
  onFinishReason: (reason: string) => void;
  onPromptTokens: (tokens: number) => void;
  onOutputTokens: (tokens: number) => void;
  maybeWriteSnapshot: (content: string, thought: string | undefined) => void;
  sendEvent: (data: Record<string, unknown>) => Promise<void>;
  streamChat: (
    llmBaseUrl: string,
    payload: Parameters<ReturnType<typeof getLLMProvider>["streamChat"]>[1]
  ) => AsyncIterable<SynthesisPassChunk>;
  deadlines?: { inactivityMs: number; totalMs: number };
  log?: (...args: unknown[]) => void;
  /** Pre-computed estimateTokens(conversationMessages) to reuse instead of re-scanning (Perf P6). */
  precomputedRawMessageTokens?: number;
  /** Pre-computed estimateToolSchemaTokens(tools) to reuse instead of re-stringifying (Perf P6). */
  precomputedToolSchemaTokens?: number;
}

/**
 * Executes a single post-tool synthesis pass, streaming tokens and thinking
 * into the shared turn accumulators under a per-pass deadline leash.
 */
export async function runSynthesisPass(
  params: RunSynthesisPassParams
): Promise<{ content: string; thinking: string }> {
  const {
    llmBaseUrl,
    activeModel,
    conversationMessages,
    tools,
    isArtifactRequest,
    turnAbortSignal,
    synthOptions,
    accumulatedThoughts,
    getAccumulatedStreamedTokens,
    setAccumulatedStreamedTokens,
    onFinishReason,
    onPromptTokens,
    onOutputTokens,
    maybeWriteSnapshot,
    sendEvent,
    streamChat,
    deadlines,
    log = console.log,
    precomputedRawMessageTokens,
    precomputedToolSchemaTokens,
  } = params;

  let passContent = "";
  let passThinking = "";
  const passAbortController = new AbortController();
  const passDeadline = createRoundDeadline(passAbortController, deadlines);

  try {
    const hasTools = Array.isArray(tools) && tools.length > 0;
    for await (const chunk of streamChat(llmBaseUrl, {
      model: activeModel,
      messages: fitContextWindow(conversationMessages, {
        isArtifactTurn: isArtifactRequest,
        tools: hasTools ? tools : undefined,
        ...(precomputedRawMessageTokens !== undefined ? { precomputedRawMessageTokens } : {}),
        ...(precomputedToolSchemaTokens !== undefined ? { precomputedToolSchemaTokens } : {}),
      }),
      ...(hasTools ? { tools, tool_choice: "none" as const } : {}),
      signal: AbortSignal.any([turnAbortSignal, passAbortController.signal]),
      reasoning_effort: synthOptions.reasoning_effort,
      options: synthOptions,
    })) {
      if (chunk.finish_reason) {
        onFinishReason(chunk.finish_reason);
      }
      if (typeof chunk.promptTokens === "number") {
        onPromptTokens(chunk.promptTokens);
      } else if (typeof chunk.prompt_eval_count === "number") {
        onPromptTokens(chunk.prompt_eval_count);
      }
      if (typeof chunk.outputTokens === "number") {
        onOutputTokens(chunk.outputTokens);
      } else if (typeof chunk.eval_count === "number") {
        onOutputTokens(chunk.eval_count);
      }
      if (chunk.message?.thinking) {
        passThinking += chunk.message.thinking;
        passDeadline.arm();
        const currentCumulativeThought =
          accumulatedThoughts.length > 0
            ? `${accumulatedThoughts.join("\n\n")}\n\n${passThinking}`
            : passThinking;
        maybeWriteSnapshot(getAccumulatedStreamedTokens(), currentCumulativeThought);
        // PERF-P3: per-token delta only. The cumulative thought reaches the
        // client via the throttled snapshot and the terminal `done` event;
        // re-sending the full cumulative string per token was O(T^2) SSE bytes.
        await sendEvent({ type: "thinking", content: chunk.message.thinking });
      }
      if (chunk.message?.content) {
        const isFirstChunk = passContent.length === 0;
        passContent += chunk.message.content;
        const nextStreamed = appendNarrationChunk(
          getAccumulatedStreamedTokens(),
          chunk.message.content,
          { roundBoundary: isFirstChunk }
        );
        setAccumulatedStreamedTokens(nextStreamed);
        passDeadline.arm();
        if (passContent.length > MAX_STREAMED_CONTENT_CHARS) {
          const capped = nextStreamed + TURN_SIZE_LIMIT_MARKER;
          setAccumulatedStreamedTokens(capped);
          maybeWriteSnapshot(capped, undefined);
          await sendEvent({ type: "token", content: TURN_SIZE_LIMIT_MARKER });
          passAbortController.abort();
          break;
        }
        const currentCumulativeThought =
          accumulatedThoughts.length > 0
            ? passThinking
              ? `${accumulatedThoughts.join("\n\n")}\n\n${passThinking}`
              : accumulatedThoughts.join("\n\n")
            : passThinking || undefined;
        maybeWriteSnapshot(nextStreamed, currentCumulativeThought);
        await sendEvent({ type: "token", content: chunk.message.content });
      }
    }
  } catch (err: unknown) {
    if (passAbortController.signal.aborted && !turnAbortSignal.aborted) {
      log(`[DBG] synthesis pass aborted timedOut=${passDeadline.getTimedOut()}`);
    } else {
      throw err;
    }
  } finally {
    passDeadline.clear();
  }
  return { content: passContent, thinking: passThinking };
}

export { runChatTurn, type RunChatTurnDeps } from "./roundLoop";
