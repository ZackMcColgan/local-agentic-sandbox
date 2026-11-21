import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  handleLiveTurnChunkBudget,
  resolveThreadChunkBudget,
  resolveChunkHandoffTarget,
} from "@/lib/jobChunking";
import {
  resolveThreadsDir,
  ThreadStore,
  deriveStoredThreadTitle,
  activeExecutionSet,
  markTurnActive,
  clearTurnActive,
  registerTurnAbortController,
  clearTurnAbortController,
  registerRoundAbortController,
  clearRoundAbortController,
  touchActiveTurn,
} from "@/lib/threads/threadStore";
import { ThrottledStreamSnapshot } from "@/lib/streamSnapshot";
import { appendNarrationChunk } from "@/lib/liveActivity";
import {
  buildFileDeliverablesDirective,
  recordTurnOutputWrite,
  collectTurnAttachments,
} from "@/lib/threadOutputs";
import {
  captureWorkspacePreImage,
  collectTurnModifiedFileDiffs,
  TurnFileDiff,
} from "@/lib/chatDiffs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_SUBAGENT_MODEL,
  AgentMode,
  AGENT_MODES,
  isReasoningEffortSupported,
  getModelProfile,
} from "@/config/models";
import { parseAttachment } from "@/lib/fileParser";
import { TelemetryTracer } from "@/lib/telemetry";
import { parseToolCallsFromText, cleanResidualToolTags, normalizeMcpUrl } from "@/lib/toolParser";
import {
  computeModelOptions,
  resolveEffectiveReasoningEffort,
  shouldConsultLocalOracle,
  parseThinkingAndContent,
  joinNarrationChunks,
} from "@/lib/chatUtils";
import {
  fitContextWindow,
  clampToolOutput,
  FINAL_ROUND_SYNTHESIS_DIRECTIVE,
  MAX_WEB_RESEARCH_CALLS,
  WEB_BUDGET_EXHAUSTED_DIRECTIVE,
  isWebResearchTool,
  filterToolsForWebBudget,
  buildSynthesisDirective,
  shouldRunPostToolSynthesis,
  mergeSystemDirective,
  hasArtifactCreationIntent,
  resolveRoundModelOptions,
  OUTPUT_HEADROOM_THINKING_DIRECTIVE,
  isLiveRealTimeIntent,
  canContinueToolLoop,
  TOOL_ROUND_BACKSTOP,
  estimateTokens,
  CHAT_CONTEXT_BUDGET_TOKENS,
  fitConversationToBudget,
  HIGH_WATER_BANKING_DIRECTIVE,
  resolveRoundDeadlineMs,
  TURN_TIMEOUT_MARKER,
  TURN_SIZE_LIMIT_MARKER,
  TURN_TRUNCATION_MARKER,
  LENGTH_CONTINUATION_DIRECTIVE,
  ROUND_TIMEOUT_DIRECTIVE,
  MAX_STREAMED_CONTENT_CHARS,
} from "@/lib/contextBudget";
import type { ToolLoopStopReason } from "@/lib/contextBudget";
import { buildJobTokenRollup, sumRoundPromptTokens } from "@/lib/tokenEconomics";
import { applyMicroElision, type ElisionMeta } from "@/lib/microElision";
import { evaluateMarkupRound, evaluateZeroTraceTripwire } from "@/lib/toolCallIntegrity";
import { verifyEvidenceLinkedSummary } from "@/lib/evidenceLinkedSummaries";
import { buildVerificationAdapters } from "@/lib/subagents/supervisor";
import { ReadDedupRegistry, type ReadDedupMeta } from "@/lib/readDedup";
import { searchOracleCodebase } from "@/lib/oracle/ingestion";
import {
  DESCRIBE_TOOL_NAME,
  buildLayer1Tools,
  buildToolRegistry,
  describeTool,
} from "@/lib/progressiveTools";
import {
  compactConversationHistory,
  resolveCompactionStrategy,
} from "@/lib/conversationCompaction";
import {
  HOST_TOOLS_DEFINITIONS,
  UNATTENDED_GIT_TOOLS_DEFINITIONS,
  executeHostTool,
  isDestructiveHostAction,
  createPendingApproval,
  consumeContinuationEntry,
  checkHostRunnerHealth,
  determineHostRunnerState,
  shouldAdvertiseHostTools,
  shouldAdvertiseUnattendedGitTools,
  getHostStateDirective,
  generateHostFileDiff,
} from "@/lib/hostMode";
import { JobQueue } from "@/lib/jobQueue";
import { serializeTurn } from "@/lib/chatTurnGate";
import { getSharedSlotScheduler, SlotPriority } from "@/lib/slotScheduler";
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
import { getLLMProvider } from "@/lib/llm/provider";
import {
  evaluateSearchQueryAttempt,
  shouldInjectHonestAbort,
  HONEST_ABORT_DIRECTIVE,
} from "@/lib/grounding";

import { formatSseWriterError } from "@/lib/turnReconciliation";

const getLlmBaseUrl = () =>
  process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const getMcpUrl = () => process.env.MCP_SERVER_URL || "http://mcp-server:8080/sse";
const getBrowserMcpUrl = () => process.env.BROWSER_MCP_URL || "http://browser-mcp:8081/sse";

// job-queue-isolation: single in-app slot — chat job turns execute one at a
// time (FIFO); additional turns queue visibly instead of contending for the
// engine slot. Module-level singleton: one queue per web-ui process.
const chatJobQueue = new JobQueue();
let chatTurnWorktreeSeq = 0;

// job-queue-isolation: host checkout root for per-job worktrees. Same
// convention as the self-deploy pipeline (web-ui may run with cwd at web-ui
// or repo root); HOST_REPO_ROOT overrides explicitly.
const resolveJobRepoRoot = () =>
  process.env.HOST_REPO_ROOT ||
  path.resolve(process.cwd(), fs.existsSync(path.join(process.cwd(), "web-ui")) ? "." : "..");
const DEFAULT_MODEL = process.env.MODEL_NAME || DEFAULT_PRIMARY_MODEL;
const ADVERTISED_TOOLS = new Set([
  "search_web",
  "fetch_webpage_markdown",
  "workspace_get_tree",
  "workspace_grep",
  "workspace_read_file",
  "workspace_write_file",
  "workspace_patch_file",
  "workspace_run_command",
  "git_status",
  "git_diff",
  "git_checkout_branch",
  "git_commit",
  "execute_sandboxed_python",
  "verify_container_provenance",
  "docker_scout_policy_gate",
]);

interface TraceItem {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  timestamp: string;
  model: string;
  tier?: "sandbox" | "browser" | "workspace" | "host";
}

