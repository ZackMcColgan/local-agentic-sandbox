import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { registerBrowserTools } from "./tools/browser.js";

const app = express();
app.use(express.json());

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

app.post("/mcp", async (req: Request, res: Response) => {
  const server = createBrowserMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
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
