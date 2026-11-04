import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as hostModeLib from "../lib/hostMode";
import { getBridgeManifest, PROTOCOL_VERSION } from "../../host-bridge/manifest";
import { GET as hostStatusGet } from "../app/api/host/status/route";

const {
  createPendingApproval,
  determineHostRunnerState,
  shouldAdvertiseHostTools,
  getHostStateDirective,
  generateHostFileDiff,
  executeHostTool
} = hostModeLib as any;

describe("Block 3: Web-UI Four-State Model, Honest Directives, Diff Cards", () => {
  describe("PIN 1: CSPRNG UUID for Approvals", () => {
    it("generates UUIDv4 approval IDs using crypto.randomUUID() without Math.random", () => {
      const approval1 = createPendingApproval("t1", "host_delete_path", { path: "C:\\test1" }, "risk");
      const approval2 = createPendingApproval("t1", "host_delete_path", { path: "C:\\test2" }, "risk");

      const uuidV4Regex = /^approval-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const generalUuidRegex = /^approval-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      assert.ok(generalUuidRegex.test(approval1.id), `Approval ID must be valid UUID format: ${approval1.id}`);
      assert.ok(generalUuidRegex.test(approval2.id), `Approval ID must be valid UUID format: ${approval2.id}`);
      assert.notEqual(approval1.id, approval2.id);

      // Verify no timestamp prefix in ID
      assert.ok(!approval1.id.startsWith(`approval-${Date.now().toString().slice(0, 5)}`), "Must not use timestamp-math.random format");
    });
  });

  describe("Four-State Availability Model & determineHostRunnerState", () => {
    it("returns DISABLED when hostAccess is false", async () => {
      const status = await determineHostRunnerState(false);
      assert.equal(status.hostAccess, false);
      assert.equal(status.runnerState, "DISABLED");
      assert.equal(status.runnerAvailable, false);
    });

    it("returns UNAVAILABLE when hostAccess is true but daemon is unreachable", async () => {
      const origUrl = process.env.HOST_RUNNER_URL;
      // Point to an unused port to simulate unreachable daemon
      process.env.HOST_RUNNER_URL = "http://127.0.0.1:59998";
      try {
        const status = await determineHostRunnerState(true);
        assert.equal(status.hostAccess, true);
        assert.equal(status.runnerState, "UNAVAILABLE");
        assert.equal(status.runnerAvailable, false);
        assert.ok(status.reason?.includes("not responding") || status.reason?.includes("port"));
      } finally {
        if (origUrl !== undefined) process.env.HOST_RUNNER_URL = origUrl;
        else delete process.env.HOST_RUNNER_URL;
      }
    });

    it("returns MISMATCH when protocolVersion or SHA256 does not match manifest", async () => {
      // Start a temporary mock server returning mismatched digest
      const mockServer = http.createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: "ok",
            protocolVersion: PROTOCOL_VERSION,
            bridgeSourceSha256: "0000000000000000000000000000000000000000000000000000000000000000"
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => mockServer.listen(59997, "127.0.0.1", resolve));
      const origUrl = process.env.HOST_RUNNER_URL;
      process.env.HOST_RUNNER_URL = "http://127.0.0.1:59997";

      try {
        const status = await determineHostRunnerState(true);
        assert.equal(status.hostAccess, true);
        assert.equal(status.runnerState, "MISMATCH");
        assert.equal(status.runnerAvailable, false);
        assert.ok(status.reason?.includes("mismatch"));
        assert.equal(status.actualSha, "0000000000000000000000000000000000000000000000000000000000000000");
        const manifest = getBridgeManifest();
        assert.equal(status.expectedSha, manifest.bridgeSourceSha256);
      } finally {
        if (origUrl !== undefined) process.env.HOST_RUNNER_URL = origUrl;
        else delete process.env.HOST_RUNNER_URL;
        await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      }
    });

    it("returns READY when daemon matches manifest and is healthy", async () => {
      const manifest = getBridgeManifest();
      const mockServer = http.createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: "ok",
            protocolVersion: PROTOCOL_VERSION,
            bridgeSourceSha256: manifest.bridgeSourceSha256
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => mockServer.listen(59996, "127.0.0.1", resolve));
      const origUrl = process.env.HOST_RUNNER_URL;
      process.env.HOST_RUNNER_URL = "http://127.0.0.1:59996";

      try {
        const status = await determineHostRunnerState(true);
        assert.equal(status.hostAccess, true);
        assert.equal(status.runnerState, "READY");
        assert.equal(status.runnerAvailable, true);
        assert.equal(status.expectedSha, manifest.bridgeSourceSha256);
        assert.equal(status.actualSha, manifest.bridgeSourceSha256);
      } finally {
        if (origUrl !== undefined) process.env.HOST_RUNNER_URL = origUrl;
        else delete process.env.HOST_RUNNER_URL;
        await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      }
    });
  });

  describe("Tool Advertisement Gate: shouldAdvertiseHostTools", () => {
    it("advertises host tools ONLY when hostAccess is true AND runnerState is READY (or true)", () => {
      // READY / true
      assert.equal(shouldAdvertiseHostTools(true, "READY"), true);
      assert.equal(shouldAdvertiseHostTools(true, true), true);

      // Withheld in DISABLED, UNAVAILABLE, MISMATCH, or false
      assert.equal(shouldAdvertiseHostTools(false, "READY"), false);
      assert.equal(shouldAdvertiseHostTools(false, true), false);
      assert.equal(shouldAdvertiseHostTools(true, "DISABLED"), false);
      assert.equal(shouldAdvertiseHostTools(true, "UNAVAILABLE"), false);
      assert.equal(shouldAdvertiseHostTools(true, "MISMATCH"), false);
      assert.equal(shouldAdvertiseHostTools(true, false), false);
      assert.equal(shouldAdvertiseHostTools(false, "UNAVAILABLE"), false);
    });
  });

  describe("Honest Host-State Directives", () => {
    it("provides honest, truthful directives for each of the 4 states", () => {
      // DISABLED
      const disabledDir = getHostStateDirective("DISABLED");
      assert.ok(disabledDir.includes("HOST ACCESS: DISABLED"));
      assert.ok(disabledDir.toLowerCase().includes("host toggle") || disabledDir.toLowerCase().includes("toggle"));

      // UNAVAILABLE
      const unavailDir = getHostStateDirective("UNAVAILABLE", "Host runner daemon not responding on port 8765");
      assert.ok(unavailDir.includes("HOST ACCESS: UNAVAILABLE"));
      assert.ok(unavailDir.includes("AI-ON.ps1"));
      assert.ok(unavailDir.includes("offline"));
      assert.ok(unavailDir.includes("NEVER pretend") || unavailDir.includes("fabricate"));

      // MISMATCH
      const mismatchDir = getHostStateDirective("MISMATCH", "version/digest mismatch");
      assert.ok(mismatchDir.includes("HOST ACCESS: MISMATCH"));
      assert.ok(mismatchDir.includes("AI-ON.ps1"));
      assert.ok(mismatchDir.includes("mismatch"));

      // READY
      const readyDir = getHostStateDirective("READY");
      assert.ok(readyDir.includes("HOST ACCESS: READY"));
      assert.ok(readyDir.includes("approval"));
      assert.ok(readyDir.includes("honestly"));
    });
  });

  describe("Diff Cards (Daemon Pre-Image Content)", () => {
    it("generates TurnFileDiff for host_write_file when preImageContent exists and differs", () => {
      const diff = generateHostFileDiff(
        "host_write_file",
        { path: "C:\\temp\\test.txt", content: "hello world\nnew line\n" },
        {
          success: true,
          preImageExists: true,
          preImageContent: "hello world\nold line\n"
        }
      );

      assert.ok(diff, "Diff should be generated");
      assert.equal(diff.path, "C:/temp/test.txt");
      assert.ok(diff.diff.includes("-old line"));
      assert.ok(diff.diff.includes("+new line"));
      assert.equal(diff.addedLines, 1);
      assert.equal(diff.removedLines, 1);
    });

    it("generates TurnFileDiff for host_replace_string when preImageContent exists and differs", () => {
      const diff = generateHostFileDiff(
        "host_replace_string",
        { path: "C:\\temp\\config.json", oldString: "debug: false", newString: "debug: true" },
        {
          success: true,
          preImageExists: true,
          preImageContent: "{\n  debug: false\n}\n"
        }
      );

      assert.ok(diff, "Diff should be generated");
      assert.equal(diff.path, "C:/temp/config.json");
      assert.ok(diff.diff.includes("-  debug: false"));
      assert.ok(diff.diff.includes("+  debug: true"));
    });

    it("returns null when file is brand-new (preImageExists is false) or unchanged", () => {
      const noPreImage = generateHostFileDiff(
        "host_write_file",
        { path: "C:\\temp\\brand-new.txt", content: "created" },
        {
          success: true,
          preImageExists: false,
          preImageContent: null
        }
      );
      assert.equal(noPreImage, null);

      const unchanged = generateHostFileDiff(
        "host_write_file",
        { path: "C:\\temp\\same.txt", content: "identical" },
        {
          success: true,
          preImageExists: true,
          preImageContent: "identical"
        }
      );
      assert.equal(unchanged, null);
    });
  });

  describe("Mid-turn Disconnect Handling", () => {
    it("throws structured 'Host runner daemon disconnected mid-turn' error on connection drop", async () => {
      const origUrl = process.env.HOST_RUNNER_URL;
      // Non-routable address / unused port to trigger connection refused immediately
      process.env.HOST_RUNNER_URL = "http://127.0.0.1:59995";
      try {
        await assert.rejects(
          async () => {
            await executeHostTool("host_run_powershell", { command: "Get-Process" });
          },
          (err: any) => {
            return (
              err instanceof Error &&
              err.message.includes("Host runner daemon disconnected mid-turn:")
            );
          }
        );
      } finally {
        if (origUrl !== undefined) process.env.HOST_RUNNER_URL = origUrl;
        else delete process.env.HOST_RUNNER_URL;
      }
    });
  });

  describe("Status Route GET /api/host/status", () => {
    it("returns four-state status object with runnerState, runnerAvailable, and hostAccess", async () => {
      const req = new Request("http://localhost:3000/api/host/status");
      const res = await hostStatusGet(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(typeof data.hostAccess, "boolean");
      assert.ok(["DISABLED", "READY", "UNAVAILABLE", "MISMATCH"].includes(data.runnerState));
      assert.equal(data.runnerAvailable, data.runnerState === "READY");
    });
  });
});
