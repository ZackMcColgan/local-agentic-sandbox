import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
// Imported first: sets this suite's own WORKSPACE_DIR before workspaceTools resolves it.
import { cleanupTestWorkspace } from "./isolatedWorkspace.js";

describe("MCP Server Streamable HTTP Transport & Stateless Core", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const { app } = await import("../src/index.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(() => {
    if (server) {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close();
    }
    cleanupTestWorkspace();
  });

  it("serves tools/list and a real tool call over Streamable HTTP on POST /mcp", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "mcp-server-test-client", version: "1.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name);
      assert.ok(toolNames.includes("workspace_get_tree"), "workspace_get_tree should be listed");
      assert.ok(
        toolNames.includes("verify_container_provenance"),
        "verify_container_provenance should be listed"
      );

      const callResult = await client.callTool({
        name: "workspace_get_tree",
        arguments: { max_depth: 1 },
      });
      const content = callResult.content as Array<{ type: string; text: string }>;
      assert.ok(Array.isArray(content) && content.length > 0);
      assert.equal(typeof content[0].text, "string");
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
    assert.ok(body1.includes("workspace_get_tree"), "Response 1 should contain tool catalog");

    // Independent request 2: tools/call with no shared session
    const res2 = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "workspace_get_tree",
          arguments: { max_depth: 1 },
        },
      }),
    });
    assert.equal(res2.status, 200, "Second independent stateless tools/call should succeed");
    const body2 = await res2.text();
    assert.ok(body2.includes("content"), "Response 2 should return tool result");

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
    assert.equal(res3.status, 200, "Request with bogus mcp-session-id must succeed in stateless mode");
    const body3 = await res3.text();
    assert.ok(body3.includes("execute_sandboxed_python"), "Bogus-session request should succeed");
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
