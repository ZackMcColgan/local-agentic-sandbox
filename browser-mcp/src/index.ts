import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response } from "express";
import cors from "cors";
import { registerBrowserTools } from "./tools/browser.js";

const app = express();
app.use(cors());

export function createBrowserMcpServer(): McpServer {
  const mcp = new McpServer({
    name: "browser-mcp-service",
    version: "1.0.0"
  });
  registerBrowserTools(mcp);
  return mcp;
}

const sessions = new Map<string, { server: McpServer; transport: SSEServerTransport }>();

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "HEALTHY",
    service: "browser-mcp-server",
    version: "1.0.0",
    security: {
      user: "10002:10002",
      role: "isolated-egress-scraper",
      ssrf_protection: "ACTIVE",
      workspace_access: "NONE"
    },
    active_sessions: sessions.size
  });
});

app.get("/sse", async (req: Request, res: Response) => {
  try {
    const server = createBrowserMcpServer();
    const transport = new SSEServerTransport("/messages", res);
    sessions.set(transport.sessionId, { server, transport });

    req.on("close", async () => {
      sessions.delete(transport.sessionId);
      try {
        await server.close();
      } catch {}
    });

    await server.connect(transport);
  } catch (error) {
    console.error("Failed to establish SSE transport in browser-mcp:", error);
    if (!res.headersSent) {
      res.status(500).send("SSE Connection Failed");
    }
  }
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const session = (sessionId && sessions.get(sessionId)) || Array.from(sessions.values())[0];

  if (session) {
    await session.transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("Session not initialized or expired");
  }
});

const PORT = parseInt(process.env.PORT || "8081", 10);
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`[Browser MCP] Active and listening at http://${HOST}:${PORT}`);
  console.log(`[Browser MCP] SSE Endpoint: http://${HOST}:${PORT}/sse`);
  console.log(`[Browser MCP] Registered Tools: search_web, fetch_webpage_markdown`);
});
