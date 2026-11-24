import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  resolveThreadsDir,
  ThreadStore,
  deriveStoredThreadTitle,
  activeExecutionSet,
  markTurnActive,
  clearTurnActive,
  markTurnQueued,
  clearTurnQueued,
  registerTurnAbortController,
  clearTurnAbortController,
  clearRoundAbortController,
} from "@/lib/threads/threadStore";
import { ThrottledStreamSnapshot } from "@/lib/streamSnapshot";
import { buildFileDeliverablesDirective } from "@/lib/threadOutputs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_SUBAGENT_MODEL,
  AgentMode,
  getModelProfile,
} from "@/config/models";
import { parseAttachment } from "@/lib/fileParser";
import { TelemetryTracer } from "@/lib/telemetry";
import { resolveEffectiveReasoningEffort } from "@/lib/chatUtils";
import { MAX_WEB_RESEARCH_CALLS } from "@/lib/contextBudget";
import { JobQueue } from "@/lib/jobQueue";
import { serializeTurn } from "@/lib/chatTurnGate";
import { getSharedSlotScheduler, SlotPriority } from "@/lib/slotScheduler";
import { getHostSettings } from "@/lib/hostSettings";
import { getLLMProvider } from "@/lib/llm/provider";
import {
  createSseEventWriter,
  buildAbortedAssistantMessage,
  registerTurnSettledPromise,
  runChatTurn,
  type RunChatTurnDeps,
} from "@/lib/chat/turnEngine";
import type { ChatInputMessage, ChatThreadData, RunChatTurnState } from "@/lib/chat/roundLoop";

const getLlmBaseUrl = () =>
  process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";

// job-queue-isolation: single in-app slot — chat job turns execute one at a
// time (FIFO); additional turns queue visibly instead of contending for the
// engine slot. Module-level singleton: one queue per web-ui process.
const chatJobQueue = new JobQueue();
let chatTurnSeq = 0;

// job-queue-isolation: host checkout root used as the chunk-handoff/runlog
// workspace root when no per-turn worktree exists. Same convention as the
// self-deploy pipeline (web-ui may run with cwd at web-ui or repo root);
// HOST_REPO_ROOT overrides explicitly.
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

function resolveChatTurnPriority(
  req: NextRequest,
  dispatchSourceBody: unknown,
  threadData: ChatThreadData | null
): SlotPriority {
  const rawSource = (
    req.headers.get("x-dispatch-source") ||
    (typeof dispatchSourceBody === "string" ? dispatchSourceBody : "")
  )
    .trim()
    .toLowerCase();
  if (rawSource === "board-drain" || rawSource === "board-job") {
    return SlotPriority.P1_BUILDER;
  }
  if (rawSource === "board-reviewer" || rawSource === "orchestrator") {
    return SlotPriority.P2_ORCHESTRATOR;
  }
  if (req.headers.get("x-internal-consumer") === "in-process" && threadData?.boardItemId) {
    return SlotPriority.P1_BUILDER;
  }
  return SlotPriority.P0_OWNER;
}

