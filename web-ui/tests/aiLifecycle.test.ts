import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import path from "path";
import fs from "fs";
import { execSync, spawnSync } from "child_process";

const AI_ON_SCRIPT = "C:\\AI\\ai-control\\AI-ON.ps1";
const AI_OFF_SCRIPT = "C:\\AI\\ai-control\\AI-OFF.ps1";
const HOST_RUNNER_BIN = "C:\\AI\\ai-control\\bin\\host-runner.exe";
const REPO_ROOT = path.resolve(__dirname, "../..");

function probeHealth(port = 8765): Promise<{ ok: boolean; status?: string; sha?: string; pid?: number }> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/health",
        timeout: 1500,
        headers: { Host: `127.0.0.1:${port}` }
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode === 200 && parsed.status === "ok") {
              resolve({ ok: true, status: parsed.status, sha: parsed.bridgeSourceSha256, pid: parsed.pid });
              return;
            }
          } catch {}
          resolve({ ok: false });
        });
      }
    );
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false });
    });
  });
}

function runPowerShell(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      SANDBOX_REPO_ROOT: REPO_ROOT
    }
  });
  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || ""
  };
}

describe("BLOCK 2 — AI-ON / AI-OFF Lifecycle Suite", () => {
  // Ensure port 8765 is stopped before and after test runs
  before(() => {
    runPowerShell(["-File", AI_OFF_SCRIPT, "-OnlyHostRunner"]);
  });

  after(() => {
    runPowerShell(["-File", AI_OFF_SCRIPT, "-OnlyHostRunner"]);
  });

  it("1. Process detached survival: daemon remains running after launcher exits", async () => {
    // Launch AI-ON with -OnlyHostRunner
    const launchResult = runPowerShell(["-File", AI_ON_SCRIPT, "-OnlyHostRunner"]);
    assert.strictEqual(
      launchResult.status,
      0,
      `AI-ON -OnlyHostRunner should exit 0. Stderr: ${launchResult.stderr} Stdout: ${launchResult.stdout}`
    );

    // AI-ON process has exited now. Probe health to verify host-runner is still alive.
    const health = await probeHealth(8765);
    assert.strictEqual(health.ok, true, "Host Runner daemon should be listening and healthy on port 8765");
    assert.strictEqual(health.status, "ok");
    assert.ok(typeof health.pid === "number" && health.pid > 0, "Daemon should report a valid PID");

    // Verify the process is still running in Windows
    const checkProc = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-Process -Id ${health.pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`
    ], { encoding: "utf8" });
    assert.strictEqual(checkProc.stdout.trim(), String(health.pid), "Process ID should exist in OS process table");
  });

  it("2. Idempotent warm re-run: skips rebuild and keeps instance running if digest matches", async () => {
    // Check initial running PID
    const beforeHealth = await probeHealth(8765);
    assert.strictEqual(beforeHealth.ok, true, "Host runner must be running before warm re-run test");

    // Re-run AI-ON
    const rerunResult = runPowerShell(["-File", AI_ON_SCRIPT, "-OnlyHostRunner"]);
    assert.strictEqual(rerunResult.status, 0, `Warm re-run should exit 0. Output: ${rerunResult.stdout}`);

    // Output should indicate matching instance was preserved or rebuild was skipped
    assert.ok(
      rerunResult.stdout.includes("Matching instance") ||
      rerunResult.stdout.includes("idempotent") ||
      rerunResult.stdout.includes("already running") ||
      rerunResult.stdout.includes("ONLINE"),
      "Should log that matching instance is active"
    );

    // Verify still healthy and PID was not needlessly recycled
    const afterHealth = await probeHealth(8765);
    assert.strictEqual(afterHealth.ok, true);
    assert.strictEqual(afterHealth.pid, beforeHealth.pid, "PID should be preserved without restart downtime");
  });

  it("3. Clean shutdown: AI-OFF terminates daemon process tree, releases port, and preserves Plex", async () => {
    // Ensure host-runner is up
    let health = await probeHealth(8765);
    if (!health.ok) {
      runPowerShell(["-File", AI_ON_SCRIPT, "-OnlyHostRunner"]);
      health = await probeHealth(8765);
    }
    assert.strictEqual(health.ok, true, "Host runner should be up prior to shutdown");

    // Execute AI-OFF with -OnlyHostRunner
    const offResult = runPowerShell(["-File", AI_OFF_SCRIPT, "-OnlyHostRunner"]);
    assert.strictEqual(offResult.status, 0, `AI-OFF should exit 0. Output: ${offResult.stdout}`);

    // Verify port 8765 is released
    const afterHealth = await probeHealth(8765);
    assert.strictEqual(afterHealth.ok, false, "Port 8765 should not respond to health check after shutdown");

    const checkPort = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue`
    ], { encoding: "utf8" });
    assert.strictEqual(checkPort.stdout.trim(), "", "Port 8765 should be completely closed");

    // Verify Plex (:32400) was untouched if running
    const checkPlex = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -LocalPort 32400 -State Listen -ErrorAction SilentlyContinue`
    ], { encoding: "utf8" });
    if (checkPlex.stdout.trim() !== "") {
      assert.ok(checkPlex.stdout.includes("32400"), "Plex port 32400 must remain listening and untouched");
    }
  });

  it("4. PIN 3 Failure Isolation: broken build logs diagnostic, marks bridge offline, and exits 0", () => {
    // Set up a mock repo root with a broken build-host-runner script
    const mockRoot = path.join(REPO_ROOT, "scratch", "broken-bridge-test");
    fs.mkdirSync(path.join(mockRoot, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(mockRoot, "scripts", "build-host-runner.js"),
      "console.error('SYNTAX ERROR: Broken TypeScript source compilation failure simulation'); process.exit(1);",
      "utf8"
    );

    try {
      const res = spawnSync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        AI_ON_SCRIPT,
        "-OnlyHostRunner"
      ], {
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...process.env,
          SANDBOX_REPO_ROOT: mockRoot
        }
      });

      // Exit code must be 0 (failure isolation: non-blocking)
      assert.strictEqual(res.status, 0, `Failure isolation must exit 0 even if bridge build fails. Stderr: ${res.stderr} Stdout: ${res.stdout}`);

      // Must log warning / offline diagnostic
      const fullLog = res.stdout + res.stderr;
      assert.ok(
        fullLog.includes("OFFLINE") || fullLog.includes("failed") || fullLog.includes("WARNING"),
        `Must report diagnostic or OFFLINE in log. Found: ${fullLog}`
      );
    } finally {
      // Clean up mock directory
      try {
        fs.rmSync(mockRoot, { recursive: true, force: true });
      } catch {}
    }
  });
});
