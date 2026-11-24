import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupTestWorkspace } from "./isolatedWorkspace.js";

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

describe("MCP Server Security & Transport Hardening (Batch 1)", () => {
  let server: Server;
  let port: number;
  let baseUrl: string;
  const origSecret = process.env.MCP_SHARED_SECRET;
  const origNodeEnv = process.env.NODE_ENV;
  const TEST_SECRET = "test-shared-secret-value-at-least-32-chars-long";

  before(async () => {
    const { app } = await import("../src/index.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (origSecret === undefined) delete process.env.MCP_SHARED_SECRET;
    else process.env.MCP_SHARED_SECRET = origSecret;
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;

    if (server) {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      cleanupTestWorkspace();
    } catch {
      // Ignore transient Windows handle release delay on temp dir cleanup
    }
  });

  it("MCP-1: enforces shared-secret auth on /mcp and /files and fails closed outside development", async () => {
    // 1. Production with missing secret -> refuses /mcp and /files
    delete process.env.MCP_SHARED_SECRET;
    process.env.NODE_ENV = "production";

    const noSecretMcp = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.ok(
      noSecretMcp.status === 401 || noSecretMcp.status === 503,
      `Expected fail-closed refusal without secret in production, got ${noSecretMcp.status}`
    );

    const noSecretFiles = await fetch(`${baseUrl}/files?path=test.txt`);
    assert.ok(
      noSecretFiles.status === 401 || noSecretFiles.status === 503,
      `Expected fail-closed refusal on /files without secret, got ${noSecretFiles.status}`
    );

    // 2. Configured secret -> missing or wrong token gets 401, valid token succeeds
    process.env.MCP_SHARED_SECRET = TEST_SECRET;

    const missingTok = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(missingTok.status, 401, "Missing secret header must return 401");

    const wrongTok = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-mcp-shared-secret": "wrong-secret",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(wrongTok.status, 401, "Wrong secret header must return 401");

    const validTok = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-mcp-shared-secret": TEST_SECRET,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(validTok.status, 200, "Valid secret header must succeed");

    // 3. Development mode without secret warns and allows
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

  it("MCP-1: disables wildcard CORS headers", async () => {
    process.env.MCP_SHARED_SECRET = TEST_SECRET;
    process.env.NODE_ENV = "production";

    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://evil.example.com" },
    });
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      null,
      "Wildcard CORS must be disabled"
    );
  });

  it("MCP-1: enables DNS rebinding protection and rejects untrusted Host headers", async () => {
    process.env.MCP_SHARED_SECRET = TEST_SECRET;
    process.env.NODE_ENV = "production";

    const evilRes = await rawHttpRequest({
      port,
      method: "POST",
      reqPath: "/mcp",
      headers: {
        Host: "evil.example.com:8080",
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

  it("MCP-5: blocks symlink escape and sibling-prefix bypass in resolveSafePath, resolveSafeWorkspacePath, and /files", async () => {
    const { resolveSafePath, WORKSPACE_DIR } = await import("../src/tools/workspaceTools.js");
    const { resolveSafeWorkspacePath } = await import("../src/tools/patchCore.js");

    // 1. Sibling-prefix bypass: /tmp/ws_sibling when root is /tmp/ws
    const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp5-prefix-"));
    const rootDir = path.join(baseTmp, "workspace");
    const siblingDir = path.join(baseTmp, "workspace_other");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    const siblingFile = path.join(siblingDir, "secret.txt");
    fs.writeFileSync(siblingFile, "TOP_SECRET", "utf8");

    try {
      assert.throws(
        () => resolveSafeWorkspacePath(rootDir, "../workspace_other/secret.txt"),
        /Security Violation|traversal|outside/i,
        "Sibling-prefix traversal must be rejected by resolveSafeWorkspacePath"
      );

      // 2. Symlink escape inside WORKSPACE_DIR pointing to outside file
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp5-outside-"));
      const outsideFile = path.join(outsideDir, "escaped.txt");
      fs.writeFileSync(outsideFile, "ESCAPED_SECRET", "utf8");
      const linkPath = path.join(WORKSPACE_DIR, "evil-link.txt");
      let symlinkCreated = false;
      try {
        try {
          fs.symlinkSync(outsideFile, linkPath, "file");
          symlinkCreated = true;
        } catch {
          // On Windows without Developer Mode, directory junctions work without elevation
          const dirLinkPath = path.join(WORKSPACE_DIR, "evil-dir-link");
          fs.symlinkSync(outsideDir, dirLinkPath, "junction");
          symlinkCreated = true;
          try {
            assert.throws(
              () => resolveSafePath("evil-dir-link/escaped.txt"),
              /Security Violation|symlink|outside/i,
              "Junction symlink escape must be rejected by resolveSafePath"
            );
            assert.throws(
              () => resolveSafeWorkspacePath(WORKSPACE_DIR, "evil-dir-link/escaped.txt"),
              /Security Violation|symlink|outside/i,
              "Junction symlink escape must be rejected by resolveSafeWorkspacePath"
            );

            process.env.MCP_SHARED_SECRET = TEST_SECRET;
            process.env.NODE_ENV = "production";
            const filesRes = await fetch(
              `${baseUrl}/files?path=${encodeURIComponent("evil-dir-link/escaped.txt")}`,
              { headers: { "x-mcp-shared-secret": TEST_SECRET } }
            );
            assert.equal(filesRes.status, 403, "/files must reject symlink escape with 403");
          } finally {
            fs.rmSync(dirLinkPath, { recursive: true, force: true });
          }
        }

        if (symlinkCreated && fs.existsSync(linkPath)) {
          assert.throws(
            () => resolveSafePath("evil-link.txt"),
            /Security Violation|symlink|outside/i,
            "File symlink escape must be rejected by resolveSafePath"
          );
          assert.throws(
            () => resolveSafeWorkspacePath(WORKSPACE_DIR, "evil-link.txt"),
            /Security Violation|symlink|outside/i,
            "File symlink escape must be rejected by resolveSafeWorkspacePath"
          );

          process.env.MCP_SHARED_SECRET = TEST_SECRET;
          process.env.NODE_ENV = "production";
          const filesRes = await fetch(
            `${baseUrl}/files?path=${encodeURIComponent("evil-link.txt")}`,
            { headers: { "x-mcp-shared-secret": TEST_SECRET } }
          );
          assert.equal(filesRes.status, 403, "/files must reject symlink escape with 403");
        }
      } finally {
        fs.rmSync(linkPath, { force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(baseTmp, { recursive: true, force: true });
    }
  });
});
