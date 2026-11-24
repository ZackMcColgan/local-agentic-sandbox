import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { normalizeMcpUrl } from "@/lib/toolParser";

export interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string; [key: string]: unknown }> }>;
  callTool?(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
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
  pooled?: boolean;
}

export interface McpSession {
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: Array<{ name: string; [key: string]: unknown }>;
}

interface PooledMcpEntry {
  url: string;
  session: McpSession;
  rawClient: Client | McpClientLike;
  rawTransport: StreamableHTTPClientTransport | McpTransportLike;
  evicted: boolean;
}

const mcpPool = new Map<string, PooledMcpEntry>();
const mcpInFlight = new Map<string, Promise<McpSession | null>>();

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

async function closeRawHandles(
  rawClient: Client | McpClientLike | null,
  rawTransport: StreamableHTTPClientTransport | McpTransportLike | null
): Promise<void> {
  if (rawClient) {
    try {
      await rawClient.close();
    } catch {}
  }
  if (rawTransport) {
    try {
      await rawTransport.close();
    } catch {}
  }
}

async function evictPooledEntry(url: string, targetEntry?: PooledMcpEntry): Promise<void> {
  const current = mcpPool.get(url);
  if (!current || (targetEntry && current !== targetEntry)) return;
  current.evicted = true;
  mcpPool.delete(url);
  await closeRawHandles(current.rawClient, current.rawTransport);
}

function wrapPooledClient(
  sseUrl: string,
  rawClient: Client | McpClientLike,
  entry: PooledMcpEntry
): Client {
  return new Proxy(rawClient as Client, {
    get(target, prop, receiver) {
      if (prop === "close") {
        // Pooled client handles stay open across turns; pool eviction/reset closes raw handles.
        return async () => {};
      }
      if (prop === "callTool") {
        return async (...args: Parameters<Client["callTool"]>) => {
          try {
            return await target.callTool(...args);
          } catch (err) {
            await evictPooledEntry(sseUrl, entry);
            throw err;
          }
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function openMcpSession(
  sseUrl: string,
  name: string,
  deps: McpClientDeps
): Promise<{
  rawClient: Client | McpClientLike;
  rawTransport: StreamableHTTPClientTransport | McpTransportLike;
  tools: Array<{ name: string; [key: string]: unknown }>;
} | null> {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const timeoutMs = resolveMcpConnectTimeoutMs(deps);
  let transport: StreamableHTTPClientTransport | McpTransportLike | null = null;
  let client: Client | McpClientLike | null = null;
  try {
    transport = deps.createTransport
      ? deps.createTransport(new URL(sseUrl))
      : new StreamableHTTPClientTransport(new URL(sseUrl));
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
      `[Orchestrator] Connected to MCP (${name}) at ${sseUrl} with ${toolsResult.tools.length} tools`
    );
    return {
      rawClient: client,
      rawTransport: transport,
      tools: toolsResult.tools,
    };
  } catch (err: unknown) {
    warn(
      `[Orchestrator] Could not connect to MCP at ${sseUrl}:`,
      err instanceof Error ? err.message : String(err)
    );
    await closeRawHandles(client, transport);
    return null;
  }
}

export async function resetMcpClientPool(): Promise<void> {
  const entries = Array.from(mcpPool.values());
  mcpPool.clear();
  mcpInFlight.clear();
  await Promise.allSettled(
    entries.map(async (entry) => {
      entry.evicted = true;
      await closeRawHandles(entry.rawClient, entry.rawTransport);
    })
  );
}

export async function connectMcpClient(
  url: string,
  name: string,
  deps: McpClientDeps = {}
): Promise<McpSession | null> {
  const sseUrl = normalizeMcpUrl(url);
  const usePool = deps.pooled ?? (!deps.createTransport && !deps.createClient);

  if (!usePool) {
    const opened = await openMcpSession(sseUrl, name, deps);
    if (!opened) return null;
    return {
      client: opened.rawClient as Client,
      transport: opened.rawTransport as StreamableHTTPClientTransport,
      tools: opened.tools,
    };
  }

  const cached = mcpPool.get(sseUrl);
  if (cached && !cached.evicted) {
    return cached.session;
  }

  const pending = mcpInFlight.get(sseUrl);
  if (pending) {
    return pending;
  }

  const connectPromise = (async (): Promise<McpSession | null> => {
    const opened = await openMcpSession(sseUrl, name, deps);
    if (!opened) return null;

    const entry: PooledMcpEntry = {
      url: sseUrl,
      rawClient: opened.rawClient,
      rawTransport: opened.rawTransport,
      evicted: false,
      session: {
        client: opened.rawClient as Client,
        transport: opened.rawTransport as StreamableHTTPClientTransport,
        tools: opened.tools,
      },
    };
    entry.session.client = wrapPooledClient(sseUrl, opened.rawClient, entry);

    const prevOnClose = opened.rawClient.onclose;
    opened.rawClient.onclose = () => {
      void evictPooledEntry(sseUrl, entry);
      if (typeof prevOnClose === "function") prevOnClose();
    };
    const prevOnError = opened.rawClient.onerror;
    opened.rawClient.onerror = (err: Error) => {
      void evictPooledEntry(sseUrl, entry);
      if (typeof prevOnError === "function") prevOnError(err);
    };

    mcpPool.set(sseUrl, entry);
    return entry.session;
  })().finally(() => {
    mcpInFlight.delete(sseUrl);
  });

  mcpInFlight.set(sseUrl, connectPromise);
  return connectPromise;
}
