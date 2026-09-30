import { NextRequest, NextResponse } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { DEFAULT_PRIMARY_MODEL } from "@/config/models";

import { parseAttachment } from "@/lib/fileParser";

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://ollama:11434";
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
  tier?: "sandbox" | "browser";
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

export async function POST(req: NextRequest) {
  const activeSessions: Array<{ client: Client; transport: SSEClientTransport }> = [];
  const toolClientMap = new Map<string, { client: Client; tier: "sandbox" | "browser" }>();

  try {
    const { messages, model: requestedModel, reasoning_effort: requestedReasoning, attachments } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Invalid messages payload" }, { status: 400 });
    }

    const activeModel = requestedModel || DEFAULT_MODEL;
    const reasoningEffort = requestedReasoning || (activeModel.includes("qwen3.8") ? "medium" : undefined);

    // 1. Connect to Sandboxed Code-Runner MCP
    const sandboxSession = await connectMcpClient(MCP_URL, "orchestrator-sandbox-client");
    if (sandboxSession) {
      activeSessions.push(sandboxSession);
      for (const t of sandboxSession.tools) {
        toolClientMap.set(t.name, { client: sandboxSession.client, tier: "sandbox" });
      }
    }

    // 2. Connect to Isolated Browser/Scraper MCP
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

const SYSTEM_PROMPT = `You are an intelligent agentic AI platform running on local hardware with Model Context Protocol (MCP) tool integration and native multimodal support.

You have access to two distinct tool tiers:
1. Web Search & Documentation Scraper (Tier: Browser / Egress Mesh):
   - 'search_web': Search the internet using DuckDuckGo. Automatically fetches and attaches clean markdown for the most informative top result in 'top_result_content'. Use this whenever the user asks about real-time information, latest documentation, weather forecasts, external packages, or general web lookups.
   - 'fetch_webpage_markdown': Fetch any public URL and convert its content into clean markdown. Use this to read documentation, inspect web pages, or scrape articles.

2. Air-Gapped Code Sandbox & Provenance (Tier: Sandbox / AI Mesh):
   - 'execute_sandboxed_python': Run Python code and test assertions inside a zero-trust, unprivileged Linux container sandbox (cap_drop ALL, read-only rootfs). Use this whenever asked to write, run, or verify code.
   - 'verify_container_provenance': Inspect runtime container security boundaries and SLSA attestations.
   - 'docker_scout_policy_gate': Evaluate container CVE vulnerabilities against security policies.

CRITICAL INSTRUCTIONS:
- When a user query requires real-time facts, current weather, news, external documentation, or data:
  1. Invoke 'search_web' to locate relevant URLs and inspect the 'top_result_content' markdown.
  2. If 'top_result_content' already contains the required information, synthesize and answer immediately.
  3. If 'top_result_content' is missing or lacks the specific details requested, invoke 'fetch_webpage_markdown' on another relevant link from the search results (preferring content-rich sources like government, official documentation, or news over ad/paywall SPAs).
  4. NEVER tell the user "I cannot display this here, visit these links". You have web scraping tools: extract the content and present the actual answer, numbers, temperatures, conditions, and facts directly to the user in formatted Markdown tables or text.
- When asked to execute or test code, invoke 'execute_sandboxed_python'.
- When invoking tools, do not output conversational preamble or filler beforehand. Trigger the tool call directly.
- Synthesize all tool results into a thorough, clear answer for the user.`;

    let effortDirective = "";
    if (reasoningEffort === "low") {
      effortDirective = "\n\nREASONING EFFORT: FAST / DIRECT. Provide direct, concise answers without <think> tags or verbose preamble.";
    } else if (reasoningEffort === "xhigh") {
      effortDirective = "\n\nREASONING EFFORT: DEEP. Think deeply step-by-step before answering.";
    }

    // Process attachments (Images -> base64 vision, Documents -> extracted text context)
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

    const computeOptions = () => {
      const opts: any = {};
      opts.num_ctx = activeModel.includes("gemma4") ? 16384 : 8192;
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
      if (activeModel.includes("qwen3.8")) {
        opts.reasoning_effort = reasoningEffort;
      }
      return opts;
    };

    // Step 1: Query Ollama with dynamic model and reasoning effort
    const ollamaPayload: any = {
      model: activeModel,
      messages: conversationMessages,
      stream: false,
      options: computeOptions()
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
      throw new Error(`Ollama engine returned ${aiRes.status}: ${errText}`);
    }

    const aiData = await aiRes.json();
    const assistantMessage = aiData.message;
    const traces: TraceItem[] = [];

    // Normalizing helper to detect tool calls either from message.tool_calls OR from content JSON (even with preamble text)
    const getEffectiveToolCalls = (msg: any) => {
      if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        return msg.tool_calls;
      }
      if (msg.content && typeof msg.content === "string") {
        // 1. Look for ```json ... ``` or ``` ... ``` blocks anywhere in the text
        const codeBlockMatches = Array.from(msg.content.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi));
        for (const match of codeBlockMatches) {
          try {
            const parsed = JSON.parse((match as RegExpMatchArray)[1].trim());
            if (parsed && typeof parsed === "object" && parsed.name && toolClientMap.has(parsed.name)) {
              return [{
                function: {
                  name: parsed.name,
                  arguments: parsed.arguments || {}
                }
              }];
            }
          } catch {}
        }

        // 2. Look for raw JSON object {"name": "...", "arguments": {...}} anywhere in text
        const jsonMatch = msg.content.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0].trim());
            if (parsed && typeof parsed === "object" && parsed.name && toolClientMap.has(parsed.name)) {
              return [{
                function: {
                  name: parsed.name,
                  arguments: parsed.arguments || {}
                }
              }];
            }
          } catch {}
        }

        // 3. Simple JSON object fallback
        try {
          const parsed = JSON.parse(msg.content.trim());
          if (parsed && typeof parsed === "object" && parsed.name && toolClientMap.has(parsed.name)) {
            return [{
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

    // Step 2: Handle Autonomous Multi-Round MCP Tool Execution Loop
    let currentAssistantMessage = assistantMessage;
    let round = 0;
    const MAX_TOOL_ROUNDS = 5;

    while (round < MAX_TOOL_ROUNDS) {
      const toolCalls = getEffectiveToolCalls(currentAssistantMessage);
      if (!toolCalls || toolCalls.length === 0) {
        break;
      }

      round++;
      conversationMessages.push(currentAssistantMessage);

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const toolArgs = typeof toolCall.function.arguments === "string"
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments;

        const target = toolClientMap.get(toolName);
        if (!target) {
          throw new Error(`Model attempted execution of unregistered tool: ${toolName}`);
        }

        const startTime = performance.now();
        const result = await target.client.callTool({
          name: toolName,
          arguments: toolArgs
        });
        const durationMs = Math.round(performance.now() - startTime);

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
      }

      // Next step: query model with updated context (and tools if not at max rounds)
      const nextPayload: any = {
        model: activeModel,
        messages: conversationMessages,
        stream: false
      };

      if (round < MAX_TOOL_ROUNDS && ollamaTools.length > 0) {
        nextPayload.tools = ollamaTools;
      }

      nextPayload.options = computeOptions();

      const nextRes = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextPayload)
      });

      if (!nextRes.ok) {
        throw new Error(`Ollama synthesis failed: ${await nextRes.text()}`);
      }

      const nextData = await nextRes.json();
      currentAssistantMessage = nextData.message;
    }

    // Post-tool synthesis safety pass:
    // If tools were invoked and the final assistant message still contains a lingering tool call,
    // or if the assistant content is empty, perform one final prompt to force human-readable markdown synthesis!
    const lingeringToolCalls = getEffectiveToolCalls(currentAssistantMessage);
    if ((traces.length > 0 && lingeringToolCalls.length > 0) || !currentAssistantMessage.content?.trim()) {
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
          options: computeOptions()
        })
      });

      if (finalRes.ok) {
        const finalData = await finalRes.json();
        if (finalData.message?.content?.trim()) {
          currentAssistantMessage = finalData.message;
        }
      }
    }

    return NextResponse.json({
      content: currentAssistantMessage.content,
      traces,
      model: activeModel,
      reasoning_effort: reasoningEffort
    });

  } catch (err: any) {
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
