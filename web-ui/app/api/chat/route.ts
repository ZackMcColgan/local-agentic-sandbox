import { NextRequest, NextResponse } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_SUBAGENT_MODEL,
  AgentMode,
  AGENT_MODES,
  isReasoningEffortSupported
} from "@/config/models";
import { parseAttachment } from "@/lib/fileParser";
import { TelemetryTracer } from "@/lib/telemetry";
import { parseToolCallsFromText, cleanResidualToolTags, normalizeMcpUrl } from "@/lib/toolParser";
import {
  computeModelOptions,
  resolveEffectiveReasoningEffort,
  shouldConsultLocalOracle,
  parseThinkingAndContent
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
  isLiveRealTimeIntent
} from "@/lib/contextBudget";
import { searchOracleCodebase } from "@/lib/oracle/ingestion";
import {
  DESCRIBE_TOOL_NAME,
  buildLayer1Tools,
  buildToolRegistry,
  describeTool
} from "@/lib/progressiveTools";
import { compactConversationHistory } from "@/lib/conversationCompaction";
import {
  loadUserProfile,
  formatProfileForContext,
  extractDurablePreferences,
  recordProfileEntry
} from "@/lib/memory/profile";
import { getLLMProvider } from "@/lib/llm/provider";
import {
  evaluateSearchQueryAttempt,
  shouldInjectHonestAbort,
  HONEST_ABORT_DIRECTIVE
} from "@/lib/grounding";

const LLM_BASE_URL = process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const OLLAMA_URL = LLM_BASE_URL; // backward-compat alias
const MCP_URL = process.env.MCP_SERVER_URL || "http://mcp-server:8080/sse";
const BROWSER_MCP_URL = process.env.BROWSER_MCP_URL || "http://browser-mcp:8081/sse";
const DEFAULT_MODEL = process.env.MODEL_NAME || DEFAULT_PRIMARY_MODEL;

interface TraceItem {
  tool: string;
  args: Record<string, any>;
  result: any;
  durationMs: number;
  timestamp: string;
  model: string;
  tier?: "sandbox" | "browser" | "workspace";
}

