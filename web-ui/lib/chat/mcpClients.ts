import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { normalizeMcpUrl } from "@/lib/toolParser";

export interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string; [key: string]: unknown }> }>;
  close(): Promise<void>;
}

export interface McpTransportLike {
  close(): Promise<void>;
}

export interface McpClientDeps {
  createTransport?: (url: URL) => McpTransportLike;
  createClient?: (name: string) => McpClientLike;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

export const getMcpUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  env.MCP_SERVER_URL || "http://mcp-server:8080/sse";

export const getBrowserMcpUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  env.BROWSER_MCP_URL || "http://browser-mcp:8081/sse";

export async function connectMcpClient(url: string, name: string, deps: McpClientDeps = {}) {
  const sseUrl = normalizeMcpUrl(url);
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  let transport: SSEClientTransport | McpTransportLike | null = null;
  let client: Client | McpClientLike | null = null;
  try {
    transport = deps.createTransport
      ? deps.createTransport(new URL(sseUrl))
      : new SSEClientTransport(new URL(sseUrl));
    client = deps.createClient
      ? deps.createClient(name)
      : new Client({ name, version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport as SSEClientTransport);
    const toolsResult = await client.listTools();
    log(
      `[Orchestrator] Connected to MCP (${name}) at ${sseUrl} with ${toolsResult.tools.length} tools`
    );
    return {
      client: client as Client,
      transport: transport as SSEClientTransport,
      tools: toolsResult.tools,
    };
  } catch (err: unknown) {
    warn(
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
