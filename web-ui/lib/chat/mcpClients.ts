import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { normalizeMcpUrl } from "@/lib/toolParser";

export interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string; [key: string]: unknown }> }>;
  close(): Promise<void>;
}

export interface McpTransportLike {
  close(): Promise<void>;
}

export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 15_000;

export interface McpClientDeps {
  createTransport?: (url: URL) => McpTransportLike;
  createClient?: (name: string) => McpClientLike;
  connectTimeoutMs?: number;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

function resolveMcpConnectTimeoutMs(deps: McpClientDeps): number {
  if (typeof deps.connectTimeoutMs === "number" && deps.connectTimeoutMs > 0) {
    return deps.connectTimeoutMs;
  }
  const envVal = Number.parseInt(process.env.MCP_CONNECT_TIMEOUT_MS || "", 10);
  if (Number.isFinite(envVal) && envVal > 0) {
    return envVal;
  }
  return DEFAULT_MCP_CONNECT_TIMEOUT_MS;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export const getMcpUrl = (env: Record<string, string | undefined> = process.env): string =>
  env.MCP_SERVER_URL || "http://mcp-server:8080/mcp";

export const getBrowserMcpUrl = (env: Record<string, string | undefined> = process.env): string =>
  env.BROWSER_MCP_URL || "http://browser-mcp:8081/mcp";

export async function connectMcpClient(url: string, name: string, deps: McpClientDeps = {}) {
  const mcpUrl = normalizeMcpUrl(url);
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const timeoutMs = resolveMcpConnectTimeoutMs(deps);
  let transport: StreamableHTTPClientTransport | McpTransportLike | null = null;
  let client: Client | McpClientLike | null = null;
  try {
    transport = deps.createTransport
      ? deps.createTransport(new URL(mcpUrl))
      : new StreamableHTTPClientTransport(new URL(mcpUrl));
    client = deps.createClient
      ? deps.createClient(name)
      : new Client({ name, version: "1.0.0" }, { capabilities: {} });
    await withTimeout(
      client.connect(transport as StreamableHTTPClientTransport),
      timeoutMs,
      `MCP connect (${name} at ${mcpUrl})`
    );
    const toolsResult = await withTimeout(
      client.listTools(),
      timeoutMs,
      `MCP listTools (${name} at ${mcpUrl})`
    );
    log(
      `[Orchestrator] Connected to MCP (${name}) at ${mcpUrl} with ${toolsResult.tools.length} tools`
    );
    return {
      client: client as Client,
      transport: transport as StreamableHTTPClientTransport,
      tools: toolsResult.tools,
    };
  } catch (err: unknown) {
    warn(
      `[Orchestrator] Could not connect to MCP at ${mcpUrl}:`,
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
