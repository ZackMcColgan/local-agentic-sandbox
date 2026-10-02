import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Task 3 — LAN Bridge Behavior & Security Exposure Suite", () => {
  let bridgeModule: any;
  let mockTargetServer: http.Server;
  let mockTargetPort: number;
  let receivedHeaders: Record<string, any> = {};
  const bridgePath = path.resolve(__dirname, "../../scripts/lan-bridge.js");
  const hasBridgeScript = fs.existsSync(bridgePath);

  before(async () => {
    if (!hasBridgeScript) return;

    // 1. Create a dummy target server mimicking the web-ui
    mockTargetServer = http.createServer((req, res) => {
      receivedHeaders = { ...req.headers };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "OK", url: req.url }));
    });

    await new Promise<void>((resolve) => {
      mockTargetServer.listen(0, "127.0.0.1", () => {
        const addr = mockTargetServer.address() as any;
        mockTargetPort = addr.port;
        resolve();
      });
    });

    // 2. Set environment variables for bridge
    process.env.TARGET_PORT = String(mockTargetPort);
    process.env.TARGET_HOST = "127.0.0.1";
    process.env.LISTEN_PORTS = "0"; // Use dynamic port for testing

    bridgeModule = await import(pathToFileURL(bridgePath).href);
  });

  after(async () => {
    if (mockTargetServer) {
      await new Promise<void>((resolve) => mockTargetServer.close(() => resolve()));
    }
  });

  it("exposes the exact startup warning regarding unauthenticated LAN shell execution", (t) => {
    if (!hasBridgeScript) {
      t.skip("Skipping in isolated container build context: scripts/lan-bridge.js not present");
      return;
    }
    const expectedWarning =
      '[LAN Bridge] WARNING: unauthenticated — any device on the local network can reach the UI and execute shell commands via workspace_run_command. See README.md "LAN bridge security" section.';

    assert.equal(
      bridgeModule.STARTUP_WARNING,
      expectedWarning,
      "Bridge must declare the explicit unauthenticated warning log line"
    );
  });

  it("binds 0.0.0.0 by default to allow home LAN connectivity", (t) => {
    if (!hasBridgeScript) {
      t.skip("Skipping in isolated container build context: scripts/lan-bridge.js not present");
      return;
    }
    assert.equal(bridgeModule.DEFAULT_BIND_HOST, "0.0.0.0");
  });

  it("proxies requests without requiring any authentication tokens or credentials", async (t) => {
    if (!hasBridgeScript) {
      t.skip("Skipping in isolated container build context: scripts/lan-bridge.js not present");
      return;
    }
    const bridgeServer = bridgeModule.createProxyServer(0);

    await new Promise<void>((resolve) => {
      bridgeServer.listen(0, "0.0.0.0", () => resolve());
    });

    const bridgeAddr = bridgeServer.address() as any;
    const bridgePort = bridgeAddr.port;

    try {
      // Send completely unauthenticated request
      const res = await fetch(`http://127.0.0.1:${bridgePort}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "test query from lan" })
      });

      // Assert request is NOT blocked or gated (HTTP 200 pass-through)
      assert.equal(res.status, 200, "Unauthenticated request must pass through without auth gate");
      const data = await res.json();
      assert.equal(data.status, "OK");
      assert.equal(data.url, "/api/chat");

      // Verify no auth headers were required or injected
      assert.equal(receivedHeaders["authorization"], undefined);
    } finally {
      await new Promise<void>((resolve) => bridgeServer.close(() => resolve()));
    }
  });
});
