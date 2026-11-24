import assert from "node:assert/strict";
import http from "node:http";
import { describe, it, afterEach } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { connectMcpClient, resetMcpClientPool } from "../lib/chat/mcpClients";

describe("MCP Client Pool Hardening & Shared Secret (Batch 1)", () => {
  const origSecret = process.env.MCP_SHARED_SECRET;

  afterEach(async () => {
    if (origSecret === undefined) delete process.env.MCP_SHARED_SECRET;
    else process.env.MCP_SHARED_SECRET = origSecret;
    await resetMcpClientPool();
  });

  it("N-R1/MCP-4: pooled session.transport.close() does not close the underlying transport", async () => {
    let rawTransportCloseCount = 0;
    let rawClientCloseCount = 0;

    const session = await connectMcpClient("http://127.0.0.1:9911/mcp", "pool-transport-test", {
      pooled: true,
      log: () => {},
      warn: () => {},
      createTransport: () => ({
        close: async () => {
          rawTransportCloseCount++;
        },
      }),
      createClient: () => ({
        connect: async () => {},
        listTools: async () => ({ tools: [{ name: "ping" }] }),
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
        close: async () => {
          rawClientCloseCount++;
        },
      }),
    });

    assert.ok(session);
    await session.client.close();
    await session.transport.close();

    assert.equal(rawClientCloseCount, 0, "pooled client.close() must not close raw client");
    assert.equal(
      rawTransportCloseCount,
      0,
      "pooled transport.close() must not close underlying raw transport"
    );
  });

  it("MCP-4: single-error eviction does not close raw handles mid-flight while a sibling callTool is active", async () => {
    let rawClientCloseCount = 0;
    let rawTransportCloseCount = 0;
    let releaseSibling!: () => void;
    const siblingGate = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });

    const session = await connectMcpClient("http://127.0.0.1:9912/mcp", "pool-race-test", {
      pooled: true,
      log: () => {},
      warn: () => {},
      createTransport: () => ({
        close: async () => {
          rawTransportCloseCount++;
        },
      }),
      createClient: () => ({
        connect: async () => {},
        listTools: async () => ({ tools: [{ name: "slow" }, { name: "fail" }] }),
        callTool: async ({ name }) => {
          if (name === "slow") {
            await siblingGate;
            if (rawClientCloseCount > 0 || rawTransportCloseCount > 0) {
              throw new Error("raw handle was closed while sibling call was in flight");
            }
            return { content: [{ type: "text", text: "sibling-ok" }] };
          }
          throw new Error("boom");
        },
        close: async () => {
          rawClientCloseCount++;
        },
      }),
    });

    assert.ok(session);

    const siblingPromise = session.client.callTool({ name: "slow", arguments: {} });
    await assert.rejects(() => session.client.callTool({ name: "fail", arguments: {} }), /boom/);

    // While sibling is still in flight, raw handles must NOT be closed yet
    assert.equal(rawClientCloseCount, 0, "rawClient must remain open while sibling is in flight");
    assert.equal(
      rawTransportCloseCount,
      0,
      "rawTransport must remain open while sibling is in flight"
    );

    releaseSibling();
    const siblingResult = await siblingPromise;
    assert.equal(
      (siblingResult.content as Array<{ text: string }>)[0].text,
      "sibling-ok",
      "sibling call must complete cleanly"
    );

    // Once sibling finishes, deferred eviction closes the old raw handles
    assert.equal(rawClientCloseCount, 1, "rawClient should close once in-flight calls drain");
    assert.equal(rawTransportCloseCount, 1, "rawTransport should close once in-flight calls drain");
  });

  it("MCP-1: connectMcpClient sends x-mcp-shared-secret header from MCP_SHARED_SECRET", async () => {
    const TEST_SECRET = "client-pool-shared-secret-32-chars-minimum";
    process.env.MCP_SHARED_SECRET = TEST_SECRET;
    let seenSecretHeader: string | undefined;

    const server = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/mcp") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      seenSecretHeader = req.headers["x-mcp-shared-secret"] as string | undefined;
      if (seenSecretHeader !== TEST_SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const mcp = new McpServer({ name: "auth-test-server", version: "1.0.0" });
      mcp.tool("ping", "ping", {}, async () => ({
        content: [{ type: "text" as const, text: "pong" }],
      }));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close().catch(() => {});
        void mcp.close().catch(() => {});
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    try {
      const session = await connectMcpClient(`http://127.0.0.1:${port}/mcp`, "auth-client", {
        pooled: false,
        log: () => {},
        warn: () => {},
      });
      assert.ok(session, "connectMcpClient must authenticate with MCP_SHARED_SECRET");
      assert.equal(seenSecretHeader, TEST_SECRET);
      await session.client.close();
      await session.transport.close();
    } finally {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close();
    }
  });
});
