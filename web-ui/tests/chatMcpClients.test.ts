import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { POST } from "../app/api/chat/route";
import { getMcpUrl, getBrowserMcpUrl, connectMcpClient } from "../lib/chat/mcpClients";

describe("chat route MCP client characterization", () => {
  it("POST rejects invalid messages payload with 400 before connecting MCP clients", async () => {
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: null }),
    });
    const res = await POST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "Invalid messages payload");
  });

  it("getMcpUrl and getBrowserMcpUrl return env overrides or defaults", () => {
    assert.equal(getMcpUrl({}), "http://mcp-server:8080/mcp");
    assert.equal(
      getMcpUrl({ MCP_SERVER_URL: "http://127.0.0.1:9000/mcp" }),
      "http://127.0.0.1:9000/mcp"
    );
    assert.equal(getBrowserMcpUrl({}), "http://browser-mcp:8081/mcp");
    assert.equal(
      getBrowserMcpUrl({ BROWSER_MCP_URL: "http://127.0.0.1:9001/mcp" }),
      "http://127.0.0.1:9001/mcp"
    );
  });

  it("connectMcpClient normalizes URL to /mcp, connects, lists tools, and returns client handle", async () => {
    let seenUrl = "";
    let connectedTransport: unknown = null;
    const fakeTransport = { close: async () => {} };
    const fakeTools = [{ name: "workspace_read_file" }, { name: "git_status" }];
    const fakeClient = {
      connect: async (t: unknown) => {
        connectedTransport = t;
      },
      listTools: async () => ({ tools: fakeTools }),
      close: async () => {},
    };

    const session = await connectMcpClient("http://mcp-server:8080", "test-client", {
      createTransport: (u) => {
        seenUrl = u.toString();
        return fakeTransport;
      },
      createClient: () => fakeClient,
      log: () => {},
      warn: () => {},
    });

    assert.ok(session);
    assert.equal(seenUrl, "http://mcp-server:8080/mcp");
    assert.equal(connectedTransport, fakeTransport);
    assert.deepEqual(session.tools, fakeTools);
  });

  it("connectMcpClient closes client and transport and returns null on listTools failure", async () => {
    let clientClosed = false;
    let transportClosed = false;
    const warnings: unknown[][] = [];

    const session = await connectMcpClient("http://mcp-server:8080/mcp", "test-client", {
      createTransport: () => ({
        close: async () => {
          transportClosed = true;
        },
      }),
      createClient: () => ({
        connect: async () => {},
        listTools: async () => {
          throw new Error("listTools boom");
        },
        close: async () => {
          clientClosed = true;
        },
      }),
      log: () => {},
      warn: (...args) => warnings.push(args),
    });

    assert.equal(session, null);
    assert.equal(clientClosed, true);
    assert.equal(transportClosed, true);
    assert.equal(warnings.length, 1);
  });

  it("connectMcpClient connects over real StreamableHTTPClientTransport to a stateless server", async () => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/mcp") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

      const mcp = new McpServer({ name: "stateless-test-server", version: "1.0.0" });
      mcp.tool("echo_ping", "Echo back input", { msg: z.string() }, async ({ msg }) => ({
        content: [{ type: "text" as const, text: `pong:${msg}` }],
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
      const handle = await connectMcpClient(`http://127.0.0.1:${port}`, "stateless-web-ui-test", {
        log: () => {},
        warn: () => {},
      });
      assert.ok(handle, "connectMcpClient should connect to stateless Streamable HTTP server");
      assert.equal(handle.transport.sessionId, undefined, "stateless server assigns no sessionId");
      assert.ok(handle.tools.some((t) => t.name === "echo_ping"));

      const res1 = await handle.client.callTool({ name: "echo_ping", arguments: { msg: "one" } });
      const res2 = await handle.client.callTool({ name: "echo_ping", arguments: { msg: "two" } });
      assert.equal((res1.content as Array<{ text: string }>)[0].text, "pong:one");
      assert.equal((res2.content as Array<{ text: string }>)[0].text, "pong:two");

      await handle.client.close();
      await handle.transport.close();
    } finally {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close();
    }
  });
});
