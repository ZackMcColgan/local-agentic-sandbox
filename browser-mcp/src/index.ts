import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response } from "express";
import cors from "cors";
import { registerBrowserTools } from "./tools/browser.js";

const app = express();
app.use(cors());

const mcp = new McpServer({
  name: "browser-mcp-service",
  version: "1.0.0"
});

// Register browser tools
registerBrowserTools(mcp);

const transports = new Map<string, SSEServerTransport>();

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
    active_sessions: transports.size
  });
});

app.get("/sse", async (req: Request, res: Response) => {
  try {
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);

    req.on("close", () => {
      transports.delete(transport.sessionId);
    });

    await mcp.connect(transport);
  } catch (error) {
    console.error("Failed to establish SSE transport in browser-mcp:", error);
    if (!res.headersSent) {
      res.status(500).send("SSE Connection Failed");
    }
  }
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = (sessionId && transports.get(sessionId)) || Array.from(transports.values())[0];

  if (transport) {
    await transport.handlePostMessage(req, res);
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
