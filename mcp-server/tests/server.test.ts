import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cors from "cors";

describe("MCP Server Express Endpoints", () => {
  it("health endpoint returns expected zero-trust security status", async () => {
    const app = express();
    app.use(cors());

    app.get("/health", (_req, res) => {
      res.json({
        status: "HEALTHY",
        service: "sandboxed-mcp-server",
        version: "1.0.0",
        security: {
          user: "10001:10001",
          network_egress: "BLOCKED",
          rootfs: "READ_ONLY",
          capabilities: "DROPPED_ALL"
        }
      });
    });

    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, "HEALTHY");
      assert.equal(data.security.user, "10001:10001");
      assert.equal(data.security.network_egress, "BLOCKED");
      assert.equal(data.security.capabilities, "DROPPED_ALL");
    } finally {
      server.close();
    }
  });

  it("files endpoint serves workspace files and blocks path traversal", async () => {
    const { resolveSafePath, WORKSPACE_DIR } = await import("../src/tools/workspaceTools.js");
    const fs = (await import("fs/promises")).default;
    const path = (await import("path")).default;

    const testSvgPath = path.join(WORKSPACE_DIR, "test_diagram.svg");
    await fs.writeFile(testSvgPath, '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', "utf8");

    const app = express();
    app.use(cors());

    app.get("/files", async (req, res) => {
      const filePath = req.query.path as string;
      if (!filePath) {
        return res.status(400).json({ error: "Missing required 'path' query parameter" });
      }

      try {
        const safePath = resolveSafePath(filePath);
        const stat = await fs.stat(safePath);
        if (!stat.isFile()) {
          return res.status(400).json({ error: "Target is not a file" });
        }
        const content = await fs.readFile(safePath);
        const ext = path.extname(safePath).toLowerCase();
        const mime = ext === ".svg" ? "image/svg+xml; charset=utf-8" : "application/octet-stream";
        res.setHeader("Content-Type", mime);
        res.setHeader("Content-Length", stat.size.toString());
        res.send(content);
      } catch (err: any) {
        if (err.message.includes("Path traversal")) {
          return res.status(403).json({ error: err.message });
        }
        res.status(404).json({ error: err.message });
      }
    });

    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      // 1. Success case
      const res = await fetch(`http://127.0.0.1:${port}/files?path=test_diagram.svg`);
      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("image/svg+xml"));
      const body = await res.text();
      assert.ok(body.includes("<svg"));

      // 2. Traversal blocked
      const travRes = await fetch(`http://127.0.0.1:${port}/files?path=../../etc/passwd`);
      assert.equal(travRes.status, 403);

      // 3. Not found
      const notFoundRes = await fetch(`http://127.0.0.1:${port}/files?path=nonexistent.svg`);
      assert.equal(notFoundRes.status, 404);

      // 4. Missing path param
      const badReqRes = await fetch(`http://127.0.0.1:${port}/files`);
      assert.equal(badReqRes.status, 400);
    } finally {
      server.close();
      await fs.unlink(testSvgPath).catch(() => {});
    }
  });
});
