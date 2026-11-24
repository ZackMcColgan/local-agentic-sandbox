import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { buildAllowedHosts, createMcpAuthMiddleware } from "./auth.js";
import { registerCodeRunner } from "./tools/codeRunner.js";
import { registerAttestation } from "./tools/attestation.js";
import { registerWorkspaceTools, resolveSafePath } from "./tools/workspaceTools.js";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

const app = express();
app.use(express.json());
const mcpAuthMiddleware = createMcpAuthMiddleware();

const MCP_SERVICE_HOSTS = [
  "mcp-runner",
  "mcp-server",
  "mcp-runner.local-agentic-sandbox.svc",
  "mcp-runner.local-agentic-sandbox.svc.cluster.local",
];

export function createMcpServer(): McpServer {
  const mcp = new McpServer({
    name: "local-agentic-sandbox-tools",
    version: "2.0.0",
  });
  registerCodeRunner(mcp);
  registerAttestation(mcp);
  registerWorkspaceTools(mcp);
  return mcp;
}

export const ALLOWED_FILE_EXTENSIONS = new Set([
  ".svg",
  ".drawio",
  ".xml",
  ".md",
  ".txt",
  ".json",
  ".html",
  ".csv",
  ".log",
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".yaml",
  ".yml",
  ".sql",
  ".css",
  ".toml",
]);

export function isAllowedFileArtifact(filePath: string): boolean {
  const lower = filePath.toLowerCase().trim();
  const ext = path.extname(lower);
  return ALLOWED_FILE_EXTENSIONS.has(ext) || lower.endsWith(".drawio.xml");
}

export function getArtifactMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".drawio":
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".txt":
    case ".log":
    case ".py":
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".sh":
    case ".yaml":
    case ".yml":
    case ".sql":
    case ".css":
    case ".toml":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

export async function handleFilesRequest(req: Request, res: Response) {
  const filePath = req.query.path as string;
  if (!filePath) {
    return res.status(400).json({ error: "Missing required 'path' query parameter" });
  }

  if (!isAllowedFileArtifact(filePath)) {
    return res.status(415).json({
      error: "Unsupported media type: only allowed workspace file artifacts are permitted",
    });
  }

  try {
    const safePath = resolveSafePath(filePath);
    if (!fsSync.existsSync(safePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    const stat = await fs.stat(safePath);
    if (stat.isDirectory()) {
      return res.status(403).json({ error: "Access forbidden: directory listing not permitted" });
    }
    if (!stat.isFile()) {
      return res.status(400).json({ error: "Target is not a file" });
    }
    const content = await fs.readFile(safePath);
    const mime = getArtifactMimeType(safePath);
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", stat.size.toString());
    res.send(content);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Security Violation") || message.includes("Path traversal")) {
      return res.status(403).json({ error: message });
    }
    res.status(500).json({ error: message });
  }
}

app.get("/files", mcpAuthMiddleware, handleFilesRequest);

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "HEALTHY",
    service: "sandboxed-mcp-server",
    version: "1.0.0",
    security: {
      user: "10001:10001",
      network_egress: "BLOCKED",
      rootfs: "READ_ONLY",
      capabilities: "DROPPED_ALL",
    },
    transport_mode: "streamable-http-stateless",
  });
});

app.post("/mcp", mcpAuthMiddleware, async (req: Request, res: Response) => {
  const server = createMcpServer();
  const allowedHosts = buildAllowedHosts(
    MCP_SERVICE_HOSTS,
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
    console.error("Failed to handle stateless Streamable HTTP request:", error);
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

const PORT = parseInt(process.env.PORT || "8080", 10);
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
    console.log(`[MCP Server] Active and listening at http://${HOST}:${PORT}`);
    console.log(`[MCP Server] Streamable HTTP Endpoint (stateless): http://${HOST}:${PORT}/mcp`);
    console.log(
      `[MCP Server] Registered Tools: execute_sandboxed_python, verify_container_provenance`
    );
  });
}
