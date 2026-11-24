import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
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

const sessions = new Map<
  string,
  { server: McpServer; transport: StreamableHTTPServerTransport }
>();

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
    active_sessions: sessions.size,
  });
});

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let entry = sessionId ? sessions.get(sessionId) : undefined;

    if (!entry && isInitializeRequest(req.body)) {
      const server = createBrowserMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { server, transport });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };
      await server.connect(transport);
      entry = { server, transport };
    }

    if (!entry) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    await entry.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Failed to handle Streamable HTTP request in browser-mcp:", error);
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
    console.log(`[Browser MCP] Streamable HTTP Endpoint: http://${HOST}:${PORT}/mcp`);
    console.log(`[Browser MCP] Registered Tools: search_web, fetch_webpage_markdown`);
  });
}