export async function POST(req: NextRequest) {
  const turnStartMs = Date.now();
  const activeSessions: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];
  const toolClientMap = new Map<
    string,
    { client: Client | null; tier: "sandbox" | "browser" | "workspace" | "host" }
  >();
  let rootSpan: ReturnType<TelemetryTracer["startSpan"]> | null = null;
  let registeredThreadId: string | null = null;
  let registeredThreadsDir: string | undefined = undefined;
  let turnEnqueued = false;

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
      dispatchSource: requestedDispatchSource,
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
    const effectiveReasoningEffort = resolveEffectiveReasoningEffort(
      activeModel,
      requestedReasoning
    );

    const activeThreadId =
      typeof requestedThreadId === "string" && requestedThreadId.trim()
        ? requestedThreadId.trim()
        : null;
    const threadsDir = resolveThreadsDir();
    const threadStore = new ThreadStore(threadsDir);
    let threadData: ChatThreadData | null = null;
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
      registeredThreadId = activeThreadId;
      registeredThreadsDir = threadsDir;

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
      // Stall clock starts at turn execution (not enqueue); mark queued until runChatTurn starts.
      markTurnQueued(activeThreadId, threadsDir);
    }

    // CHAT-8: throttled mid-turn snapshots (status "streaming"), upserted by message id.
    const streamSnapshot = new ThrottledStreamSnapshot(
      threadStore,
      activeThreadId,
      assistantMessageId
    );

    const threadOutputsDir = activeThreadId ? path.join(threadsDir, activeThreadId, "files") : null;
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
- PARALLEL READS: When you need several independent read-only lookups (file reads, greps, tree listings), emit them together in a single tool-call block instead of one call per round; every round carries a fixed engine cost. Keep writes, patches, and deletes one at a time, in order.
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
    const stream = new TransformStream<Uint8Array, Uint8Array>();

    const turnState: RunChatTurnState = {
      activeModel,
      accumulatedStreamedTokens: "",
      assistantPersisted: false,
      lastFinishReason: undefined,
      turnOutputTokens: undefined,
      cumulativeOutputTokens: 0,
      turnCreatedFiles: [],
      turnPreImages: new Map<string, string>(),
      turnHostDiffs: [],
      traces: [],
      turnMicroElisions: [],
      turnReadDedups: [],
      accumulatedThoughts: [],
    };

    let explicitStopped = false;
    const turnAbortController = new AbortController();

    const persistAssistantOnAbort = () => {
      if (!activeThreadId || turnState.assistantPersisted) return;
      turnState.assistantPersisted = true;
      try {
        const abortedMsg = buildAbortedAssistantMessage({
          assistantMessageId,
          activeThreadId,
          threadsDir,
          turnCreatedFiles: turnState.turnCreatedFiles,
          turnPreImages: turnState.turnPreImages,
          turnHostDiffs: turnState.turnHostDiffs,
          explicitStopped,
          turnSignalAborted: turnAbortController.signal.aborted,
          accumulatedStreamedTokens: turnState.accumulatedStreamedTokens,
          accumulatedThoughts: turnState.accumulatedThoughts,
          traces: turnState.traces,
          activeModel: turnState.activeModel,
          requestedModel,
          lastFinishReason: turnState.lastFinishReason,
          turnOutputTokens:
            (turnState.cumulativeOutputTokens ?? 0) > 0
              ? turnState.cumulativeOutputTokens
              : turnState.turnOutputTokens,
          turnStartMs,
          turnMicroElisions: turnState.turnMicroElisions,
          turnReadDedups: turnState.turnReadDedups,
        });
        threadStore.addMessage(activeThreadId, abortedMsg);
      } catch (err) {
        console.warn("[ChatRoute] Failed to persist aborted assistant message:", err);
      }
    };

    if (activeThreadId) {
      registerTurnAbortController(activeThreadId, turnAbortController);
    }

    turnAbortController.signal.addEventListener("abort", () => {
      explicitStopped = true;
      persistAssistantOnAbort();
    });

    const inProcessConsumer = req.headers.get("x-internal-consumer") === "in-process";
    const turnPriority = resolveChatTurnPriority(req, requestedDispatchSource, threadData);

    const sseWriter = createSseEventWriter({
      stream,
      signal: req.signal,
      activeThreadId,
      inProcessConsumer,
    });
    const { sendEvent, cleanupClientSignal } = sseWriter;

    let runTurnStarted = false;
    let runTurnFinallyRan = false;

    const deps: RunChatTurnDeps = {
      reqSignal: req.signal,
      messages: typedMessages,
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
      initialEffectiveReasoningEffort: effectiveReasoningEffort,
      invalidRequestedModel,
      triageComplexityResult,
      getLlmBaseUrl,
      resolveJobRepoRoot,
      streamLlmChat,
      advertisedTools: ADVERTISED_TOOLS,
      activeThreadId,
      threadsDir,
      threadStore,
      initialThreadData: threadData,
      initialThreadHostAccess: threadHostAccess,
      streamSnapshot,
      sseWriter,
      turnAbortController,
      persistAssistantOnAbort,
      onRunTurnStarted: () => {
        runTurnStarted = true;
      },
      onRunTurnFinally: () => {
        runTurnFinallyRan = true;
      },
      isExplicitStopped: () => explicitStopped,
      turnState,
      turnStartMs,
      activeSessions,
      toolClientMap,
      tracer,
      rootSpan,
    };

    // job-queue-isolation: serialize this job turn through the single in-app
    // queue (one turn executes at a time, FIFO). A turn arriving while one is
    // running queues visibly (queue_position event) instead of contending for
    // the slot. Board item #63: NO per-turn git worktree — MCP workspace tools
    // execute against the container's shared /workspace, so a worktree here
    // added git churn without providing isolation. Re-enable repoRoot only
    // when MCP workspace tools accept a workspace-root argument.
    const isBoardJob = turnPriority === SlotPriority.P1_BUILDER || Boolean(threadData?.boardItemId);
    const configuredWorkspaceDir = process.env.WORKSPACE_DIR?.trim();
    const configuredHostCheckout = process.env.HOST_CHECKOUT_PATH?.trim();
    const envThreadsDir = process.env.THREADS_DIR?.trim();
    const usesContainerWorkspace =
      Boolean(configuredWorkspaceDir) ||
      Boolean(envThreadsDir && envThreadsDir.startsWith("/workspace")) ||
      (process.env.NODE_ENV === "production" && !envThreadsDir && fs.existsSync("/workspace"));
    const usesSharedHostCheckout =
      Boolean(configuredHostCheckout) && (threadHostAccess || isBoardJob);
    const sharedWorkspaceKey = usesContainerWorkspace
      ? configuredWorkspaceDir || "/workspace"
      : usesSharedHostCheckout
        ? configuredHostCheckout
        : undefined;

    const turnHandle = serializeTurn(
      chatJobQueue,
      {
        id: `${assistantMessageId}-${process.pid}-${++chatTurnSeq}`,
        threadId: activeThreadId || clientSessionId,
        prompt: userPrompt,
      },
      {
        priority: turnPriority,
        scheduler: getSharedSlotScheduler(),
        signal: turnAbortController.signal,
        ...(sharedWorkspaceKey ? { workspaceKey: sharedWorkspaceKey, sharedWorkspace: true } : {}),
        onQueued: (position) => {
          sendEvent({
            type: "status",
            status: `Queued (position ${position})`,
            queue_position: position,
          });
        },
        onSettled: () => {
          if (runTurnStarted || runTurnFinallyRan) return;
          sseWriter.stopHeartbeat();
          if (activeThreadId) {
            activeExecutionSet.delete(activeThreadId);
            clearTurnActive(activeThreadId);
            clearTurnQueued(activeThreadId, threadsDir);
            clearTurnAbortController(activeThreadId);
            clearRoundAbortController(activeThreadId);
          }
          req.signal.removeEventListener("abort", cleanupClientSignal);
          sseWriter.closeWriterPreStart(1000);
        },
        runTurn: (job, worktree, lease) => runChatTurn(deps, job, worktree, lease),
      }
    );
    turnEnqueued = true;
    if (activeThreadId) {
      registerTurnSettledPromise(activeThreadId, turnHandle.settled);
    }

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (err: unknown) {
    if (registeredThreadId && !turnEnqueued) {
      activeExecutionSet.delete(registeredThreadId);
      clearTurnActive(registeredThreadId);
      clearTurnQueued(registeredThreadId, registeredThreadsDir);
      clearTurnAbortController(registeredThreadId);
      clearRoundAbortController(registeredThreadId);
    }
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
