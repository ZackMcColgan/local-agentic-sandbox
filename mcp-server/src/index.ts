import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response } from "express";
import cors from "cors";
import { registerCodeRunner } from "./tools/codeRunner.js";
import { registerAttestation } from "./tools/attestation.js";
import { registerWorkspaceTools } from "./tools/workspaceTools.js";

const app = express();
app.use(cors());

const mcp = new McpServer({
  name: "local-agentic-sandbox-tools",
  version: "2.0.0"
});

// Register MCP tools
registerCodeRunner(mcp);
registerAttestation(mcp);
registerWorkspaceTools(mcp);

// Active SSE transports keyed by sessionId
const transports = new Map<string, SSEServerTransport>();

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "HEALTHY",
    service: "sandboxed-mcp-server",
    version: "1.0.0",
    security: {
      user: "10001:10001",
      network_egress: "BLOCKED",
      rootfs: "READ_ONLY",
      capabilities: "DROPPED_ALL"
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
    console.error("Failed to establish SSE transport:", error);
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

const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`[MCP Server] Active and listening at http://${HOST}:${PORT}`);
  console.log(`[MCP Server] SSE Endpoint: http://${HOST}:${PORT}/sse`);
  console.log(`[MCP Server] Registered Tools: execute_sandboxed_python, verify_container_provenance`);
});
