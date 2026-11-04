import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";

describe("Start-HostRunner.ps1 Static Security & Conformance Suite", () => {
  const scriptPath = path.resolve(__dirname, "../../scripts/Start-HostRunner.ps1");
  const scriptContent = fs.readFileSync(scriptPath, "utf8");

  it("does not bind to 0.0.0.0 anywhere in the file", () => {
    assert.ok(
      !scriptContent.includes("0.0.0.0"),
      "Start-HostRunner.ps1 must not contain 0.0.0.0 anywhere"
    );
  });

  it("does not contain Access-Control-Allow-Origin or any Access-Control-Allow- headers", () => {
    assert.ok(
      !scriptContent.includes("Access-Control-Allow-Origin"),
      "Start-HostRunner.ps1 must not contain Access-Control-Allow-Origin"
    );
    assert.ok(
      !scriptContent.includes("Access-Control-Allow-"),
      "Start-HostRunner.ps1 must not contain Access-Control-Allow- headers"
    );
  });

  it("binds strictly to loopback prefix http://127.0.0.1: and has no BindAddress parameter", () => {
    assert.ok(
      scriptContent.includes("http://127.0.0.1:"),
      "Start-HostRunner.ps1 must bind to http://127.0.0.1:"
    );
    assert.ok(
      !scriptContent.includes("$BindAddress"),
      "Start-HostRunner.ps1 must not have a BindAddress parameter"
    );
  });

  it("enforces an auth check with X-Host-Runner-Secret and SHA-256 fixed-time comparison", () => {
    assert.ok(
      scriptContent.includes("X-Host-Runner-Secret"),
      "Start-HostRunner.ps1 must verify the X-Host-Runner-Secret header"
    );
    assert.ok(
      scriptContent.includes("SHA256") || scriptContent.includes("SHA-256"),
      "Start-HostRunner.ps1 must compute SHA-256 hashes for secret verification"
    );
    assert.ok(
      scriptContent.includes("FixedTime") || scriptContent.includes("-bxor"),
      "Start-HostRunner.ps1 must use a fixed-time/constant-time comparison"
    );
  });

  it("never echoes commands in console output (Write-Host must never reference $command)", () => {
    const lines = scriptContent.split(/\r?\n/);
    for (const line of lines) {
      if (line.includes("Write-Host")) {
        assert.ok(
          !line.includes("$command"),
          `Write-Host line must not reference $command: ${line.trim()}`
        );
      }
    }
  });

  it("/health returns exact JSON status ok without extra metadata", () => {
    assert.ok(
      scriptContent.includes('{"status":"ok"}'),
      'Start-HostRunner.ps1 health endpoint must return exact {"status":"ok"}'
    );
    assert.ok(
      !scriptContent.includes('"powershell_host"'),
      "Start-HostRunner.ps1 health endpoint must not include powershell_host"
    );
  });
});

