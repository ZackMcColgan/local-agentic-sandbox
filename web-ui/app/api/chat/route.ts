import { NextRequest, NextResponse } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { DEFAULT_PRIMARY_MODEL } from "@/config/models";

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
    const { messages, model: requestedModel, reasoning_effort: requestedReasoning } = await req.json();

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

const SYSTEM_PROMPT = `You are an intelligent agentic AI platform running on local hardware with Model Context Protocol (MCP) tool integration.

You have access to two distinct tool tiers:
1. Web Search & Documentation Scraper (Tier: Browser / Egress Mesh):
   - 'search_web': Search the internet using DuckDuckGo. Use this whenever the user asks about real-time events, current weather, latest documentation, or questions requiring live web lookups.
   - 'fetch_webpage_markdown': Fetch any public URL and convert its content into clean markdown. Use this to read documentation or scrape specific websites.

2. Air-Gapped Code Sandbox & Provenance (Tier: Sandbox / AI Mesh):
   - 'execute_sandboxed_python': Run Python code and test assertions inside a zero-trust, unprivileged Linux container sandbox (cap_drop ALL, read-only rootfs). Use this whenever asked to write, run, or verify code.
   - 'verify_container_provenance': Inspect runtime container security boundaries and SLSA attestations.
   - 'docker_scout_policy_gate': Evaluate container CVE vulnerabilities against security policies.

IMPORTANT INSTRUCTIONS:
- Whenever the user asks about current facts, weather, external libraries, or web lookups, ALWAYS proactively invoke the 'search_web' tool. Do NOT claim you cannot access the internet; your browser toolchain handles web access safely through an isolated egress proxy.
- Whenever asked to run or test Python code, ALWAYS invoke 'execute_sandboxed_python'.
- Synthesize tool execution results cleanly for the user.`;

    const conversationMessages = [...messages];
    if (!conversationMessages.some((m: any) => m.role === "system")) {
      conversationMessages.unshift({
        role: "system",
        content: SYSTEM_PROMPT
      });
    }

    // Step 1: Query Ollama with dynamic model and reasoning effort
    const ollamaPayload: any = {
      model: activeModel,
      messages: conversationMessages,
      stream: false
    };

    if (reasoningEffort) {
      ollamaPayload.options = {
        reasoning_effort: reasoningEffort
      };
    }

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

    // Step 2: Handle Autonomous Multi-Round MCP Tool Execution Loop
    let currentAssistantMessage = assistantMessage;
    let round = 0;
    const MAX_TOOL_ROUNDS = 3;

    while (
      currentAssistantMessage.tool_calls &&
      currentAssistantMessage.tool_calls.length > 0 &&
      round < MAX_TOOL_ROUNDS
    ) {
      round++;
      conversationMessages.push(currentAssistantMessage);

      for (const toolCall of currentAssistantMessage.tool_calls) {
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

      if (reasoningEffort) {
        nextPayload.options = { reasoning_effort: reasoningEffort };
      }

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
