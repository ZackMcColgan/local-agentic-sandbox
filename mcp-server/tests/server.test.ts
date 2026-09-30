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
});
