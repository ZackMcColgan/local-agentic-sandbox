import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import http from "node:http";

function rawHttpRequest(options: {
  port: number;
  method: string;
  reqPath: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.reqPath,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("Browser MCP Security & Transport Hardening (Batch 1)", () => {
  let server: Server;
  let port: number;
  let baseUrl: string;
  const origSecret = process.env.MCP_SHARED_SECRET;
  const origNodeEnv = process.env.NODE_ENV;
  const TEST_SECRET = "test-browser-mcp-shared-secret-32-chars-minimum";

  before(async () => {
    const { app } = await import("../src/index.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    if (origSecret === undefined) delete process.env.MCP_SHARED_SECRET;
    else process.env.MCP_SHARED_SECRET = origSecret;
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;

    if (server) {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close();
    }
  });

  it("MCP-1: enforces shared-secret auth on /mcp and fails closed outside development", async () => {
    delete process.env.MCP_SHARED_SECRET;
    process.env.NODE_ENV = "production";

    const noSecretRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.ok(
      noSecretRes.status === 401 || noSecretRes.status === 503,
      `Expected fail-closed refusal without secret, got ${noSecretRes.status}`
    );

    process.env.MCP_SHARED_SECRET = TEST_SECRET;

    const unauthRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(unauthRes.status, 401, "Missing secret header must return 401");

    const authRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-mcp-shared-secret": TEST_SECRET,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(authRes.status, 200, "Valid secret header must succeed");

    delete process.env.MCP_SHARED_SECRET;
    process.env.NODE_ENV = "development";
    const devRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(devRes.status, 200, "Development mode without secret should allow");
  });

  it("MCP-1: enables DNS rebinding protection and rejects untrusted Host headers", async () => {
    process.env.MCP_SHARED_SECRET = TEST_SECRET;
    process.env.NODE_ENV = "production";

    const evilRes = await rawHttpRequest({
      port,
      method: "POST",
      reqPath: "/mcp",
      headers: {
        Host: "evil.example.com:8081",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-mcp-shared-secret": TEST_SECRET,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(evilRes.status, 403, `Untrusted Host must return 403, got ${evilRes.status}`);
  });

  it("MCP-4: returns 405 with Allow: POST for GET and DELETE on /mcp", async () => {
    process.env.MCP_SHARED_SECRET = TEST_SECRET;
    process.env.NODE_ENV = "production";

    const getRes = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { "x-mcp-shared-secret": TEST_SECRET },
    });
    assert.equal(getRes.status, 405, "GET /mcp must return 405");
    assert.equal(getRes.headers.get("allow"), "POST", "GET /mcp must set Allow: POST");

    const delRes = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "x-mcp-shared-secret": TEST_SECRET },
    });
    assert.equal(delRes.status, 405, "DELETE /mcp must return 405");
    assert.equal(delRes.headers.get("allow"), "POST", "DELETE /mcp must set Allow: POST");
  });
});
