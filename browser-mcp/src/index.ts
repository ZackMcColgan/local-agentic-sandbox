import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { buildAllowedHosts, createMcpAuthMiddleware } from "./auth.js";
import { registerBrowserTools } from "./tools/browser.js";

const app = express();
app.use(express.json());
const mcpAuthMiddleware = createMcpAuthMiddleware();

const BROWSER_MCP_SERVICE_HOSTS = [
  "browser-mcp",
  "browser-mcp.local-agentic-sandbox.svc",
  "browser-mcp.local-agentic-sandbox.svc.cluster.local",
];

export function createBrowserMcpServer(): McpServer {
  const mcp = new McpServer({
    name: "browser-mcp-service",
    version: "1.0.0",
  });
  registerBrowserTools(mcp);
  return mcp;
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "HEALTHY",
    service: "browser-mcp-server",
    version: "1.0.0",
    security: {
      user: "10002:10002",
      role: "isolated-egress-scraper",
      ssrf_protection: "ACTIVE",
      workspace_access: "NONE",
    },
    transport_mode: "streamable-http-stateless",
  });
});

app.post("/mcp", mcpAuthMiddleware, async (req: Request, res: Response) => {
  const server = createBrowserMcpServer();
  const allowedHosts = buildAllowedHosts(
    BROWSER_MCP_SERVICE_HOSTS,
    PORT,
    req.socket?.localPort,
    process.env.MCP_ALLOWED_HOSTS
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts,
  });

  res.on("close", () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Failed to handle stateless Streamable HTTP request in browser-mcp:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.all("/mcp", mcpAuthMiddleware, (_req: Request, res: Response) => {
  res.setHeader("Allow", "POST");
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
    id: null,
  });
});

export { app };

const PORT = parseInt(process.env.PORT || "8081", 10);
const HOST = "0.0.0.0";

const isMainModule = Boolean(
  typeof process !== "undefined" &&
  process.argv?.[1] &&
  (process.argv[1].endsWith("index.js") || process.argv[1].endsWith("index.ts")) &&
  !process.env.NODE_TEST_CONTEXT &&
  !process.argv[1].includes(".test.")
);

if (isMainModule) {
  app.listen(PORT, HOST, () => {
    console.log(`[Browser MCP] Active and listening at http://${HOST}:${PORT}`);
    console.log(`[Browser MCP] Streamable HTTP Endpoint (stateless): http://${HOST}:${PORT}/mcp`);
    console.log(`[Browser MCP] Registered Tools: search_web, fetch_webpage_markdown`);
  });
}