interface LlmToolCall {
  id?: string;
  type?: string;
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

interface ChatInputMessage {
  id?: string;
  role: string;
  content: string;
  timestamp?: string;
  tool_calls?: LlmToolCall[];
  [key: string]: unknown;
}

async function connectMcpClient(url: string, name: string) {
  const sseUrl = normalizeMcpUrl(url);
  let transport: SSEClientTransport | null = null;
  let client: Client | null = null;
  try {
    transport = new SSEClientTransport(new URL(sseUrl));
    client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const toolsResult = await client.listTools();
    console.log(
      `[Orchestrator] Connected to MCP (${name}) at ${sseUrl} with ${toolsResult.tools.length} tools`
    );
    return { client, transport, tools: toolsResult.tools };
  } catch (err: unknown) {
    console.warn(
      `[Orchestrator] Could not connect to MCP at ${sseUrl}:`,
      err instanceof Error ? err.message : String(err)
    );
    if (client) {
      try {
        await client.close();
      } catch {}
    }
    if (transport) {
      try {
        await transport.close();
      } catch {}
    }
    return null;
  }
}

/**
 * Lean hierarchical triage classifier using fast subagent model (~80 tok/s).
 * Classifies incoming prompt into SIMPLE_EXECUTION vs DEEP_SYNTHESIS in < 300ms.
 */
async function triageComplexity(
  userQuery: string,
  llmBaseUrl: string,
  triageModel: string = DEFAULT_SUBAGENT_MODEL
): Promise<"SIMPLE_EXECUTION" | "DEEP_SYNTHESIS"> {
  try {
    const data = await getLLMProvider().chat(llmBaseUrl, {
      model: triageModel,
      messages: [
        {
          role: "system",
          content: `Classify this user request into COMPLEXITY: 'SIMPLE_EXECUTION' or 'DEEP_SYNTHESIS'.
SIMPLE_EXECUTION: file navigation, git branch operations, running tests/commands, inspecting logs, small bug fixes, direct tool calls.
DEEP_SYNTHESIS: novel system architecture, complex algorithm design, full module refactoring, difficult multi-step planning.
Output JSON strictly: {"complexity": "SIMPLE_EXECUTION" | "DEEP_SYNTHESIS", "reasoning": "brief explanation"}`,
        },
        {
          role: "user",
          content: userQuery,
        },
      ],
      format: "json",
      keep_alive: "24h",
      options: {
        temperature: 0.1,
        num_ctx: 2048,
        num_predict: 128,
      },
    });

    const rawContent = (data.message?.content || "{}")
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(rawContent || "{}");
    if (parsed.complexity === "DEEP_SYNTHESIS") {
      return "DEEP_SYNTHESIS";
    }
    return "SIMPLE_EXECUTION";
  } catch (err) {
    console.warn("[Triage] Error classifying complexity, defaulting to SIMPLE_EXECUTION:", err);
    return "SIMPLE_EXECUTION";
  }
}

/**
 * Unified streaming generator delegating to the resolved LLMProvider (Ollama or llama.cpp)
 */
async function* streamLlmChat(
  llmBaseUrl: string,
  payload: Parameters<ReturnType<typeof getLLMProvider>["streamChat"]>[1]
) {
  const provider = getLLMProvider();
  yield* provider.streamChat(llmBaseUrl, payload);
}

// Backward-compat alias
const streamOllamaChat = streamLlmChat;

export async function POST(req: NextRequest) {
  const activeSessions: Array<{ client: Client; transport: SSEClientTransport }> = [];
  const toolClientMap = new Map<
    string,
    { client: Client | null; tier: "sandbox" | "browser" | "workspace" | "host" }
  >();
  let rootSpan: ReturnType<TelemetryTracer["startSpan"]> | null = null;

  try {
    const {
      messages,
      threadId: requestedThreadId,
      model: requestedModel,
      mode: requestedMode,
      reasoning_effort: requestedReasoning,
      attachments,
      approvalContinuationId,
      userMessageId: requestedUserMessageId,
      assistantMessageId: requestedAssistantMessageId,
    } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Invalid messages payload" }, { status: 400 });
    }

    const typedMessages = messages as ChatInputMessage[];
    const lastUserMsg = [...typedMessages].reverse().find((m) => m.role === "user");
    const userPrompt = lastUserMsg?.content || "";
    const priorUserMsg = [...typedMessages].reverse().filter((m) => m.role === "user")[1];
    const priorUserPrompt: string =
      typeof priorUserMsg?.content === "string" ? priorUserMsg.content : "";

    const userMessageId = requestedUserMessageId || lastUserMsg?.id || `msg-${Date.now()}-u`;
    const assistantMessageId = requestedAssistantMessageId || `msg-${Date.now()}-a`;

    const mode: AgentMode = requestedMode || "auto";

    // Initialize OpenTelemetry Distributed Tracer
    const clientSessionId = req.headers.get("x-session-id") || `turn_${Date.now()}`;
    const tracer = new TelemetryTracer(clientSessionId);
    rootSpan = tracer.startSpan("agent.turn", undefined, {
      mode,
      requestedModel: requestedModel || "auto",
      messagesCount: messages.length,
    });

    // 1. Resolve Active Model via Tri-Mode Dispatcher
    let activeModel = requestedModel;
    const triageComplexityResult: "SIMPLE_EXECUTION" | "DEEP_SYNTHESIS" | null = null;
    let invalidRequestedModel: string | null = null;

    if (
      !activeModel ||
      activeModel === "auto" ||
      activeModel === "Swift-1.5-Qwen3.8-27B-IQ3_XS" ||
      activeModel === "swift-15-27b-mtp"
    ) {
      // Zero VRAM eviction: auto, flash, and pro modes route directly to configured DEFAULT_MODEL
      activeModel = DEFAULT_MODEL;
    } else if (
      activeModel !== DEFAULT_MODEL &&
      activeModel !== DEFAULT_PRIMARY_MODEL &&
      activeModel !== DEFAULT_SUBAGENT_MODEL &&
      !getModelProfile(activeModel)
    ) {
      invalidRequestedModel = activeModel;
    }

    // Resolve honest effective reasoning effort
    let effectiveReasoningEffort = resolveEffectiveReasoningEffort(activeModel, requestedReasoning);

    const activeThreadId =
      typeof requestedThreadId === "string" && requestedThreadId.trim()
        ? requestedThreadId.trim()
        : null;
    const threadsDir = resolveThreadsDir();
    const threadStore = new ThreadStore(threadsDir);
    let threadData:
      | (NonNullable<Awaited<ReturnType<ThreadStore["getThread"]>>> & {
          gitCapability?: Parameters<typeof shouldAdvertiseUnattendedGitTools>[1];
          mergeGrant?: Parameters<typeof executeHostTool>[4];
        })
      | null = null;
    const hostSettings = getHostSettings();
    let threadHostAccess = hostSettings.hostAccessEnabled;

    if (activeThreadId) {
      try {
        threadData = await threadStore.getThread(activeThreadId);
        if (!threadData) {
          threadData = threadStore.createThread({
            id: activeThreadId,
            title: deriveStoredThreadTitle(userPrompt),
            hostAccess: threadHostAccess,
          });
        }
        if (typeof threadData?.hostAccess === "boolean") {
          threadHostAccess = threadData.hostAccess;
        }

        // Turn Start (PIN 2 User Message): save user message immediately to threadStore
        if (lastUserMsg && userPrompt.trim()) {
          const alreadyPresent = (threadData.messages || []).some(
            (m) => m.id === userMessageId || (m.role === "user" && m.content === userPrompt)
          );
          if (!alreadyPresent) {
            const userMsgToSave = {
              id: userMessageId,
              role: "user" as const,
              content: userPrompt,
              attachments: attachments && attachments.length > 0 ? attachments : undefined,
              timestamp: lastUserMsg.timestamp || new Date().toISOString(),
            };
            threadStore.addMessage(activeThreadId, userMsgToSave);
            threadData = await threadStore.getThread(activeThreadId);
          }
        }
      } catch (err: unknown) {
        console.warn(
          "[ChatRoute] Turn start persistence warning:",
          err instanceof Error ? err.message : String(err)
        );
      }

      // CHAT-8: keep the thread honestly live while the turn runs so mid-turn
      // GETs do not reconcile it to stopped, and snapshots can surface partial content.
      activeExecutionSet.add(activeThreadId);
      // CHAT-PRESENCE: register the turn marker before the first token exists, so
      // cross-device watchers see the running turn immediately.
      markTurnActive(activeThreadId);

      // Seed initial streaming assistant message immediately so GET /api/threads/[id]
      // never sees a hole while the turn prepares tools/reasoning
      try {
        threadStore.addMessage(activeThreadId, {
          id: assistantMessageId,
          role: "assistant" as const,
          content: "",
          status: "streaming" as const,
          modelUsed: activeModel,
          selectedModel: requestedModel || activeModel,
          timestamp: new Date().toISOString(),
        });
      } catch (seedErr) {
        console.warn("[ChatRoute] Warning writing initial streaming placeholder:", seedErr);
      }
    }

    // CHAT-8: throttled mid-turn snapshots (status "streaming"), upserted by message id.
    const streamSnapshot = new ThrottledStreamSnapshot(
      threadStore,
      activeThreadId,
      assistantMessageId
    );

    const threadOutputsDir = activeThreadId ? path.join(threadsDir, activeThreadId, "files") : null;
    const threadOutputsRelPath = activeThreadId ? `${activeThreadId}/files` : null;
    if (threadOutputsDir) {
      try {
        fs.mkdirSync(threadOutputsDir, { recursive: true, mode: 0o770 });
      } catch {}
      try {
        fs.chmodSync(path.dirname(threadsDir), 0o770);
      } catch {}
      try {
        fs.chmodSync(threadsDir, 0o770);
      } catch {}
      try {
        fs.chmodSync(path.dirname(threadOutputsDir), 0o770);
      } catch {}
      try {
        fs.chmodSync(threadOutputsDir, 0o770);
      } catch {}
    }

    const SYSTEM_PROMPT = `Autonomous AI engineering platform on local hardware with MCP tool integration, workspace automation, and multimodal support.

TOOL TIERS:
1. Browser / Egress:
   - 'search_web': DuckDuckGo search returning markdown summaries. Use for live data, documentation, weather, packages.
   - 'fetch_webpage_markdown': Scrape public URL into markdown.
2. Sandbox / Git:
   - 'workspace_get_tree', 'workspace_grep', 'workspace_read_file', 'workspace_write_file', 'workspace_run_command'.
   - 'git_status', 'git_diff', 'git_checkout_branch', 'git_commit'.
   - 'execute_sandboxed_python', 'verify_container_provenance', 'docker_scout_policy_gate'.
3. Tool Discovery:
   - 'describe_tool': Inspect full JSON schema and parameters for any tool on demand.

CRITICAL INSTRUCTIONS:
- TOOL LATENCY: Invoke tools immediately as your first action without conversational filler. Reason over facts after results return.
- VECTOR DIAGRAMS & ARCHITECTURE DRAWINGS:
  - Prefer self-contained SVG (<svg xmlns="http://www.w3.org/2000/svg" viewBox="...">) in \`\`\`svg blocks. Draw.io XML (<mxfile> / <mxGraphModel>) in \`\`\`xml blocks. Render directly in chat.
- ZERO-DEFLECTION POLICY FOR IN-CHAT RENDERING:
  - In-chat vector graphic and diagram rendering is a core product promise.
  - You MUST NEVER tell the user "rendering fails on your side", "the SVG viewer has not caught it", "paste into an external viewer", or tell them to use diagrams.net externally.
  - If a diagram does not render as expected, debug it, fix the markup, format the code block properly (\`\`\`svg or \`\`\`xml), or adjust the SVG/XML structure directly. Never deflect to external tools or blame the user's browser.
- LOCAL CODEBASE ORACLE & GROUNDING:
  - Ground answers in provided context and cite file:line (e.g. \`web-ui/lib/subagents/supervisor.ts:608-655\`). For general knowledge, answer naturally without fabricating citations.
- CODE EXECUTION: Run test commands with 'workspace_run_command' or run Python via 'execute_sandboxed_python'.
- WEB RESEARCH & ACTION DISCIPLINE:
  - You may make up to ${MAX_WEB_RESEARCH_CALLS} web research calls ('search_web' or 'fetch_webpage_markdown') per turn. Use as many as the task genuinely needs; stop when the facts are sufficient. Never loop on redundant web searches.
  - When asked to create, draw, or generate an SVG, diagram, or visual card in chat, output the complete <svg xmlns="http://www.w3.org/2000/svg" viewBox="...">...</svg> directly in a \`\`\`svg fenced code block in your response. Do NOT call 'workspace_write_file' for chat SVGs unless the user explicitly asks to save a file to disk, and NEVER output the full SVG twice.
- GROUNDING & HONESTY RULE:
  - Never state, claim, or imply you checked real-time data (weather, live prices, news, web pages) unless you executed a 'search_web' or 'fetch_webpage_markdown' tool call in this turn.
  - If you did not call a search tool, state plainly that you do not have live data and offer to look it up. Never invent or hallucinate live metrics or web lookup results.
- REAL-TIME & LIVE DATA RESEARCH GUIDANCE:
  - When the user asks about live, real-time, or current data (e.g. current weather, temperatures, latest news, breaking updates, package versions), invoke 'search_web' as your first action before producing your response.
- EXECUTION & RETRY DISCIPLINE (HOUSE RULES):
  - Bounded retries: maximum 2 identical runs of any command or tool call, and maximum 3 distinct strategies per subproblem; if still failing, stop and report BLOCKED with the exact error and command.
  - Targeted tests first: run only the specific test file(s) for the modified module before running any broader test gate.
  - Paging discipline: use startLine/endLine when reading large files instead of re-reading entire files repeatedly.
- FILE EDITING DISCIPLINE (PATCHES, NOT BLOBS):
  - Edit existing files with the patch tools: 'host_replace_string' on the host, 'workspace_patch_file' in the workspace. Reserve 'host_write_file' / 'workspace_write_file' for creating NEW files, or for a deliberate full-file rewrite.
  - Work one file at a time: patch it, run the targeted check for that file, and commit it before editing the next file. Never hold a multi-file rewrite to dump at the end of a turn.
${buildFileDeliverablesDirective(activeThreadId, threadsDir)}`;

    let effortDirective = "";
    if (effectiveReasoningEffort === "low") {
      effortDirective =
        "\n\nREASONING EFFORT: FAST / DIRECT. Provide direct, concise answers without <think> tags or verbose preamble. Call tools immediately.";
    } else if (effectiveReasoningEffort === "xhigh") {
      effortDirective = "\n\nREASONING EFFORT: DEEP. Think deeply step-by-step before answering.";
    } else if (effectiveReasoningEffort === "medium") {
      effortDirective =
        "\n\nREASONING EFFORT: BALANCED. Keep reasoning concise before executing tools.";
    }

    // Process attachments (Images -> multimodal diagram ingestion + rawBase64, Documents -> text)
    const imagePayloads: string[] = [];
    const docContexts: string[] = [];

    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        const parsed = await parseAttachment(att.name, att.type, att.size, att.base64);
        if (parsed.isImage && parsed.rawBase64) {
          imagePayloads.push(parsed.rawBase64);
        } else if (parsed.textContent) {
          docContexts.push(
            `\n\n--- ATTACHED DOCUMENT: ${parsed.name} (${parsed.type}) ---\n${parsed.textContent}\n--- END OF ATTACHED DOCUMENT ---`
          );
        }
      }
    }

    // Create TransformStream for Real-Time SSE Token & Trace Streaming
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    // job-queue-isolation: consume the readable side so pending writer.write /
    // writer.close resolve even when the client abandoned the stream. Without
    // this, an unread TransformStream backpressures forever and the serialized
    // chat job queue stalls (queue tail never settles).
    let readableDrainStarted = false;
    const startReadableDrain = () => {
      if (readableDrainStarted) return;
      readableDrainStarted = true;
      (async () => {
        try {
          // If the readable is already locked (a live client reader), that
          // reader consumes the stream; nothing to drain here.
          if (stream.readable.locked) return;
          const drainReader = stream.readable.getReader();
          while (true) {
            const { done } = await drainReader.read();
            if (done) break;
          }
        } catch {}
      })().catch(() => {});
    };

    let accumulatedStreamedTokens = "";
    let assistantPersisted = false;
    const turnCreatedFiles: string[] = [];
    const turnPreImages = new Map<string, string>();
    const turnHostDiffs: TurnFileDiff[] = [];
    const traces: TraceItem[] = [];
    // TOKEN ECONOMICS (c): micro-elision audit log for this turn — every stub
    // applied during the turn, with tool + target + original size + round.
    // Declared alongside the other turn state so both persist paths (abort and
    // final) can carry it onto the assistant message.
    const turnMicroElisions: ElisionMeta[] = [];
    // TOKEN ECONOMICS (d): within-thread read dedup audit log — every stubbed
    // unchanged re-read, carrying path + content hash + the earlier trace/round
    // reference. Declared with the other turn state so both persist paths carry it.
    const turnReadDedups: ReadDedupMeta[] = [];
    const accumulatedThoughts: string[] = [];
    const turnStartMs = Date.now();
    let thinkingEndMs: number | null = null;
    let firstLlmRequestMs: number | null = null;
    let thinkingMsAcc = 0;
    let lastThinkingChunkMs: number | null = null;
    let writingMsAcc = 0;
    let lastWritingChunkMs: number | null = null;

    let lastFinishReason: string | undefined = undefined;
    let turnOutputTokens: number | undefined = undefined;

    const persistAssistantOnAbort = () => {
      if (!activeThreadId || assistantPersisted) return;
      assistantPersisted = true;
      try {
        const turnAttachments = collectTurnAttachments(
          activeThreadId,
          threadsDir,
          turnCreatedFiles
        );
        const turnWorkspaceDiffs = collectTurnModifiedFileDiffs(turnPreImages);
        const turnDiffs = [...turnHostDiffs, ...turnWorkspaceDiffs];

        const abortMarker =
          explicitStopped || turnAbortController.signal.aborted
            ? "*[Stopped by user]*"
            : "⚠️ [Turn incomplete: Stream aborted or disconnected.]";
        const abortContent = accumulatedStreamedTokens.trim()
          ? `${accumulatedStreamedTokens}\n\n${abortMarker}`
          : abortMarker;

        const finalOutputTokens =
          turnOutputTokens ??
          (accumulatedStreamedTokens ? estimateTokens(accumulatedStreamedTokens) : 0);

        const abortedMsg = {
          id: assistantMessageId,
          role: "assistant" as const,
          content: abortContent,
          thought: accumulatedThoughts.length > 0 ? accumulatedThoughts.join("\n\n") : undefined,
          traces:
            traces.length > 0
              ? (traces as unknown as Parameters<ThreadStore["addMessage"]>[1]["traces"])
              : undefined,
          attachments: turnAttachments.length > 0 ? turnAttachments : undefined,
          diffs: turnDiffs.length > 0 ? turnDiffs : undefined,
          modelUsed: activeModel,
          selectedModel: requestedModel || activeModel,
          timestamp: new Date().toISOString(),
          status: "incomplete" as const,
          isStopped: explicitStopped || turnAbortController.signal.aborted ? true : undefined,
          finish_reason: lastFinishReason || "abort",
          outputTokens: finalOutputTokens,
          // TOKEN ECONOMICS (c): the elision audit rides on the aborted record too.
          microElisions: turnMicroElisions.length > 0 ? turnMicroElisions : undefined,
          // TOKEN ECONOMICS (d): the read-dedup audit rides on the aborted record too.
          readDedups: turnReadDedups.length > 0 ? turnReadDedups : undefined,
        };
        threadStore.addMessage(activeThreadId, abortedMsg);
      } catch (err) {
        console.warn("[ChatRoute] Failed to persist aborted assistant message:", err);
      }
    };

    let clientDisconnected = false;
    let explicitStopped = false;
    const turnAbortController = new AbortController();

    if (activeThreadId) {
      registerTurnAbortController(activeThreadId, turnAbortController);
    }

    turnAbortController.signal.addEventListener("abort", () => {
      explicitStopped = true;
      persistAssistantOnAbort();
    });

    const cleanupClientSignal = () => {
      if (!clientDisconnected) {
        clientDisconnected = true;
        clearInterval(heartbeatInterval);

        console.log(
          `[ChatRoute] Client SSE connection disconnected for thread ${activeThreadId || "ephemeral"}. Turn continuing detached server-side.`
        );
        // job-queue-isolation: drain the unread readable so pending SSE writes
        // and writer.close() resolve. The client is gone, so consuming the
        // stream here is safe; without this, an abandoned stream deadlocks
        // the serialized job queue forever (queue tail never settles).
        startReadableDrain();
      }
    };
    req.signal.addEventListener("abort", cleanupClientSignal);

    const sendEvent = async (data: Record<string, unknown>) => {
      if (clientDisconnected || req.signal.aborted) {
        clearInterval(heartbeatInterval);
        return;
      }
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        // job-queue-isolation: await the write itself (no 500ms timeout race).
        // A slow reader is backpressure, not a dead client: the drain on client
        // disconnect and writer.abort on real write errors keep the serialized
        // queue moving, so a queued turn is never misclassified as abandoned.
        const writePromise = writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        writePromise.catch(() => {});
        await Promise.race([
          writePromise,
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error("writer timeout")), 2000);
          }),
          new Promise((_, reject) => {
            onAbort = () => reject(new Error("client aborted"));
            req.signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } catch (err: unknown) {
        clearInterval(heartbeatInterval);
        clientDisconnected = true;
        const errMessage = err instanceof Error ? err.message : undefined;
        if (!req.signal.aborted && errMessage === "writer timeout") {
          // Idle reader (client stopped consuming): abort the writable so the
          // readable errors out and later writes skip instantly instead of
          // waiting the timeout again each event.
          startReadableDrain();
          try {
            writer.abort(err).catch(() => {});
          } catch {}
        }
        console.log(
          `[ChatRoute] SSE writer failed for thread ${activeThreadId || "ephemeral"}: ${formatSseWriterError(err)}. Turn continuing detached server-side.`
        );
        // job-queue-isolation: the client is gone; abort the writable so any
        // pending write/close resolves instead of backpressuring forever on an
        // unread (locked) readable — which would stall the serialized queue.
        try {
          writer.abort(err).catch(() => {});
        } catch {}
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        if (onAbort !== undefined) req.signal.removeEventListener("abort", onAbort);
      }
    };

    const heartbeatInterval = setInterval(() => {
      if (clientDisconnected || req.signal.aborted) {
        clearInterval(heartbeatInterval);
        return;
      }
      sendEvent({ type: "ping", ts: Date.now() }).catch(() => {
        clearInterval(heartbeatInterval);
      });
    }, 10_000);
    if (typeof heartbeatInterval.unref === "function") {
      heartbeatInterval.unref();
    }

    let runTurnStarted = false;
    let runTurnFinallyRan = false;

    // job-queue-isolation: serialize this job turn through the single in-app
    // queue (one turn executes at a time, FIFO) and run it against its OWN git
    // worktree of the host checkout. A turn arriving while one is running
    // queues visibly (queue_position event) instead of contending for the slot.
    serializeTurn(
      chatJobQueue,
      {
        id: `${assistantMessageId}-${process.pid}-${++chatTurnWorktreeSeq}`,
        threadId: activeThreadId || clientSessionId,
        prompt: userPrompt,
      },
      {
        repoRoot: resolveJobRepoRoot(),
        priority: SlotPriority.P0_OWNER,
        scheduler: getSharedSlotScheduler(),
        signal: turnAbortController.signal,
        onQueued: (position) => {
          sendEvent({
            type: "status",
            status: `Queued (position ${position})`,
            queue_position: position,
          });
        },
        onSettled: () => {
          if (runTurnStarted || runTurnFinallyRan) return;
          clearInterval(heartbeatInterval);
          if (activeThreadId) {
            clearTurnAbortController(activeThreadId);
            clearRoundAbortController(activeThreadId);
          }
          req.signal.removeEventListener("abort", cleanupClientSignal);
          startReadableDrain();
          try {
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
              }, 1000).unref?.();
            }
          } catch {}
        },
        runTurn: async (_job, _worktree) => {
          runTurnStarted = true;
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
            if (
              !approvalContinuationId &&
              userPrompt.trim() &&
              shouldConsultLocalOracle(userPrompt)
            ) {
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
            const sandboxSession = await connectMcpClient(
              getMcpUrl(),
              "orchestrator-sandbox-client"
            );
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
              !isProhibitedContext &&
              shouldAdvertiseHostTools(threadHostAccess, hostStatus.runnerState);

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
                    model: activeModel,
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

            const hostDirective =
              "\n\n" + getHostStateDirective(hostStatus.runnerState, hostStatus.reason);

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
                clearInterval(heartbeatInterval);
                for (const s of activeSessions) {
                  try {
                    await s.client.close();
                  } catch {}
                }
                try {
                  await writer.close();
                } catch {}
                return;
              }

              const entry = consumed.entry;
              const hostContinuationDiff = generateHostFileDiff(
                entry.tool,
                entry.args,
                entry.result
              );
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
                conversationMessages.push({
                  role: "tool",
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
            await sendEvent({
              type: "meta",
              model: activeModel,
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
            let turnEndedByTimeout = false;
            let turnEndedBySizeLimit = false;
            let turnEndedByTruncation = false;
            let honestEndMarker = "";
            // Text carried across a length-truncated auto-continue: the final answer
            // must contain EVERY produced half, never just the last round.
            let carriedLengthContent = "";
            let carriedToolRoundProse = "";
            // TOKEN ECONOMICS (a): per-round prompt-token integral + compaction count,
            // rolled up onto the assistant message and the thread record.
            const roundPromptTokens: number[] = [];
            let turnCompactionCount = prep.compactedThisTurn ? 1 : 0;
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

            const turnStartMs = Date.now();
            const chunkBudget = resolveThreadChunkBudget(threadData ?? undefined);
            const chunkWorkspaceRoot = _worktree?.path || resolveJobRepoRoot() || process.cwd();
            const { jobId: chunkJobId, handoffPath: chunkHandoffPath } = resolveChunkHandoffTarget({
              taskId: threadData?.taskId,
              threadId: activeThreadId || _job.threadId,
              fallbackJobId: _job.id,
            });
            const chunkRunlogPath = path.join(
              chunkWorkspaceRoot,
              "docs/internal/queue-steer-runlog.md"
            );

            while (true) {
              if (turnAbortController.signal.aborted) break;
              if (getHostSettings().jobChunkingEnabled) {
                const chunkResult = await handleLiveTurnChunkBudget({
                  roundsUsed: round,
                  elapsedMs: Date.now() - turnStartMs,
                  budget: chunkBudget,
                  jobId: chunkJobId,
                  workspaceRoot: chunkWorkspaceRoot,
                  handoffPath: chunkHandoffPath,
                  runlogPath: chunkRunlogPath,
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

              // TOKEN ECONOMICS (c): MICRO-ELISION. Superseded tool results (those
              // past the recent window) are stubbed EVERY round, independent of the
              // 85K fit trigger, so bulk that the model has already moved past stops
              // paying prompt tokens. The recent window stays byte-identical; each
              // stub carries tool + path/command + original size + round metadata and
              // the full result remains in the thread trace record (audit copy).
              const roundElision = applyMicroElision(conversationMessages, round + 1);
              if (roundElision.stubbed > 0) {
                turnMicroElisions.push(...roundElision.elisions);
              }

              // 1. Fit conversation to budget FIRST through ladder before evaluating continuation
              const compaction = fitConversationToBudget(conversationMessages, {
                budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
              });
              if (compaction.compacted) {
                let appliedMessages = compaction.messages;
                let appliedTokensBefore = compaction.tokensBefore;
                let appliedTokensAfter = compaction.tokensAfter;
                let appliedActions: string[] = compaction.actions;

                if (activeThreadId && threadData) {
                  try {
                    // ROUTE WIRING (compaction-hybrid step 3 + AUD-10): COMPACTION_STRATEGY=hybrid
                    // selects the async hybrid rung and rebuilds the live conversationMessages
                    // from the compacted thread record; unset/anything-else keeps the
                    // extraction call and live replacement byte-identical.
                    if (resolveCompactionStrategy() === "hybrid") {
                      const hybridResult = await threadStore.compactThreadIncrementalHybrid(
                        threadData,
                        {
                          summarize: async (sumReq) => {
                            let text = "";
                            let truncated = false;
                            for await (const chunk of streamLlmChat(getLlmBaseUrl(), {
                              model: activeModel,
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
                              // Per-chunk progress hook: re-arms the deadline wrapper's
                              // inactivity timer so 180s means silence since the LAST
                              // chunk, not elapsed time since start.
                              sumReq.onProgress?.();
                              if (chunk.message?.content) text += chunk.message.content;
                              if (chunk.finish_reason === "length") truncated = true;
                            }
                            return { text, truncated };
                          },
                        }
                      );
                      if (!hybridResult.noop) {
                        const rebuilt: Array<{
                          role: string;
                          content: string;
                          [key: string]: unknown;
                        }> = threadStore.buildModelMessages(threadData);
                        const liveSystem =
                          conversationMessages[0]?.role === "system"
                            ? conversationMessages[0]
                            : null;
                        if (liveSystem && rebuilt[0]?.role !== "system") {
                          rebuilt.unshift(liveSystem);
                        }
                        // Preserve any in-flight tool-round messages from the current turn
                        // that are present in live conversationMessages after the last user message.
                        let lastUserIdx = -1;
                        for (let i = conversationMessages.length - 1; i >= 0; i--) {
                          if (conversationMessages[i]?.role === "user") {
                            lastUserIdx = i;
                            break;
                          }
                        }
                        if (lastUserIdx >= 0 && lastUserIdx < conversationMessages.length - 1) {
                          const inFlightTail = conversationMessages.slice(lastUserIdx + 1);
                          const hasInFlightTools = inFlightTail.some(
                            (m) =>
                              m?.role === "tool" ||
                              (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0)
                          );
                          if (hasInFlightTools) {
                            rebuilt.push(...inFlightTail);
                          }
                        }
                        appliedMessages = rebuilt;
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
                  model: activeModel,
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
                mergeSystemDirective(conversationMessages, HIGH_WATER_BANKING_DIRECTIVE);
              }

              // 2. Measure fitted tokens for continuation
              const continuation = canContinueToolLoop({
                round,
                contextTokens: estimateTokens(conversationMessages),
                budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
                lastRoundTools,
                webResearchCalls,
                roundBackstop: TOOL_ROUND_BACKSTOP,
                awaitingToolRound: groundingDirectivePending,
              });
              if (!continuation.canContinue) {
                toolLoopStopReason = continuation.stopReason;
                budgetExhaustedAtTokens = estimateTokens(conversationMessages);
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
                  await sendEvent({ type: "steer", texts: steers });
                }
              }

              const reasoningSpan = tracer.startSpan("model.reasoning", rootSpan?.spanId, {
                model: activeModel,
                round,
              });

              // CHAT-7: forced synthesis only on the last permitted round (backstop boundary).
              // Budget-exhausted research-extension rounds keep tools — they are still gathering data.
              const isFinalRound = continuation.forceSynthesis === true;
              // Final round forced synthesis: prompt model to synthesize answer and omit tools
              if (isFinalRound) {
                mergeSystemDirective(
                  conversationMessages,
                  buildSynthesisDirective(userPrompt, true)
                );
              }
              if (isArtifactRequest) {
                mergeSystemDirective(conversationMessages, OUTPUT_HEADROOM_THINKING_DIRECTIVE);
              }

              const roundTools = filterToolsForWebBudget(llmTools, webResearchCalls);

              const roundOptions = resolveRoundModelOptions({
                model: activeModel,
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
              const { inactivityMs, totalMs } = resolveRoundDeadlineMs();
              console.log(
                `[DBG] dispatch round ${round} inactivity=${inactivityMs} total=${totalMs}`
              );
              let roundTimedOut: "inactivity" | "total" | null = null;
              let roundInactivityTimer: ReturnType<typeof setTimeout> | null = null;
              let roundTotalTimer: ReturnType<typeof setTimeout> | null = null;
              const armRoundDeadline = () => {
                if (roundInactivityTimer) clearTimeout(roundInactivityTimer);
                roundInactivityTimer = setTimeout(() => {
                  roundTimedOut = "inactivity";
                  roundAbortController.abort();
                }, inactivityMs);
                if (typeof roundInactivityTimer.unref === "function") roundInactivityTimer.unref();
              };
              armRoundDeadline();
              roundTotalTimer = setTimeout(() => {
                roundTimedOut = "total";
                roundAbortController.abort();
              }, totalMs);
              if (typeof roundTotalTimer.unref === "function") roundTotalTimer.unref();

              const llmPayload: Parameters<ReturnType<typeof getLLMProvider>["streamChat"]>[1] = {
                model: activeModel,
                messages: fitContextWindow(conversationMessages, {
                  tools: isFinalRound ? undefined : roundTools,
                  isArtifactTurn: isArtifactRequest,
                }),
                keep_alive: -1,
                signal: AbortSignal.any([turnAbortController.signal, roundAbortController.signal]),
                reasoning_effort: roundOptions.reasoning_effort,
                options: roundOptions,
              };

              if (roundTools.length > 0 && !isFinalRound) {
                llmPayload.tools = roundTools;
              }

              let fullRoundContent = "";
              let roundThinking = "";
              let roundFinishReason: string | undefined = undefined;
              let roundSizeCapped = false;
              const toolCallsFromMessage: LlmToolCall[] = [];

              try {
                for await (const chunk of streamLlmChat(getLlmBaseUrl(), llmPayload)) {
                  if (chunk.finish_reason) {
                    lastFinishReason = chunk.finish_reason;
                    roundFinishReason = chunk.finish_reason;
                  }
                  if (typeof chunk.outputTokens === "number") {
                    turnOutputTokens = chunk.outputTokens;
                  } else if (typeof chunk.eval_count === "number") {
                    turnOutputTokens = chunk.eval_count;
                  }
                  // TOKEN ECONOMICS (a): prompt tokens arrive on the finish chunk via
                  // the PR #63 usage plumbing (promptTokens) or Ollama's
                  // prompt_eval_count. Exactly one entry is pushed per round.
                  if (typeof chunk.promptTokens === "number") {
                    roundPromptTokens.push(chunk.promptTokens);
                  } else if (typeof chunk.prompt_eval_count === "number") {
                    roundPromptTokens.push(chunk.prompt_eval_count);
                  }
                  if (chunk.message?.thinking) {
                    const nowMs = Date.now();
                    if (firstLlmRequestMs === null) firstLlmRequestMs = nowMs;
                    if (lastThinkingChunkMs !== null) {
                      thinkingMsAcc += Math.max(0, nowMs - lastThinkingChunkMs);
                    }
                    lastThinkingChunkMs = nowMs;
                    roundThinking += chunk.message.thinking;
                    armRoundDeadline();
                    const currentCumulativeThought =
                      accumulatedThoughts.length > 0
                        ? `${accumulatedThoughts.join("\n\n")}\n\n${roundThinking}`
                        : roundThinking;
                    streamSnapshot.maybeWrite(accumulatedStreamedTokens, currentCumulativeThought);
                    await sendEvent({ type: "thought", thought: currentCumulativeThought });
                  }
                  if (chunk.message?.content) {
                    const nowMs = Date.now();
                    if (firstLlmRequestMs === null) firstLlmRequestMs = nowMs;
                    if (lastWritingChunkMs !== null) {
                      writingMsAcc += Math.max(0, nowMs - lastWritingChunkMs);
                    }
                    lastWritingChunkMs = nowMs;
                    const textChunk = chunk.message.content;
                    fullRoundContent += textChunk;
                    accumulatedStreamedTokens = appendNarrationChunk(
                      accumulatedStreamedTokens,
                      textChunk
                    );
                    armRoundDeadline();
                    // TURN SIZE LIMIT: hard cap on total streamed content. A runaway
                    // round (e.g. a huge tool-call payload as one generation) is cut
                    // off with an honest marker and the round ends.
                    if (accumulatedStreamedTokens.length > MAX_STREAMED_CONTENT_CHARS) {
                      roundSizeCapped = true;
                      accumulatedStreamedTokens += TURN_SIZE_LIMIT_MARKER;
                      streamSnapshot.maybeWrite(accumulatedStreamedTokens, undefined);
                      await sendEvent({ type: "token", content: TURN_SIZE_LIMIT_MARKER });
                      roundAbortController.abort();
                      break;
                    }
                    const currentCumulativeThought =
                      accumulatedThoughts.length > 0
                        ? roundThinking
                          ? `${accumulatedThoughts.join("\n\n")}\n\n${roundThinking}`
                          : accumulatedThoughts.join("\n\n")
                        : roundThinking || undefined;
                    streamSnapshot.maybeWrite(accumulatedStreamedTokens, currentCumulativeThought);
                    await sendEvent({ type: "token", content: textChunk });
                  }
                  if (chunk.message?.tool_calls && Array.isArray(chunk.message.tool_calls)) {
                    toolCallsFromMessage.push(...chunk.message.tool_calls);
                  }
                }
              } catch (roundErr: unknown) {
                if (!roundAbortController.signal.aborted || turnAbortController.signal.aborted) {
                  throw roundErr;
                }
              } finally {
                if (roundInactivityTimer) clearTimeout(roundInactivityTimer);
                if (roundTotalTimer) clearTimeout(roundTotalTimer);
                if (activeThreadId) {
                  clearRoundAbortController(activeThreadId, roundAbortController);
                }
              }

              roundFinishReasons.push(roundFinishReason || "stop");

              if (roundThinking.trim()) {
                accumulatedThoughts.push(roundThinking.trim());
                thinkingEndMs = Date.now();
              }

              if (roundAbortController.signal.aborted && !turnAbortController.signal.aborted) {
                console.log(
                  `[DBG] round ${round} aborted timedOut=${roundTimedOut} sizeCapped=${roundSizeCapped} consec=${consecutiveDeadlineAborts}`
                );
                if (roundSizeCapped) {
                  // Size limit hit: the turn ends honestly. No retry — the content
                  // cap exists precisely to stop runaway generations.
                  turnEndedBySizeLimit = true;
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
                    turnEndedByTimeout = true;
                    honestEndMarker = TURN_TIMEOUT_MARKER;
                    accumulatedStreamedTokens += TURN_TIMEOUT_MARKER;
                    streamSnapshot.maybeWrite(accumulatedStreamedTokens, undefined);
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
                  });
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
                turnEndedBySizeLimit = true;
                const sizeMarker = `${TURN_SIZE_LIMIT_MARKER} (tool: ${bad?.function?.name}, arguments truncated at ${byteSize} bytes)`;
                honestEndMarker = sizeMarker;
                accumulatedStreamedTokens += sizeMarker;
                streamSnapshot.maybeWrite(accumulatedStreamedTokens, undefined);
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
                  });
                  groundingDirectivePending = true;
                  lastRoundTools = [];
                  round++;
                  continue;
                }
                if (markupEval.action === "end_turn") {
                  consecutiveMarkupFailures = markupEval.consecutiveMarkupFailures;
                  honestEndMarker = markupEval.marker!;
                  accumulatedStreamedTokens += markupEval.marker!;
                  streamSnapshot.maybeWrite(accumulatedStreamedTokens, undefined);
                  await sendEvent({ type: "token", content: markupEval.marker! });
                  break;
                }
                consecutiveMarkupFailures = 0;

                if (
                  isLiveRealTimeIntent(userPrompt) &&
                  webResearchCalls === 0 &&
                  round < TOOL_ROUND_BACKSTOP - 1 &&
                  estimateTokens(conversationMessages) <= CHAT_CONTEXT_BUDGET_TOKENS &&
                  !groundingEnforced
                ) {
                  groundingEnforced = true;
                  groundingDirectivePending = true;
                  mergeSystemDirective(
                    conversationMessages,
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
                  if (consecutiveLengthTruncations >= 2 || round >= TOOL_ROUND_BACKSTOP - 1) {
                    turnEndedByTruncation = true;
                    honestEndMarker = TURN_TRUNCATION_MARKER;
                    // Keep EVERY produced half: the final answer carries the earlier
                    // truncated rounds plus this one, never just the last round.
                    currentAssistantMessage = {
                      role: "assistant",
                      content: joinNarrationChunks(carriedLengthContent, fullRoundContent),
                    };
                    accumulatedStreamedTokens += TURN_TRUNCATION_MARKER;
                    streamSnapshot.maybeWrite(accumulatedStreamedTokens, undefined);
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
                  });
                  // Bank this half so the final answer keeps every produced part.
                  carriedLengthContent = joinNarrationChunks(
                    carriedLengthContent,
                    fullRoundContent
                  );
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
                carriedToolRoundProse = joinNarrationChunks(
                  carriedToolRoundProse,
                  fullRoundContent.trim()
                );
              }
              consecutiveMarkupFailures = 0;

              if (accumulatedThoughts.length > 0) {
                await sendEvent({
                  type: "thought",
                  thought: accumulatedThoughts.join("\n\n"),
                });
              }

              round++;
              lastRoundTools = toolCalls.map((tc) => tc.function?.name || "");
              const assistantMsgToPush = {
                ...currentAssistantMessage,
                tool_calls: toolCalls,
              };
              conversationMessages.push(assistantMsgToPush);

              let searchBlocked = false;

              for (const toolCall of toolCalls) {
                if (turnAbortController.signal.aborted) break;
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
                } else if (
                  toolCall.function.arguments &&
                  typeof toolCall.function.arguments === "object"
                ) {
                  toolArgs = { ...toolCall.function.arguments };
                }

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
                  const evalResult = evaluateSearchQueryAttempt(
                    queryAttempt,
                    userPrompt,
                    searchNudges
                  );

                  if (evalResult.action === "nudge") {
                    searchNudges++;
                    conversationMessages.push({
                      role: "tool",
                      name: toolName,
                      content: JSON.stringify({
                        status: "RETRY_REQUIRED",
                        message: evalResult.message,
                      }),
                    });
                    mergeSystemDirective(
                      conversationMessages,
                      `[QUERY REVISION REQUIRED]: ${evalResult.message}`
                    );
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
                      name: toolName,
                      content: JSON.stringify({
                        status: "BLOCKED",
                        error: evalResult.message,
                      }),
                    });
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
                } else if (toolName === "workspace_read_file") {
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
                  if (
                    !toolArgs.code ||
                    typeof toolArgs.code !== "string" ||
                    !toolArgs.code.trim()
                  ) {
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

                if (toolName === DESCRIBE_TOOL_NAME) {
                  const targetTool = String(toolArgs.tool_name || toolArgs.name || "");
                  const toolDesc = describeTool(targetTool, toolRegistry);
                  conversationMessages.push({
                    role: "tool",
                    name: DESCRIBE_TOOL_NAME,
                    content: JSON.stringify(toolDesc),
                  });
                  await sendEvent({
                    type: "trace",
                    trace: {
                      tool: DESCRIBE_TOOL_NAME,
                      args: toolArgs,
                      result: toolDesc,
                      durationMs: 1,
                      timestamp: new Date().toISOString(),
                      model: activeModel,
                      tier: "workspace",
                    },
                  });
                  continue;
                }

                const target = toolClientMap.get(toolName);
                if (!target) {
                  if (ADVERTISED_TOOLS.has(toolName)) {
                    console.warn(
                      `[ChatRoute] Advertised tool \'${toolName}\' called but backend client is disconnected. Gracefully returning tool status.`
                    );
                    conversationMessages.push({
                      role: "tool",
                      name: toolName,
                      content: `Tool \'${toolName}\' is temporarily unavailable (client disconnected or service unreachable). Please proceed without it or explain to the user.`,
                    });
                    await sendEvent({
                      type: "trace",
                      trace: {
                        tool: toolName,
                        args: toolArgs,
                        result: `Tool \'${toolName}\' temporarily unavailable`,
                        durationMs: 1,
                        timestamp: new Date().toISOString(),
                        model: activeModel,
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
                      name: toolName,
                      content: WEB_BUDGET_EXHAUSTED_DIRECTIVE,
                    });
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
                if (
                  toolName === "workspace_run_command" ||
                  toolName === "execute_sandboxed_python"
                ) {
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
                        threadData?.mergeGrant
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
                  result = await target.client.callTool({
                    name: toolName,
                    arguments: toolArgs,
                  });
                }
                const durationMs = Math.round(performance.now() - startTime);

                // Track test / command failure for auto-escalation
                let isExecutionError = false;
                try {
                  const resultStr = JSON.stringify(result);
                  if (
                    resultStr.includes('"status":"EXECUTION_ERROR"') ||
                    resultStr.includes('"exit_code":1') ||
                    Boolean((result as { isError?: boolean } | null)?.isError)
                  ) {
                    isExecutionError = true;
                  }
                } catch {}

                if (bashSpan) {
                  bashSpan.end(isExecutionError ? "error" : "ok", { durationMs, isExecutionError });
                }
                toolSpan.end(isExecutionError ? "error" : "ok", { durationMs });

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
                  timestamp: new Date().toISOString(),
                  model: activeModel,
                  tier: target.tier,
                };
                if (
                  toolName === "workspace_write_file" &&
                  !isExecutionError &&
                  toolArgs?.path &&
                  typeof toolArgs.path === "string"
                ) {
                  recordTurnOutputWrite(
                    turnCreatedFiles,
                    toolArgs.path,
                    activeThreadId,
                    threadsDir
                  );
                }

                traces.push(traceItem);

                await sendEvent({
                  type: "trace",
                  trace: traceItem,
                });

                const isFileReadTool =
                  toolName === "workspace_read_file" || toolName === "host_read_file";
                // TOKEN ECONOMICS (d): within-thread read dedup. A read whose
                // path + content hash matches an earlier read in this thread is
                // answered with a short stub referencing the earlier trace/round; a
                // changed file re-reads full and re-anchors the registry. The full
                // result stays recoverable in the trace record (audit copy pushed
                // above), and every stub is logged on the turn's readDedups field.
                // The pinned clamp-bypass expression below stays byte-identical
                // (chatFilePaging Pin 1 compliance); dedup swaps `result` itself.
                if (isFileReadTool && !isExecutionError) {
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
                conversationMessages.push({
                  role: "tool",
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
                  mergeSystemDirective(
                    conversationMessages,
                    "[DELIVERABLE SAVED]: You have already saved the complete SVG diagram via workspace_write_file, and the UI automatically renders it inline for the user. Now respond with a concise 2-3 sentence summary of the diagram's contents and do NOT call more tools or repeat the <svg> markup in your text response."
                  );
                }

                if (isWebResearchTool(toolName, target.tier)) {
                  if (isArtifactRequest && !isExecutionError) {
                    webResearchCalls = MAX_WEB_RESEARCH_CALLS;
                    mergeSystemDirective(
                      conversationMessages,
                      buildSynthesisDirective(userPrompt, false)
                    );
                  } else if (webResearchCalls >= MAX_WEB_RESEARCH_CALLS && !webBudgetNoticeAdded) {
                    webBudgetNoticeAdded = true;
                    mergeSystemDirective(conversationMessages, WEB_BUDGET_EXHAUSTED_DIRECTIVE);
                  }
                }

                // Auto-Escalation Check: If 2 consecutive failures, ensure activeModel escalates to Primary model
                if (
                  mode === "auto" &&
                  consecutiveFailures >= 2 &&
                  activeModel !== DEFAULT_PRIMARY_MODEL
                ) {
                  console.log(
                    "[Auto-Escalation] 2 consecutive failures detected. Escalating to Primary model..."
                  );
                  activeModel = DEFAULT_PRIMARY_MODEL;
                  effectiveReasoningEffort = resolveEffectiveReasoningEffort(
                    activeModel,
                    requestedReasoning
                  );
                  await sendEvent({
                    type: "status",
                    status: "Auto-escalating to Pro Reasoning Model...",
                  });
                  await sendEvent({
                    type: "meta",
                    model: activeModel,
                    reasoning_effort: effectiveReasoningEffort,
                  });
                  mergeSystemDirective(
                    conversationMessages,
                    "[AUTO-ESCALATION]: Execution engine encountered 2 consecutive failures. Escalating session to Primary Reasoning Engine for deep architectural root-cause diagnosis and code synthesis."
                  );
                }
              }

              // TURN-LIVENESS: round boundary is a discrete progress event — persist the
              // accumulated content + traces to the thread record immediately (bypassing the
              // token throttle) and refresh the heartbeat so watchers read ALIVE in-flight work.
              const roundThought =
                accumulatedThoughts.length > 0 ? accumulatedThoughts.join("\n\n") : undefined;
              streamSnapshot.maybeWrite(
                accumulatedStreamedTokens,
                roundThought,
                traces as unknown as Parameters<typeof streamSnapshot.maybeWrite>[2],
                {
                  force: true,
                  roundPromptTokens: [...roundPromptTokens],
                }
              );
              if (activeThreadId) {
                touchActiveTurn(activeThreadId);
              }

              if (searchBlocked) {
                break;
              }

              if (
                !honestAbortInjected &&
                (isArtifactRequest || webResearchCalls >= MAX_WEB_RESEARCH_CALLS) &&
                shouldInjectHonestAbort({ userPrompt, priorUserPrompt, webResearchCalls, traces })
              ) {
                honestAbortInjected = true;
                mergeSystemDirective(conversationMessages, HONEST_ABORT_DIRECTIVE);
                await sendEvent({
                  type: "trace",
                  trace: {
                    tool: "grounding_gate",
                    args: { reason: "insufficient_live_web_results" },
                    result: HONEST_ABORT_DIRECTIVE,
                    durationMs: 0,
                    timestamp: new Date().toISOString(),
                    model: activeModel,
                    tier: "ORCHESTRATOR",
                  },
                });
              }

              if (isArtifactRequest && traces.some((t) => isWebResearchTool(t.tool))) {
                break;
              }
            }

            if (
              !honestAbortInjected &&
              shouldInjectHonestAbort({ userPrompt, priorUserPrompt, webResearchCalls, traces })
            ) {
              honestAbortInjected = true;
              mergeSystemDirective(conversationMessages, HONEST_ABORT_DIRECTIVE);
              await sendEvent({
                type: "trace",
                trace: {
                  tool: "grounding_gate",
                  args: { reason: "insufficient_live_web_results" },
                  result: HONEST_ABORT_DIRECTIVE,
                  durationMs: 0,
                  timestamp: new Date().toISOString(),
                  model: activeModel,
                  tier: "ORCHESTRATOR",
                },
              });
            }

            // SYNTHESIS-RETRY: hoisted flag — true when BOTH synthesis passes returned no text.
            let synthesisReturnedEmpty = false;
            // Post-tool synthesis safety pass if lingering tool calls, missing artifact, empty text, or late steers:
            const lingeringToolCalls = getEffectiveToolCalls(currentAssistantMessage);
            const pendingLateSteers = activeThreadId
              ? threadStore.getPendingSteers(activeThreadId)
              : [];

            // Invariant: If late steers arrived and we have context (e.g. tools were used or model produced content),
            // we MUST dispatch a model synthesis pass that incorporates the steer, OR if no request can run,
            // we do NOT consume them so they return honestly in pendingSteers.
            const shouldSynthesize =
              !turnAbortController.signal.aborted &&
              !honestEndMarker &&
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
                  await sendEvent({ type: "steer", texts: steers });
                }
              }

              const synthSpan = tracer.startSpan("model.synthesis", rootSpan?.spanId, {
                model: activeModel,
              });
              conversationMessages.push(currentAssistantMessage);
              conversationMessages.push({
                role: "user",
                content: buildSynthesisDirective(userPrompt, false),
              });

              await sendEvent({
                type: "status",
                status: "Synthesizing final answer...",
              });

              if (isArtifactRequest) {
                mergeSystemDirective(conversationMessages, OUTPUT_HEADROOM_THINKING_DIRECTIVE);
              }

              const synthOptions = resolveRoundModelOptions({
                model: activeModel,
                requestedEffort: effectiveReasoningEffort,
                userPrompt,
                isSynthesisOrFinalRound: true,
                hasCompletedToolCalls: traces.length > 0,
              });

              // SYNTHESIS-RETRY: a single synthesis pass, streamed into the shared accumulators.
              const runSynthesisPass = async (): Promise<{ content: string; thinking: string }> => {
                let passContent = "";
                let passThinking = "";
                const passAbortController = new AbortController();
                const { inactivityMs, totalMs } = resolveRoundDeadlineMs();
                let passTimedOut: "inactivity" | "total" | null = null;
                let passInactivityTimer: ReturnType<typeof setTimeout> | null = null;
                let passTotalTimer: ReturnType<typeof setTimeout> | null = null;
                const armPassDeadline = () => {
                  if (passInactivityTimer) clearTimeout(passInactivityTimer);
                  passInactivityTimer = setTimeout(() => {
                    passTimedOut = "inactivity";
                    passAbortController.abort();
                  }, inactivityMs);
                  if (typeof passInactivityTimer.unref === "function") passInactivityTimer.unref();
                };
                armPassDeadline();
                passTotalTimer = setTimeout(() => {
                  passTimedOut = "total";
                  passAbortController.abort();
                }, totalMs);
                if (typeof passTotalTimer.unref === "function") passTotalTimer.unref();

                try {
                  for await (const chunk of streamLlmChat(getLlmBaseUrl(), {
                    model: activeModel,
                    messages: fitContextWindow(conversationMessages, {
                      isArtifactTurn: isArtifactRequest,
                    }),
                    signal: AbortSignal.any([
                      turnAbortController.signal,
                      passAbortController.signal,
                    ]),
                    reasoning_effort: synthOptions.reasoning_effort,
                    options: synthOptions,
                  })) {
                    if (chunk.finish_reason) {
                      lastFinishReason = chunk.finish_reason;
                    }
                    if (typeof chunk.promptTokens === "number") {
                      roundPromptTokens.push(chunk.promptTokens);
                    } else if (typeof chunk.prompt_eval_count === "number") {
                      roundPromptTokens.push(chunk.prompt_eval_count);
                    }
                    if (typeof chunk.outputTokens === "number") {
                      turnOutputTokens = chunk.outputTokens;
                    } else if (typeof chunk.eval_count === "number") {
                      turnOutputTokens = chunk.eval_count;
                    }
                    if (chunk.message?.thinking) {
                      passThinking += chunk.message.thinking;
                      armPassDeadline();
                      const currentCumulativeThought =
                        accumulatedThoughts.length > 0
                          ? `${accumulatedThoughts.join("\n\n")}\n\n${passThinking}`
                          : passThinking;
                      streamSnapshot.maybeWrite(
                        accumulatedStreamedTokens,
                        currentCumulativeThought
                      );
                      await sendEvent({ type: "thinking", content: chunk.message.thinking });
                      await sendEvent({ type: "thought", thought: currentCumulativeThought });
                    }
                    if (chunk.message?.content) {
                      passContent += chunk.message.content;
                      accumulatedStreamedTokens = appendNarrationChunk(
                        accumulatedStreamedTokens,
                        chunk.message.content
                      );
                      armPassDeadline();
                      if (accumulatedStreamedTokens.length > MAX_STREAMED_CONTENT_CHARS) {
                        accumulatedStreamedTokens += TURN_SIZE_LIMIT_MARKER;
                        streamSnapshot.maybeWrite(accumulatedStreamedTokens, undefined);
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
                      streamSnapshot.maybeWrite(
                        accumulatedStreamedTokens,
                        currentCumulativeThought
                      );
                      await sendEvent({ type: "token", content: chunk.message.content });
                    }
                  }
                } catch (err: unknown) {
                  if (passAbortController.signal.aborted && !turnAbortController.signal.aborted) {
                    console.log(`[DBG] synthesis pass aborted timedOut=${passTimedOut}`);
                  } else {
                    throw err;
                  }
                } finally {
                  if (passInactivityTimer) clearTimeout(passInactivityTimer);
                  if (passTotalTimer) clearTimeout(passTotalTimer);
                }
                return { content: passContent, thinking: passThinking };
              };

              let synthResult = await runSynthesisPass();
              let synthesisPasses = 1;

              const initialMarkupEval = evaluateMarkupRound({
                roundContent: synthResult.content,
                executedToolCallsCount: 0,
                consecutiveMarkupFailures,
                roundFinishReason: lastFinishReason,
                roundThinking: synthResult.thinking,
              });
              const needsSynthRetry =
                (!synthResult.content.trim() || initialMarkupEval.action === "reprompt") &&
                !turnAbortController.signal.aborted &&
                !explicitStopped;

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

              const finalMarkupEval = evaluateMarkupRound({
                roundContent: synthResult.content,
                executedToolCallsCount: 0,
                consecutiveMarkupFailures,
                roundFinishReason: lastFinishReason,
                roundThinking: synthResult.thinking,
              });

              if (finalMarkupEval.action === "end_turn" || finalMarkupEval.action === "reprompt") {
                const marker =
                  finalMarkupEval.marker || "⚠️ [Turn incomplete: Tool-call formatting failed.]";
                honestEndMarker = marker;
                accumulatedStreamedTokens += marker;
                streamSnapshot.maybeWrite(accumulatedStreamedTokens, undefined);
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
            if (carriedToolRoundProse.trim()) {
              const currentText = currentAssistantMessage.content || "";
              if (!currentText.includes(carriedToolRoundProse.trim())) {
                currentAssistantMessage = {
                  ...currentAssistantMessage,
                  content: currentText.trim()
                    ? `${carriedToolRoundProse.trim()}\n\n${currentText}`
                    : carriedToolRoundProse.trim(),
                };
              }
            }
            // Clean residual tool tags
            let cleanedContent = cleanResidualToolTags(currentAssistantMessage.content || "");
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
                    ? `⚠️ [Turn paused: Tool execution limit reached (${TOOL_ROUND_BACKSTOP} rounds).]`
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
                cleanedContent =
                  "I am ready to assist you. What would you like to build or explore?";
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
            const turnAttachments = collectTurnAttachments(
              activeThreadId,
              threadsDir,
              turnCreatedFiles
            );
            const turnWorkspaceDiffs = collectTurnModifiedFileDiffs(turnPreImages);
            const turnDiffs = [...turnHostDiffs, ...turnWorkspaceDiffs];

            rootSpan?.end("ok", {
              tracesCount: traces.length,
              modelUsed: activeModel,
            });

            if (explicitStopped || turnAbortController.signal.aborted) {
              if (activeThreadId && !assistantPersisted) {
                persistAssistantOnAbort();
              }
              return;
            }

            if (
              lastFinishReason === "length" ||
              lastFinishReason === "error" ||
              lastFinishReason === "abort"
            ) {
              turnStatus = "incomplete";
              const truncationNotice = `⚠️ [Turn incomplete: Generation truncated (${lastFinishReason}).]`;
              if (!cleanedContent.includes("⚠️ [Turn incomplete:")) {
                cleanedContent = cleanedContent.trim()
                  ? `${cleanedContent}\n\n${truncationNotice}`
                  : truncationNotice;
              }
            }

            // TURN SIZE LIMIT: a runaway generation (e.g. a huge tool-call payload
            // emitted as content) must never be persisted or streamed whole. Clamp
            // to a safe prefix (prefer a newline boundary) and stamp honestly.
            if (cleanedContent.length > MAX_STREAMED_CONTENT_CHARS) {
              turnStatus = "incomplete";
              let cut = cleanedContent.slice(0, MAX_STREAMED_CONTENT_CHARS);
              const lastNewline = cut.lastIndexOf("\n");
              if (lastNewline > MAX_STREAMED_CONTENT_CHARS / 2) {
                cut = cut.slice(0, lastNewline);
              }
              cleanedContent = `${cut}\n\n${TURN_SIZE_LIMIT_MARKER}`;
            }

            const finalOutputTokens =
              turnOutputTokens ?? (cleanedContent ? estimateTokens(cleanedContent) : 0);
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

            if (activeThreadId && !assistantPersisted) {
              const assistantMsgToSave = {
                id: assistantMessageId,
                role: "assistant" as const,
                content: cleanedContent,
                thought:
                  accumulatedThoughts.length > 0 ? accumulatedThoughts.join("\n\n") : undefined,
                traces:
                  traces.length > 0
                    ? (traces as unknown as Parameters<ThreadStore["addMessage"]>[1]["traces"])
                    : undefined,
                completionStamp: finalCompletionStamp,
                verificationGaps:
                  finalVerificationGaps.length > 0 ? finalVerificationGaps : undefined,
                attachments: turnAttachments.length > 0 ? turnAttachments : undefined,
                diffs: turnDiffs.length > 0 ? turnDiffs : undefined,
                modelUsed: activeModel,
                selectedModel: requestedModel || activeModel,
                timestamp: new Date().toISOString(),
                compactedThisTurn: turnCompacted || undefined,
                tokensBeforeCompaction: turnCompacted ? turnTokensBefore : undefined,
                tokensAfterCompaction: turnCompacted ? turnTokensAfter : undefined,
                compactionActions: turnCompacted ? turnCompactionActions : undefined,
                status: turnStatus || ("completed" as const),
                thinkingDurationMs:
                  thinkingEndMs !== null ? Math.max(0, thinkingEndMs - turnStartMs) : undefined,
                phaseTimings: {
                  contextPrepMs:
                    firstLlmRequestMs !== null
                      ? Math.max(0, firstLlmRequestMs - turnStartMs)
                      : undefined,
                  thinkingMs: thinkingMsAcc > 0 ? thinkingMsAcc : undefined,
                  toolsMs:
                    traces.reduce(
                      (sum, tr) => sum + (typeof tr.durationMs === "number" ? tr.durationMs : 0),
                      0
                    ) || undefined,
                  writingMs: writingMsAcc > 0 ? writingMsAcc : undefined,
                },
                finish_reason: lastFinishReason || "stop",
                roundFinishReasons: roundFinishReasons.length > 0 ? roundFinishReasons : undefined,
                outputTokens: finalOutputTokens,
                roundPromptTokens: roundPromptTokens,
                // TOKEN ECONOMICS (c): micro-elision audit rides on the final record.
                microElisions: turnMicroElisions.length > 0 ? turnMicroElisions : undefined,
                // TOKEN ECONOMICS (d): read-dedup audit rides on the final record.
                readDedups: turnReadDedups.length > 0 ? turnReadDedups : undefined,
                tokenEconomics: buildJobTokenRollup({
                  rounds: round,
                  promptTokens: finalPromptTokens,
                  outputTokens: finalOutputTokens,
                  compactions: turnCompactionCount,
                }),
              };
              threadStore.addMessage(activeThreadId, assistantMsgToSave);
              assistantPersisted = true;
              if (clientDisconnected || req.signal.aborted) {
                console.log(
                  `[ChatRoute] Detached turn completed server-side for thread ${activeThreadId} (status: ${turnStatus || "completed"}).`
                );
              }
            }

            // CHAT-STEER: unconsumed steers returning in done payload
            const unconsumedSteers = activeThreadId
              ? threadStore.consumeSteers(activeThreadId)
              : [];

            await sendEvent({
              type: "done",
              status: turnStatus,
              roundPromptTokens,
              outputTokens: finalOutputTokens,
              isIncomplete: turnStatus === "incomplete" ? true : undefined,
              attachments: turnAttachments.length > 0 ? turnAttachments : undefined,
              diffs: turnDiffs.length > 0 ? turnDiffs : undefined,
              content: cleanedContent,
              thought:
                accumulatedThoughts.length > 0 ? accumulatedThoughts.join("\n\n") : undefined,
              thinkingDurationMs:
                thinkingEndMs !== null ? Math.max(0, thinkingEndMs - turnStartMs) : undefined,
              phaseTimings: {
                contextPrepMs:
                  firstLlmRequestMs !== null
                    ? Math.max(0, firstLlmRequestMs - turnStartMs)
                    : undefined,
                thinkingMs: thinkingMsAcc > 0 ? thinkingMsAcc : undefined,
                toolsMs:
                  traces.reduce(
                    (sum, tr) => sum + (typeof tr.durationMs === "number" ? tr.durationMs : 0),
                    0
                  ) || undefined,
                writingMs: writingMsAcc > 0 ? writingMsAcc : undefined,
              },
              traces,
              model: activeModel,
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

            if (explicitStopped || turnAbortController.signal.aborted) {
              if (activeThreadId && !assistantPersisted) {
                persistAssistantOnAbort();
              }
              return;
            }

            if (activeThreadId && !assistantPersisted) {
              assistantPersisted = true;
              try {
                const turnAttachments = collectTurnAttachments(
                  activeThreadId,
                  threadsDir,
                  turnCreatedFiles
                );
                const turnWorkspaceDiffs = collectTurnModifiedFileDiffs(turnPreImages);
                const turnDiffs = [...turnHostDiffs, ...turnWorkspaceDiffs];

                const errorContent = accumulatedStreamedTokens.trim()
                  ? `${accumulatedStreamedTokens}\n\n⚠️ [Turn error: ${friendlyMessage}]`
                  : `⚠️ [Turn error: ${friendlyMessage}]`;

                const errorMsg = {
                  id: assistantMessageId,
                  role: "assistant" as const,
                  content: errorContent,
                  thought:
                    accumulatedThoughts.length > 0 ? accumulatedThoughts.join("\n\n") : undefined,
                  traces:
                    traces.length > 0
                      ? (traces as unknown as Parameters<ThreadStore["addMessage"]>[1]["traces"])
                      : undefined,
                  attachments: turnAttachments.length > 0 ? turnAttachments : undefined,
                  diffs: turnDiffs.length > 0 ? turnDiffs : undefined,
                  modelUsed: activeModel,
                  selectedModel: requestedModel || activeModel,
                  timestamp: new Date().toISOString(),
                  status: "error" as const,
                };
                threadStore.addMessage(activeThreadId, errorMsg);
              } catch (errSave) {
                console.warn(
                  "[ChatRoute] Failed to persist error assistant message in catch:",
                  errSave
                );
              }
            }

            await sendEvent({
              type: "error",
              error: friendlyMessage,
            });
          } finally {
            runTurnFinallyRan = true;
            clearInterval(heartbeatInterval);
            if (activeThreadId) {
              activeExecutionSet.delete(activeThreadId);
              clearTurnActive(activeThreadId);
              clearTurnAbortController(activeThreadId);
              clearRoundAbortController(activeThreadId);
              threadStore.clearSteers(activeThreadId);
            }
            req.signal.removeEventListener("abort", cleanupClientSignal);

            if (activeThreadId && !assistantPersisted && explicitStopped) {
              persistAssistantOnAbort();
            }
            if (!assistantPersisted) {
              assistantPersisted = true;
            }
            if (!turnAbortController.signal.aborted) {
              turnAbortController.abort();
            }
            for (const session of activeSessions) {
              try {
                await session.client.close();
              } catch {}
            }
            // job-queue-isolation: drain the readable before close so a client that
            // abandoned the stream (no req.signal abort) cannot leave writer.close()
            // blocked on unread chunks — which would stall the serialized job queue.
            startReadableDrain();
            try {
              if (clientDisconnected) {
                // Client gone: abort the stream outright so the serialized queue
                // tail settles even if the readable is locked by an abandoned reader.
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
                        1000
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
          }
        },
      }
    );

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
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
    console.error("[Agent Orchestrator Setup Error]:", err);
    const isEngineStopped =
      errMsg.includes("engine_stopped") ||
      errMsg.includes("LLM engine is stopped") ||
      errMsg.includes("ECONNREFUSED") ||
      errObj?.statusCode === 503;

    const friendlyMessage = isEngineStopped
      ? "LLM engine is stopped. Start it from Settings or the status bar."
      : errMsg || "Internal orchestrator error";

    return NextResponse.json(
      {
        error: friendlyMessage,
        type: isEngineStopped ? "engine_stopped" : undefined,
        traces: [],
      },
      { status: isEngineStopped ? 503 : 500 }
    );
  }
}
