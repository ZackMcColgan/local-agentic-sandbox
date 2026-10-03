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
import { extractArchitectureSpec } from "@/lib/visionProcessor";
import { TelemetryTracer } from "@/lib/telemetry";
import { parseToolCallsFromText, cleanResidualToolTags, normalizeMcpUrl } from "@/lib/toolParser";
import { computeModelOptions, resolveEffectiveReasoningEffort } from "@/lib/chatUtils";
import { searchOracleCodebase } from "@/lib/oracle/ingestion";
import {
  loadUserProfile,
  formatProfileForContext,
  extractDurablePreferences,
  recordProfileEntry
} from "@/lib/memory/profile";

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
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
 * Lean hierarchical triage classifier using Gemma 4 E4B (~80 tok/s).
 * Classifies incoming prompt into SIMPLE_EXECUTION vs DEEP_SYNTHESIS in < 300ms.
 */
async function triageComplexity(
  userQuery: string,
  ollamaBaseUrl: string,
  triageModel: string = DEFAULT_SUBAGENT_MODEL
): Promise<"SIMPLE_EXECUTION" | "DEEP_SYNTHESIS"> {
  try {
    const res = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
        stream: false,
        keep_alive: "24h",
        options: {
          temperature: 0.1,
          num_ctx: 2048,
          num_predict: 128
        }
      })
    });

    if (!res.ok) {
      return "SIMPLE_EXECUTION";
    }

    const data = await res.json();
    const parsed = JSON.parse(data.message?.content || "{}");
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
 * Async generator for streaming NDJSON chunks from Ollama /api/chat
 */
async function* streamOllamaChat(ollamaUrl: string, payload: any) {
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, stream: true })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama engine returned ${res.status}: ${errText}`);
  }

  if (!res.body) {
    throw new Error("Ollama returned empty response body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const json = JSON.parse(trimmed);
          yield json;
        } catch (err) {
          console.warn("[Ollama Stream] JSON parse error on chunk:", trimmed);
        }
      }
    }

    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer.trim());
      } catch {}
    }
  } finally {
    reader.releaseLock();
  }
}

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
      if (mode === "flash") {
        activeModel = "gemma4:e4b";
      } else if (mode === "pro") {
        activeModel = DEFAULT_PRIMARY_MODEL;
      } else {
        // mode === "auto": Execute fast triage step with OpenTelemetry span
        const triageSpan = tracer.startSpan("router.triage", rootSpan.spanId, { model: "gemma4:e4b" });
        const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
        const userPrompt = lastUserMsg?.content || "";
        triageComplexityResult = await triageComplexity(userPrompt, OLLAMA_URL, "gemma4:e4b");
        triageSpan.end("ok", { result: triageComplexityResult });

        if (triageComplexityResult === "DEEP_SYNTHESIS") {
          activeModel = DEFAULT_PRIMARY_MODEL;
        } else {
          activeModel = "gemma4:e4b";
        }
      }
    }

    // Resolve honest effective reasoning effort
    let effectiveReasoningEffort = resolveEffectiveReasoningEffort(activeModel, requestedReasoning);

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

    // Format tools for Ollama / OpenAI function calling specification
    const ollamaTools = allTools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.inputSchema || {}
      }
    }));

    const SYSTEM_PROMPT = `You are an intelligent autonomous AI engineering platform running on local hardware with Model Context Protocol (MCP) tool integration, workspace automation, and native multimodal support.

You have access to two distinct tool tiers:
1. Web Search & Documentation Scraper (Tier: Browser / Egress Mesh):
   - 'search_web': Search the internet using DuckDuckGo. Automatically fetches and attaches clean markdown for the most informative top result in 'top_result_content'. Use this whenever the user asks about real-time information, latest documentation, weather forecasts, external packages, or general web lookups.
   - 'fetch_webpage_markdown': Fetch any public URL and convert its content into clean markdown. Use this to read documentation, inspect web pages, or scrape articles.

2. Air-Gapped Code Sandbox, Workspace & Git Operations (Tier: Sandbox / AI Mesh):
   - 'workspace_get_tree': Retrieve repository directory tree skipping node_modules and .git.
   - 'workspace_grep': Fast regex/substring search across codebase.
   - 'workspace_read_file': Read files with line numbers.
   - 'workspace_write_file': Atomically write code, Markdown documentation, and SVG vector diagrams (.svg).
   - 'workspace_run_command': Execute commands (pytest, npm test, cargo, bash) and inspect exit codes & stderr.
   - 'git_status' & 'git_diff': Inspect branch status, unstaged changes, and unified diffs.
   - 'git_checkout_branch': Create or switch to an autonomous branch (e.g. agent/feat-xyz).
   - 'git_commit': Commit staged modifications with semantic messages.
   - 'execute_sandboxed_python': Run Python code and test assertions inside a zero-trust, unprivileged Linux container sandbox (cap_drop ALL, read-only rootfs).
   - 'verify_container_provenance': Inspect runtime container security boundaries and SLSA attestations.
   - 'docker_scout_policy_gate': Evaluate container CVE vulnerabilities against security policies.

