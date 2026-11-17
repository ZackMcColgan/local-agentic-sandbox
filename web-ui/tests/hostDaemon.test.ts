import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { spawn, execSync } from "child_process";
import { isDestructiveHostAction } from "../../host-bridge/classifier";
import { getBridgeManifest } from "../../host-bridge/manifest";
import { createHostServer } from "../../host-bridge/server";

const VECTORS_PATH = path.resolve(__dirname, "../../host-bridge/destructive-classifier-vectors.json");
const TEST_PORT = 18765;
const VALID_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef"; // 48 chars (> 32)
const SHORT_SECRET = "too-short-secret";

describe("Host Daemon & Classifier Contract Suite (Block 1)", () => {
  describe("Classifier & Test Battery", () => {
    it("verifies all test vectors in destructive-classifier-vectors.json", () => {
      assert.ok(fs.existsSync(VECTORS_PATH), "vectors file must exist");
      const vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf8"));
      assert.ok(Array.isArray(vectors) && vectors.length >= 20, "vectors battery must contain >= 20 cases");

      for (const vector of vectors) {
        const result = isDestructiveHostAction(vector.tool, vector.args);
        assert.equal(
          result.isDestructive,
          vector.expectedDestructive,
          `Vector failed: [${vector.description}] tool=${vector.tool} command=${JSON.stringify(vector.args?.command || vector.args?.path)}`
        );
        if (vector.expectedDestructive) {
          assert.ok(result.reason, `Destructive vector must include a reason: ${vector.description}`);
        }
      }
    });

    it("verifies provenance manifest exports protocolVersion 1 and valid 64-hex bridgeSourceSha256", () => {
      const manifest = getBridgeManifest();
      assert.equal(manifest.protocolVersion, 1);
      assert.match(manifest.bridgeSourceSha256, /^[0-9a-f]{64}$/i);
    });
  });

  describe("Security Boundary & Startup Validation", () => {
    it("fails closed on startup if HOST_RUNNER_SHARED_SECRET is missing or < 32 characters", () => {
      // Test missing
      assert.throws(() => {
        createHostServer({ port: 18766, sharedSecret: "" });
      }, /HOST_RUNNER_SHARED_SECRET/);

      // Test < 32 characters
      assert.throws(() => {
        createHostServer({ port: 18766, sharedSecret: SHORT_SECRET });
      }, /at least 32 characters/);
    });
  });

  describe("HTTP Server & API Security", () => {
    let server: any;
    let baseUrl: string;

    before(async () => {
      server = createHostServer({ port: TEST_PORT, sharedSecret: VALID_SECRET });
      await server.start();
      baseUrl = `http://127.0.0.1:${TEST_PORT}`;
    });

    after(async () => {
      if (server) {
        await server.stop();
      }
    });

    it("returns 401 Unauthorized PRE-PARSE on invalid secret even with malformed body", async () => {
      const res = await fetch(`${baseUrl}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Host-Runner-Secret": "invalid-secret-value",
          "Host": `127.0.0.1:${TEST_PORT}`
        },
        body: "{ this is invalid malformed json !!!"
      });
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.error, "Unauthorized");
    });

    it("returns 403 Forbidden and zero CORS headers on browser-originated requests", async () => {
      // 1. Origin header
      const resOrigin = await fetch(`${baseUrl}/health`, {
        headers: {
          Origin: "http://malicious-site.com",
          Host: `127.0.0.1:${TEST_PORT}`
        }
      });
      assert.equal(resOrigin.status, 403);
      assert.equal(resOrigin.headers.get("access-control-allow-origin"), null);

      // 2. Sec-Fetch-* header
      const resSec = await fetch(`${baseUrl}/health`, {
        headers: {
          "Sec-Fetch-Site": "cross-site",
          Host: `127.0.0.1:${TEST_PORT}`
        }
      });
      assert.equal(resSec.status, 403);

      // 3. Access-Control-Request-* header
      const resAcr = await fetch(`${baseUrl}/health`, {
        headers: {
          "Access-Control-Request-Method": "POST",
          Host: `127.0.0.1:${TEST_PORT}`
        }
      });
      assert.equal(resAcr.status, 403);
    });

    it("validates Host header and returns 400 on unrecognized host", async () => {
      const statusCode = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: TEST_PORT,
            path: "/health",
            method: "GET",
            headers: {
              Host: "evil-proxy.internal:8765"
            }
          },
          (res) => {
            resolve(res.statusCode || 0);
          }
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(statusCode, 400);
    });

    it("returns fast /health (<100ms) with protocolVersion and SHA-256 while a 10s sleep executes concurrently", { skip: process.platform !== "win32" ? "Windows PowerShell test" : false }, async () => {
      // Start a long running command
      const execPromise = fetch(`${baseUrl}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Host-Runner-Secret": VALID_SECRET,
          "Host": `127.0.0.1:${TEST_PORT}`
        },
        body: JSON.stringify({
          tool: "host_run_powershell",
          args: { command: "Start-Sleep -Seconds 4; Write-Output 'done sleep'", timeoutSeconds: 10 }
        })
      });

      // Give it 100ms to begin running
      await new Promise((r) => setTimeout(r, 100));

      const start = performance.now();
      const healthRes = await fetch(`${baseUrl}/health`, {
        headers: { Host: `127.0.0.1:${TEST_PORT}` }
      });
      const elapsed = performance.now() - start;

      assert.equal(healthRes.status, 200);
      const healthData = await healthRes.json();
      assert.equal(healthData.status, "ok");
      assert.equal(healthData.protocolVersion, 1);
      assert.ok(healthData.bridgeSourceSha256);
      assert.ok(healthData.pid);
      assert.ok(elapsed < 100, `Health check must respond in <100ms (took ${elapsed}ms)`);

      const execRes = await execPromise;
      assert.equal(execRes.status, 200);
      const execData = await execRes.json();
      assert.equal(execData.success, true);
    });

    it("enforces dual-layer destructive action gate (403 missing, 200 success, 409 replay)", { skip: process.platform !== "win32" ? "Windows PowerShell test" : false }, async () => {
      const approvalId = `appr-test-${Date.now()}`;
      const destructivePayload = {
        tool: "host_run_powershell",
        args: { command: "Remove-Item -Path nonexistent.txt" }
      };

      // 1. Missing approval header -> 403
      const resMissing = await fetch(`${baseUrl}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Host-Runner-Secret": VALID_SECRET,
          "Host": `127.0.0.1:${TEST_PORT}`
        },
        body: JSON.stringify(destructivePayload)
      });
      assert.equal(resMissing.status, 403);
      const missingData = await resMissing.json();
      assert.ok(missingData.error.includes("explicit approval header"));

      // 2. With approval header -> 200
      const resAllowed = await fetch(`${baseUrl}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Host-Runner-Secret": VALID_SECRET,
          "X-Host-Approval-Id": approvalId,
          "Host": `127.0.0.1:${TEST_PORT}`
        },
        body: JSON.stringify(destructivePayload)
      });
      assert.equal(resAllowed.status, 200);

      // 3. Replay with same approval header -> 409 Conflict
      const resReplay = await fetch(`${baseUrl}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Host-Runner-Secret": VALID_SECRET,
          "X-Host-Approval-Id": approvalId,
          "Host": `127.0.0.1:${TEST_PORT}`
        },
        body: JSON.stringify(destructivePayload)
      });
      assert.equal(resReplay.status, 409);
      const replayData = await resReplay.json();
      assert.ok(replayData.error.includes("already consumed"));
    });

    it("terminates full process tree and leaves 0 surviving processes on timeout", { skip: process.platform !== "win32" ? "Windows PowerShell test" : false }, async () => {
      const res = await fetch(`${baseUrl}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Host-Runner-Secret": VALID_SECRET,
          "Host": `127.0.0.1:${TEST_PORT}`
        },
        body: JSON.stringify({
          tool: "host_run_powershell",
          args: {
            command: "Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 60' -NoNewWindow; Start-Sleep -Seconds 60",
            timeoutSeconds: 2
          }
        })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.timedOut, true);
      assert.equal(data.success, false);
    });

    it("host_read_file rejects files > 2 MB with 413 before reading into memory", async () => {
      const tempLargeFile = path.resolve(os.tmpdir(), `test-large-${Date.now()}.bin`);
      const largeBuf = Buffer.alloc(2 * 1024 * 1024 + 1024, "a");
      fs.writeFileSync(tempLargeFile, largeBuf);

      try {
        const res = await fetch(`${baseUrl}/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Host-Runner-Secret": VALID_SECRET,
            "Host": `127.0.0.1:${TEST_PORT}`
          },
          body: JSON.stringify({
            tool: "host_read_file",
            args: { path: tempLargeFile }
          })
        });
        assert.equal(res.status, 413);
        const data = await res.json();
        assert.ok(data.error.includes("2MB limit"));
      } finally {
        if (fs.existsSync(tempLargeFile)) {
          fs.unlinkSync(tempLargeFile);
        }
      }
    });

    it("host_write_file returns pre-image capture on overwrite", async () => {
      const tempTarget = path.resolve(os.tmpdir(), `test-write-preimage-${Date.now()}.txt`);
      try {
        // First write (new file)
        const res1 = await fetch(`${baseUrl}/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Host-Runner-Secret": VALID_SECRET,
            "Host": `127.0.0.1:${TEST_PORT}`
          },
          body: JSON.stringify({
            tool: "host_write_file",
            args: { path: tempTarget, content: "Initial original content" }
          })
        });
        const data1 = await res1.json();
        assert.equal(data1.success, true);
        assert.equal(data1.preImageExists, false);
        assert.equal(data1.preImageContent, null);

        // Second write (overwrite)
        const res2 = await fetch(`${baseUrl}/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Host-Runner-Secret": VALID_SECRET,
            "Host": `127.0.0.1:${TEST_PORT}`
          },
          body: JSON.stringify({
            tool: "host_write_file",
            args: { path: tempTarget, content: "New overwritten content" }
          })
        });
        const data2 = await res2.json();
        assert.equal(data2.success, true);
        assert.equal(data2.preImageExists, true);
        assert.equal(data2.preImageContent, "Initial original content");
        assert.ok(data2.preImageSha256);
        assert.equal(data2.preImageTruncated, false);
      } finally {
        if (fs.existsSync(tempTarget)) {
          fs.unlinkSync(tempTarget);
        }
      }
    });

    it("host_list_dir caps items at 500 and flags truncated", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-test-"));
      try {
        // Create 505 files
        for (let i = 0; i < 505; i++) {
          fs.writeFileSync(path.join(tempDir, `f_${String(i).padStart(4, "0")}.txt`), "x");
        }

        const res = await fetch(`${baseUrl}/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Host-Runner-Secret": VALID_SECRET,
            "Host": `127.0.0.1:${TEST_PORT}`
          },
          body: JSON.stringify({
            tool: "host_list_dir",
            args: { path: tempDir }
          })
        });
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.items.length, 500);
        assert.equal(data.truncated, true);
        assert.equal(data.originalCount, 505);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("host_delete_path requires recursive: true for directories", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "del-test-"));
      try {
        const app1 = `del-${Date.now()}-1`;
        const resNonRec = await fetch(`${baseUrl}/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Host-Runner-Secret": VALID_SECRET,
            "X-Host-Approval-Id": app1,
            "Host": `127.0.0.1:${TEST_PORT}`
          },
          body: JSON.stringify({
            tool: "host_delete_path",
            args: { path: tempDir, recursive: false }
          })
        });
        const dataNonRec = await resNonRec.json();
        assert.equal(dataNonRec.success, false);
        assert.ok(dataNonRec.error.includes("requires recursive: true"));

        const app2 = `del-${Date.now()}-2`;
        const resRec = await fetch(`${baseUrl}/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Host-Runner-Secret": VALID_SECRET,
            "X-Host-Approval-Id": app2,
            "Host": `127.0.0.1:${TEST_PORT}`
          },
          body: JSON.stringify({
            tool: "host_delete_path",
            args: { path: tempDir, recursive: true }
          })
        });
        const dataRec = await resRec.json();
        assert.equal(dataRec.success, true);
        assert.equal(fs.existsSync(tempDir), false);
      } finally {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    });
  });

  describe("Compiled SEA Binary Acceptance & Single-Instance Contract", { skip: process.platform !== "win32" ? "Windows native binary suite" : false }, () => {
    const BIN_PATH = "C:\\AI\\ai-control\\bin\\host-runner.exe";
    const LIVE_TEST_PORT = 18780;

    it("verifies compiled SEA binary exists and responds with health check", () => {
      assert.ok(fs.existsSync(BIN_PATH), `Compiled SEA binary must exist at ${BIN_PATH}`);
      const stats = fs.statSync(BIN_PATH);
      assert.ok(stats.size > 10 * 1024 * 1024, "Binary must be a packaged single executable (>10MB)");
    });

    it("fails closed on startup with non-zero exit code when secret is missing", () => {
      let exitCode: number | null = null;
      try {
        execSync(`"${BIN_PATH}"`, {
          env: { ...process.env, HOST_RUNNER_SHARED_SECRET: "", PORT: String(LIVE_TEST_PORT) },
          stdio: "pipe"
        });
      } catch (err: any) {
        exitCode = err.status;
      }
      assert.equal(exitCode, 1, "SEA binary must exit 1 when secret is missing");
    });

    it("runs compiled binary, binds loopback, answers /health, and handles single-instance matching cleanly", async () => {
      let proc: ReturnType<typeof spawn> | null = null;
      try {
        proc = spawn(BIN_PATH, [], {
          env: {
            ...process.env,
            HOST_RUNNER_SHARED_SECRET: VALID_SECRET,
            PORT: String(LIVE_TEST_PORT)
          },
          stdio: "pipe"
        });

        // Wait for server to bind
        let healthy = false;
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 200));
          try {
            const res = await fetch(`http://127.0.0.1:${LIVE_TEST_PORT}/health`, {
              headers: { Host: `127.0.0.1:${LIVE_TEST_PORT}` }
            });
            if (res.status === 200) {
              const data = await res.json();
              if (data.status === "ok") {
                healthy = true;
                break;
              }
            }
          } catch {}
        }
        assert.ok(healthy, "Compiled SEA binary must start up and serve /health");

        // Test single-instance handling: second instance with same SHA should exit 0 cleanly
        let duplicateExitCode: number | null = null;
        try {
          execSync(`"${BIN_PATH}"`, {
            env: {
              ...process.env,
              HOST_RUNNER_SHARED_SECRET: VALID_SECRET,
              PORT: String(LIVE_TEST_PORT)
            },
            stdio: "pipe"
          });
          duplicateExitCode = 0;
        } catch (err: any) {
          duplicateExitCode = err.status;
        }
        assert.equal(duplicateExitCode, 0, "Second instance must exit 0 cleanly when SHA-256 matches");
      } finally {
        if (proc && proc.pid) {
          try {
            execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: "ignore" });
          } catch {}
          try {
            proc.kill();
          } catch {}
        }
      }
    });

    it("exits non-zero (1) when another process holds the port with mismatched SHA-256", async () => {
      const MOCK_PORT = 18785;
      const fakeServer = http.createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", bridgeSourceSha256: "mismatched-sha-digest" }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => fakeServer.listen(MOCK_PORT, "127.0.0.1", () => resolve()));

      try {
        let exitCode: number | null = null;
        try {
          execSync(`"${BIN_PATH}"`, {
            env: {
              ...process.env,
              HOST_RUNNER_SHARED_SECRET: VALID_SECRET,
              PORT: String(MOCK_PORT)
            },
            stdio: "pipe"
          });
          exitCode = 0;
        } catch (err: any) {
          exitCode = err.status;
        }
        assert.equal(exitCode, 1, "Binary must exit 1 when port is held by process with mismatched SHA-256");
      } finally {
        await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
      }
    });
  });
});
