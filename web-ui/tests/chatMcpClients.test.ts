import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
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
    assert.equal(getMcpUrl({}), "http://mcp-server:8080/sse");
    assert.equal(
      getMcpUrl({ MCP_SERVER_URL: "http://127.0.0.1:9000/sse" }),
      "http://127.0.0.1:9000/sse"
    );
    assert.equal(getBrowserMcpUrl({}), "http://browser-mcp:8081/sse");
    assert.equal(
      getBrowserMcpUrl({ BROWSER_MCP_URL: "http://127.0.0.1:9001/sse" }),
      "http://127.0.0.1:9001/sse"
    );
  });

  it("connectMcpClient normalizes URL, connects, lists tools, and returns session", async () => {
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
    assert.equal(seenUrl, "http://mcp-server:8080/sse");
    assert.equal(connectedTransport, fakeTransport);
    assert.deepEqual(session.tools, fakeTools);
  });

  it("connectMcpClient closes client and transport and returns null on listTools failure", async () => {
    let clientClosed = false;
    let transportClosed = false;
    const warnings: unknown[][] = [];

    const session = await connectMcpClient("http://mcp-server:8080/sse", "test-client", {
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
});