describe("Start-HostRunner.ps1 Live Loopback & Execution Suite", () => {
  const scriptPath = path.resolve(__dirname, "../../scripts/Start-HostRunner.ps1");
  const testPort = 8765;
  const testSecret = `disposable-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let tempDir: string;
  let runnerProc: ReturnType<typeof spawn> | null = null;

  function stopRunner() {
    if (runnerProc && runnerProc.pid) {
      try {
        execSync(`taskkill /PID ${runnerProc.pid} /T /F`, { stdio: "ignore" });
      } catch {}
      try {
        runnerProc.kill();
      } catch {}
      runnerProc = null;
    }
  }

  it("starts runner, binds loopback-only, authenticates via shared secret, and handles tool execution with timeouts", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-runner-live-"));
    const fixtureFile = path.join(tempDir, "hello.txt");
    fs.writeFileSync(fixtureFile, "Hello from live host runner test!");

    try {
      // 1. Spawn host runner process
      runnerProc = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-Port",
          String(testPort)
        ],
        {
          cwd: tempDir,
          env: {
            ...process.env,
            HOST_RUNNER_SHARED_SECRET: testSecret
          },
          stdio: "pipe"
        }
      );

      // 2. Poll /health until 200 {"status":"ok"}
      let healthy = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        try {
          const res = await fetch(`http://127.0.0.1:${testPort}/health`);
          if (res.status === 200) {
            const body = (await res.json()) as any;
            if (body?.status === "ok") {
              healthy = true;
              break;
            }
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 300));
      }
      assert.ok(healthy, "Host runner failed to become healthy on http://127.0.0.1:8765/health");

      // 3. Verify port is bound ONLY to 127.0.0.1
      const tcpOut = execSync(
        `powershell.exe -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${testPort} -ErrorAction SilentlyContinue).LocalAddress"`,
        { encoding: "utf8" }
      ).trim();
      const boundAddresses = tcpOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      assert.ok(boundAddresses.length > 0, "No TCP listener found on test port");
      for (const addr of boundAddresses) {
        assert.equal(addr, "127.0.0.1", `Port ${testPort} must bind only to 127.0.0.1, got: ${addr}`);
      }

      // 4. Unauthenticated POST /execute -> 401
      const unauthRes = await fetch(`http://127.0.0.1:${testPort}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "host_list_dir", args: { path: tempDir } })
      });
      assert.equal(unauthRes.status, 401, "Unauthenticated request must return HTTP 401");
      const unauthData = (await unauthRes.json()) as any;
      assert.equal(unauthData?.error, "Unauthorized");

      // 5. Wrong secret POST /execute -> 401
      const wrongRes = await fetch(`http://127.0.0.1:${testPort}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Host-Runner-Secret": "wrong-secret-token"
        },
        body: JSON.stringify({ tool: "host_list_dir", args: { path: tempDir } })
      });
      assert.equal(wrongRes.status, 401, "Wrong secret request must return HTTP 401");
      const wrongData = (await wrongRes.json()) as any;
      assert.equal(wrongData?.error, "Unauthorized");

      // 6. Correct secret POST /execute with host_list_dir -> 200, success: true, lists hello.txt
      const listRes = await fetch(`http://127.0.0.1:${testPort}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Host-Runner-Secret": testSecret
        },
        body: JSON.stringify({ tool: "host_list_dir", args: { path: tempDir } })
      });
      assert.equal(listRes.status, 200, "Authorized host_list_dir must return HTTP 200");
      const listData = (await listRes.json()) as any;
      assert.equal(listData?.success, true);
      assert.ok(Array.isArray(listData?.items), "Items must be returned as an array");
      const names = listData.items.map((i: any) => i.Name);
      assert.ok(names.includes("hello.txt"), "Items array must contain hello.txt");

      // 7. Correct secret POST /execute with host_run_powershell timeoutSeconds: 2 -> returns 200, timedOut: true
      const startMs = Date.now();
      const timeoutRes = await fetch(`http://127.0.0.1:${testPort}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Host-Runner-Secret": testSecret
        },
        body: JSON.stringify({
          tool: "host_run_powershell",
          args: { command: "Start-Sleep -Seconds 10", timeoutSeconds: 2 }
        })
      });
      const elapsedMs = Date.now() - startMs;
      assert.equal(timeoutRes.status, 200, "Timed out command request must return HTTP 200");
      const timeoutData = (await timeoutRes.json()) as any;
      assert.equal(timeoutData?.success, false);
      assert.equal(timeoutData?.timedOut, true);
      assert.equal(timeoutData?.timeoutSeconds, 2);
      assert.ok(
        elapsedMs >= 1800 && elapsedMs < 8000,
        `Execution should take roughly 2-4 seconds, took ${elapsedMs}ms`
      );

      // 8. Test host_delete_path requires recursive: true for directory
      const subDir = path.join(tempDir, "subdir");
      fs.mkdirSync(subDir);
      const delDirNonRecursive = await fetch(`http://127.0.0.1:${testPort}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Host-Runner-Secret": testSecret
        },
        body: JSON.stringify({
          tool: "host_delete_path",
          args: { path: subDir }
        })
      });
      const delDirNonRecData = (await delDirNonRecursive.json()) as any;
      assert.equal(delDirNonRecData?.success, false);
      assert.equal(delDirNonRecData?.error, "Directory deletion requires recursive: true");
      assert.ok(fs.existsSync(subDir), "Directory must not be deleted without recursive: true");

      // 9. Test cwd validation
      const badCwdRes = await fetch(`http://127.0.0.1:${testPort}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Host-Runner-Secret": testSecret
        },
        body: JSON.stringify({
          tool: "host_run_powershell",
          args: { command: "Get-Date", cwd: "Z:\\NonExistentPathXYZ123" }
        })
      });
      const badCwdData = (await badCwdRes.json()) as any;
      assert.equal(badCwdData?.success, false);
      assert.ok(badCwdData?.error?.includes("Directory not found"));
    } finally {
      stopRunner();
      if (tempDir && fs.existsSync(tempDir)) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    }
  });
});
