import {
  handleLiveTurnChunkBudget,
  resolveThreadChunkBudget,
  resolveChunkHandoffTarget,
  resolveChunkRunlogPath,
} from "@/lib/jobChunking";
import {
  ThreadStore,
  activeExecutionSet,
  clearTurnActive,
  clearTurnAbortController,
  registerRoundAbortController,
  clearRoundAbortController,
  markTurnExecuting,
  touchActiveTurn,
} from "@/lib/threads/threadStore";
import { ThrottledStreamSnapshot } from "@/lib/streamSnapshot";
import { appendNarrationChunk } from "@/lib/liveActivity";
import { recordTurnOutputWrite, collectTurnAttachments } from "@/lib/threadOutputs";
import {
  captureWorkspacePreImage,
  coalesceTurnDiffs,
  collectTurnModifiedFileDiffs,
  TurnFileDiff,
} from "@/lib/chatDiffs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_PRIMARY_MODEL, AgentMode } from "@/config/models";
import { TelemetryTracer } from "@/lib/telemetry";
import { parseToolCallsFromText, cleanResidualToolTags } from "@/lib/toolParser";
import { getMcpUrl, getBrowserMcpUrl, connectMcpClient } from "@/lib/chat/mcpClients";
import {
  resolveEffectiveReasoningEffort,
  shouldConsultLocalOracle,
  joinNarrationChunks,
} from "@/lib/chatUtils";
import {
  fitContextWindow,
  clampToolOutput,
  MAX_WEB_RESEARCH_CALLS,
  WEB_BUDGET_EXHAUSTED_DIRECTIVE,
  isWebResearchTool,
  filterToolsForWebBudget,
  buildSynthesisDirective,
  shouldRunPostToolSynthesis,
  appendTrailingDirective,
  hasArtifactCreationIntent,
  resolveRoundModelOptions,
  OUTPUT_HEADROOM_THINKING_DIRECTIVE,
  isLiveRealTimeIntent,
  canContinueToolLoop,
  TOOL_ROUND_BACKSTOP,
  estimateTokens,
  estimateToolSchemaTokens,
  estimateEffectivePromptTokens,
  computeEffectiveInputCeiling,
  CHAT_CONTEXT_BUDGET_TOKENS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  fitConversationToBudget,
  HIGH_WATER_BANKING_DIRECTIVE,
  TURN_TIMEOUT_MARKER,
  TURN_SIZE_LIMIT_MARKER,
  TURN_TRUNCATION_MARKER,
  LENGTH_CONTINUATION_DIRECTIVE,
  ROUND_TIMEOUT_DIRECTIVE,
  MAX_STREAMED_CONTENT_CHARS,
} from "@/lib/contextBudget";
import { ROUND_MAX_TOKENS } from "@/lib/modelLimits";
import type { ToolLoopStopReason } from "@/lib/contextBudget";
import { buildJobTokenRollup, sumRoundPromptTokens } from "@/lib/tokenEconomics";
import {
  applyMicroElision,
  computeMicroElisionTriggerTokens,
  MICRO_ELISION_REARM_DELTA_TOKENS,
  type ElisionMeta,
} from "@/lib/microElision";
import { evaluateMarkupRound, evaluateZeroTraceTripwire } from "@/lib/toolCallIntegrity";
import { verifyEvidenceLinkedSummary } from "@/lib/evidenceLinkedSummaries";
import { buildVerificationAdapters } from "@/lib/subagents/supervisor";
import { ReadDedupRegistry, isMultiReadResult, type ReadDedupMeta } from "@/lib/readDedup";
import {
  TOOL_FANOUT_CAP,
  isReadOnlyFanoutTool,
  partitionToolCallBatches,
  executeWithConcurrencyLimit,
} from "@/lib/chat/toolFanout";
import { searchOracleCodebase } from "@/lib/oracle/ingestion";
import {
  DESCRIBE_TOOL_NAME,
  buildLayer1Tools,
  buildToolRegistry,
  describeTool,
} from "@/lib/progressiveTools";
import {
  resolveCompactionStrategy,
  resolveMidTurnHybridEnabled,
} from "@/lib/conversationCompaction";
import {
  HOST_TOOLS_DEFINITIONS,
  HOST_TOOL_NAMES,
  UNATTENDED_GIT_TOOLS_DEFINITIONS,
  UNATTENDED_GIT_TOOL_NAMES,
  executeHostTool,
  isDestructiveHostAction,
  createPendingApproval,
  consumeContinuationEntry,
  determineHostRunnerState,
  shouldAdvertiseHostTools,
  shouldAdvertiseUnattendedGitTools,
  getHostStateDirective,
  generateHostFileDiff,
} from "@/lib/hostMode";
import { getHostSettings } from "@/lib/hostSettings";
import { notify } from "@/lib/notifications";
import {
  loadUserProfile,
  formatProfileForContext,
  extractDurablePreferences,
  recordProfileEntry,
} from "@/lib/memory/profile";
import {
  loadOperatorMemory,
  formatMemoryForContext,
  assembleSystemPrompt,
} from "@/lib/memory/operatorMemory";
import type { getLLMProvider } from "@/lib/llm/provider";
import {
  evaluateSearchQueryAttempt,
  shouldInjectHonestAbort,
  HONEST_ABORT_DIRECTIVE,
} from "@/lib/grounding";
import {
  type SseEventWriter,
  createRoundDeadline,
  runSynthesisPass as executeSynthesisPass,
} from "@/lib/chat/turnEngine";
import type { QueuedJob } from "@/lib/jobQueue";
import type { WorktreeHandle } from "@/lib/worktree";
import type { SlotLease } from "@/lib/slotScheduler";

export interface TraceItem {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  timestamp: string;
  model: string;
  tier?: "sandbox" | "browser" | "workspace" | "host";
  round?: number;
  isError?: boolean;
}

/**
 * Classifies a tool execution result as an error using structured fields
 * (host `{ success, exitCode }` and parsed MCP `content[0].text` `{ status, exit_code }`)
 * rather than raw substring matching across serialized output.
 */
export function classifyExecutionError(res: unknown): boolean {
  if (!res || typeof res !== "object") return false;
  const obj = res as Record<string, unknown>;

  if (obj.isError === true) return true;
  if (obj.success === false || obj.ok === false) return true;
  if (typeof obj.exitCode === "number" && obj.exitCode !== 0) return true;
  if (typeof obj.exit_code === "number" && obj.exit_code !== 0) return true;
  if (obj.status === "EXECUTION_ERROR") return true;

  const explicitSuccess =
    obj.success === true ||
    obj.ok === true ||
    obj.exitCode === 0 ||
    obj.exit_code === 0 ||
    obj.status === "SUCCESS";
  if (!explicitSuccess && typeof obj.error === "string" && obj.error.trim().length > 0) {
    return true;
  }

  if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      if (!item || typeof item !== "object") continue;
      const text = (item as { text?: unknown }).text;
      if (typeof text !== "string") continue;
      const trimmed = text.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (!parsed || typeof parsed !== "object") continue;
        if (parsed.isError === true) return true;
        if (parsed.success === false || parsed.ok === false) return true;
        if (parsed.status === "EXECUTION_ERROR") return true;
        if (typeof parsed.exit_code === "number" && parsed.exit_code !== 0) return true;
        if (typeof parsed.exitCode === "number" && parsed.exitCode !== 0) return true;
      } catch {
        // Non-JSON text (e.g. file reads) is not an error envelope.
      }
    }
  }

  return false;
}

export interface LlmToolCall {
  id?: string;
  type?: string;
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

export interface ChatInputMessage {
  id?: string;
  role: string;
  content: string;
  timestamp?: string;
  isDirective?: boolean;
  tool_calls?: LlmToolCall[];
  [key: string]: unknown;
}

/**
 * Extracts in-flight assistant tool_calls and tool results occurring after the
 * last real user message (ignoring synthetic `isDirective: true` user messages).
 */
export function extractInFlightTail<
  T extends { role?: string; isDirective?: boolean; tool_calls?: unknown[] },
>(conversationMessages: T[]): T[] {
  let lastUserIdx = -1;
  for (let i = conversationMessages.length - 1; i >= 0; i--) {
    if (conversationMessages[i]?.role === "user" && !conversationMessages[i]?.isDirective) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx >= 0 && lastUserIdx < conversationMessages.length - 1) {
    const inFlightTail = conversationMessages.slice(lastUserIdx + 1);
    if (
      inFlightTail.some(
        (m) => m?.role === "tool" || (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0)
      )
    ) {
      return inFlightTail;
    }
  }
  return [];
}

export type ChatThreadData = NonNullable<Awaited<ReturnType<ThreadStore["getThread"]>>> & {
  gitCapability?: Parameters<typeof shouldAdvertiseUnattendedGitTools>[1];
  mergeGrant?: Parameters<typeof executeHostTool>[4];
};

export interface RunChatTurnState {
  activeModel: string;
  accumulatedStreamedTokens: string;
  assistantPersisted: boolean;
  lastFinishReason: string | undefined;
  turnOutputTokens: number | undefined;
  /** Cumulative completion tokens across all dispatched rounds and synthesis passes. */
  cumulativeOutputTokens?: number;
  turnCreatedFiles: string[];
  turnPreImages: Map<string, string>;
  turnHostDiffs: TurnFileDiff[];
  traces: TraceItem[];
  turnMicroElisions: ElisionMeta[];
  turnReadDedups: ReadDedupMeta[];
  accumulatedThoughts: string[];
  inFlightThinking?: string;
  inFlightThinkingRound?: number;
}

/** Default in-turn heartbeat cadence to keep thread.updatedAt fresh during long spans. */
export const IN_TURN_HEARTBEAT_INTERVAL_MS = 30_000;

const DELIVERABLE_WRITE_TOOLS = new Set([
  "workspace_write_file",
  "workspace_patch_file",
  "host_write_file",
  "host_replace_string",
  "git_commit",
  "host_git_commit",
]);

export interface RunChatTurnDeps {
  // Request & prompt context
  reqSignal: AbortSignal;
  messages: ChatInputMessage[];
  userPrompt: string;
  priorUserPrompt: string;
  approvalContinuationId?: string;
  assistantMessageId: string;
  clientSessionId: string;
  systemPrompt: string;
  effortDirective: string;
  imagePayloads: string[];
  docContexts: string[];

  // Model & inference configuration
  mode: AgentMode;
  requestedModel?: string;
  requestedReasoning?: Parameters<typeof resolveEffectiveReasoningEffort>[1];
  initialEffectiveReasoningEffort: ReturnType<typeof resolveEffectiveReasoningEffort>;
  invalidRequestedModel: string | null;
  triageComplexityResult: "SIMPLE_EXECUTION" | "DEEP_SYNTHESIS" | null;
  getLlmBaseUrl: () => string;
  resolveJobRepoRoot: () => string;
  streamLlmChat: (
    llmBaseUrl: string,
    payload: Parameters<ReturnType<typeof getLLMProvider>["streamChat"]>[1]
  ) => ReturnType<ReturnType<typeof getLLMProvider>["streamChat"]>;
  advertisedTools: Set<string>;

  // Thread, storage & host settings
  activeThreadId: string | null;
  threadsDir: string;
  threadStore: ThreadStore;
  initialThreadData: ChatThreadData | null;
  initialThreadHostAccess: boolean;
  streamSnapshot: ThrottledStreamSnapshot;

  // SSE writer, abort & lifecycle
  sseWriter: SseEventWriter;
  turnAbortController: AbortController;
  persistAssistantOnAbort: () => void;
  onRunTurnStarted: () => void;
  onRunTurnFinally: () => void;
  isExplicitStopped: () => boolean;
  turnState: RunChatTurnState;
  /** Timestamp (ms) captured at chat-route entry before queue wait, MCP connect, Oracle, and compaction. */
  turnStartMs?: number;
  /** Optional override for the in-turn touchActiveTurn heartbeat interval (defaults to 30s). */
  heartbeatIntervalMs?: number;
  /** Optional override for TOOL_ROUND_BACKSTOP (defaults to TOOL_ROUND_BACKSTOP). */
  roundBackstop?: number;