async function connectMcpClient(url: string, name: string) {
  const sseUrl = normalizeMcpUrl(url);
  try {
    const transport = new SSEClientTransport(new URL(sseUrl));
    const client = new Client(
      { name, version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(transport);
    const toolsResult = await client.listTools();
    console.log(`[Orchestrator] Connected to MCP (${name}) at ${sseUrl} with ${toolsResult.tools.length} tools`);
    return { client, transport, tools: toolsResult.tools };
  } catch (err: any) {
    console.warn(`[Orchestrator] Could not connect to MCP at ${sseUrl}:`, err.message);
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
Output JSON strictly: {"complexity": "SIMPLE_EXECUTION" | "DEEP_SYNTHESIS", "reasoning": "brief explanation"}`
        },
        {
          role: "user",
          content: userQuery
        }
      ],
      format: "json",
      keep_alive: "24h",
      options: {
        temperature: 0.1,
        num_ctx: 2048,
        num_predict: 128
      }
    });

    const rawContent = (data.message?.content || "{}").replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
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
async function* streamLlmChat(llmBaseUrl: string, payload: any) {
  const provider = getLLMProvider();
  yield* provider.streamChat(llmBaseUrl, payload);
}

// Backward-compat alias
const streamOllamaChat = streamLlmChat;

export async function POST(req: NextRequest) {
  const activeSessions: Array<{ client: Client; transport: SSEClientTransport }> = [];
  const toolClientMap = new Map<string, { client: Client; tier: "sandbox" | "browser" | "workspace" }>();
  let rootSpan: any = null;

  try {
    const {
      messages,
      model: requestedModel,
      mode: requestedMode,
      reasoning_effort: requestedReasoning,
      attachments
    } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Invalid messages payload" }, { status: 400 });
    }

    const mode: AgentMode = requestedMode || "auto";

    // Initialize OpenTelemetry Distributed Tracer
    const clientSessionId = req.headers.get("x-session-id") || `turn_${Date.now()}`;
    const tracer = new TelemetryTracer(clientSessionId);
    rootSpan = tracer.startSpan("agent.turn", undefined, {
      mode,
      requestedModel: requestedModel || "auto",
      messagesCount: messages.length
    });

    // 1. Resolve Active Model via Tri-Mode Dispatcher
    let activeModel = requestedModel;
    let triageComplexityResult: "SIMPLE_EXECUTION" | "DEEP_SYNTHESIS" | null = null;

    if (!activeModel || activeModel === "auto") {
      // Zero VRAM eviction: auto, flash, and pro modes route directly to DEFAULT_PRIMARY_MODEL
      activeModel = DEFAULT_PRIMARY_MODEL;
    }

    // Resolve honest effective reasoning effort
    let effectiveReasoningEffort = resolveEffectiveReasoningEffort(activeModel, requestedReasoning);

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
  - Maximum 3 web research calls ('search_web' or 'fetch_webpage_markdown') per turn. As soon as you have the core facts (typically 1-2 searches), STOP searching immediately and produce the requested deliverable or final answer. Never loop on redundant web searches.
  - When asked to create, draw, or generate an SVG, diagram, or visual card in chat, output the complete <svg xmlns="http://www.w3.org/2000/svg" viewBox="...">...</svg> directly in a \`\`\`svg fenced code block in your response. Do NOT call 'workspace_write_file' for chat SVGs unless the user explicitly asks to save a file to disk, and NEVER output the full SVG twice.
- GROUNDING & HONESTY RULE:
  - Never state, claim, or imply you checked real-time data (weather, live prices, news, web pages) unless you executed a 'search_web' or 'fetch_webpage_markdown' tool call in this turn.
  - If you did not call a search tool, state plainly that you do not have live data and offer to look it up. Never invent or hallucinate live metrics or web lookup results.
- REAL-TIME & LIVE DATA RESEARCH GUIDANCE:
  - When the user asks about live, real-time, or current data (e.g. current weather, temperatures, latest news, breaking updates, package versions), invoke 'search_web' as your first action before producing your response.`;

    let effortDirective = "";
    if (effectiveReasoningEffort === "low") {
      effortDirective = "\n\nREASONING EFFORT: FAST / DIRECT. Provide direct, concise answers without <think> tags or verbose preamble. Call tools immediately.";
    } else if (effectiveReasoningEffort === "xhigh") {
      effortDirective = "\n\nREASONING EFFORT: DEEP. Think deeply step-by-step before answering.";
    } else if (effectiveReasoningEffort === "medium") {
      effortDirective = "\n\nREASONING EFFORT: BALANCED. Keep reasoning concise before executing tools.";
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

    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
    const userPrompt = lastUserMsg?.content || "";
    const priorUserMsg = [...messages].reverse().filter((m: any) => m.role === "user")[1];
    const priorUserPrompt: string = typeof priorUserMsg?.content === "string" ? priorUserMsg.content : "";

    // Create TransformStream for Real-Time SSE Token & Trace Streaming
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    let aborted = false;
    const abortController = new AbortController();
    const cleanupSignal = () => {
      aborted = true;
      clearInterval(heartbeatInterval);
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    };
    req.signal.addEventListener("abort", cleanupSignal);

    const sendEvent = async (data: any) => {
      if (aborted || req.signal.aborted) {
        clearInterval(heartbeatInterval);
        return;
      }
      try {
        await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      } catch (err: any) {
        clearInterval(heartbeatInterval);
        aborted = true;
        if (!req.signal.aborted) {
          console.warn("[SSE sendEvent error]:", err?.message || err);
        }
      }
    };

    const heartbeatInterval = setInterval(() => {
      if (aborted || req.signal.aborted) {
        clearInterval(heartbeatInterval);
        return;
      }
      sendEvent({ type: "ping", ts: Date.now() }).catch(() => {
        clearInterval(heartbeatInterval);
      });
    }, 10_000);

    // Run async orchestrator pipeline in background feeding SSE stream
    (async () => {
      const traces: TraceItem[] = [];
      let accumulatedThoughts: string[] = [];
      let oracleSnippet = "";
      let oracleCitations: string[] = [];

      try {
        await sendEvent({
          type: "status",
          status: "Preparing context & tools..."
        });

        // 1. Gated Oracle Codebase & Semantic Memory Lookup with 2500ms timeout
        if (userPrompt.trim() && shouldConsultLocalOracle(userPrompt)) {
          try {
            const timeoutPromise = new Promise<{ contextSnippet: string; citations: string[] }>((resolve) =>
              setTimeout(() => resolve({ contextSnippet: "", citations: [] }), 2500)
            );
            const ragPromise = (async () => {
              const oracleResult = await searchOracleCodebase(userPrompt);
              return {
                contextSnippet: oracleResult.contextSnippet || "",
                citations: oracleResult.citations || []
              };
            })();

            const lookupResult = await Promise.race([ragPromise, timeoutPromise]);
            if (lookupResult.contextSnippet) {
              oracleSnippet = lookupResult.contextSnippet;
              oracleCitations = lookupResult.citations;
            }
          } catch (err: any) {
            console.warn("[ChatRoute] Oracle codebase retrieval warning:", err.message);
          }
        }

        // Tier 1 User Profile Memory
        if (userPrompt.trim()) {
          try {
            const durableFacts = extractDurablePreferences(userPrompt, clientSessionId);
            for (const fact of durableFacts) {
              recordProfileEntry(fact.key, fact.value, {
                sessionId: clientSessionId,
                origin: fact.origin
              });
            }
          } catch (err: any) {
            console.warn("[ChatRoute] Failed to record durable preferences:", err.message);
          }
        }

        // 2. Connect to Sandboxed Code-Runner / Workspace MCP
        const sandboxSession = await connectMcpClient(MCP_URL, "orchestrator-sandbox-client");
        if (sandboxSession) {
          activeSessions.push(sandboxSession);
          for (const t of sandboxSession.tools) {
            toolClientMap.set(t.name, { client: sandboxSession.client, tier: "sandbox" });
          }
        }

        // 3. Connect to Isolated Browser/Scraper MCP
        const browserSession = await connectMcpClient(BROWSER_MCP_URL, "orchestrator-browser-client");
        if (browserSession) {
          activeSessions.push(browserSession);
          for (const t of browserSession.tools) {
            toolClientMap.set(t.name, { client: browserSession.client, tier: "browser" });
          }
        }

        const allTools = [
          ...(sandboxSession?.tools || []),
          ...(browserSession?.tools || [])
        ];

        const toolRegistry = buildToolRegistry(allTools);
        const llmTools = buildLayer1Tools(allTools);

        const conversationMessages = [...messages];
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

        if (!conversationMessages.some((m: any) => m.role === "system")) {
          conversationMessages.unshift({
            role: "system",
            content: SYSTEM_PROMPT + profileContext + effortDirective
          });
        } else {
          const sysIdx = conversationMessages.findIndex((m: any) => m.role === "system");
          conversationMessages[sysIdx].content += profileContext;
        }

        // Helper to detect tool calls from message.tool_calls OR XML / JSON blocks
        const getEffectiveToolCalls = (msg: any) => {
          if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            return msg.tool_calls;
          }
          return parseToolCallsFromText(msg.content, toolClientMap);
        };

        // Send initial metadata
        await sendEvent({
          type: "meta",
          model: activeModel,
          mode,
          reasoning_effort: effectiveReasoningEffort,
          triage: triageComplexityResult,
          citations: oracleCitations
        });

        let currentAssistantMessage: any = { role: "assistant", content: "" };
        let round = 0;
        const MAX_TOOL_ROUNDS = 8;
        let consecutiveFailures = 0;
        let webResearchCalls = 0;
        let webBudgetNoticeAdded = false;
        let groundingEnforced = false;
        let honestAbortInjected = false;
        let searchNudges = 0;

        let accumulatedThoughts: string[] = [];

        const { isArtifactRequest } = hasArtifactCreationIntent(userPrompt);

        while (round < MAX_TOOL_ROUNDS) {
          if (aborted || req.signal.aborted) break;

          const compaction = compactConversationHistory(conversationMessages, { maxContentTokens: 6000 });
          if (compaction.compacted) {
            conversationMessages.length = 0;
            conversationMessages.push(...compaction.messages);
          }

          const reasoningSpan = tracer.startSpan("model.reasoning", rootSpan.spanId, {
            model: activeModel,
            round
          });

          const isFinalRound = round === MAX_TOOL_ROUNDS - 1;
          // Final round forced synthesis: prompt model to synthesize answer and omit tools
          if (isFinalRound) {
            mergeSystemDirective(conversationMessages, buildSynthesisDirective(userPrompt, true));
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
            hasCompletedToolCalls: traces.length > 0
          });

          const llmPayload: any = {
            model: activeModel,
            messages: fitContextWindow(conversationMessages, {
              tools: isFinalRound ? undefined : roundTools,
              isArtifactTurn: isArtifactRequest
            }),
            keep_alive: -1,
            signal: abortController.signal,
            reasoning_effort: roundOptions.reasoning_effort,
            options: roundOptions
          };

          if (roundTools.length > 0 && round < MAX_TOOL_ROUNDS - 1) {
            llmPayload.tools = roundTools;
          }

          let fullRoundContent = "";
          let roundThinking = "";
          let toolCallsFromMessage: any[] = [];

          for await (const chunk of streamLlmChat(LLM_BASE_URL, llmPayload)) {
            if (chunk.message?.thinking) {
              roundThinking += chunk.message.thinking;
              await sendEvent({ type: "thought", thought: roundThinking });
            }
            if (chunk.message?.content) {
              const textChunk = chunk.message.content;
              fullRoundContent += textChunk;
              await sendEvent({ type: "token", content: textChunk });
            }
            if (chunk.message?.tool_calls && Array.isArray(chunk.message.tool_calls)) {
              toolCallsFromMessage.push(...chunk.message.tool_calls);
            }
          }

          if (roundThinking.trim()) {
            accumulatedThoughts.push(roundThinking.trim());
          }

          reasoningSpan.end("ok");
          currentAssistantMessage = {
            role: "assistant",
            content: fullRoundContent,
            tool_calls: toolCallsFromMessage.length > 0 ? toolCallsFromMessage : undefined
          };

          const rawToolCalls = getEffectiveToolCalls(currentAssistantMessage);
          const seenKeys = new Set<string>();
          const toolCalls = (rawToolCalls || []).filter((tc: any) => {
            const key = tc.id || `${tc.function?.name}:${typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {})}`;
            if (seenKeys.has(key)) return false;
            seenKeys.add(key);
            return true;
          });

          if (!toolCalls || toolCalls.length === 0) {
            if (
              isLiveRealTimeIntent(userPrompt) &&
              webResearchCalls === 0 &&
              round < MAX_TOOL_ROUNDS - 1 &&
              !groundingEnforced
            ) {
              groundingEnforced = true;
              mergeSystemDirective(
                conversationMessages,
                `[GROUNDING ENFORCEMENT]: You need current/real-time information before answering. Formulate the web search query YOURSELF: concise, the information need only. Resolve references from the conversation ("the day" means today, "there"/"it" means the place or topic already discussed -- carry place names like "Spanish Fort AL" forward). Never use the user's instructions, formatting requests, or meta-questions as the query. Only invoke search_web when you genuinely need external data -- do not search questions about the conversation itself. Invoke 'search_web' with your formulated query now. Do not hallucinate or claim you searched without invoking 'search_web'.`
              );
              round++;
              continue;
            }
            break;
          }

          if (accumulatedThoughts.length > 0) {
            await sendEvent({
              type: "thought",
              thought: accumulatedThoughts.join("\n\n")
            });
          }

          round++;
          const assistantMsgToPush = {
            ...currentAssistantMessage,
            tool_calls: toolCalls
          };
          conversationMessages.push(assistantMsgToPush);

          let searchBlocked = false;

          for (const toolCall of toolCalls) {
            if (aborted || req.signal.aborted) break;
            const toolName = toolCall.function.name;
            let toolArgs: Record<string, any> = {};
            if (typeof toolCall.function.arguments === "string") {
              try {
                toolArgs = toolCall.function.arguments.trim()
                  ? JSON.parse(toolCall.function.arguments)
                  : {};
              } catch {
                toolArgs = {};
              }
            } else if (toolCall.function.arguments && typeof toolCall.function.arguments === "object") {
              toolArgs = { ...toolCall.function.arguments };
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
                  name: toolName,
                  content: JSON.stringify({
                    status: "RETRY_REQUIRED",
                    message: evalResult.message
                  })
                });
                mergeSystemDirective(conversationMessages, `[QUERY REVISION REQUIRED]: ${evalResult.message}`);
                await sendEvent({
                  type: "status",
                  status: "Revising search query..."
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
                    error: evalResult.message
                  })
                });
                await sendEvent({
                  type: "status",
                  status: "Search query blocked"
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
                toolArgs.url = toolArgs.url.trim();
                if (!/^https?:\/\//i.test(toolArgs.url)) {
                  toolArgs.url = `https://${toolArgs.url}`;
                }
              }
            } else if (toolName === "workspace_read_file") {
              if (!toolArgs.path || typeof toolArgs.path !== "string" || !toolArgs.path.trim()) {
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
              if (!toolArgs.command || typeof toolArgs.command !== "string" || !toolArgs.command.trim()) {
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

            if (toolName === DESCRIBE_TOOL_NAME) {
              const targetTool = toolArgs.tool_name || toolArgs.name;
              const toolDesc = describeTool(targetTool, toolRegistry);
              conversationMessages.push({
                role: "tool",
                name: DESCRIBE_TOOL_NAME,
                content: JSON.stringify(toolDesc)
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
                  tier: "workspace"
                }
              });
              continue;
            }

            const target = toolClientMap.get(toolName);
            if (!target) {
              throw new Error(`Model attempted execution of unregistered tool: ${toolName}`);
            }

            if (isWebResearchTool(toolName, target.tier)) {
              if (webResearchCalls >= MAX_WEB_RESEARCH_CALLS) {
                conversationMessages.push({
                  role: "tool",
                  name: toolName,
                  content: WEB_BUDGET_EXHAUSTED_DIRECTIVE
                });
                continue;
              }
              webResearchCalls++;
            }

            await sendEvent({
              type: "status",
              status: `Executing tool ${toolName}...`
            });

            const toolSpan = tracer.startSpan("mcp.tool_call", rootSpan.spanId, {
              tool: toolName,
              tier: target.tier
            });

            let bashSpan: any = null;
            if (toolName === "workspace_run_command" || toolName === "execute_sandboxed_python") {
              bashSpan = tracer.startSpan("sandbox.bash_exec", toolSpan.spanId, {
                command: toolArgs.command || (toolArgs.code ? toolArgs.code.slice(0, 100) : "python")
              });
            }

            const startTime = performance.now();
            const result = await target.client.callTool({
              name: toolName,
              arguments: toolArgs
            });
            const durationMs = Math.round(performance.now() - startTime);

            // Track test / command failure for auto-escalation
            let isExecutionError = false;
            try {
              const resultStr = JSON.stringify(result);
              if (
                resultStr.includes('"status":"EXECUTION_ERROR"') ||
                resultStr.includes('"exit_code":1') ||
                (result as any).isError
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
              tier: target.tier
            };
            traces.push(traceItem);

            await sendEvent({
              type: "trace",
              trace: traceItem
            });

            conversationMessages.push({
              role: "tool",
              name: toolName,
              content: clampToolOutput(JSON.stringify(result))
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
                mergeSystemDirective(conversationMessages, buildSynthesisDirective(userPrompt, false));
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
              console.log("[Auto-Escalation] 2 consecutive failures detected. Escalating to Primary model...");
              activeModel = DEFAULT_PRIMARY_MODEL;
              effectiveReasoningEffort = resolveEffectiveReasoningEffort(activeModel, requestedReasoning);
              await sendEvent({
                type: "status",
                status: "Auto-escalating to Pro Reasoning Model..."
              });
              await sendEvent({
                type: "meta",
                model: activeModel,
                reasoning_effort: effectiveReasoningEffort
              });
              mergeSystemDirective(
                conversationMessages,
                "[AUTO-ESCALATION]: Execution engine encountered 2 consecutive failures. Escalating session to Primary Reasoning Engine for deep architectural root-cause diagnosis and code synthesis."
              );
            }
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
                tier: "ORCHESTRATOR"
              }
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
              tier: "ORCHESTRATOR"
            }
          });
        }

        // Post-tool synthesis safety pass if lingering tool calls, missing artifact, or empty text:
        const lingeringToolCalls = getEffectiveToolCalls(currentAssistantMessage);
        if (
          shouldRunPostToolSynthesis({
            userPrompt,
            assistantContent: currentAssistantMessage.content || "",
            lingeringToolCallsCount: lingeringToolCalls.length,
            traces
          })
        ) {
          const synthSpan = tracer.startSpan("model.synthesis", rootSpan.spanId, { model: activeModel });
          conversationMessages.push(currentAssistantMessage);
          conversationMessages.push({
            role: "user",
            content: buildSynthesisDirective(userPrompt, false)
          });

          await sendEvent({
            type: "status",
            status: "Synthesizing final answer..."
          });

          if (isArtifactRequest) {
            mergeSystemDirective(conversationMessages, OUTPUT_HEADROOM_THINKING_DIRECTIVE);
          }

          let synthContent = "";
          const synthOptions = resolveRoundModelOptions({
            model: activeModel,
            requestedEffort: effectiveReasoningEffort,
            userPrompt,
            isSynthesisOrFinalRound: true,
            hasCompletedToolCalls: traces.length > 0
          });

          for await (const chunk of streamLlmChat(LLM_BASE_URL, {
            model: activeModel,
            messages: fitContextWindow(conversationMessages, { isArtifactTurn: isArtifactRequest }),
            signal: abortController.signal,
            reasoning_effort: synthOptions.reasoning_effort,
            options: synthOptions
          })) {
            if (chunk.message?.content) {
              synthContent += chunk.message.content;
              await sendEvent({ type: "token", content: chunk.message.content });
            }
          }

          if (synthContent.trim()) {
            currentAssistantMessage = { role: "assistant", content: synthContent };
          }
          synthSpan.end("ok");
        }

        // Clean residual tool tags
        let cleanedContent = cleanResidualToolTags(currentAssistantMessage.content || "");

        if (!cleanedContent) {
          if (traces.length > 0) {
            cleanedContent = `Executed ${traces.map(t => t.tool).join(", ")}.`;
          } else if (currentAssistantMessage.content?.trim()) {
            cleanedContent = currentAssistantMessage.content.trim();
          } else {
            cleanedContent = "I am ready to assist you. What would you like to build or explore?";
          }
        }

        rootSpan.end("ok", {
          tracesCount: traces.length,
          modelUsed: activeModel
        });

        await sendEvent({
          type: "done",
          content: cleanedContent,
          thought: accumulatedThoughts.length > 0 ? accumulatedThoughts.join("\n\n") : undefined,
          traces,
          model: activeModel,
          mode,
          reasoning_effort: effectiveReasoningEffort,
          triage: triageComplexityResult,
          trace_session: {
            sessionId: tracer.getSessionId(),
            traceId: tracer.getTraceId()
          }
        });

      } catch (err: any) {
        if (rootSpan) {
          try {
            rootSpan.end("error", { error: err.message });
          } catch {}
        }
        console.error("[Agent Orchestrator Streaming Error]:", err);
        const errMsg = String(err?.message || "");
        const isEngineStopped =
          errMsg.includes("engine_stopped") ||
          errMsg.includes("LLM engine is stopped") ||
          errMsg.includes("ECONNREFUSED") ||
          err?.statusCode === 503;

        const friendlyMessage = isEngineStopped
          ? "LLM engine is stopped. Start it from Settings or the status bar."
          : (err.message || "Internal orchestrator error");

        await sendEvent({
          type: "error",
          error: friendlyMessage
        });
      } finally {
        clearInterval(heartbeatInterval);
        req.signal.removeEventListener("abort", cleanupSignal);
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
        for (const session of activeSessions) {
          try {
            await session.client.close();
          } catch {}
        }
        try {
          await writer.close();
        } catch {}
      }
    })();

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive"
      }
    });

  } catch (err: any) {
    if (rootSpan) {
      try {
        rootSpan.end("error", { error: err.message });
      } catch {}
    }
    console.error("[Agent Orchestrator Setup Error]:", err);
    const errMsg = String(err?.message || "");
    const isEngineStopped =
      errMsg.includes("engine_stopped") ||
      errMsg.includes("LLM engine is stopped") ||
      errMsg.includes("ECONNREFUSED") ||
      err?.statusCode === 503;

    const friendlyMessage = isEngineStopped
      ? "LLM engine is stopped. Start it from Settings or the status bar."
      : (err.message || "Internal orchestrator error");

    return NextResponse.json(
      {
        error: friendlyMessage,
        type: isEngineStopped ? "engine_stopped" : undefined,
        traces: []
      },
      { status: isEngineStopped ? 503 : 500 }
    );
  }
}