CRITICAL INSTRUCTIONS:
- TOOL INVOCATION LATENCY & EFFICIENCY:
  - When a query requires tools, invoke the tool call IMMEDIATELY as your first action.
  - DO NOT output extensive conversational filler before calling a tool.
  - Trigger the tool directly so execution starts in the sandbox without delay.
  - Synthesize and reason over the facts AFTER tool results are returned.
- VECTOR DIAGRAMS & ARCHITECTURE DRAWINGS:
  - When asked to draw, design, or provide architecture diagrams, flowcharts, schemas, or vector graphics, prefer pure, self-contained SVG markup (<svg xmlns="http://www.w3.org/2000/svg" viewBox="...">) with explicit shapes and crisp high-contrast styling. Standard Draw.io XML (<mxfile> / <mxGraphModel>) is also fully supported and rendered interactively by the frontend viewer.
  - When saving diagrams via 'workspace_write_file', use '.svg' or '.drawio' as appropriate.
  - Both raw SVG code and Draw.io XML code blocks render as interactive vector graphics directly within the chat UI.
- ZERO-DEFLECTION POLICY FOR IN-CHAT RENDERING:
  - In-chat vector graphic and diagram rendering is a core product promise.
  - You MUST NEVER tell the user "rendering fails on your side", "the SVG viewer has not caught it", "paste into an external viewer", or tell them to use diagrams.net externally.
  - If a diagram does not render as expected, debug it, fix the markup, format the code block properly (\`\`\`svg or \`\`\`xml), or adjust the SVG/XML structure directly. Never deflect to external tools or blame the user's browser.
- LOCAL CODEBASE ORACLE & GROUNDING:
  - The system automatically consults local repository source files and documentation.
  - When local repository context is provided in the prompt context below, ground your answer in those files and cite the file path and line numbers explicitly (e.g. \`web-ui/lib/subagents/supervisor.ts:608-655\`).
  - When no local repository context is provided or the user query is a general knowledge question (e.g. creative writing, haikus, general knowledge, standard facts), answer directly and naturally from your general knowledge. NEVER fabricate imaginary file:line citations when no local context applies.
- When asked to execute or test code, run the appropriate test command or sandbox runner.
- Synthesize all tool results into a thorough, clean Markdown answer for the user.`;

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
          // Run multimodal architecture diagram ingestion via Gemma 4 E4B
          try {
            const archSpec = await extractArchitectureSpec(
              { name: parsed.name, base64: parsed.rawBase64, type: parsed.type },
              OLLAMA_URL,
              "gemma4:e4b"
            );
            docContexts.push(
              `\n\n--- EXTRACTED ARCHITECTURE SPECIFICATION (${parsed.name}) ---\n${archSpec.markdownSpec}\n--- END OF ARCHITECTURE SPECIFICATION ---`
            );
          } catch (err: any) {
            console.warn(`[ChatRoute] Failed to extract architecture spec for ${parsed.name}:`, err.message);
          }
        } else if (parsed.textContent) {
          docContexts.push(
            `\n\n--- ATTACHED DOCUMENT: ${parsed.name} (${parsed.type}) ---\n${parsed.textContent}\n--- END OF ATTACHED DOCUMENT ---`
          );
        }
      }
    }

    // 4. Grounding via Local Repository Oracle (consults local repos/docs)
    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
    const userPrompt = lastUserMsg?.content || "";
    let oracleSnippet = "";
    let oracleCitations: string[] = [];

    // Tier 1 User Profile Memory: Extract & record explicit durable preferences (gated)
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

    if (userPrompt.trim()) {
      try {
        const oracleResult = await searchOracleCodebase(userPrompt);
        if (oracleResult.contextSnippet) {
          oracleSnippet = oracleResult.contextSnippet;
          oracleCitations = oracleResult.citations;
        }
      } catch (err: any) {
        console.warn("[ChatRoute] Oracle retrieval warning:", err.message);
      }
    }

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

    // Create TransformStream for Real-Time SSE Token & Trace Streaming
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    const sendEvent = async (data: any) => {
      try {
        await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      } catch (err) {
        console.warn("[SSE sendEvent error]:", err);
      }
    };

    // Run async orchestrator pipeline in background feeding SSE stream
    (async () => {
      const traces: TraceItem[] = [];
      try {
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

        while (round < MAX_TOOL_ROUNDS) {
          const reasoningSpan = tracer.startSpan("model.reasoning", rootSpan.spanId, {
            model: activeModel,
            round
          });

          const ollamaPayload: any = {
            model: activeModel,
            messages: conversationMessages,
            keep_alive: "24h",
            options: computeModelOptions(activeModel, effectiveReasoningEffort)
          };

          if (ollamaTools.length > 0) {
            ollamaPayload.tools = ollamaTools;
          }

          let fullRoundContent = "";
          let toolCallsFromMessage: any[] = [];

          for await (const chunk of streamOllamaChat(OLLAMA_URL, ollamaPayload)) {
            if (chunk.message?.content) {
              const textChunk = chunk.message.content;
              fullRoundContent += textChunk;
              await sendEvent({ type: "token", content: textChunk });
            }
            if (chunk.message?.tool_calls && Array.isArray(chunk.message.tool_calls)) {
              toolCallsFromMessage.push(...chunk.message.tool_calls);
            }
          }

          reasoningSpan.end("ok");
          currentAssistantMessage = {
            role: "assistant",
            content: fullRoundContent,
            tool_calls: toolCallsFromMessage.length > 0 ? toolCallsFromMessage : undefined
          };

          const toolCalls = getEffectiveToolCalls(currentAssistantMessage);
          if (!toolCalls || toolCalls.length === 0) {
            break;
          }

          round++;
          const assistantMsgToPush = {
            ...currentAssistantMessage,
            tool_calls: toolCalls
          };
          conversationMessages.push(assistantMsgToPush);

          for (const toolCall of toolCalls) {
            const toolName = toolCall.function.name;
            const toolArgs =
              typeof toolCall.function.arguments === "string"
                ? JSON.parse(toolCall.function.arguments)
                : toolCall.function.arguments;

            await sendEvent({
              type: "status",
              status: `Executing tool ${toolName}...`
            });

            const target = toolClientMap.get(toolName);
            if (!target) {
              throw new Error(`Model attempted execution of unregistered tool: ${toolName}`);
            }

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
              content: JSON.stringify(result)
            });

            // Auto-Escalation Check: If 2 consecutive failures on fast engine, escalate to Pro model
            if (
              mode === "auto" &&
              activeModel.includes("gemma4") &&
              consecutiveFailures >= 2
            ) {
              console.log("[Auto-Escalation] 2 consecutive failures detected. Escalating to Pro model (Qwen 3.8 27B)...");
              activeModel = DEFAULT_PRIMARY_MODEL;
              effectiveReasoningEffort = resolveEffectiveReasoningEffort(activeModel, requestedReasoning);
              await sendEvent({
                type: "status",
                status: "Auto-escalating to Pro Reasoning Model (Qwen 27B)..."
              });
              await sendEvent({
                type: "meta",
                model: activeModel,
                reasoning_effort: effectiveReasoningEffort
              });
              conversationMessages.push({
                role: "system",
                content: "[AUTO-ESCALATION]: Fast execution engine encountered 2 consecutive failures. Escalating session to Pro Reasoning Engine (Qwen 3.8 27B) for deep architectural root-cause diagnosis and code synthesis."
              });
            }
          }
        }

        // Post-tool synthesis safety pass if lingering tool calls or empty text:
        const lingeringToolCalls = getEffectiveToolCalls(currentAssistantMessage);
        if ((traces.length > 0 && lingeringToolCalls.length > 0) || !currentAssistantMessage.content?.trim()) {
          const synthSpan = tracer.startSpan("model.synthesis", rootSpan.spanId, { model: activeModel });
          conversationMessages.push(currentAssistantMessage);
          conversationMessages.push({
            role: "user",
            content: "Now synthesize all the tool results above into a complete, clear, direct Markdown answer for the user. Do not invoke any more tools."
          });

          await sendEvent({
            type: "status",
            status: "Synthesizing final answer..."
          });

          let synthContent = "";
          for await (const chunk of streamOllamaChat(OLLAMA_URL, {
            model: activeModel,
            messages: conversationMessages,
            options: computeModelOptions(activeModel, effectiveReasoningEffort)
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
        await sendEvent({
          type: "error",
          error: err.message || "Internal orchestrator error"
        });
      } finally {
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
    return NextResponse.json(
      {
        error: err.message || "Internal orchestrator error",
        traces: []
      },
      { status: 500 }
    );
  }
}
