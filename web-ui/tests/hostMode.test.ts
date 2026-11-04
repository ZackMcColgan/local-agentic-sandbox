import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isDestructiveHostAction,
  createPendingApproval,
  getPendingApprovals,
  resolvePendingApproval,
  HOST_TOOLS_DEFINITIONS,
  executeHostTool,
  checkHostRunnerHealth,
  getHostRunnerBaseUrl,
  HOST_RUNNER_BASE_URL
} from "../lib/hostMode";

describe("Host Mode & Destructive Action Gate Suite", () => {
  it("defines all 5 standard host tools with valid schemas", () => {
    assert.equal(HOST_TOOLS_DEFINITIONS.length, 5);
    const names = HOST_TOOLS_DEFINITIONS.map((t) => t.function.name);
    assert.ok(names.includes("host_run_powershell"));
    assert.ok(names.includes("host_read_file"));
    assert.ok(names.includes("host_write_file"));
    assert.ok(names.includes("host_list_dir"));
    assert.ok(names.includes("host_delete_path"));
  });

  it("detects destructive PowerShell patterns and file deletion", () => {
    const delPath = isDestructiveHostAction("host_delete_path", { path: "C:\\Windows\\temp" });
    assert.equal(delPath.isDestructive, true);

    const safePs = isDestructiveHostAction("host_run_powershell", { command: "Get-Process | Select-Object -First 5" });
    assert.equal(safePs.isDestructive, false);

    const rmPs = isDestructiveHostAction("host_run_powershell", { command: "Remove-Item -Recurse -Force ./build" });
    assert.equal(rmPs.isDestructive, true);

    const taskkillPs = isDestructiveHostAction("host_run_powershell", { command: "taskkill /F /IM node.exe" });
    assert.equal(taskkillPs.isDestructive, true);
  });

  it("manages pending approvals in memory without persistence", () => {
    const req = createPendingApproval(
      "thread-test-1",
      "host_delete_path",
      { path: "D:\\AI\\temp_junk.txt" },
      "Permanent deletion of host path"
    );

    assert.equal(req.status, "pending");
    const pending = getPendingApprovals("thread-test-1");
    assert.ok(pending.some((p) => p.id === req.id));

    const resolved = resolvePendingApproval(req.id, "approved");
    assert.equal(resolved?.status, "approved");
  });
});