  // Stateless MCP client handles (tracked per turn for cleanup only) & telemetry
  activeSessions: Array<{ client: Client; transport: StreamableHTTPClientTransport }>;
  toolClientMap: Map<
    string,
    { client: Client | null; tier: "sandbox" | "browser" | "workspace" | "host" }
  >;
  tracer: TelemetryTracer;
  rootSpan: ReturnType<TelemetryTracer["startSpan"]> | null;
}

export async function runChatTurn(
  deps: RunChatTurnDeps,
  _job: QueuedJob,
  _worktree: WorktreeHandle | null,
  lease?: SlotLease
): Promise<void> {
  const {
    messages,
    userPrompt,
    priorUserPrompt,
    approvalContinuationId,
    assistantMessageId,
    clientSessionId,
    systemPrompt: SYSTEM_PROMPT,
    effortDirective,
    imagePayloads,
    docContexts,
    mode,
    requestedModel,
    requestedReasoning,
    invalidRequestedModel,
    triageComplexityResult,
    getLlmBaseUrl,
    resolveJobRepoRoot,
    streamLlmChat,
    advertisedTools: ADVERTISED_TOOLS,
    activeThreadId,
    threadsDir,
    threadStore,
    streamSnapshot,
    sseWriter,
    turnAbortController,
    persistAssistantOnAbort,
    turnState,
    activeSessions,
    toolClientMap,
    tracer,
    rootSpan,
  } = deps;

  const { sendEvent, cleanupClientSignal } = sseWriter;
  const {
    turnCreatedFiles,
    turnPreImages,
    turnHostDiffs,
    traces,
    turnMicroElisions,
    turnReadDedups,
    accumulatedThoughts,
  } = turnState;

  const turnStartMs = deps.turnStartMs ?? Date.now();
  const effectiveRoundBackstop = deps.roundBackstop ?? TOOL_ROUND_BACKSTOP;
  turnState.cumulativeOutputTokens = turnState.cumulativeOutputTokens ?? 0;

  let effectiveReasoningEffort = deps.initialEffectiveReasoningEffort;
  let threadData: ChatThreadData | null = deps.initialThreadData;
  let threadHostAccess = deps.initialThreadHostAccess;
  let thinkingEndMs: number | null = null;
  let firstLlmRequestMs: number | null = null;
  let thinkingMsAcc = 0;
  let lastThinkingChunkMs: number | null = null;
  let writingMsAcc = 0;
  let lastWritingChunkMs: number | null = null;

  deps.onRunTurnStarted();
  const envHeartbeatMs = Number.parseInt(process.env.TURN_HEARTBEAT_INTERVAL_MS || "", 10);
  const turnHeartbeatMs =
    deps.heartbeatIntervalMs ??
    (Number.isFinite(envHeartbeatMs) && envHeartbeatMs > 0
      ? envHeartbeatMs
      : IN_TURN_HEARTBEAT_INTERVAL_MS);
  if (activeThreadId) {
    // Stall clock starts at turn execution (not queue enqueue).
    markTurnExecuting(activeThreadId, threadsDir);
    touchActiveTurn(activeThreadId, threadsDir);
  }
  let inTurnHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (activeThreadId && turnHeartbeatMs > 0) {
    inTurnHeartbeatTimer = setInterval(() => {
      touchActiveTurn(activeThreadId, threadsDir);
    }, turnHeartbeatMs);
    if (typeof inTurnHeartbeatTimer.unref === "function") {
      inTurnHeartbeatTimer.unref();
    }
  }
  let oracleSnippet = "";
  let oracleCitations: string[] = [];

  try {
    if (invalidRequestedModel) {
      throw new Error(
        `Model "${invalidRequestedModel}" is not available on the active inference engine.`
      );
    }

    await sendEvent({
      type: "status",
      status: "Preparing context & tools...",
    });

    // 1. Gated Oracle Codebase & Semantic Memory Lookup with 2500ms timeout
    if (!approvalContinuationId && userPrompt.trim() && shouldConsultLocalOracle(userPrompt)) {
      try {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<{ contextSnippet: string; citations: string[] }>(
          (resolve) => {
            timer = setTimeout(() => resolve({ contextSnippet: "", citations: [] }), 2500);
            if (typeof timer?.unref === "function") timer.unref();
          }
        );
        const ragPromise = (async () => {
          const oracleResult = await searchOracleCodebase(userPrompt);
          return {
            contextSnippet: oracleResult.contextSnippet || "",
            citations: oracleResult.citations || [],
          };
        })();

        const lookupResult = await Promise.race([ragPromise, timeoutPromise]);
        if (timer) clearTimeout(timer);
        if (lookupResult.contextSnippet) {
          oracleSnippet = lookupResult.contextSnippet;
          oracleCitations = lookupResult.citations;
        }
      } catch (err: unknown) {
        console.warn(
          "[ChatRoute] Oracle codebase retrieval warning:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Tier 1 User Profile Memory
    if (!approvalContinuationId && userPrompt.trim()) {
      try {
        const durableFacts = extractDurablePreferences(userPrompt, clientSessionId);
        for (const fact of durableFacts) {
          recordProfileEntry(fact.key, fact.value, {
            sessionId: clientSessionId,
            origin: fact.origin,
          });
        }
      } catch (err: unknown) {
        console.warn(
          "[ChatRoute] Failed to record durable preferences:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // 2. Connect to Sandboxed Code-Runner / Workspace MCP
    const sandboxSession = await connectMcpClient(getMcpUrl(), "orchestrator-sandbox-client");
    if (sandboxSession) {
      activeSessions.push(sandboxSession);
      for (const t of sandboxSession.tools) {
        toolClientMap.set(t.name, { client: sandboxSession.client, tier: "sandbox" });
      }
    }

    // 3. Connect to Isolated Browser/Scraper MCP
    const browserSession = await connectMcpClient(
      getBrowserMcpUrl(),
      "orchestrator-browser-client"
    );
    if (browserSession) {
      activeSessions.push(browserSession);
      for (const t of browserSession.tools) {
        toolClientMap.set(t.name, { client: browserSession.client, tier: "browser" });
      }
    }

    // 4. Host Mode Tools (if host access enabled AND runner is healthy)

    if (activeThreadId && !threadData) {
      try {
        threadData = await threadStore.getThread(activeThreadId);
        if (typeof threadData?.hostAccess === "boolean") {
          threadHostAccess = threadData.hostAccess;
        }
      } catch {}
    }

    // Prohibited contexts: scheduled/subagent threads (flags are type-only and
    // never assigned today) and task threads — taskId IS assigned on task threads,
    // so it is the reliable signal for the standing host-tool prohibition.
    const isProhibitedContext = Boolean(
      threadData?.isSubagent || threadData?.isScheduled || threadData?.taskId
    );
    const hostStatus = await determineHostRunnerState(threadHostAccess);

    const includeHostTools =
      !isProhibitedContext && shouldAdvertiseHostTools(threadHostAccess, hostStatus.runnerState);

    const hostTools = includeHostTools
      ? HOST_TOOLS_DEFINITIONS.map((ht) => ({
          name: ht.function.name,
          description: ht.function.description,
          inputSchema: ht.function.parameters,
        }))
      : [];

    for (const ht of hostTools) {
      toolClientMap.set(ht.name, { client: null, tier: "host" });
    }

    // Unattended Git Tool Admission: requires Key (a) Settings ON + explicit capability + READY runner
    const hostSettings = getHostSettings();
    const threadGitCapability = threadData?.gitCapability;
    const includeUnattendedGit = shouldAdvertiseUnattendedGitTools(
      hostSettings.allowUnattendedHostGit,
      threadGitCapability,
      hostStatus.runnerState,
      isProhibitedContext
    );

    const gitTools = includeUnattendedGit
      ? UNATTENDED_GIT_TOOLS_DEFINITIONS.map((gt) => ({
          name: gt.function.name,
          description: gt.function.description,
          inputSchema: gt.function.parameters,
        }))
      : [];

    for (const gt of gitTools) {
      toolClientMap.set(gt.name, { client: null, tier: "host" });
    }

    const allTools = [
      ...(sandboxSession?.tools || []),
      ...(browserSession?.tools || []),
      ...hostTools,
      ...gitTools,
    ];

    const toolRegistry = buildToolRegistry(allTools);
    const llmTools = buildLayer1Tools(allTools);
    // Fix D1 + D2 (F8a/F8b) + Phase 1 (P1): keep roundTools byte-stable across
    // all rounds of a turn (even after webResearchCalls reaches MAX_WEB_RESEARCH_CALLS;
    // filterToolsForWebBudget is retained for standalone callers while excess web
    // calls in the turn loop are rejected at dispatch time), and precompute
    // roundToolSchemaTokens once per turn.
    void filterToolsForWebBudget;
    const roundTools = llmTools;
    const roundToolSchemaTokens = estimateToolSchemaTokens(roundTools);

    // TURN-START WIRING (compaction-hybrid turn-start fix): the turn-start
    // prepare now receives the resolved strategy plus the summarize adapter so
    // a flag-on thread crossing the 85% trigger at turn start reaches the
    // hybrid rung instead of being pre-empted by the extraction digest.
    // Flag OFF / unset resolves to "extraction" and the prepare stays on the
    // synchronous extraction call (the callback is never invoked).
    const prep = await threadStore.prepareTurnConversationMessages(
      threadData,
      messages,
      CHAT_CONTEXT_BUDGET_TOKENS,
      {
        strategy: resolveCompactionStrategy(),
        summarize: async (sumReq) => {
          let text = "";
          let truncated = false;
          for await (const chunk of streamLlmChat(getLlmBaseUrl(), {
            model: turnState.activeModel,
            messages: [
              { role: "system", content: sumReq.prompt },
              { role: "user", content: sumReq.digest },
            ],
            keep_alive: -1,
            signal: sumReq.signal,
            options: { temperature: sumReq.temperature, num_predict: sumReq.maxTokens },
          })) {
            sumReq.onProgress?.();
            if (chunk.message?.content) text += chunk.message.content;
            if (chunk.finish_reason === "length") truncated = true;
          }
          return { text, truncated };
        },
      }
    );

    let turnCompacted = prep.compactedThisTurn;
    let turnTokensBefore = prep.tokensBeforeCompaction;
    let turnTokensAfter = prep.tokensAfterCompaction;
    let turnCompactionActions: string[] | undefined = undefined;

    const conversationMessages = [...prep.messages];
    if (conversationMessages.length > 0) {
      const lastIdx = conversationMessages.length - 1;
      const lastMsg = { ...conversationMessages[lastIdx] };

      if (docContexts.length > 0) {
        lastMsg.content = `${lastMsg.content || ""}${docContexts.join("\n")}`;
      }
      if (imagePayloads.length > 0) {
        lastMsg.images = imagePayloads;
      }
      if (oracleSnippet) {
        lastMsg.content = `${lastMsg.content || ""}\n${oracleSnippet}`;
      }
      conversationMessages[lastIdx] = lastMsg;
    }

    const userProfile = loadUserProfile();
    const profileContext = formatProfileForContext(userProfile);
    const ownerMemory = loadOperatorMemory();
    const memoryText = ownerMemory.text;

    const hostDirective = "\n\n" + getHostStateDirective(hostStatus.runnerState, hostStatus.reason);

    if (!conversationMessages.some((m) => m.role === "system")) {
      conversationMessages.unshift({
        role: "system",
        content: assembleSystemPrompt(
          SYSTEM_PROMPT,
          profileContext,
          memoryText,
          effortDirective,
          hostDirective
        ),
      });
    } else {
      const sysIdx = conversationMessages.findIndex((m) => m.role === "system");
      conversationMessages[sysIdx].content +=
        profileContext + formatMemoryForContext(memoryText) + hostDirective;
    }

    // Handle single-use approval continuation buffer
    if (approvalContinuationId) {
      const consumed = consumeContinuationEntry(
        approvalContinuationId,
        activeThreadId || "general"
      );
      if (!consumed.ok) {
        await sendEvent({
          type: "error",
          error: `Approval continuation failed: ${consumed.reason}`,
        });
        sseWriter.stopHeartbeat();
        for (const s of activeSessions) {
          try {
            await s.client.close();
          } catch {}
          try {
            await s.transport.close();
          } catch {}
        }
        await sseWriter.closeWriterWithTimeout(1000);
        return;
      }

      const entry = consumed.entry;
      const hostContinuationDiff = generateHostFileDiff(entry.tool, entry.args, entry.result);
      if (hostContinuationDiff) {
        turnHostDiffs.push(hostContinuationDiff);
      }

      const toolResultPayload = {
        status: entry.status,
        tool: entry.tool,
        ...(entry.result !== undefined ? { result: entry.result } : {}),
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      };

      const lastMsg = conversationMessages[conversationMessages.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        const pairedId =
          Array.isArray(lastMsg.tool_calls) && lastMsg.tool_calls[0]?.id
            ? lastMsg.tool_calls[0].id
            : undefined;
        conversationMessages.push({
          role: "tool",
          ...(pairedId ? { tool_call_id: pairedId } : {}),
          name: entry.tool,
          content: JSON.stringify(toolResultPayload),
        });
      } else {
        conversationMessages.push({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: `call_${entry.approvalId}`,
              type: "function",
              function: {
                name: entry.tool,
                arguments: JSON.stringify(entry.args),
              },
            },
          ],
        });
        conversationMessages.push({
          role: "tool",
          tool_call_id: `call_${entry.approvalId}`,
          name: entry.tool,
          content: JSON.stringify(toolResultPayload),
        });
      }
    }

    // Helper to detect tool calls from message.tool_calls OR XML / JSON blocks
    const getEffectiveToolCalls = (msg: {
      content: string;
      tool_calls?: LlmToolCall[];
    }): LlmToolCall[] => {
      if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        return msg.tool_calls;
      }
      return parseToolCallsFromText(msg.content, toolClientMap) as LlmToolCall[];
    };

    // Send initial metadata
    const initialEstimatedTokens = estimateTokens(conversationMessages);
    let turnRawTokens = initialEstimatedTokens;
    let turnRawTokensDirty = false;
    const markTurnRawTokensDirty = () => {
      turnRawTokensDirty = true;
    };
    const getTurnRawTokens = () => {
      if (turnRawTokensDirty) {
        turnRawTokens = estimateTokens(conversationMessages);
        turnRawTokensDirty = false;
      }
      return turnRawTokens;
    };
    const appendTurnDirective = (directive: string) => {
      const lenBefore = conversationMessages.length;
      appendTrailingDirective(conversationMessages, directive);
      if (conversationMessages.length !== lenBefore) {
        markTurnRawTokensDirty();
      }
    };
    await sendEvent({
      type: "meta",
      model: turnState.activeModel,
      mode,
      reasoning_effort: effectiveReasoningEffort,
      triage: triageComplexityResult,
      citations: oracleCitations,
      context: {
        estimatedTokens: initialEstimatedTokens,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactedThisTurn: turnCompacted,
        tokensBeforeCompaction: turnTokensBefore,
        tokensAfterCompaction: turnTokensAfter,
      },
    });

    let currentAssistantMessage: {
      role: "assistant";
      content: string;
      tool_calls?: LlmToolCall[];
    } = { role: "assistant", content: "" };
    let round = 0;
    let dispatchedRounds = 0;
    // CHAT-7: no fixed 8-round ceiling. Rounds are governed by context headroom;
    // TOOL_ROUND_BACKSTOP is only the runaway guard.
    let toolLoopStopReason: ToolLoopStopReason | undefined = undefined;
    let budgetExhaustedAtTokens = 0;
    let groundingDirectivePending = false;
    let consecutiveFailures = 0;
    let consecutiveMarkupFailures = 0;
    let webResearchCalls = 0;
    let webBudgetNoticeAdded = false;
    let groundingEnforced = false;
    let honestAbortInjected = false;
    let searchNudges = 0;
    let lastRoundTools: string[] = [];
    // ROUND-DEADLINES forensics + honest-end bookkeeping:
    //  - roundFinishReasons: per-round finish_reason recorded on the turn record.
    //  - consecutiveDeadlineAborts: a SECOND consecutive deadline-aborted round
    //    ends the turn with TURN_TIMEOUT_MARKER (never a silent endless retry).
    //  - consecutiveLengthTruncations: text-round length truncation auto-continues
    //    ONCE; a second consecutive truncation ends with TURN_TRUNCATION_MARKER.
    const roundFinishReasons: string[] = [];
    let consecutiveDeadlineAborts = 0;
    let consecutiveLengthTruncations = 0;
    let honestEndMarker = "";
    // Text carried across a length-truncated auto-continue: the final answer
    // must contain EVERY produced half, never just the last round.
    let carriedLengthContent = "";
    let carriedToolRoundProse = "";
    // TOKEN ECONOMICS (a): per-round prompt-token integral + compaction count,
    // rolled up onto the assistant message and the thread record.
    const roundPromptTokens: number[] = [];
    const roundGenerationMs: number[] = [];
    const thinkingSegments: Array<{ round: number; text: string }> = [];
    const roundNarrations: Array<{ round: number; text: string }> = [];
    let cumulativeOutputTokens = 0;
    let turnCompactionCount = prep.compactedThisTurn ? 1 : 0;
    // Fix D1 (F8a): provider-measured prompt truth calibration across rounds.
    let lastMeasuredPromptTokens: number | undefined = undefined;
    let lastMeasuredEstimateTokens: number | undefined = undefined;
    // TOKEN ECONOMICS (c): stubs recorded here append to the turn-level
    // turnMicroElisions declared with the other turn state, so both persist
    // paths (abort and final) carry the elision audit onto the message.

    const { isArtifactRequest } = hasArtifactCreationIntent(userPrompt);

    // TOKEN ECONOMICS (d): WITHIN-THREAD READ DEDUP registry. Seeded from the
    // conversation messages already in context (earlier turns' tool results)
    // so a re-read in a later turn stubs against the earlier turn's read.
    // Survives compaction (its own entries map), and the full result of the
    // first read stays recoverable in the thread trace record.
    const readDedupRegistry = new ReadDedupRegistry(conversationMessages);

    const chunkLoopStartMs = Date.now();
    const chunkBudget = resolveThreadChunkBudget(threadData ?? undefined);
    const chunkWorkspaceRoot = _worktree?.path || resolveJobRepoRoot() || process.cwd();
    const {
      jobId: chunkJobId,
      checkpointDir: chunkCheckpointDir,
      handoffPath: chunkHandoffPath,
    } = resolveChunkHandoffTarget({
      taskId: threadData?.taskId,
      threadId: activeThreadId || _job.threadId,
      fallbackJobId: _job.id,
    });
    const chunkRunlogPath = resolveChunkRunlogPath({
      worktreePath: _worktree?.path ?? null,
      jobId: chunkJobId,
      checkpointDir: chunkCheckpointDir,
    });
    let nextMicroElisionFloorTokens = 0;

    while (true) {
      if (turnAbortController.signal.aborted) break;
      if (getHostSettings().jobChunkingEnabled) {
        const chunkResult = await handleLiveTurnChunkBudget({
          roundsUsed: round,
          elapsedMs: Date.now() - chunkLoopStartMs,
          budget: chunkBudget,
          jobId: chunkJobId,
          workspaceRoot: chunkWorkspaceRoot,
          handoffPath: chunkHandoffPath,
          runlogPath: chunkRunlogPath,
          // Only stage/commit/push git state when running inside an isolated
          // per-turn worktree. When falling back to the shared host checkout
          // root (board #63), keep handoff/runlog resolution without mutating
          // host git state.
          bankGit: Boolean(_worktree),
          currentState: (
            carriedToolRoundProse ||
            carriedLengthContent ||
            `round ${round} completed`
          ).slice(0, 500),
          nextStep: `resume from round ${round}`,
          openQuestions: [],
        });
        if (chunkResult.exceeded) {
          honestEndMarker = chunkResult.marker;
          break;
        }
      }
      console.log(
        `[DBG] loop top round=${round} turnAborted=${turnAbortController.signal.aborted}`
      );

      const roundContextWindowTokens =
        resolveRoundModelOptions({
          model: turnState.activeModel,
          requestedEffort: effectiveReasoningEffort,
          userPrompt,
          hasCompletedToolCalls: traces.length > 0,
        }).num_ctx || DEFAULT_CONTEXT_WINDOW_TOKENS;

      // Round-scoped raw message-token tracker (Perf P6):
      // Reuses the initial turn-start scan on round 0 when clean, otherwise measures
      // conversationMessages once per round and re-scans only when markDirty() fires.
      let rawTokens = turnRawTokensDirty ? 0 : turnRawTokens;
      let dirty = turnRawTokensDirty;
      const markDirty = () => {
        dirty = true;
        markTurnRawTokensDirty();
      };
      const getRawTokens = () => {
        if (dirty) {
          rawTokens = estimateTokens(conversationMessages);
          dirty = false;
          turnRawTokens = rawTokens;
          turnRawTokensDirty = false;
        }
        return rawTokens;
      };
      const appendRoundDirective = (directive: string) => {
        const lenBefore = conversationMessages.length;
        appendTrailingDirective(conversationMessages, directive);
        if (conversationMessages.length !== lenBefore) {
          markDirty();
        }
      };

      // TOKEN ECONOMICS (c) + Fix D3 (F8c) + Prefix-Reuse Preservation:
      // Defer in-place micro-elision while prompt tokens stay below the 70%
      // pressure watermark (and rearm floor after a sweep) so earlier rounds
      // remain byte-identical for engine KV/SSM prefix-cache reuse. Once
      // pressure crosses the watermark, elide all accumulated superseded
      // payloads in a single batch sweep before the 85% compaction trigger.
      const preElisionEffectiveTokens = estimateEffectivePromptTokens(conversationMessages, {
        lastMeasuredPromptTokens,
        lastMeasuredEstimateTokens,
        precomputedToolSchemaTokens: roundToolSchemaTokens,
        precomputedRawMessageTokens: getRawTokens(),
      });
      const microElisionTriggerTokens = computeMicroElisionTriggerTokens({
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        contextWindowTokens: roundContextWindowTokens,
        outputReserveTokens: ROUND_MAX_TOKENS,
        rearmFloorTokens: nextMicroElisionFloorTokens,
      });
      const roundElision = applyMicroElision(conversationMessages, round + 1, {
        currentPromptTokens: preElisionEffectiveTokens,
        minPromptTokens: microElisionTriggerTokens,
      });
      let postElisionTokens: number | undefined;
      if (roundElision.stubbed > 0) {
        markDirty();
        turnMicroElisions.push(...roundElision.elisions);
        postElisionTokens = estimateEffectivePromptTokens(conversationMessages, {
          lastMeasuredPromptTokens,
          lastMeasuredEstimateTokens,
          precomputedToolSchemaTokens: roundToolSchemaTokens,
          precomputedRawMessageTokens: getRawTokens(),
        });
        nextMicroElisionFloorTokens = postElisionTokens + MICRO_ELISION_REARM_DELTA_TOKENS;
      }

      const preFitRawEstimate = getRawTokens() + roundToolSchemaTokens;
      const preFitEffectiveTokens =
        roundElision.stubbed > 0 && postElisionTokens !== undefined
          ? postElisionTokens
          : preElisionEffectiveTokens;

      // 1. Fit conversation to budget FIRST through ladder before evaluating continuation
      const compaction = fitConversationToBudget(conversationMessages, {
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        measuredPromptTokens:
          lastMeasuredPromptTokens !== undefined ? preFitEffectiveTokens : undefined,
        lastMeasuredEstimateTokens:
          lastMeasuredPromptTokens !== undefined ? preFitRawEstimate : undefined,
        precomputedToolSchemaTokens: roundToolSchemaTokens,
        precomputedRawMessageTokens: getRawTokens(),
        contextWindowTokens: roundContextWindowTokens,
        outputReserveTokens: ROUND_MAX_TOKENS,
      });
      if (compaction.compacted) {
        let appliedMessages = compaction.messages;
        let appliedTokensBefore = compaction.tokensBefore;
        let appliedTokensAfter = compaction.tokensAfter;
        let appliedActions: string[] = compaction.actions;

        if (activeThreadId && threadData) {
          try {
            // Board #129 P5-A: on the single-slot engine, mid-turn compaction
            // defaults to the synchronous extraction digest. The hybrid rung
            // dispatches a secondary summarization call with a DIFFERENT
            // system prompt on the same slot, evicting the active turn's
            // prefix state (next main round restarts at zero reuse). Opt in
            // via MID_TURN_HYBRID_COMPACTION=1 for multi-slot engines.
            if (resolveCompactionStrategy() === "hybrid" && resolveMidTurnHybridEnabled()) {
              const hybridResult = await threadStore.compactThreadIncrementalHybrid(threadData, {
                liveMessages: conversationMessages,
                maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
                measuredPromptTokens:
                  lastMeasuredPromptTokens !== undefined ? preFitEffectiveTokens : undefined,
                toolSchemaTokens: roundToolSchemaTokens,
                contextWindowTokens: roundContextWindowTokens,
                outputReserveTokens: ROUND_MAX_TOKENS,
                summarize: async (sumReq) => {
                  let text = "";
                  let truncated = false;
                  for await (const chunk of streamLlmChat(getLlmBaseUrl(), {
                    model: turnState.activeModel,
                    messages: [
                      { role: "system", content: sumReq.prompt },
                      { role: "user", content: sumReq.digest },
                    ],
                    keep_alive: -1,
                    signal: sumReq.signal,
                    options: {
                      temperature: sumReq.temperature,
                      num_predict: sumReq.maxTokens,
                    },
                  })) {
                    sumReq.onProgress?.();
                    if (chunk.message?.content) text += chunk.message.content;
                    if (chunk.finish_reason === "length") truncated = true;
                  }
                  return { text, truncated };
                },
              });
              if (!hybridResult.noop) {
                if (hybridResult.messages && hybridResult.messages.length > 0) {
                  appliedMessages = hybridResult.messages.map((m) => ({ ...m }));
                } else {
                  const rebuilt: Array<{ role: string; content: string; [key: string]: unknown }> =
                    threadStore.buildModelMessages(threadData);
                  const liveSystem =
                    conversationMessages[0]?.role === "system" ? conversationMessages[0] : null;
                  if (liveSystem && rebuilt[0]?.role !== "system") rebuilt.unshift(liveSystem);
                  const inFlightTail = extractInFlightTail(conversationMessages);
                  if (inFlightTail.length > 0) {
                    rebuilt.push(...inFlightTail);
                  }
                  appliedMessages = rebuilt;
                }
                appliedTokensBefore = hybridResult.tokensBefore;
                appliedTokensAfter = hybridResult.tokensAfter;
                appliedActions = hybridResult.modelSummaryUsed
                  ? ["hybrid_model_digest"]
                  : ["hybrid_extraction_fallback"];
              }
            } else {
              threadStore.compactThreadIncremental(threadData);
            }
          } catch {}
        }

        conversationMessages.length = 0;
        conversationMessages.push(...appliedMessages);
        markDirty();

        // When Rung (a) or hybrid compaction replaced older history, clear the
        // pre-compaction provider baseline so the next round dispatches cleanly
        // and re-measures real promptTokens from the provider. If only Rungs
        // (b)-(d) trimmed scraps without Rung (a) compaction, retain the
        // measured baseline so Fix D2 still blocks overflowing rounds.
        const compactedViaRungA =
          appliedActions.includes("compaction") ||
          appliedActions.includes("hybrid_model_digest") ||
          appliedActions.includes("hybrid_extraction_fallback");
        if (compactedViaRungA) {
          lastMeasuredPromptTokens = undefined;
          lastMeasuredEstimateTokens = undefined;
          nextMicroElisionFloorTokens = 0;
        }

        turnCompacted = true;
        turnTokensBefore = appliedTokensBefore;
        turnTokensAfter = appliedTokensAfter;
        turnCompactionActions = appliedActions;
        turnCompactionCount++;

        await sendEvent({
          type: "compaction",
          tokensBefore: appliedTokensBefore,
          tokensAfter: appliedTokensAfter,
          actions: appliedActions,
        });

        await sendEvent({
          type: "meta",
          model: turnState.activeModel,
          mode,
          reasoning_effort: effectiveReasoningEffort,
          triage: triageComplexityResult,
          citations: oracleCitations,
          context: {
            estimatedTokens: appliedTokensAfter,
            budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
            compactedThisTurn: true,
            tokensBeforeCompaction: appliedTokensBefore,
            tokensAfterCompaction: appliedTokensAfter,
            compactionActions: appliedActions,
          },
        });
      }

      if (compaction.highWater) {
        appendRoundDirective(HIGH_WATER_BANKING_DIRECTIVE);
      }

      const postFitEffectiveTokens = estimateEffectivePromptTokens(conversationMessages, {
        lastMeasuredPromptTokens,
        lastMeasuredEstimateTokens,
        precomputedToolSchemaTokens: roundToolSchemaTokens,
        precomputedRawMessageTokens: getRawTokens(),
      });

      // 2. Measure fitted tokens for continuation (with measured truth + output headroom)
      const continuation = canContinueToolLoop({
        round,
        contextTokens: getRawTokens(),
        measuredPromptTokens: postFitEffectiveTokens,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        contextWindowTokens: roundContextWindowTokens,
        outputReserveTokens: ROUND_MAX_TOKENS,
        lastRoundTools,
        webResearchCalls,
        ...(deps.roundBackstop !== undefined
          ? { roundBackstop: deps.roundBackstop }
          : { roundBackstop: TOOL_ROUND_BACKSTOP }),
        awaitingToolRound: groundingDirectivePending,
      });
      if (!continuation.canContinue) {
        toolLoopStopReason = continuation.stopReason;
        budgetExhaustedAtTokens = postFitEffectiveTokens;
        break;
      }
      groundingDirectivePending = false;

      // CHAT-STEER: consume pending steers at round boundary only AFTER verifying round can continue,
      // guaranteeing an LLM request will actually be dispatched with the steer!
      if (activeThreadId) {
        const steers = threadStore.consumeSteers(activeThreadId);
        if (steers.length > 0) {
          for (const s of steers) {
            const steerContent = `[Steer from user, mid-turn] ${s}`;
            conversationMessages.push({
              role: "user",
              content: steerContent,
            });
            try {
              threadStore.addMessage(activeThreadId, {
                id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                role: "user",
                content: steerContent,
                timestamp: new Date().toISOString(),
              });
            } catch {}
          }
          markDirty();
          await sendEvent({ type: "steer", texts: steers });
        }
      }

      const reasoningSpan = tracer.startSpan("model.reasoning", rootSpan?.spanId, {
        model: turnState.activeModel,
        round,
      });

      // CHAT-7: forced synthesis only on the last permitted round (backstop boundary).
      // Budget-exhausted research-extension rounds keep tools — they are still gathering data.
      const isFinalRound = continuation.forceSynthesis === true;
      // Final round forced synthesis: prompt model to synthesize answer and suppress tool calls via tool_choice: "none"
      if (isFinalRound) {
        appendRoundDirective(buildSynthesisDirective(userPrompt, true));
      }
      if (isArtifactRequest) {
        appendRoundDirective(OUTPUT_HEADROOM_THINKING_DIRECTIVE);
      }

      const roundOptions = resolveRoundModelOptions({
        model: turnState.activeModel,
        requestedEffort: effectiveReasoningEffort,
        userPrompt,
        isSynthesisOrFinalRound: isFinalRound,
        hasCompletedToolCalls: traces.length > 0,
      });

      const roundAbortController = new AbortController();
      if (activeThreadId) {
        registerRoundAbortController(activeThreadId, roundAbortController);
      }

      // ROUND-DEADLINES: wall-clock leash on every round. The inactivity timer
      // re-arms on each streamed chunk (silence since LAST chunk), the total
      // timer is absolute. Both abort ONLY this round's controller, never the
      // turn — the existing round-abort path then continues the turn once.
      const roundDeadline = createRoundDeadline(roundAbortController);
      console.log(
        `[DBG] dispatch round ${round} inactivity=${roundDeadline.inactivityMs} total=${roundDeadline.totalMs}`
      );
      const armRoundDeadline = roundDeadline.arm;

      const fittedMessages = fitContextWindow(conversationMessages, {
        contextWindowTokens: roundOptions.num_ctx,
        tools: roundTools,
        precomputedToolSchemaTokens: roundToolSchemaTokens,
        precomputedRawMessageTokens: getRawTokens(),
        isArtifactTurn: isArtifactRequest,
      });
      const llmPayload: Parameters<ReturnType<typeof getLLMProvider>["streamChat"]>[1] = {
        model: turnState.activeModel,
        messages: fittedMessages,
        keep_alive: -1,
        signal: AbortSignal.any([turnAbortController.signal, roundAbortController.signal]),
        reasoning_effort: roundOptions.reasoning_effort,
        options: roundOptions,
      };

      if (roundTools.length > 0) {
        llmPayload.tools = roundTools;
        if (isFinalRound) {
          llmPayload.tool_choice = "none";
        }
      }

      const dispatchedEstimateTokens =
        (fittedMessages.estimatedTokens ?? getRawTokens()) +
        (llmPayload.tools ? roundToolSchemaTokens : 0);

      let fullRoundContent = "";
      let roundThinking = "";
      let roundFinishReason: string | undefined = undefined;
      let roundSizeCapped = false;
      const toolCallsFromMessage: LlmToolCall[] = [];
      const roundStreamStartMs = Date.now();
      let roundOutputTokens = 0;
      let roundPromptTokenCount: number | undefined = undefined;
      dispatchedRounds++;
      const currentRoundNumber = dispatchedRounds;
      turnState.inFlightThinking = "";
      turnState.inFlightThinkingRound = currentRoundNumber;

      try {
        for await (const chunk of streamLlmChat(getLlmBaseUrl(), llmPayload)) {
          if (chunk.finish_reason) {
            turnState.lastFinishReason = chunk.finish_reason;
            roundFinishReason = chunk.finish_reason;
          }
          const chunkOutputTokens =
            typeof chunk.outputTokens === "number"
              ? chunk.outputTokens
              : typeof chunk.eval_count === "number"
                ? chunk.eval_count
                : undefined;
          if (typeof chunkOutputTokens === "number" && chunkOutputTokens > roundOutputTokens) {
            turnState.cumulativeOutputTokens =
              (turnState.cumulativeOutputTokens ?? 0) + (chunkOutputTokens - roundOutputTokens);
            roundOutputTokens = chunkOutputTokens;
            turnState.turnOutputTokens = turnState.cumulativeOutputTokens;
          }
          // TOKEN ECONOMICS (a): prompt tokens arrive on the finish chunk via
          // the PR #63 usage plumbing (promptTokens) or Ollama's
          // prompt_eval_count. Exactly one entry is pushed per round in finally.
          if (typeof chunk.promptTokens === "number") {
            roundPromptTokenCount = chunk.promptTokens;
          } else if (typeof chunk.prompt_eval_count === "number") {
            roundPromptTokenCount = chunk.prompt_eval_count;
          }
          if (chunk.message?.thinking) {
            const nowMs = Date.now();
            if (firstLlmRequestMs === null) firstLlmRequestMs = nowMs;
            if (lastThinkingChunkMs !== null) {
              thinkingMsAcc += Math.max(0, nowMs - lastThinkingChunkMs);
            }
            lastThinkingChunkMs = nowMs;
            roundThinking += chunk.message.thinking;
            turnState.inFlightThinking = roundThinking;
            turnState.inFlightThinkingRound = currentRoundNumber;
            armRoundDeadline();
            // P-F6: skip cumulative thought joins and segment clones on throttled sub-5s tokens.
            if (streamSnapshot.isDue()) {
              const currentCumulativeThought =
                accumulatedThoughts.length > 0
                  ? `${accumulatedThoughts.join("\n\n")}\n\n${roundThinking}`
                  : roundThinking;
              const liveSegments = roundThinking.trim()
                ? [...thinkingSegments, { round: currentRoundNumber, text: roundThinking.trim() }]
                : [...thinkingSegments];
              streamSnapshot.maybeWrite(
                turnState.accumulatedStreamedTokens,
                currentCumulativeThought,
                undefined,
                { thinkingSegments: liveSegments }
              );
            }
            // PERF-P3 / R9: per-token delta only. Complete cumulative `thought`
            // event is emitted once unconditionally at round completion below.
            await sendEvent({ type: "thinking", content: chunk.message.thinking });
          }
          if (chunk.message?.content) {
            const nowMs = Date.now();
            if (firstLlmRequestMs === null) firstLlmRequestMs = nowMs;
            if (lastWritingChunkMs !== null) {
              writingMsAcc += Math.max(0, nowMs - lastWritingChunkMs);
            }
            lastWritingChunkMs = nowMs;
            const textChunk = chunk.message.content;
            const isFirstChunkOfRound = fullRoundContent.length === 0;
            fullRoundContent += textChunk;
            turnState.accumulatedStreamedTokens = appendNarrationChunk(
              turnState.accumulatedStreamedTokens,
              textChunk,
              { roundBoundary: isFirstChunkOfRound }
            );
            armRoundDeadline();
            // TURN SIZE LIMIT: per-round hard cap on streamed content. A single
            // runaway round (e.g. a huge tool-call payload as one generation) is
            // cut off with an honest marker, without starving later rounds of a
            // healthy multi-round turn.
            if (fullRoundContent.length > MAX_STREAMED_CONTENT_CHARS) {
              roundSizeCapped = true;
              turnState.accumulatedStreamedTokens += TURN_SIZE_LIMIT_MARKER;
              streamSnapshot.maybeWrite(turnState.accumulatedStreamedTokens, undefined);
              await sendEvent({ type: "token", content: TURN_SIZE_LIMIT_MARKER });
              roundAbortController.abort();
              break;
            }
            if (streamSnapshot.isDue()) {
              const currentCumulativeThought =
                accumulatedThoughts.length > 0
                  ? roundThinking
                    ? `${accumulatedThoughts.join("\n\n")}\n\n${roundThinking}`
                    : accumulatedThoughts.join("\n\n")
                  : roundThinking || undefined;
              streamSnapshot.maybeWrite(
                turnState.accumulatedStreamedTokens,
                currentCumulativeThought
              );
            }
            await sendEvent({ type: "token", content: textChunk });
          }
          if (chunk.toolCallProgress) {
            if (firstLlmRequestMs === null) firstLlmRequestMs = Date.now();
            armRoundDeadline();
          }
          if (chunk.message?.tool_calls && Array.isArray(chunk.message.tool_calls)) {
            armRoundDeadline();
            toolCallsFromMessage.push(...chunk.message.tool_calls);
          }
        }
      } catch (roundErr: unknown) {
        if (!roundAbortController.signal.aborted || turnAbortController.signal.aborted) {
          throw roundErr;
        }
      } finally {
        const roundElapsedMs = Math.max(1, Date.now() - roundStreamStartMs);
        roundGenerationMs.push(roundElapsedMs);
        if (roundPromptTokenCount !== undefined) {
          roundPromptTokens.push(roundPromptTokenCount);
          if (roundPromptTokenCount > 0) {
            lastMeasuredPromptTokens = roundPromptTokenCount;
            lastMeasuredEstimateTokens = dispatchedEstimateTokens;
          }
        }
        if (roundOutputTokens > 0) {
          cumulativeOutputTokens += roundOutputTokens;
          void sendEvent({
            type: "metrics",
            outputTokens: cumulativeOutputTokens,
            roundOutputTokens,
            roundElapsedMs,
            roundGenerationMs: [...roundGenerationMs],
          }).catch(() => {});
        }
        roundDeadline.clear();
        if (activeThreadId) {
          clearRoundAbortController(activeThreadId, roundAbortController);
        }
      }

      const roundTimedOut = roundDeadline.getTimedOut();

      roundFinishReasons.push(roundFinishReason || "stop");

      if (roundThinking.trim()) {
        const trimmedThinking = roundThinking.trim();
        accumulatedThoughts.push(trimmedThinking);
        thinkingSegments.push({ round: currentRoundNumber, text: trimmedThinking });
        thinkingEndMs = Date.now();
        turnState.inFlightThinking = "";
        turnState.inFlightThinkingRound = undefined;
        // PERF-P3 / R9 round boundary: emit the complete cumulative `thought`
        // event unconditionally once at round completion so earlier snapshot
        // flushes never suppress full round reasoning.
        await sendEvent({
          type: "thought",
          thought: accumulatedThoughts.join("\n\n"),
          thinkingSegments: [...thinkingSegments],
        });
      } else {
        turnState.inFlightThinking = "";
        turnState.inFlightThinkingRound = undefined;
      }

      if (roundAbortController.signal.aborted && !turnAbortController.signal.aborted) {
        console.log(
          `[DBG] round ${round} aborted timedOut=${roundTimedOut} sizeCapped=${roundSizeCapped} consec=${consecutiveDeadlineAborts}`
        );
        if (roundSizeCapped) {
          // Size limit hit: the turn ends honestly. No retry — the content
          // cap exists precisely to stop runaway generations.
          honestEndMarker = TURN_SIZE_LIMIT_MARKER;
          reasoningSpan.end("ok", { roundSizeCapped: true });
          break;
        }
        if (roundTimedOut) {
          roundFinishReasons[roundFinishReasons.length - 1] = "timeout";
          consecutiveDeadlineAborts++;
          if (consecutiveDeadlineAborts >= 2) {
            // Second consecutive deadline-aborted round: end the turn with the
            // honest marker. Never a silent endless retry.
            honestEndMarker = TURN_TIMEOUT_MARKER;
            turnState.accumulatedStreamedTokens += TURN_TIMEOUT_MARKER;
            streamSnapshot.maybeWrite(turnState.accumulatedStreamedTokens, undefined);
            await sendEvent({ type: "token", content: TURN_TIMEOUT_MARKER });
            reasoningSpan.end("ok", { roundTimedOut, consecutiveDeadlineAborts });
            break;
          }
          // First abort: existing round-abort path, turn continues once. No
          // marker in the content yet — a single abort is not an end.
          conversationMessages.push({
            role: "assistant",
            content: fullRoundContent,
          });
          conversationMessages.push({
            role: "user",
            content: ROUND_TIMEOUT_DIRECTIVE,
            isDirective: true,
          });
          markDirty();
          reasoningSpan.end("ok", { roundTimedOut });
          // The retry round must actually be dispatched: lastRoundTools is
          // empty after an abort, so without awaitingToolRound the loop
          // would read the abort as "turn completed" and break.
          groundingDirectivePending = true;
          lastRoundTools = [];
          round++;
          continue;
        }
        if (fullRoundContent.trim()) {
          conversationMessages.push({
            role: "assistant",
            content: fullRoundContent,
          });
          markDirty();
        }
        reasoningSpan.end("ok");
        groundingDirectivePending = true;
        round++;
        continue;
      }

      reasoningSpan.end("ok");
      consecutiveDeadlineAborts = 0;

      console.log(
        `[DBG] round ${round} finish=${roundFinishReason} toolCalls=${toolCallsFromMessage.length} contentLen=${fullRoundContent.length}`
      );
      // SIZE-LIMIT EVENT: finish_reason:"length" with a tool call whose
      // arguments cannot be parsed = an oversized generation cut off mid-JSON.
      // Never retried silently: end the turn with the honest marker naming the
      // tool and the truncated argument byte size.
      if (
        roundFinishReason === "length" &&
        toolCallsFromMessage.length > 0 &&
        toolCallsFromMessage.some((tc) => {
          const rawArgs = tc.function?.arguments;
          if (typeof rawArgs !== "string") return false;
          try {
            JSON.parse(rawArgs);
            return false;
          } catch {
            return true;
          }
        })
      ) {
        const bad = toolCallsFromMessage.find((tc) => {
          try {
            if (typeof tc.function?.arguments !== "string") return false;
            JSON.parse(tc.function.arguments);
            return false;
          } catch {
            return true;
          }
        });
        const byteSize =
          typeof bad?.function?.arguments === "string" ? bad.function.arguments.length : 0;
        const sizeMarker = `${TURN_SIZE_LIMIT_MARKER} (tool: ${bad?.function?.name}, arguments truncated at ${byteSize} bytes)`;
        honestEndMarker = sizeMarker;
        turnState.accumulatedStreamedTokens += sizeMarker;
        streamSnapshot.maybeWrite(turnState.accumulatedStreamedTokens, undefined);
        await sendEvent({ type: "token", content: sizeMarker });
        reasoningSpan.end("ok", { sizeLimit: true, tool: bad?.function?.name, byteSize });
        break;
      }

      currentAssistantMessage = {
        role: "assistant",
        content: fullRoundContent,
        tool_calls: toolCallsFromMessage.length > 0 ? toolCallsFromMessage : undefined,
      };

      const rawToolCalls = getEffectiveToolCalls(currentAssistantMessage);
      const seenKeys = new Set<string>();
      const toolCalls = (rawToolCalls || []).filter((tc) => {
        const key =
          tc.id ||
          `${tc.function?.name}:${typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {})}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

      if (isFinalRound && toolCalls && toolCalls.length > 0) {
        // R9 guard: even if an engine ignores tool_choice: "none" on the final
        // round, never execute tools. Break so synthesis/completion runs.
        break;
      }

      if (!toolCalls || toolCalls.length === 0) {
        const markupEval = evaluateMarkupRound({
          roundContent: fullRoundContent,
          executedToolCallsCount: 0,
          consecutiveMarkupFailures,
          roundFinishReason,
          roundThinking,
        });
        if (markupEval.action === "reprompt") {
          consecutiveMarkupFailures = markupEval.consecutiveMarkupFailures;
          conversationMessages.push({
            role: "assistant",
            content: fullRoundContent,
          });
          conversationMessages.push({
            role: "user",
            content: markupEval.directive!,
            isDirective: true,
          });
          markDirty();
          groundingDirectivePending = true;
          lastRoundTools = [];
          round++;
          continue;
        }
        if (markupEval.action === "end_turn") {
          consecutiveMarkupFailures = markupEval.consecutiveMarkupFailures;
          honestEndMarker = markupEval.marker!;
          turnState.accumulatedStreamedTokens += markupEval.marker!;
          streamSnapshot.maybeWrite(turnState.accumulatedStreamedTokens, undefined);
          await sendEvent({ type: "token", content: markupEval.marker! });
          break;
        }
        consecutiveMarkupFailures = 0;

        if (
          isLiveRealTimeIntent(userPrompt) &&
          webResearchCalls === 0 &&
          round < effectiveRoundBackstop - 1 &&
          getRawTokens() <= CHAT_CONTEXT_BUDGET_TOKENS &&
          !groundingEnforced
        ) {
          groundingEnforced = true;
          groundingDirectivePending = true;
          appendRoundDirective(
            `[GROUNDING ENFORCEMENT]: You need current/real-time information before answering. Formulate the web search query YOURSELF: concise, the information need only. Resolve references from the conversation ("the day" means today, "there"/"it" means the place or topic already discussed -- carry place names like "Spanish Fort AL" forward). Never use the user's instructions, formatting requests, or meta-questions as the query. Only invoke search_web when you genuinely need external data -- do not search questions about the conversation itself. Invoke 'search_web' with your formulated query now. Do not hallucinate or claim you searched without invoking 'search_web'.`
          );
          round++;
          continue;
        }
        // AUTO-CONTINUE ON LENGTH: the model hit num_predict mid-answer.
        // Continue ONCE with the directive; a second consecutive truncation
        // ends the turn honestly with the truncation marker.
        if (
          roundFinishReason === "length" &&
          fullRoundContent.trim() &&
          !turnAbortController.signal.aborted
        ) {
          consecutiveLengthTruncations++;
          if (consecutiveLengthTruncations >= 2 || round >= effectiveRoundBackstop - 1) {
            honestEndMarker = TURN_TRUNCATION_MARKER;
            // Keep EVERY produced half: the final answer carries the earlier
            // truncated rounds plus this one, never just the last round.
            currentAssistantMessage = {
              role: "assistant",
              content: joinNarrationChunks(carriedLengthContent, fullRoundContent),
            };
            turnState.accumulatedStreamedTokens += TURN_TRUNCATION_MARKER;
            streamSnapshot.maybeWrite(turnState.accumulatedStreamedTokens, undefined);
            await sendEvent({ type: "token", content: TURN_TRUNCATION_MARKER });
            break;
          }
          conversationMessages.push({
            role: "assistant",
            content: fullRoundContent,
          });
          conversationMessages.push({
            role: "user",
            content: LENGTH_CONTINUATION_DIRECTIVE,
            isDirective: true,
          });
          markDirty();
          // Bank this half so the final answer keeps every produced part.
          carriedLengthContent = joinNarrationChunks(carriedLengthContent, fullRoundContent);
          await sendEvent({
            type: "status",
            status:
              "Generation hit the per-message size limit: continue exactly where you stopped.",
          });
          // The continuation round must actually be dispatched: lastRoundTools
          // is empty on a text round, so without awaitingToolRound the loop
          // would read the truncation as "turn completed" and break.
          groundingDirectivePending = true;
          lastRoundTools = [];
          round++;
          continue;
        }
        consecutiveLengthTruncations = 0;
        // If earlier rounds were length-truncated and auto-continued, the
        // final answer must carry every produced half, not just this round.
        if (carriedLengthContent) {
          currentAssistantMessage = {
            ...currentAssistantMessage,
            content: joinNarrationChunks(carriedLengthContent, fullRoundContent),
          };
          carriedLengthContent = "";
        }
        break;
      }

      if (fullRoundContent.trim()) {
        const trimmedNarration = fullRoundContent.trim();
        const narrationRound = round + 1;
        roundNarrations.push({ round: narrationRound, text: trimmedNarration });
        carriedToolRoundProse = carriedToolRoundProse
          ? `${carriedToolRoundProse}\n\n${trimmedNarration}`
          : trimmedNarration;
        await sendEvent({
          type: "round_narration",
          round: narrationRound,
          text: trimmedNarration,
          roundNarrations: [...roundNarrations],
        });
      }
      consecutiveMarkupFailures = 0;

      // PERF-P3: the cumulative `thought` event for this round was already
      // emitted at the round boundary above; delta-only per token.

      round++;
      lastRoundTools = toolCalls.map((tc) => tc.function?.name || "");
      const assistantMsgToPush = {
        ...currentAssistantMessage,
        tool_calls: toolCalls,
      };
      conversationMessages.push(assistantMsgToPush);
      markDirty();

      let searchBlocked = false;

      type ParsedToolCallEntry = {
        toolCall: LlmToolCall;
        toolName: string;
        toolArgs: Record<string, unknown>;
        malformedArgsError: string | null;
      };

      const parsedToolCalls: ParsedToolCallEntry[] = toolCalls.map((toolCall) => {
        const toolName = toolCall.function.name;
        let toolArgs: Record<string, unknown> = {};
        let malformedArgsError: string | null = null;
        if (typeof toolCall.function.arguments === "string") {
          try {
            toolArgs = toolCall.function.arguments.trim()
              ? JSON.parse(toolCall.function.arguments)
              : {};
          } catch (parseErr: unknown) {
            const parseMsg = parseErr instanceof Error ? parseErr.message : undefined;
            malformedArgsError = `Malformed JSON arguments for tool '${toolName}': ${parseMsg || "Invalid JSON"}`;
          }
        } else if (toolCall.function.arguments && typeof toolCall.function.arguments === "object") {
          toolArgs = { ...toolCall.function.arguments };
        }
        return { toolCall, toolName, toolArgs, malformedArgsError };
      });

      const bufferedRoundDirectives: string[] = [];
      const bufferRoundDirective = (directive: string): void => {
        if (directive && directive.trim()) {
          bufferedRoundDirectives.push(directive);
        }
      };

      const commitExecutedToolResult = async (params: {
        toolCallId?: string;
        toolName: string;
        toolArgs: Record<string, unknown>;
        target: { client: Client | null; tier: "sandbox" | "browser" | "workspace" | "host" };
        result: unknown;
        durationMs: number;
        timestamp: string;
        isExecutionError: boolean;
      }): Promise<void> => {
        const { toolCallId, toolName, toolArgs, target, durationMs, timestamp, isExecutionError } =
          params;
        let result = params.result;

        if (isExecutionError) {
          consecutiveFailures++;
        } else {
          consecutiveFailures = 0;
        }

        const traceItem: TraceItem = {
          tool: toolName,
          args: toolArgs,
          result,
          durationMs,
          timestamp,
          model: turnState.activeModel,
          tier: target.tier,
          round: currentRoundNumber,
          isError: isExecutionError,
        };
        if (
          toolName === "workspace_write_file" &&
          !isExecutionError &&
          toolArgs?.path &&
          typeof toolArgs.path === "string"
        ) {
          recordTurnOutputWrite(turnCreatedFiles, toolArgs.path, activeThreadId, threadsDir);
        }

        traces.push(traceItem);

        await sendEvent({
          type: "trace",
          trace: traceItem,
        });

        const isFileReadTool = toolName === "workspace_read_file" || toolName === "host_read_file";
        // TOKEN ECONOMICS (d): within-thread read dedup. A read whose
        // path + content hash matches an earlier read in this thread is
        // answered with a short stub referencing the earlier trace/round; a
        // changed file re-reads full and re-anchors the registry. Multi-read
        // results flow through per-file dedup individually so only unchanged
        // file sections are stubbed. The full result stays recoverable in the
        // trace record (audit copy pushed above), and every stub is logged on
        // the turn's readDedups field.
        // The pinned clamp-bypass expression below stays byte-identical
        // (chatFilePaging Pin 1 compliance); dedup swaps `result` itself.
        if (isFileReadTool && !isExecutionError) {
          if (isMultiReadResult(result)) {
            const multiDedup = readDedupRegistry.checkAndRecordMultiRead(
              toolName,
              result,
              round,
              traces.length - 1
            );
            if (multiDedup.dedupedMetas.length > 0) {
              result = multiDedup.result;
              for (const meta of multiDedup.dedupedMetas) {
                turnReadDedups.push({ ...meta, reReadRound: round });
              }
            }
          } else {
            const dedupDecision = readDedupRegistry.checkAndRecord(
              toolName,
              toolArgs,
              JSON.stringify(result),
              round,
              traces.length - 1
            );
            if (dedupDecision.deduplicated && dedupDecision.stub && dedupDecision.meta) {
              result = { status: "DEDUP_STUB", stub: dedupDecision.stub };
              turnReadDedups.push({ ...dedupDecision.meta, reReadRound: round });
            }
          }
        }
        conversationMessages.push({
          role: "tool",
          ...(toolCallId ? { tool_call_id: toolCallId } : {}),
          name: toolName,
          content: isFileReadTool
            ? JSON.stringify(result)
            : clampToolOutput(JSON.stringify(result)),
        });

        if (
          toolName === "workspace_write_file" &&
          !isExecutionError &&
          typeof toolArgs?.content === "string" &&
          /<svg[\s>][\s\S]*?<\/svg>/i.test(toolArgs.content)
        ) {
          bufferRoundDirective(
            "[DELIVERABLE SAVED]: You have already saved the complete SVG diagram via workspace_write_file, and the UI automatically renders it inline for the user. Now respond with a concise 2-3 sentence summary of the diagram's contents and do NOT call more tools or repeat the <svg> markup in your text response."
          );
        }

        if (isWebResearchTool(toolName, target.tier)) {
          if (webResearchCalls >= MAX_WEB_RESEARCH_CALLS && !webBudgetNoticeAdded) {
            webBudgetNoticeAdded = true;
            bufferRoundDirective(WEB_BUDGET_EXHAUSTED_DIRECTIVE);
          }
        }

        // Auto-Escalation Check: If 2 consecutive failures, ensure turnState.activeModel escalates to Primary model
        if (
          mode === "auto" &&
          consecutiveFailures >= 2 &&
          turnState.activeModel !== DEFAULT_PRIMARY_MODEL
        ) {
          console.log(
            "[Auto-Escalation] 2 consecutive failures detected. Escalating to Primary model..."
          );
          turnState.activeModel = DEFAULT_PRIMARY_MODEL;
          effectiveReasoningEffort = resolveEffectiveReasoningEffort(
            turnState.activeModel,
            requestedReasoning
          );
          await sendEvent({
            type: "status",
            status: "Auto-escalating to Pro Reasoning Model...",
          });
          await sendEvent({
            type: "meta",
            model: turnState.activeModel,
            reasoning_effort: effectiveReasoningEffort,
          });
          bufferRoundDirective(
            "[AUTO-ESCALATION]: Execution engine encountered 2 consecutive failures. Escalating session to Primary Reasoning Engine for deep architectural root-cause diagnosis and code synthesis."
          );
        }
      };

      const batches = partitionToolCallBatches(parsedToolCalls, (entry) => {
        if (entry.malformedArgsError) return false;
        if (!isReadOnlyFanoutTool(entry.toolName)) return false;
        // Unregistered/prohibited tools (e.g. host tools withheld in prohibited
        // contexts) must stay barriers so prohibition errors fire in exact order.
        if (entry.toolName !== DESCRIBE_TOOL_NAME && !toolClientMap.has(entry.toolName)) {
          return false;
        }
        return true;
      });

      // Board #129 P5-B: tool execution is not engine work. The single-slot
      // lease is released for the duration of the tool batches (30-60s host
      // installs/tests) so a queued turn can dispatch during the wait; the
      // lease re-acquires before the next LLM round.
      const executeToolBatches = async (): Promise<void> => {
        const emittedToolIndices = new Set<number>();
        try {
          for (const batch of batches) {
            if (turnAbortController.signal.aborted || searchBlocked) break;
            if (activeThreadId) {
              touchActiveTurn(activeThreadId, threadsDir);
            }

            if (batch.kind === "parallel") {
              if (batch.items.length === 1) {
                const only = batch.items[0].item;
                if (only.toolName !== DESCRIBE_TOOL_NAME) {
                  await sendEvent({
                    type: "status",
                    status: `Executing tool ${only.toolName}...`,
                  });
                }
              } else {
                await sendEvent({
                  type: "status",
                  status: `Executing ${batch.items.length} read-only tools in parallel...`,
                });
              }

              type ParallelOutcome =
                | {
                    kind: "skipped_abort";
                    toolCallId?: string;
                    toolName: string;
                  }
                | {
                    kind: "describe";
                    toolCallId?: string;
                    toolArgs: Record<string, unknown>;
                    toolDesc: ReturnType<typeof describeTool>;
                    timestamp: string;
                  }
                | {
                    kind: "executed";
                    toolCallId?: string;
                    toolName: string;
                    toolArgs: Record<string, unknown>;
                    target: {
                      client: Client | null;
                      tier: "sandbox" | "browser" | "workspace" | "host";
                    };
                    result: unknown;
                    durationMs: number;
                    timestamp: string;
                    isExecutionError: boolean;
                  };

              const outcomes = await executeWithConcurrencyLimit<
                { index: number; item: ParsedToolCallEntry },
                ParallelOutcome
              >(batch.items, TOOL_FANOUT_CAP, async ({ item: entry }) => {
                if (turnAbortController.signal.aborted) {
                  return {
                    kind: "skipped_abort",
                    toolCallId: entry.toolCall.id,
                    toolName: entry.toolName,
                  };
                }
                const { toolName, toolArgs } = entry;

                if (toolName === "workspace_read_file") {
                  if (
                    !toolArgs.path ||
                    typeof toolArgs.path !== "string" ||
                    !toolArgs.path.trim()
                  ) {
                    const candidate =
                      toolArgs.file ||
                      toolArgs.filepath ||
                      toolArgs.filename ||
                      toolArgs.target ||
                      Object.values(toolArgs).find((v) => typeof v === "string" && v.trim());
                    if (typeof candidate === "string" && candidate.trim()) {
                      toolArgs.path = candidate.trim();
                    }
                  }
                }

                if (toolName === DESCRIBE_TOOL_NAME) {
                  const targetTool = String(toolArgs.tool_name || toolArgs.name || "");
                  const toolDesc = describeTool(targetTool, toolRegistry);
                  return {
                    kind: "describe",
                    toolCallId: entry.toolCall.id,
                    toolArgs,
                    toolDesc,
                    timestamp: new Date().toISOString(),
                  };
                }

                const target = toolClientMap.get(toolName)!;
                const toolSpan = tracer.startSpan("mcp.tool_call", rootSpan?.spanId, {
                  tool: toolName,
                  tier: target.tier,
                });
                const startTime = performance.now();
                let result: unknown = null;

                if (target.tier === "host") {
                  try {
                    result = await executeHostTool(
                      toolName,
                      toolArgs,
                      undefined,
                      threadData?.gitCapability,
                      threadData?.mergeGrant,
                      {
                        heartbeatIntervalMs: turnHeartbeatMs,
                        onHeartbeat: (elapsedMs) => {
                          if (activeThreadId) {
                            touchActiveTurn(activeThreadId, threadsDir);
                          }
                          void sendEvent({
                            type: "status",
                            status: `Running ${toolName} (${Math.round(elapsedMs / 1000)}s)...`,
                          });
                        },
                      }
                    );
                  } catch (hostErr: unknown) {
                    const hostMsg = hostErr instanceof Error ? hostErr.message : undefined;
                    result = {
                      success: false,
                      error: hostMsg || "Host execution error",
                      isError: true,
                    };
                  }
                } else if (target.client) {
                  try {
                    result = await target.client.callTool({
                      name: toolName,
                      arguments: toolArgs,
                    });
                  } catch (mcpErr: unknown) {
                    const mcpMsg = mcpErr instanceof Error ? mcpErr.message : undefined;
                    result = {
                      success: false,
                      error: mcpMsg || "Tool execution error",
                      isError: true,
                    };
                  }
                }

                const durationMs = Math.round(performance.now() - startTime);
                const isExecutionError = classifyExecutionError(result);
                toolSpan.end(isExecutionError ? "error" : "ok", { durationMs });

                return {
                  kind: "executed",
                  toolCallId: entry.toolCall.id,
                  toolName,
                  toolArgs,
                  target,
                  result,
                  durationMs,
                  timestamp: new Date().toISOString(),
                  isExecutionError,
                };
              });

              // Commit parallel results strictly in EMISSION order regardless of completion order.
              for (let k = 0; k < outcomes.length; k++) {
                const outcome = outcomes[k];
                const batchItemIndex = batch.items[k].index;
                if (outcome.kind === "skipped_abort") {
                  conversationMessages.push({
                    role: "tool",
                    ...(outcome.toolCallId ? { tool_call_id: outcome.toolCallId } : {}),
                    name: outcome.toolName,
                    content: JSON.stringify({
                      status: "SKIPPED",
                      reason: "Skipped after turn aborted before tool execution",
                    }),
                  });
                  emittedToolIndices.add(batchItemIndex);
                  continue;
                }
                if (outcome.kind === "describe") {
                  conversationMessages.push({
                    role: "tool",
                    ...(outcome.toolCallId ? { tool_call_id: outcome.toolCallId } : {}),
                    name: DESCRIBE_TOOL_NAME,
                    content: JSON.stringify(outcome.toolDesc),
                  });
                  emittedToolIndices.add(batchItemIndex);
                  await sendEvent({
                    type: "trace",
                    trace: {
                      tool: DESCRIBE_TOOL_NAME,
                      args: outcome.toolArgs,
                      result: outcome.toolDesc,
                      durationMs: 1,
                      timestamp: outcome.timestamp,
                      model: turnState.activeModel,
                      tier: "workspace",
                    },
                  });
                  continue;
                }
                await commitExecutedToolResult(outcome);
                emittedToolIndices.add(batchItemIndex);
              }

              continue;
            }

            // BARRIER execution: runs alone in exact original order.
            const { toolCall, toolName, toolArgs, malformedArgsError } = batch.item;

            if (malformedArgsError) {
              const errPayload = JSON.stringify({ error: malformedArgsError });
              await sendEvent({
                type: "trace",
                trace: {
                  tool: toolName,
                  args: { raw: toolCall.function.arguments },
                  result: errPayload,
                  isError: true,
                },
              });
              conversationMessages.push({
                role: "tool",
                tool_call_id: toolCall.id || `${toolName}_err`,
                name: toolName,
                content: errPayload,
              });
              emittedToolIndices.add(batch.index);
              continue;
            }

            if (toolName === "search_web") {
              const candidate =
                toolArgs.query ||
                toolArgs.q ||
                toolArgs.search ||
                toolArgs.search_query ||
                toolArgs.input ||
                toolArgs.keyword ||
                toolArgs.text ||
                Object.values(toolArgs).find((v) => typeof v === "string" && v.trim());
              const queryAttempt = typeof candidate === "string" ? candidate.trim() : "";
              const evalResult = evaluateSearchQueryAttempt(queryAttempt, userPrompt, searchNudges);

              if (evalResult.action === "nudge") {
                searchNudges++;
                conversationMessages.push({
                  role: "tool",
                  ...(toolCall.id ? { tool_call_id: toolCall.id } : {}),
                  name: toolName,
                  content: JSON.stringify({
                    status: "RETRY_REQUIRED",
                    message: evalResult.message,
                  }),
                });
                emittedToolIndices.add(batch.index);
                bufferRoundDirective(`[QUERY REVISION REQUIRED]: ${evalResult.message}`);
                await sendEvent({
                  type: "status",
                  status: "Revising search query...",
                });
                continue;
              } else if (evalResult.action === "block") {
                if (evalResult.countAttempt) {
                  webResearchCalls++;
                }
                conversationMessages.push({
                  role: "tool",
                  ...(toolCall.id ? { tool_call_id: toolCall.id } : {}),
                  name: toolName,
                  content: JSON.stringify({
                    status: "BLOCKED",
                    error: evalResult.message,
                  }),
                });
                emittedToolIndices.add(batch.index);
                await sendEvent({
                  type: "status",
                  status: "Search query blocked",
                });
                searchBlocked = true;
                break;
              }

              // Valid query -> proceed with tool call
              toolArgs.query = queryAttempt;
            } else if (toolName === "fetch_webpage_markdown") {
              if (!toolArgs.url || typeof toolArgs.url !== "string" || !toolArgs.url.trim()) {
                const candidate =
                  toolArgs.link ||
                  toolArgs.href ||
                  toolArgs.target ||
                  toolArgs.uri ||
                  toolArgs.site ||
                  toolArgs.page ||
                  toolArgs.address ||
                  toolArgs.endpoint ||
                  Object.values(toolArgs).find((v) => typeof v === "string" && v.trim());
                if (typeof candidate === "string" && candidate.trim()) {
                  toolArgs.url = candidate.trim();
                } else {
                  for (let i = traces.length - 1; i >= 0; i--) {
                    const traceContent = JSON.stringify(traces[i].result || "");
                    const urlMatch = traceContent.match(/https?:\/\/[^\s)"]+/i);
                    if (urlMatch) {
                      toolArgs.url = urlMatch[0];
                      break;
                    }
                  }
                  if (!toolArgs.url) {
                    const promptUrlMatch = userPrompt.match(/https?:\/\/[^\s)"]+/i);
                    if (promptUrlMatch) {
                      toolArgs.url = promptUrlMatch[0];
                    }
                  }
                }
              }
              if (typeof toolArgs.url === "string" && toolArgs.url.trim()) {
                const trimmedUrl = toolArgs.url.trim();
                toolArgs.url = /^https?:\/\//i.test(trimmedUrl)
                  ? trimmedUrl
                  : `https://${trimmedUrl}`;
              }
            } else if (toolName === "workspace_run_command") {
              if (
                !toolArgs.command ||
                typeof toolArgs.command !== "string" ||
                !toolArgs.command.trim()
              ) {
                const candidate =
                  toolArgs.cmd ||
                  toolArgs.exec ||
                  toolArgs.script ||
                  toolArgs.code ||
                  Object.values(toolArgs).find((v) => typeof v === "string" && v.trim());
                if (typeof candidate === "string" && candidate.trim()) {
                  toolArgs.command = candidate.trim();
                }
              }
            } else if (toolName === "execute_sandboxed_python") {
              if (!toolArgs.code || typeof toolArgs.code !== "string" || !toolArgs.code.trim()) {
                const candidate =
                  toolArgs.python ||
                  toolArgs.script ||
                  toolArgs.command ||
                  Object.values(toolArgs).find((v) => typeof v === "string" && v.trim());
                if (typeof candidate === "string" && candidate.trim()) {
                  toolArgs.code = candidate.trim();
                }
              }
            }

            const target = toolClientMap.get(toolName);
            if (!target) {
              const isHostToolProbeUnavailable =
                !isProhibitedContext &&
                threadHostAccess &&
                (HOST_TOOL_NAMES.has(toolName) ||
                  (hostSettings.allowUnattendedHostGit &&
                    Boolean(threadGitCapability) &&
                    UNATTENDED_GIT_TOOL_NAMES.has(toolName)));
              if (isHostToolProbeUnavailable) {
                const errDetail = `Host tool '${toolName}' is temporarily unavailable (${hostStatus.reason || `host runner state: ${hostStatus.runnerState}`}). Retry later or proceed without it.`;
                console.warn(`[ChatRoute] ${errDetail}`);
                const errResult = {
                  ok: false,
                  success: false,
                  isError: true,
                  error: errDetail,
                };
                await commitExecutedToolResult({
                  toolCallId: toolCall.id,
                  toolName,
                  toolArgs,
                  target: { client: null, tier: "host" },
                  result: errResult,
                  durationMs: 1,
                  timestamp: new Date().toISOString(),
                  isExecutionError: true,
                });
                emittedToolIndices.add(batch.index);
                continue;
              }
              if (ADVERTISED_TOOLS.has(toolName)) {
                console.warn(
                  `[ChatRoute] Advertised tool \'${toolName}\' called but backend client is disconnected. Gracefully returning tool status.`
                );
                conversationMessages.push({
                  role: "tool",
                  ...(toolCall.id ? { tool_call_id: toolCall.id } : {}),
                  name: toolName,
                  content: `Tool \'${toolName}\' is temporarily unavailable (client disconnected or service unreachable). Please proceed without it or explain to the user.`,
                });
                emittedToolIndices.add(batch.index);
                await sendEvent({
                  type: "trace",
                  trace: {
                    tool: toolName,
                    args: toolArgs,
                    result: `Tool \'${toolName}\' temporarily unavailable`,
                    durationMs: 1,
                    timestamp: new Date().toISOString(),
                    model: turnState.activeModel,
                    tier: "browser",
                  },
                });
                continue;
              }
              throw new Error(`Model attempted execution of unregistered tool: ${toolName}`);
            }

            if (isWebResearchTool(toolName, target.tier)) {
              if (webResearchCalls >= MAX_WEB_RESEARCH_CALLS) {
                conversationMessages.push({
                  role: "tool",
                  ...(toolCall.id ? { tool_call_id: toolCall.id } : {}),
                  name: toolName,
                  content: WEB_BUDGET_EXHAUSTED_DIRECTIVE,
                });
                emittedToolIndices.add(batch.index);
                continue;
              }
              webResearchCalls++;
            }

            await sendEvent({
              type: "status",
              status: `Executing tool ${toolName}...`,
            });

            const toolSpan = tracer.startSpan("mcp.tool_call", rootSpan?.spanId, {
              tool: toolName,
              tier: target.tier,
            });

            let bashSpan: ReturnType<TelemetryTracer["startSpan"]> | null = null;
            if (toolName === "workspace_run_command" || toolName === "execute_sandboxed_python") {
              const codeStr = typeof toolArgs.code === "string" ? toolArgs.code : "";
              bashSpan = tracer.startSpan("sandbox.bash_exec", toolSpan.spanId, {
                command: toolArgs.command || (codeStr ? codeStr.slice(0, 100) : "python"),
              });
            }

            const startTime = performance.now();
            let result: unknown = null;

            if (
              (toolName === "workspace_write_file" || toolName === "workspace_patch_file") &&
              typeof toolArgs?.path === "string"
            ) {
              captureWorkspacePreImage(turnPreImages, toolArgs.path);
            }

            if (target.tier === "host") {
              const check = isDestructiveHostAction(toolName, toolArgs);
              if (check.isDestructive) {
                const approval = createPendingApproval(
                  activeThreadId || "general",
                  toolName,
                  toolArgs,
                  check.reason || "Destructive action requires approval"
                );
                notify("host.approval_pending", {
                  title: "Host approval needed",
                  body: "Tap to review in the sandbox chat.",
                }).catch(() => {});
                await sendEvent({
                  type: "approval_required",
                  approval: {
                    id: approval.id,
                    tool: toolName,
                    args: toolArgs,
                    riskReason: approval.riskReason,
                    createdAt: approval.createdAt,
                    expiresAt: approval.expiresAt,
                  },
                });
                result = {
                  approvalRequired: true,
                  approvalId: approval.id,
                  message: `[HOST SECURITY GATE]: ${approval.riskReason}. Awaiting user approval.`,
                };
              } else {
                try {
                  result = await executeHostTool(
                    toolName,
                    toolArgs,
                    undefined,
                    threadData?.gitCapability,
                    threadData?.mergeGrant,
                    {
                      heartbeatIntervalMs: turnHeartbeatMs,
                      onHeartbeat: (elapsedMs) => {
                        if (activeThreadId) {
                          touchActiveTurn(activeThreadId, threadsDir);
                        }
                        void sendEvent({
                          type: "status",
                          status: `Running ${toolName} (${Math.round(elapsedMs / 1000)}s)...`,
                        });
                      },
                    }
                  );
                  const hostDiff = generateHostFileDiff(toolName, toolArgs, result);
                  if (hostDiff) {
                    turnHostDiffs.push(hostDiff);
                  }
                } catch (hostErr: unknown) {
                  const hostMsg = hostErr instanceof Error ? hostErr.message : undefined;
                  result = {
                    success: false,
                    error: hostMsg || "Host execution error",
                    isError: true,
                  };
                }
              }
            } else if (target.client) {
              try {
                result = await target.client.callTool({
                  name: toolName,
                  arguments: toolArgs,
                });
              } catch (mcpErr: unknown) {
                const mcpMsg = mcpErr instanceof Error ? mcpErr.message : undefined;
                result = {
                  success: false,
                  error: mcpMsg || "Tool execution error",
                  isError: true,
                };
              }
            }
            const durationMs = Math.round(performance.now() - startTime);
            const isExecutionError = classifyExecutionError(result);

            if (bashSpan) {
              bashSpan.end(isExecutionError ? "error" : "ok", { durationMs, isExecutionError });
            }
            toolSpan.end(isExecutionError ? "error" : "ok", { durationMs });

            await commitExecutedToolResult({
              toolCallId: toolCall.id,
              toolName,
              toolArgs,
              target,
              result,
              durationMs,
              timestamp: new Date().toISOString(),
              isExecutionError,
            });
            emittedToolIndices.add(batch.index);
            if (activeThreadId) {
              touchActiveTurn(activeThreadId, threadsDir);
            }
          }
        } finally {
          // Ensure no assistant.tool_calls entry is left dangling if the batch exited early.
          for (let idx = 0; idx < parsedToolCalls.length; idx++) {
            if (emittedToolIndices.has(idx)) continue;
            const skippedEntry = parsedToolCalls[idx];
            conversationMessages.push({
              role: "tool",
              ...(skippedEntry.toolCall.id ? { tool_call_id: skippedEntry.toolCall.id } : {}),
              name: skippedEntry.toolName,
              content: JSON.stringify({
                status: "SKIPPED",
                reason: searchBlocked
                  ? "Skipped after web search blocked earlier in round"
                  : "Skipped after turn aborted before tool execution",
              }),
            });
            emittedToolIndices.add(idx);
          }
          // Flush mid-batch trailing directives strictly after all role: "tool" messages.
          for (const directive of bufferedRoundDirectives) {
            appendTrailingDirective(conversationMessages, directive);
          }
        }
      }; // end executeToolBatches

      // Board #129 P5-B + R5: on single-slot engines (LLM_CONCURRENCY === 1),
      // keep the lease held across short read-only parallel batches to preserve
      // KV cache residency; only release when a barrier/long wait is present or
      // when LLM_CONCURRENCY > 1.
      const hasBarrierBatch = batches.some((b) => b.kind === "barrier");
      const parsedConcurrency = process.env.LLM_CONCURRENCY
        ? parseInt(process.env.LLM_CONCURRENCY, 10)
        : 1;
      const llmConcurrency =
        Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 1;
      if (lease && (hasBarrierBatch || llmConcurrency > 1)) {
        await lease.releaseForWait(executeToolBatches);
      } else {
        await executeToolBatches();
      }

      // PERF-P1 / P-F1: persist round-boundary traces on the throttled 5s snapshot
      // cadence (fast <5s rounds coalesce until the interval elapses or settlement).
      const roundThought =
        accumulatedThoughts.length > 0 ? accumulatedThoughts.join("\n\n") : undefined;
      streamSnapshot.maybeWrite(
        "",
        roundThought,
        traces as unknown as Parameters<typeof streamSnapshot.maybeWrite>[2],
        {
          roundPromptTokens: [...roundPromptTokens],
          roundGenerationMs: [...roundGenerationMs],
          outputTokens:
            (turnState.cumulativeOutputTokens ?? 0) > 0
              ? turnState.cumulativeOutputTokens
              : undefined,
          thinkingSegments: thinkingSegments.length > 0 ? [...thinkingSegments] : undefined,
          roundNarrations: roundNarrations.length > 0 ? [...roundNarrations] : undefined,
        }
      );

      if (searchBlocked) {
        break;
      }

      if (
        !honestAbortInjected &&
        (isArtifactRequest || webResearchCalls >= MAX_WEB_RESEARCH_CALLS) &&
        shouldInjectHonestAbort({ userPrompt, priorUserPrompt, webResearchCalls, traces })
      ) {
        honestAbortInjected = true;
        appendRoundDirective(HONEST_ABORT_DIRECTIVE);
        await sendEvent({
          type: "trace",
          trace: {
            tool: "grounding_gate",
            args: { reason: "insufficient_live_web_results" },
            result: HONEST_ABORT_DIRECTIVE,
            durationMs: 0,
            timestamp: new Date().toISOString(),
            model: turnState.activeModel,
            tier: "ORCHESTRATOR",
          },
        });
      }

      const hasSubstantiveDeliverable =
        turnCreatedFiles.length > 0 ||
        turnHostDiffs.length > 0 ||
        turnPreImages.size > 0 ||
        traces.some(
          (t) => DELIVERABLE_WRITE_TOOLS.has(t.tool) && !classifyExecutionError(t.result)
        ) ||
        /<svg[\s>][\s\S]*?<\/svg>|<mxfile|<mxGraphModel/i.test(
          currentAssistantMessage.content || ""
        );
      if (
        isArtifactRequest &&
        traces.some((t) => isWebResearchTool(t.tool)) &&
        hasSubstantiveDeliverable
      ) {
        break;
      }
    }

    if (
      !honestAbortInjected &&
      shouldInjectHonestAbort({ userPrompt, priorUserPrompt, webResearchCalls, traces })
    ) {
      honestAbortInjected = true;
      appendTurnDirective(HONEST_ABORT_DIRECTIVE);
      await sendEvent({
        type: "trace",
        trace: {
          tool: "grounding_gate",
          args: { reason: "insufficient_live_web_results" },
          result: HONEST_ABORT_DIRECTIVE,
          durationMs: 0,
          timestamp: new Date().toISOString(),
          model: turnState.activeModel,
          tier: "ORCHESTRATOR",
        },
      });
    }

    // SYNTHESIS-RETRY: hoisted flag — true when BOTH synthesis passes returned no text.
    let synthesisReturnedEmpty = false;
    // Post-tool synthesis safety pass if lingering tool calls, missing artifact, empty text, or late steers:
    const lingeringToolCalls = getEffectiveToolCalls(currentAssistantMessage);
    const pendingLateSteers = activeThreadId ? threadStore.getPendingSteers(activeThreadId) : [];

    // Fix D2 (F8b): never start a synthesis round when measured input already
    // leaves no room for ROUND_MAX_TOKENS of output inside the context window.
    const synthWindowCeiling = computeEffectiveInputCeiling(
      resolveRoundModelOptions({
        model: turnState.activeModel,
        requestedEffort: effectiveReasoningEffort,
        userPrompt,
        isSynthesisOrFinalRound: true,
        hasCompletedToolCalls: traces.length > 0,
      }).num_ctx || DEFAULT_CONTEXT_WINDOW_TOKENS,
      ROUND_MAX_TOKENS
    );
    const synthToolSchemaTokens = roundToolSchemaTokens;
    const synthMeasuredInput = estimateEffectivePromptTokens(conversationMessages, {
      lastMeasuredPromptTokens,
      lastMeasuredEstimateTokens,
      precomputedToolSchemaTokens: synthToolSchemaTokens,
      precomputedRawMessageTokens: getTurnRawTokens(),
    });
    const hasOutputHeadroomForSynthesis = !(
      toolLoopStopReason === "budget" && synthMeasuredInput > synthWindowCeiling
    );

    // Invariant: If late steers arrived and we have context (e.g. tools were used or model produced content),
    // we MUST dispatch a model synthesis pass that incorporates the steer, OR if no request can run,
    // we do NOT consume them so they return honestly in pendingSteers.
    const shouldSynthesize =
      !turnAbortController.signal.aborted &&
      !honestEndMarker &&
      hasOutputHeadroomForSynthesis &&
      (pendingLateSteers.length > 0 ||
        shouldRunPostToolSynthesis({
          userPrompt,
          assistantContent: currentAssistantMessage.content || "",
          lingeringToolCallsCount: lingeringToolCalls.length,
          traces,
        }));

    if (shouldSynthesize) {
      // CHAT-STEER: only consume and persist steers now that a model request is GUARANTEED to be dispatched!
      if (activeThreadId) {
        const steers = threadStore.consumeSteers(activeThreadId);
        if (steers.length > 0) {
          for (const s of steers) {
            const steerContent = `[Steer from user, mid-turn] ${s}`;
            conversationMessages.push({
              role: "user",
              content: steerContent,
            });
            try {
              threadStore.addMessage(activeThreadId, {
                id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                role: "user",
                content: steerContent,
                timestamp: new Date().toISOString(),
              });
            } catch {}
          }
          markTurnRawTokensDirty();
          await sendEvent({ type: "steer", texts: steers });
        }
      }

      const synthSpan = tracer.startSpan("model.synthesis", rootSpan?.spanId, {
        model: turnState.activeModel,
      });
      conversationMessages.push({
        role: "assistant",
        content: currentAssistantMessage.content || "",
      });
      conversationMessages.push({
        role: "user",
        content: buildSynthesisDirective(userPrompt, false),
        isDirective: true,
      });
      markTurnRawTokensDirty();

      await sendEvent({
        type: "status",
        status: "Synthesizing final answer...",
      });

      if (isArtifactRequest) {
        appendTurnDirective(OUTPUT_HEADROOM_THINKING_DIRECTIVE);
      }

      const synthOptions = resolveRoundModelOptions({
        model: turnState.activeModel,
        requestedEffort: effectiveReasoningEffort,
        userPrompt,
        isSynthesisOrFinalRound: true,
        hasCompletedToolCalls: traces.length > 0,
      });
      const synthRawMessageTokens = getTurnRawTokens();

      // SYNTHESIS-RETRY: a single synthesis pass, streamed into the shared accumulators.
      const runSynthesisPass = async () => {
        dispatchedRounds++;
        const synthRoundNumber = dispatchedRounds;
        const synthStartMs = Date.now();
        let synthOutputTokens = 0;
        let synthPromptTokens: number | undefined = undefined;
        let synthFinishReason: string | undefined = undefined;
        turnState.inFlightThinking = "";
        turnState.inFlightThinkingRound = synthRoundNumber;
        try {
          const result = await executeSynthesisPass({
            llmBaseUrl: getLlmBaseUrl(),
            activeModel: turnState.activeModel,
            conversationMessages,
            tools: roundTools,
            precomputedRawMessageTokens: synthRawMessageTokens,
            precomputedToolSchemaTokens: roundToolSchemaTokens,
            isArtifactRequest,
            turnAbortSignal: turnAbortController.signal,
            synthOptions,
            accumulatedThoughts,
            getAccumulatedStreamedTokens: () => turnState.accumulatedStreamedTokens,
            setAccumulatedStreamedTokens: (next) => {
              turnState.accumulatedStreamedTokens = next;
            },
            onFinishReason: (reason) => {
              synthFinishReason = reason;
              turnState.lastFinishReason = reason;
            },
            onPromptTokens: (tokens) => {
              synthPromptTokens = tokens;
            },
            onOutputTokens: (tokens) => {
              if (tokens > synthOutputTokens) {
                turnState.cumulativeOutputTokens =
                  (turnState.cumulativeOutputTokens ?? 0) + (tokens - synthOutputTokens);
                synthOutputTokens = tokens;
                turnState.turnOutputTokens = turnState.cumulativeOutputTokens;
              }
            },
            onThinkingChunk: (thinkingSoFar) => {
              turnState.inFlightThinking = thinkingSoFar;
              turnState.inFlightThinkingRound = synthRoundNumber;
            },
            isSnapshotDue: () => streamSnapshot.isDue(),
            maybeWriteSnapshot: (content, thought) => {
              streamSnapshot.maybeWrite(content, thought, undefined, {
                outputTokens:
                  (turnState.cumulativeOutputTokens ?? 0) > 0
                    ? turnState.cumulativeOutputTokens
                    : undefined,
              });
            },
            sendEvent,
            streamChat: streamLlmChat,
          });
          if (result.thinking.trim()) {
            thinkingSegments.push({ round: synthRoundNumber, text: result.thinking.trim() });
            thinkingEndMs = Date.now();
          }
          return result;
        } finally {
          roundGenerationMs.push(Math.max(1, Date.now() - synthStartMs));
          if (synthPromptTokens !== undefined) {
            roundPromptTokens.push(synthPromptTokens);
          }
          roundFinishReasons.push(synthFinishReason || "stop");
        }
      };

      let synthResult = await runSynthesisPass();
      let synthesisPasses = 1;

      const initialMarkupEval = evaluateMarkupRound({
        roundContent: synthResult.content,
        executedToolCallsCount: 0,
        consecutiveMarkupFailures,
        roundFinishReason: turnState.lastFinishReason,
        roundThinking: synthResult.thinking,
      });
      const needsSynthRetry =
        (!synthResult.content.trim() || initialMarkupEval.action === "reprompt") &&
        !turnAbortController.signal.aborted &&
        !deps.isExplicitStopped();

      if (needsSynthRetry) {
        if (initialMarkupEval.action === "reprompt") {
          consecutiveMarkupFailures = initialMarkupEval.consecutiveMarkupFailures;
        }
        // SYNTHESIS-RETRY: an empty post-tool synthesis must never strand the turn.
        // Bank pass 1's thinking BEFORE the retry overwrites it so the thought
        // record never jumps backward.
        if (synthResult.thinking.trim()) {
          accumulatedThoughts.push(synthResult.thinking.trim());
        }
        turnState.inFlightThinking = "";
        turnState.inFlightThinkingRound = undefined;
        if (synthResult.content.trim()) {
          conversationMessages.push({
            role: "assistant",
            content: synthResult.content,
          });
        }
        appendTrailingDirective(
          conversationMessages,
          "[SYNTHESIS CORRECTION]: Your previous synthesis response produced no usable plain-prose answer (it was empty or emitted tool-call markup/calls). Do NOT call any tools or emit any tool-call XML/markup. Write a clear, plain-prose final answer summarizing the work and results above."
        );
        await sendEvent({
          type: "status",
          status: "Synthesis returned no text — retrying once...",
        });
        synthResult = await runSynthesisPass();
        synthesisPasses = 2;
      }

      if (synthResult.thinking.trim()) {
        accumulatedThoughts.push(synthResult.thinking.trim());
      }
      turnState.inFlightThinking = "";
      turnState.inFlightThinkingRound = undefined;

      const finalMarkupEval = evaluateMarkupRound({
        roundContent: synthResult.content,
        executedToolCallsCount: 0,
        consecutiveMarkupFailures,
        roundFinishReason: turnState.lastFinishReason,
        roundThinking: synthResult.thinking,
      });

      if (finalMarkupEval.action === "end_turn" || finalMarkupEval.action === "reprompt") {
        const marker =
          finalMarkupEval.marker || "⚠️ [Turn incomplete: Tool-call formatting failed.]";
        honestEndMarker = marker;
        turnState.accumulatedStreamedTokens += marker;
        streamSnapshot.maybeWrite(turnState.accumulatedStreamedTokens, undefined);
        await sendEvent({ type: "token", content: marker });
        currentAssistantMessage = { role: "assistant", content: marker };
        synthSpan.end("error", { synthesisPasses, markupFailure: true });
      } else if (synthResult.content.trim()) {
        currentAssistantMessage = { role: "assistant", content: synthResult.content };
        synthSpan.end("ok", { synthesisPasses });
      } else {
        synthesisReturnedEmpty = true;
        synthSpan.end("error", { synthesisPasses, emptySynthesis: true });
      }
    }

    // SYNTHESIS-RETRY: honest end-of-turn stamp for a failed synthesis (retry exhausted).
    const EMPTY_SYNTHESIS_STAMP = `⚠️ [Turn incomplete: Tool execution concluded without synthesis text. Traces captured above.] Work persisted above; the summary failed. The thread is resumable — resume this thread to continue.`;
    // U1: Intermediate tool-round commentary is persisted separately in `roundNarrations`
    // (attached to each round in the timeline), keeping `currentAssistantMessage.content`
    // strictly for the model's closing summary words.
    // Clean residual tool tags (also used for the per-segment TURN SIZE LIMIT check below).
    const finalSegmentContent = cleanResidualToolTags(currentAssistantMessage.content || "");
    let cleanedContent = finalSegmentContent;
    let turnStatus: "completed" | "incomplete" | undefined = undefined;

    // CHAT-7 honest pause markers keyed on the loop's stop reason.
    const loopPaused =
      toolLoopStopReason === "budget" ||
      toolLoopStopReason === "backstop" ||
      toolLoopStopReason === "web-research-cap";
    const pauseNote =
      toolLoopStopReason === "budget"
        ? `⚠️ [Turn paused: Context budget exhausted (${budgetExhaustedAtTokens} tokens > ${CHAT_CONTEXT_BUDGET_TOKENS} budget) after ${round} tool rounds.]`
        : toolLoopStopReason === "web-research-cap"
          ? `⚠️ [Turn paused: Tool execution limit reached (${webResearchCalls} web research calls / ${round} rounds).]`
          : toolLoopStopReason === "backstop"
            ? `⚠️ [Turn paused: Tool execution limit reached (${effectiveRoundBackstop} rounds).]`
            : "";

    if (!cleanedContent) {
      turnStatus = "incomplete";
      if (loopPaused) {
        cleanedContent = `${pauseNote} Traces captured above; synthesis returned no text.`;
      } else if (traces.length > 0) {
        cleanedContent = EMPTY_SYNTHESIS_STAMP;
      } else if (currentAssistantMessage.content?.trim()) {
        cleanedContent = currentAssistantMessage.content.trim();
        turnStatus = undefined;
      } else {
        cleanedContent = "I am ready to assist you. What would you like to build or explore?";
        turnStatus = undefined;
      }
    } else if (loopPaused) {
      turnStatus = "incomplete";
      cleanedContent = `${cleanedContent}\n\n${pauseNote}`;
    }

    // SYNTHESIS-RETRY: if BOTH synthesis passes returned no text, the turn ends honestly —
    // whatever landed above is persisted, status is incomplete, and the stamp says the
    // summary failed and the thread is resumable (never a silent "completed").
    if (synthesisReturnedEmpty) {
      turnStatus = "incomplete";
      if (!cleanedContent.includes(EMPTY_SYNTHESIS_STAMP)) {
        cleanedContent = cleanedContent.trim()
          ? `${cleanedContent}\n\n${EMPTY_SYNTHESIS_STAMP}`
          : EMPTY_SYNTHESIS_STAMP;
      }
    }

    // ROUND-DEADLINES honest end: the marker that ended the turn must be in
    // the persisted content (it was streamed live), and the turn is stamped
    // incomplete — never a silent "completed".
    if (honestEndMarker) {
      turnStatus = "incomplete";
      if (!cleanedContent.includes(honestEndMarker)) {
        cleanedContent = cleanedContent.trim()
          ? `${cleanedContent}\n\n${honestEndMarker}`
          : honestEndMarker;
      }
    }
    // Gather turn attachments using exact write tracking
    const turnAttachments = collectTurnAttachments(activeThreadId, threadsDir, turnCreatedFiles);
    const turnWorkspaceDiffs = collectTurnModifiedFileDiffs(turnPreImages);
    const turnDiffs = coalesceTurnDiffs([...turnHostDiffs, ...turnWorkspaceDiffs]);

    rootSpan?.end("ok", {
      tracesCount: traces.length,
      modelUsed: turnState.activeModel,
    });

    if (deps.isExplicitStopped() || turnAbortController.signal.aborted) {
      if (activeThreadId && !turnState.assistantPersisted) {
        persistAssistantOnAbort();
      }
      return;
    }

    if (
      turnState.lastFinishReason === "length" ||
      turnState.lastFinishReason === "error" ||
      turnState.lastFinishReason === "abort"
    ) {
      turnStatus = "incomplete";
      const truncationNotice = `⚠️ [Turn incomplete: Generation truncated (${turnState.lastFinishReason}).]`;
      if (!cleanedContent.includes("⚠️ [Turn incomplete:")) {
        cleanedContent = cleanedContent.trim()
          ? `${cleanedContent}\n\n${truncationNotice}`
          : truncationNotice;
      }
    }

    // TURN SIZE LIMIT: per-segment guard on final persisted output. A single
    // runaway generation exceeding MAX_STREAMED_CONTENT_CHARS is clamped and
    // stamped honestly; healthy multi-round turns whose combined narration
    // exceeds 64K across separate rounds are NOT truncated.
    if (finalSegmentContent.length > MAX_STREAMED_CONTENT_CHARS) {
      turnStatus = "incomplete";
      let cut = cleanedContent.slice(0, MAX_STREAMED_CONTENT_CHARS);
      const lastNewline = cut.lastIndexOf("\n");
      if (lastNewline > MAX_STREAMED_CONTENT_CHARS / 2) {
        cut = cut.slice(0, lastNewline);
      }
      cleanedContent = `${cut}\n\n${TURN_SIZE_LIMIT_MARKER}`;
    }

    const finalOutputTokens =
      (turnState.cumulativeOutputTokens ?? 0) > 0
        ? turnState.cumulativeOutputTokens!
        : (turnState.turnOutputTokens ?? (cleanedContent ? estimateTokens(cleanedContent) : 0));
    const turnDurationMs = Math.max(1, Date.now() - turnStartMs);
    // TOKEN ECONOMICS (a): per-round prompt-token integral + per-job rollup.
    const finalPromptTokens = sumRoundPromptTokens(roundPromptTokens);

    const zeroTraceResult = evaluateZeroTraceTripwire({
      content: cleanedContent,
      tracesCount: traces.length,
    });

    const isJobThread = Boolean(threadData?.taskId);
    const evidenceResult =
      isJobThread && cleanedContent
        ? await verifyEvidenceLinkedSummary(
            cleanedContent,
            buildVerificationAdapters(process.cwd()),
            { isJobSummary: true }
          )
        : { flagged: false, completionStamp: undefined, gaps: [] };

    const finalCompletionStamp =
      zeroTraceResult.completionStamp === "completed-unverified"
        ? "completed-unverified"
        : (evidenceResult.completionStamp ?? zeroTraceResult.completionStamp);
    const finalVerificationGaps = [...zeroTraceResult.gaps, ...evidenceResult.gaps];

    if (activeThreadId && !turnState.assistantPersisted) {
      const assistantMsgToSave = {
        id: assistantMessageId,
        role: "assistant" as const,
        content: cleanedContent,
        thought: accumulatedThoughts.length > 0 ? accumulatedThoughts.join("\n\n") : undefined,
        traces:
          traces.length > 0
            ? (traces as unknown as Parameters<ThreadStore["addMessage"]>[1]["traces"])
            : undefined,
        completionStamp: finalCompletionStamp,
        verificationGaps: finalVerificationGaps.length > 0 ? finalVerificationGaps : undefined,
        attachments: turnAttachments.length > 0 ? turnAttachments : undefined,
        diffs: turnDiffs.length > 0 ? turnDiffs : undefined,
        modelUsed: turnState.activeModel,
        selectedModel: requestedModel || turnState.activeModel,
        timestamp: new Date().toISOString(),
        compactedThisTurn: turnCompacted || undefined,
        tokensBeforeCompaction: turnCompacted ? turnTokensBefore : undefined,
        tokensAfterCompaction: turnCompacted ? turnTokensAfter : undefined,
        compactionActions: turnCompacted ? turnCompactionActions : undefined,
        status: turnStatus || ("completed" as const),
        turnStartMs,
        durationMs: turnDurationMs,
        thinkingDurationMs:
          thinkingEndMs !== null ? Math.max(0, thinkingEndMs - turnStartMs) : undefined,
        phaseTimings: {
          contextPrepMs:
            firstLlmRequestMs !== null ? Math.max(0, firstLlmRequestMs - turnStartMs) : undefined,
          thinkingMs: thinkingMsAcc > 0 ? thinkingMsAcc : undefined,
          toolsMs:
            traces.reduce(
              (sum, tr) => sum + (typeof tr.durationMs === "number" ? tr.durationMs : 0),
              0
            ) || undefined,
          writingMs: writingMsAcc > 0 ? writingMsAcc : undefined,
        },
        finish_reason: turnState.lastFinishReason || "stop",
        roundFinishReasons: roundFinishReasons.length > 0 ? roundFinishReasons : undefined,
        outputTokens: finalOutputTokens,
        roundPromptTokens: roundPromptTokens,
        roundGenerationMs: roundGenerationMs.length > 0 ? roundGenerationMs : undefined,
        thinkingSegments: thinkingSegments.length > 0 ? thinkingSegments : undefined,
        roundNarrations: roundNarrations.length > 0 ? roundNarrations : undefined,
        // TOKEN ECONOMICS (c): micro-elision audit rides on the final record.
        microElisions: turnMicroElisions.length > 0 ? turnMicroElisions : undefined,
        // TOKEN ECONOMICS (d): read-dedup audit rides on the final record.
        readDedups: turnReadDedups.length > 0 ? turnReadDedups : undefined,
        tokenEconomics: buildJobTokenRollup({
          rounds: dispatchedRounds,
          promptTokens: finalPromptTokens,
          outputTokens: finalOutputTokens,
          compactions: turnCompactionCount,
        }),
      };
      threadStore.addMessage(activeThreadId, assistantMsgToSave);
      turnState.assistantPersisted = true;
      if (sseWriter.isClientDisconnected() || deps.reqSignal.aborted) {
        console.log(
          `[ChatRoute] Detached turn completed server-side for thread ${activeThreadId} (status: ${turnStatus || "completed"}).`
        );
      }
    }

    // CHAT-STEER: unconsumed steers returning in done payload
    const unconsumedSteers = activeThreadId ? threadStore.consumeSteers(activeThreadId) : [];

    await sendEvent({
      type: "done",
      status: turnStatus,
      roundPromptTokens,
      roundGenerationMs: roundGenerationMs.length > 0 ? roundGenerationMs : undefined,
      outputTokens: finalOutputTokens,
      isIncomplete: turnStatus === "incomplete" ? true : undefined,
      attachments: turnAttachments.length > 0 ? turnAttachments : undefined,
      diffs: turnDiffs.length > 0 ? turnDiffs : undefined,
      content: cleanedContent,
      thought: accumulatedThoughts.length > 0 ? accumulatedThoughts.join("\n\n") : undefined,
      thinkingSegments: thinkingSegments.length > 0 ? thinkingSegments : undefined,
      roundNarrations: roundNarrations.length > 0 ? roundNarrations : undefined,
      turnStartMs,
      durationMs: turnDurationMs,
      thinkingDurationMs:
        thinkingEndMs !== null ? Math.max(0, thinkingEndMs - turnStartMs) : undefined,
      phaseTimings: {
        contextPrepMs:
          firstLlmRequestMs !== null ? Math.max(0, firstLlmRequestMs - turnStartMs) : undefined,
        thinkingMs: thinkingMsAcc > 0 ? thinkingMsAcc : undefined,
        toolsMs:
          traces.reduce(
            (sum, tr) => sum + (typeof tr.durationMs === "number" ? tr.durationMs : 0),
            0
          ) || undefined,
        writingMs: writingMsAcc > 0 ? writingMsAcc : undefined,
      },
      traces,
      model: turnState.activeModel,
      mode,
      reasoning_effort: effectiveReasoningEffort,
      triage: triageComplexityResult,
      compactedThisTurn: turnCompacted || undefined,
      tokensBeforeCompaction: turnCompacted ? turnTokensBefore : undefined,
      tokensAfterCompaction: turnCompacted ? turnTokensAfter : undefined,
      compactionActions: turnCompacted ? turnCompactionActions : undefined,
      pendingSteers: unconsumedSteers.length > 0 ? unconsumedSteers : undefined,
      trace_session: {
        sessionId: tracer.getSessionId(),
        traceId: tracer.getTraceId(),
      },
    });
  } catch (err: unknown) {
    const errObj = err as { message?: string; statusCode?: number };
    const errMsg = String(errObj?.message || "");
    if (rootSpan) {
      try {
        rootSpan.end("error", { error: errMsg });
      } catch {}
    }
    console.error("[Agent Orchestrator Streaming Error]:", err);
    const isEngineStopped =
      errMsg.includes("engine_stopped") ||
      errMsg.includes("LLM engine is stopped") ||
      errMsg.includes("ECONNREFUSED") ||
      errObj?.statusCode === 503;

    const friendlyMessage = isEngineStopped
      ? "LLM engine is stopped. Start it from Settings or the status bar."
      : errMsg || "Internal orchestrator error";

    if (deps.isExplicitStopped() || turnAbortController.signal.aborted) {
      if (activeThreadId && !turnState.assistantPersisted) {
        persistAssistantOnAbort();
      }
      return;
    }

    if (activeThreadId && !turnState.assistantPersisted) {
      turnState.assistantPersisted = true;
      try {
        const turnAttachments = collectTurnAttachments(
          activeThreadId,
          threadsDir,
          turnCreatedFiles
        );
        const turnWorkspaceDiffs = collectTurnModifiedFileDiffs(turnPreImages);
        const turnDiffs = coalesceTurnDiffs([...turnHostDiffs, ...turnWorkspaceDiffs]);

        const errorContent = turnState.accumulatedStreamedTokens.trim()
          ? `${turnState.accumulatedStreamedTokens}\n\n⚠️ [Turn error: ${friendlyMessage}]`
          : `⚠️ [Turn error: ${friendlyMessage}]`;

        const errorThoughts = turnState.inFlightThinking?.trim()
          ? [...accumulatedThoughts, turnState.inFlightThinking.trim()]
          : accumulatedThoughts;
        const errorMsg = {
          id: assistantMessageId,
          role: "assistant" as const,
          content: errorContent,
          thought: errorThoughts.length > 0 ? errorThoughts.join("\n\n") : undefined,
          traces:
            traces.length > 0
              ? (traces as unknown as Parameters<ThreadStore["addMessage"]>[1]["traces"])
              : undefined,
          attachments: turnAttachments.length > 0 ? turnAttachments : undefined,
          diffs: turnDiffs.length > 0 ? turnDiffs : undefined,
          modelUsed: turnState.activeModel,
          selectedModel: requestedModel || turnState.activeModel,
          timestamp: new Date().toISOString(),
          status: "error" as const,
        };
        threadStore.addMessage(activeThreadId, errorMsg);
      } catch (errSave) {
        console.warn("[ChatRoute] Failed to persist error assistant message in catch:", errSave);
      }
    }

    await sendEvent({
      type: "error",
      error: friendlyMessage,
    });
  } finally {
    if (inTurnHeartbeatTimer !== null) {
      clearInterval(inTurnHeartbeatTimer);
      inTurnHeartbeatTimer = null;
    }
    deps.onRunTurnFinally();
    sseWriter.stopHeartbeat();
    if (activeThreadId) {
      activeExecutionSet.delete(activeThreadId);
      clearTurnActive(activeThreadId);
      clearTurnAbortController(activeThreadId);
      clearRoundAbortController(activeThreadId);
      threadStore.clearSteers(activeThreadId);
    }
    deps.reqSignal.removeEventListener("abort", cleanupClientSignal);

    if (activeThreadId && !turnState.assistantPersisted && deps.isExplicitStopped()) {
      persistAssistantOnAbort();
    }
    if (!turnState.assistantPersisted) {
      turnState.assistantPersisted = true;
    }
    if (!turnAbortController.signal.aborted) {
      turnAbortController.abort();
    }
    for (const session of activeSessions) {
      try {
        await session.client.close();
      } catch {}
      try {
        await session.transport.close();
      } catch {}
    }
    // job-queue-isolation: drain the readable before close so a client that
    // abandoned the stream (no deps.reqSignal abort) cannot leave writer.close()
    // blocked on unread chunks — which would stall the serialized job queue.
    await sseWriter.closeWriterWithTimeout(1000);
  }
}
