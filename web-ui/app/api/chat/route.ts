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

    // Step 1: Query Ollama with dynamic model and reasoning effort
    const ollamaPayload: any = {
      model: activeModel,
      messages,
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

    // Step 2: Handle Autonomous MCP Tool Execution Loop
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      for (const toolCall of assistantMessage.tool_calls) {
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

        // Append assistant tool request and tool outcome to conversation history
        messages.push(assistantMessage);
        messages.push({
          role: "tool",
          name: toolName,
          content: JSON.stringify(result)
        });
      }

      // Step 3: Synthesis call with execution output
      const synthesisPayload: any = {
        model: activeModel,
        messages,
        stream: false
      };

      if (reasoningEffort) {
        synthesisPayload.options = { reasoning_effort: reasoningEffort };
      }

      const synthesisRes = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(synthesisPayload)
      });

      if (!synthesisRes.ok) {
        throw new Error(`Ollama synthesis failed: ${await synthesisRes.text()}`);
      }

      const synthesisData = await synthesisRes.json();

      return NextResponse.json({
        content: synthesisData.message.content,
        traces,
        model: activeModel,
        reasoning_effort: reasoningEffort
      });
    }

    // Direct text response without tool invocation
    return NextResponse.json({
      content: assistantMessage.content,
      traces: [],
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
