import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import path from "path";
import fs from "fs";
import os from "os";
import { spawn, spawnSync } from "child_process";
import { assertSacrificialTarget, PROD_HOST_RUNNER_PORT } from "../lib/lifecycleTargetGuard";

const HOST_RUNNER_BIN = "C:\\AI\\ai-control\\bin\\host-runner.exe";
const TARGET_PORT = parseInt(process.env.TEST_LIFECYCLE_PORT || "8799", 10);
const SACRIFICIAL_CONFIG_DIR = process.env.TEST_LIFECYCLE_CONFIG_DIR || path.join(os.tmpdir(), "sacrificial-host-runner-live-" + Date.now());

// (3) HARD GUARD: asserts that target runner is strictly sacrificial and refuses production target immediately
assertSacrificialTarget({ port: TARGET_PORT, configDir: SACRIFICIAL_CONFIG_DIR });

function probeHealth(port: number): Promise<{ ok: boolean; status?: string; sha?: string; pid?: number }> {
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

function killProcessTree(pid: number) {
  try {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
  } catch {}
}

async function waitForPortState(port: number, shouldListen: boolean, maxWaitMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const h = await probeHealth(port);
    if (h.ok === shouldListen) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function spawnSacrificialInstance(port: number, configDir: string) {
  // Re-verify hard guard before spawning
  assertSacrificialTarget({ port, configDir });

  fs.mkdirSync(configDir, { recursive: true });
  const child = spawn(HOST_RUNNER_BIN, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PORT: String(port),
      HOST_RUNNER_SHARED_SECRET: "sacrificial-live-tier-secret-at-least-32-chars-long",
      LOCALAPPDATA: configDir,
      APPDATA: configDir
    }
  });
  child.unref();
  return child;
}

describe("LIVE TIER — Host Runner Sacrificial Lifecycle Suite", { skip: process.platform !== "win32" ? "Windows-only" : false }, () => {
  let prodDaemonPid: number | undefined;
  let activeSacrificialPid: number | null = null;

  before(async () => {
    // Record production runner PID proof to guarantee zero interference
    const prodHealth = await probeHealth(PROD_HOST_RUNNER_PORT);
    if (prodHealth.ok && prodHealth.pid) {
      prodDaemonPid = prodHealth.pid;
    }

    // Ensure sacrificial port is initially free
    const initialCheck = await probeHealth(TARGET_PORT);
    if (initialCheck.ok && initialCheck.pid) {
      killProcessTree(initialCheck.pid);
      await waitForPortState(TARGET_PORT, false);
    }
  });

  after(async () => {
    // Teardown sacrificial runner cleanly
    if (activeSacrificialPid) {
      killProcessTree(activeSacrificialPid);
      activeSacrificialPid = null;
    }
    const finalCheck = await probeHealth(TARGET_PORT);
    if (finalCheck.ok && finalCheck.pid) {
      killProcessTree(finalCheck.pid);
    }
    await waitForPortState(TARGET_PORT, false);

    // Clean up temporary config directory
    try {
      fs.rmSync(SACRIFICIAL_CONFIG_DIR, { recursive: true, force: true });
    } catch {}

    // Verify production host runner was never touched
    if (prodDaemonPid) {
      const prodHealth = await probeHealth(PROD_HOST_RUNNER_PORT);
      assert.strictEqual(prodHealth.ok, true, "Production host runner must still be healthy on port 8765");
      assert.strictEqual(prodHealth.pid, prodDaemonPid, "Production host runner PID must remain identical");
    }
  });

  it("1. Process detached survival: sacrificial daemon remains running after launcher exits", async () => {
    spawnSacrificialInstance(TARGET_PORT, SACRIFICIAL_CONFIG_DIR);
    const ready = await waitForPortState(TARGET_PORT, true, 10000);
    assert.strictEqual(ready, true, `Sacrificial daemon should become ready on port ${TARGET_PORT}`);

    const health = await probeHealth(TARGET_PORT);
    assert.strictEqual(health.ok, true);
    assert.ok(typeof health.pid === "number" && health.pid > 0);
    activeSacrificialPid = health.pid;

    // Verify it is NOT the production PID
    if (prodDaemonPid) {
      assert.notStrictEqual(health.pid, prodDaemonPid, "Sacrificial instance PID must not be production PID");
    }

    // Verify process is active in OS
    const checkProc = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-Process -Id ${health.pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`
    ], { encoding: "utf8" });
    assert.strictEqual(checkProc.stdout.trim(), String(health.pid), "Process ID should exist in OS process table");
  });

  it("2. Idempotent warm probe: matching sacrificial instance preserves PID and state", async () => {
    const beforeHealth = await probeHealth(TARGET_PORT);
    assert.strictEqual(beforeHealth.ok, true);

    // Second probe simulating warm check
    const afterHealth = await probeHealth(TARGET_PORT);
    assert.strictEqual(afterHealth.ok, true);
    assert.strictEqual(afterHealth.pid, beforeHealth.pid, "PID must be preserved on warm check");
  });

  it("3. Clean shutdown: terminating sacrificial runner releases port completely", async () => {
    const health = await probeHealth(TARGET_PORT);
    assert.strictEqual(health.ok, true);

    if (health.pid) {
      killProcessTree(health.pid);
      activeSacrificialPid = null;
    }

    const released = await waitForPortState(TARGET_PORT, false, 8000);
    assert.strictEqual(released, true, `Port ${TARGET_PORT} should be completely closed after termination`);

    // Verify production daemon on 8765 was untouched
    if (prodDaemonPid) {
      const prodCheck = await probeHealth(PROD_HOST_RUNNER_PORT);
      assert.strictEqual(prodCheck.ok, true, "Production daemon on 8765 must remain healthy");
      assert.strictEqual(prodCheck.pid, prodDaemonPid, "Production daemon PID must remain untouched");
    }
  });
});