describe("Host Mode F1 Client Execution & Auth Suite", () => {
  it("getHostRunnerBaseUrl defaults to loopback and respects HOST_RUNNER_URL", () => {
    const origUrl = process.env.HOST_RUNNER_URL;
    try {
      delete process.env.HOST_RUNNER_URL;
      assert.equal(getHostRunnerBaseUrl(), "http://127.0.0.1:8765");
      process.env.HOST_RUNNER_URL = "http://custom-host:8765";
      assert.equal(getHostRunnerBaseUrl(), "http://custom-host:8765");
    } finally {
      if (origUrl !== undefined) {
        process.env.HOST_RUNNER_URL = origUrl;
      } else {
        delete process.env.HOST_RUNNER_URL;
      }
    }
  });

  it("executeHostTool sends X-Host-Runner-Secret header from HOST_RUNNER_SHARED_SECRET", async () => {
    const origFetch = global.fetch;
    const origSecret = process.env.HOST_RUNNER_SHARED_SECRET;
    let capturedHeaders: Record<string, string> = {};

    try {
      process.env.HOST_RUNNER_SHARED_SECRET = "secret-test-token-xyz";
      global.fetch = (async (_url: any, init?: any) => {
        capturedHeaders = (init?.headers as Record<string, string>) || {};
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true })
        } as Response;
      }) as typeof fetch;

      await executeHostTool("host_list_dir", { path: "." });
      assert.equal(
        capturedHeaders["X-Host-Runner-Secret"],
        "secret-test-token-xyz",
        "executeHostTool must forward X-Host-Runner-Secret from environment"
      );
    } finally {
      global.fetch = origFetch;
      process.env.HOST_RUNNER_SHARED_SECRET = origSecret;
    }
  });

  it("executeHostTool uses timeoutSeconds (default 120, cap 600) + 5s transport buffer for host_run_powershell, and 30s for file/list calls", async () => {
    const origFetch = global.fetch;
    const origTimeout = AbortSignal.timeout;
    const timeoutsUsed: number[] = [];

    try {
      AbortSignal.timeout = (ms: number) => {
        timeoutsUsed.push(ms);
        return origTimeout.call(AbortSignal, ms);
      };

      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true })
      })) as any;

      // 1. Default timeout (120s + 5s buffer = 125s = 125,000ms)
      await executeHostTool("host_run_powershell", { command: "Get-Date" });
      assert.equal(timeoutsUsed[timeoutsUsed.length - 1], 125000, "Default timeout should be (120 + 5) * 1000 ms");

      // 2. Custom timeout within range (30s + 5s buffer = 35s = 35,000ms)
      await executeHostTool("host_run_powershell", { command: "Get-Date", timeoutSeconds: 30 });
      assert.equal(timeoutsUsed[timeoutsUsed.length - 1], 35000, "30s timeout should be (30 + 5) * 1000 ms");

      // 3. Custom timeout capped at 600s (600s + 5s buffer = 605s = 605,000ms)
      await executeHostTool("host_run_powershell", { command: "Get-Date", timeoutSeconds: 999 });
      assert.equal(timeoutsUsed[timeoutsUsed.length - 1], 605000, "Capped timeout should be (600 + 5) * 1000 ms");

      // 4. File / list calls use fixed 30s (30,000ms)
      await executeHostTool("host_read_file", { path: "C:\\test.txt" });
      assert.equal(timeoutsUsed[timeoutsUsed.length - 1], 30000, "File reads should use 30,000 ms");

      await executeHostTool("host_list_dir", { path: "C:\\test" });
      assert.equal(timeoutsUsed[timeoutsUsed.length - 1], 30000, "List dir should use 30,000 ms");
    } finally {
      global.fetch = origFetch;
      AbortSignal.timeout = origTimeout;
    }
  });

  it("checkHostRunnerHealth sends GET /health with 1500ms timeout; returns true on 200 {'status':'ok'}, and false on 500, bad json, or network timeout", async () => {
    const origFetch = global.fetch;
    const origTimeout = AbortSignal.timeout;
    let lastTimeoutMs: number | null = null;
    let lastMethod: string | null = null;
    let lastUrl: string | null = null;

    try {
      AbortSignal.timeout = (ms: number) => {
        lastTimeoutMs = ms;
        return origTimeout.call(AbortSignal, ms);
      };

      // Case 1: Healthy 200 {"status":"ok"}
      global.fetch = (async (url: any, init?: any) => {
        lastUrl = String(url);
        lastMethod = init?.method || "GET";
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ok" })
        } as Response;
      }) as typeof fetch;

      const healthy = await checkHostRunnerHealth();
      assert.equal(healthy, true, "checkHostRunnerHealth must return true on 200 ok");
      assert.equal(lastTimeoutMs, 1500, "checkHostRunnerHealth must use 1500ms timeout");
      assert.equal(lastMethod, "GET", "checkHostRunnerHealth must use GET");
      assert.ok(lastUrl?.endsWith("/health"), "checkHostRunnerHealth must target /health");

      // Case 2: HTTP 500 error
      global.fetch = (async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "internal server error" })
      })) as any;
      const unhealthy500 = await checkHostRunnerHealth();
      assert.equal(unhealthy500, false, "checkHostRunnerHealth must return false on HTTP 500");

      // Case 3: Bad JSON payload {"status":"error"}
      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "error" })
      })) as any;
      const unhealthyBadPayload = await checkHostRunnerHealth();
      assert.equal(unhealthyBadPayload, false, "checkHostRunnerHealth must return false on bad payload");

      // Case 4: Network rejection
      global.fetch = (async () => {
        throw new TypeError("Failed to fetch");
      }) as any;
      const unhealthyNetwork = await checkHostRunnerHealth();
      assert.equal(unhealthyNetwork, false, "checkHostRunnerHealth must return false on network error");

      // Case 5: Timeout rejection
      global.fetch = (async () => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      }) as any;
      const unhealthyTimeout = await checkHostRunnerHealth();
      assert.equal(unhealthyTimeout, false, "checkHostRunnerHealth must return false on timeout");
    } finally {
      global.fetch = origFetch;
      AbortSignal.timeout = origTimeout;
    }
  });
});
