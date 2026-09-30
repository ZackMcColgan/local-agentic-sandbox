import { NextRequest, NextResponse } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://ollama:11434";
const MCP_URL = process.env.MCP_SERVER_URL || "http://mcp-server:8080/sse";
const MODEL_NAME = process.env.MODEL_NAME || "qwen3.8";

interface TraceItem {
  tool: string;
  args: Record<string, any>;
  result: any;
  durationMs: number;
  timestamp: string;
}

async function getMcpClient() {
  const transport = new SSEClientTransport(new URL(MCP_URL));
  const client = new Client(
    { name: "local-agentic-sandbox-orchestrator", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  const toolsResult = await client.listTools();
  return { client, transport, tools: toolsResult.tools };
}

export async function POST(req: NextRequest) {
  let mcpSession: { client: Client; transport: SSEClientTransport } | null = null;

  try {
    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Invalid messages payload" }, { status: 400 });
    }

    // Connect to MCP Server and retrieve tools
    let tools: any[] = [];
    try {
      const session = await getMcpClient();
      mcpSession = session;
      tools = session.tools;
    } catch (mcpErr: any) {
      console.warn("[Orchestrator] MCP Server unreachable:", mcpErr.message);
      // Fallback: Proceed without tools if MCP is offline, informing user in trace
    }

    // Format tools for Ollama / OpenAI function calling specification
    const ollamaTools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.inputSchema || {}
      }
    }));

    // Step 1: Query Ollama with user messages + registered MCP tools
    const ollamaPayload: any = {
      model: MODEL_NAME,
      messages,
      stream: false
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

    // Step 2: Handle Autonomous MCP Tool Execution Loop
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      if (!mcpSession) {
        throw new Error("Model attempted tool execution, but MCP Server is unreachable");
      }

      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = typeof toolCall.function.arguments === "string"
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments;

        const startTime = performance.now();
        const result = await mcpSession.client.callTool({
          name: toolName,
          arguments: toolArgs
        });
        const durationMs = Math.round(performance.now() - startTime);

        traces.push({
          tool: toolName,
          args: toolArgs,
          result,
          durationMs,
          timestamp: new Date().toISOString()
        });

        // Append assistant tool request and tool outcome to conversation history
        messages.push(assistantMessage);
        messages.push({
          role: "tool",
          name: toolName,
          content: JSON.stringify(result)
        });
      }

      // Step 3: Send execution output back to Ollama to synthesize the final user-facing response
      const synthesisRes = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL_NAME,
          messages,
          stream: false
        })
      });

      if (!synthesisRes.ok) {
        throw new Error(`Ollama synthesis failed: ${await synthesisRes.text()}`);
      }

      const synthesisData = await synthesisRes.json();

      return NextResponse.json({
        content: synthesisData.message.content,
        traces,
        model: MODEL_NAME
      });
    }

    // Direct text response without tool invocation
    return NextResponse.json({
      content: assistantMessage.content,
      traces: [],
      model: MODEL_NAME
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
    if (mcpSession) {
      try {
        await mcpSession.client.close();
      } catch {
        // Ignored on teardown
      }
    }
  }
}
