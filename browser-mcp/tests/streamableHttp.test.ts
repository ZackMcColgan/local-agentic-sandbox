import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

describe("Browser MCP Streamable HTTP Transport & Stateless Core", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const mod = (await import("../src/index.js")) as { app?: import("express").Express };
    assert.ok(mod.app, "browser-mcp/src/index.ts must export Express app");
    server = mod.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(() => {
    if (server) {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close();
    }
  });

  it("serves tools/list and a real tool call over Streamable HTTP on POST /mcp", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "browser-mcp-test-client", version: "1.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name);
      assert.ok(toolNames.includes("search_web"), "search_web should be listed");
      assert.ok(
        toolNames.includes("fetch_webpage_markdown"),
        "fetch_webpage_markdown should be listed"
      );

      // Real tool call exercising SSRF guard deterministically without external network
      const callResult = await client.callTool({
        name: "fetch_webpage_markdown",
        arguments: { url: "http://127.0.0.1:8080/admin" },
      });
      const content = callResult.content as Array<{ type: string; text: string }>;
      assert.ok(Array.isArray(content) && content.length > 0);
      const parsed = JSON.parse(content[0].text);
      assert.equal(parsed.status, "BLOCKED_SSRF");
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  });

  it("removes legacy /sse and /messages routes", async () => {
    const sseRes = await fetch(`${baseUrl}/sse`);
    assert.equal(sseRes.status, 404, "GET /sse must be removed");

    const msgRes = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(msgRes.status, 404, "POST /messages must be removed");
  });

  it("proves stateless core: two independent requests with no shared session succeed and bogus session id is accepted", async () => {
    const rpcHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    // Independent request 1: tools/list with no session handshake
    const res1 = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(res1.status, 200, "First stateless tools/list should succeed");
    assert.equal(
      res1.headers.get("mcp-session-id"),
      null,
      "Stateless server must not emit mcp-session-id header"
    );
    const body1 = await res1.text();
    assert.ok(body1.includes("fetch_webpage_markdown"), "Response 1 should contain tool catalog");

    // Independent request 2: tools/call with no shared session
    const res2 = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "fetch_webpage_markdown",
          arguments: { url: "http://169.254.169.254/latest/meta-data/" },
        },
      }),
    });
    assert.equal(res2.status, 200, "Second independent stateless tools/call should succeed");
    const body2 = await res2.text();
    assert.ok(body2.includes("BLOCKED_SSRF"), "Response 2 should contain SSRF block verdict");

    // Request carrying a bogus session identifier must not fail in stateless mode
    const res3 = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...rpcHeaders,
        "mcp-session-id": "bogus-session-id-does-not-exist",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(
      res3.status,
      200,
      "Request with bogus mcp-session-id must succeed in stateless mode"
    );
    const body3 = await res3.text();
    assert.ok(body3.includes("search_web"), "Bogus-session request should return tool catalog");
  });

  it("/health reports stateless transport mode and omits active_sessions", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.equal(data.status, "HEALTHY");
    assert.equal("active_sessions" in data, false, "/health must not report active_sessions");
    assert.equal(data.transport_mode, "streamable-http-stateless");
  });
});
