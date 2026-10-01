import { NextRequest, NextResponse } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_SUBAGENT_MODEL,
  AgentMode,
  AGENT_MODES
} from "@/config/models";
import { parseAttachment } from "@/lib/fileParser";
import { extractArchitectureSpec } from "@/lib/visionProcessor";
import { TelemetryTracer } from "@/lib/telemetry";

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
  try {
    const transport = new SSEClientTransport(new URL(url));
    const client = new Client(
      { name, version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(transport);
    const toolsResult = await client.listTools();
    return { client, transport, tools: toolsResult.tools };
  } catch (err: any) {
    console.warn(`[Orchestrator] Could not connect to MCP at ${url}:`, err.message);
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

    const reasoningEffort = requestedReasoning || (activeModel.includes("qwen3.8") ? "medium" : "low");

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
   - 'workspace_write_file': Atomically write code, Markdown documentation, and .drawio.svg diagrams.
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
- When asked to execute or test code, run the appropriate test command or sandbox runner.
- Synthesize all tool results into a thorough, clean Markdown answer for the user.`;

    let effortDirective = "";
    if (reasoningEffort === "low") {
      effortDirective = "\n\nREASONING EFFORT: FAST / DIRECT. Provide direct, concise answers without <think> tags or verbose preamble. Call tools immediately.";
    } else if (reasoningEffort === "xhigh") {
      effortDirective = "\n\nREASONING EFFORT: DEEP. Think deeply step-by-step before answering.";
    } else {
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
      conversationMessages[lastIdx] = lastMsg;
    }

    if (!conversationMessages.some((m: any) => m.role === "system")) {
      conversationMessages.unshift({
        role: "system",
        content: SYSTEM_PROMPT + effortDirective
      });
    }

    const computeOptions = (modelToUse: string) => {
      const opts: any = {};
      opts.num_ctx = modelToUse.includes("gemma4") ? 16384 : 8192;
      if (reasoningEffort === "low") {
        opts.temperature = 0.2;
        opts.num_predict = 4096;
      } else if (reasoningEffort === "xhigh") {
        opts.temperature = 0.7;
        opts.num_predict = 8192;
      } else {
        opts.temperature = 0.5;
        opts.num_predict = 4096;
      }
      if (modelToUse.includes("qwen3.8")) {
        opts.reasoning_effort = reasoningEffort;
      }
      return opts;
    };

    // Step 1: Initial query to Ollama with OpenTelemetry reasoning span
    const reasoningSpan = tracer.startSpan("model.reasoning", rootSpan.spanId, {
      model: activeModel,
      round: 0
    });

    const ollamaPayload: any = {
      model: activeModel,
      messages: conversationMessages,
      stream: false,
      options: computeOptions(activeModel)
    };

    if (ollamaTools.length > 0) {
      ollamaPayload.tools = ollamaTools;
    }

    const aiRes = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ollamaPayload)
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      reasoningSpan.end("error", { error: errText });
      throw new Error(`Ollama engine returned ${aiRes.status}: ${errText}`);
    }

    const aiData = await aiRes.json();
    reasoningSpan.end("ok");
    const assistantMessage = aiData.message;
    const traces: TraceItem[] = [];

    // Helper to detect tool calls from message.tool_calls OR XML / JSON blocks
    const getEffectiveToolCalls = (msg: any) => {
      if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        return msg.tool_calls;
      }
      if (!msg.content || typeof msg.content !== "string") {
        return [];
      }

      const content = msg.content;
      const extractedCalls: any[] = [];

      // 1. Qwen XML syntax: <function=NAME>...</function>
      const funcRegex = /<function(?:=|\s+name=)[\"']?([a-zA-Z0-9_\-]+)[\"']?>([\s\S]*?)<\/function>/gi;
      let match;
      while ((match = funcRegex.exec(content)) !== null) {
        const name = match[1].trim();
        const paramsBlock = match[2];
        const args: Record<string, any> = {};
        const paramRegex = /<parameter(?:=|\s+name=)[\"']?([a-zA-Z0-9_\-]+)[\"']?>([\s\S]*?)<\/parameter>/gi;
        let pMatch;
        while ((pMatch = paramRegex.exec(paramsBlock)) !== null) {
          const key = pMatch[1].trim();
          const rawVal = pMatch[2].trim();
          try {
            args[key] = JSON.parse(rawVal);
          } catch {
            args[key] = rawVal;
          }
        }
        if (toolClientMap.has(name)) {
          extractedCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            type: "function",
            function: { name, arguments: args }
          });
        }
      }
      if (extractedCalls.length > 0) {
        return extractedCalls;
      }

      // 2. Qwen JSON inside <tool_call>...</tool_call>
      const toolCallBlockRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
      let blockMatch;
      while ((blockMatch = toolCallBlockRegex.exec(content)) !== null) {
        const inner = blockMatch[1].trim();
        try {
          const parsed = JSON.parse(inner);
          if (parsed && typeof parsed === "object" && parsed.name && toolClientMap.has(parsed.name)) {
            extractedCalls.push({
              id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              type: "function",
              function: {
                name: parsed.name,
                arguments: parsed.arguments || {}
              }
            });
          }
        } catch {}
      }
      if (extractedCalls.length > 0) {
        return extractedCalls;
      }

      // 3. Code block ```json ... ```
      const codeBlockMatches = Array.from(content.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi));
      for (const match of codeBlockMatches) {
        try {
          const parsed = JSON.parse((match as RegExpMatchArray)[1].trim());
          if (parsed && typeof parsed === "object" && parsed.name && toolClientMap.has(parsed.name)) {
            return [{
              id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              type: "function",
              function: {
                name: parsed.name,
                arguments: parsed.arguments || {}
              }
            }];
          }
        } catch {}
      }

      // 4. Raw JSON object fallback
      const jsonMatch = content.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0].trim());
          if (parsed && typeof parsed === "object" && parsed.name && toolClientMap.has(parsed.name)) {
            return [{
              id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              type: "function",
              function: {
                name: parsed.name,
                arguments: parsed.arguments || {}
              }
            }];
          }
        } catch {}
      }

      return [];
    };

    // Step 2: Handle Autonomous Multi-Round Tool Execution Loop
    let currentAssistantMessage = assistantMessage;
    let round = 0;
    const MAX_TOOL_ROUNDS = 8;
    let consecutiveFailures = 0;

    while (round < MAX_TOOL_ROUNDS) {
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

        traces.push({
          tool: toolName,
          args: toolArgs,
          result,
          durationMs,
          timestamp: new Date().toISOString(),
          model: activeModel,
          tier: target.tier
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
          conversationMessages.push({
            role: "system",
            content: "[AUTO-ESCALATION]: Fast execution engine encountered 2 consecutive failures. Escalating session to Pro Reasoning Engine (Qwen 3.8 27B) for deep architectural root-cause diagnosis and code synthesis."
          });
        }
      }

      // Query model with updated tool results
      const nextPayload: any = {
        model: activeModel,
        messages: conversationMessages,
        stream: false
      };

      if (round < MAX_TOOL_ROUNDS && ollamaTools.length > 0) {
        nextPayload.tools = ollamaTools;
      }

      nextPayload.options = computeOptions(activeModel);

      const nextReasoningSpan = tracer.startSpan("model.reasoning", rootSpan.spanId, {
        model: activeModel,
        round
      });

      const nextRes = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextPayload)
      });

      if (!nextRes.ok) {
        nextReasoningSpan.end("error");
        throw new Error(`Ollama synthesis failed: ${await nextRes.text()}`);
      }

      const nextData = await nextRes.json();
      nextReasoningSpan.end("ok");
      currentAssistantMessage = nextData.message;
    }

    // Post-tool synthesis safety pass:
    const lingeringToolCalls = getEffectiveToolCalls(currentAssistantMessage);
    if ((traces.length > 0 && lingeringToolCalls.length > 0) || !currentAssistantMessage.content?.trim()) {
      const synthSpan = tracer.startSpan("model.synthesis", rootSpan.spanId, { model: activeModel });
      conversationMessages.push(currentAssistantMessage);
      conversationMessages.push({
        role: "user",
        content: "Now synthesize all the tool results above into a complete, clear, direct Markdown answer for the user. Do not invoke any more tools."
      });

      const finalRes = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: activeModel,
          messages: conversationMessages,
          stream: false,
          options: computeOptions(activeModel)
        })
      });

      if (finalRes.ok) {
        const finalData = await finalRes.json();
        if (finalData.message?.content?.trim()) {
          currentAssistantMessage = finalData.message;
        }
      }
      synthSpan.end("ok");
    }

    // Clean residual tool tags
    let cleanedContent = (currentAssistantMessage.content || "")
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
      .replace(/<function(?:=|\s+name=)[\"']?[a-zA-Z0-9_\-]+[\"']?>[\s\S]*?<\/function>/gi, "")
      .trim();

    if (!cleanedContent && traces.length > 0) {
      cleanedContent = `Executed ${traces.map(t => t.tool).join(", ")}.`;
    }

    rootSpan.end("ok", {
      tracesCount: traces.length,
      modelUsed: activeModel
    });

    return NextResponse.json({
      content: cleanedContent,
      traces,
      model: activeModel,
      mode,
      reasoning_effort: reasoningEffort,
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
    console.error("[Agent Orchestrator Error]:", err);
    return NextResponse.json(
      {
        error: err.message || "Internal orchestrator error",
        traces: []
      },
      { status: 500 }
    );
  } finally {
    for (const session of activeSessions) {
      try {
        await session.client.close();
      } catch {
        // Ignored on teardown
      }
    }
  }
}
