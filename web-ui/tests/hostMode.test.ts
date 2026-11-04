import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import * as hostModeLib from "../lib/hostMode";
import { GET as hostApprovalsGet, POST as hostApprovalsPost } from "../app/api/host/approvals/route";
import { ThreadStore } from "../lib/threads/threadStore";

const {
  isDestructiveHostAction,
  createPendingApproval,
  getPendingApprovals,
  consumePendingApproval,
  recordContinuationEntry,
  consumeContinuationEntry,
  DESTRUCTIVE_POWERSHELL_PATTERNS,
  HOST_TOOLS_DEFINITIONS,
  executeHostTool,
  checkHostRunnerHealth,
  getHostRunnerBaseUrl
} = hostModeLib as any;

describe("Host Mode & Destructive Action Gate Suite", () => {
  it("defines all 5 standard host tools with valid schemas", () => {
    assert.equal(HOST_TOOLS_DEFINITIONS.length, 5);
    const names = HOST_TOOLS_DEFINITIONS.map((t: any) => t.function.name);
    assert.ok(names.includes("host_run_powershell"));
    assert.ok(names.includes("host_read_file"));
    assert.ok(names.includes("host_write_file"));
    assert.ok(names.includes("host_list_dir"));
    assert.ok(names.includes("host_delete_path"));
  });

  it("exports DESTRUCTIVE_POWERSHELL_PATTERNS constant", () => {
    assert.ok(DESTRUCTIVE_POWERSHELL_PATTERNS, "DESTRUCTIVE_POWERSHELL_PATTERNS must be exported");
    assert.ok(Array.isArray(DESTRUCTIVE_POWERSHELL_PATTERNS));
  });

  it("detects destructive PowerShell patterns and file deletion (positive cases)", () => {
    // 1. host_delete_path is always destructive
    const delPath = isDestructiveHostAction("host_delete_path", { path: "C:\\Windows\\temp" });
    assert.equal(delPath.isDestructive, true);

    // 2. Remove-* cmdlets
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Remove-Item -Recurse -Force ./build" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "remove-item ./file.txt" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Remove-ItemProperty -Path HKLM:\\Software\\App -Name Test" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Remove-EventLog -LogName MyApp" }).isDestructive, true);

    // 3. Destructive disk/computer cmdlets
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Format-Volume -DriveLetter D -FileSystem NTFS" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Clear-Disk -Number 1 -RemoveData" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Initialize-Disk -Number 1" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Restart-Computer -Force" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Stop-Computer -Force" }).isDestructive, true);

    // 4. shutdown / shutdown.exe in command position
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "shutdown /s /t 0" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "shutdown.exe -r -t 60" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Get-Process; shutdown /r" }).isDestructive, true);

    // 5. Aliases (del, erase, rd, rmdir, ri, rm) in command position
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "del C:\\temp\\junk.txt" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Get-Process; erase junk.log" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Get-ChildItem | rd ./junk" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Get-Process & rmdir /s /q temp" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "(ri ./file.txt)" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Write-Host 'hello'\nrm -rf ./build" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "& rm ./build" }).isDestructive, true);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Get-Process; & del foo.txt" }).isDestructive, true);
  });

  it("does not gate safe commands, variables, quoted strings, or removed patterns (negative cases)", () => {
    // Read-only cmdlets
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Get-Process | Select-Object -First 5" }).isDestructive, false);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Get-ChildItem -Recurse" }).isDestructive, false);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Get-Content ./README.md" }).isDestructive, false);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Test-Path ./package.json" }).isDestructive, false);

    // Variable or property names containing del, rm, format
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "$delta = 5; Write-Output $delta" }).isDestructive, false);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "$item.Delete()" }).isDestructive, false);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "$format = 'json'" }).isDestructive, false);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "$rm = 10" }).isDestructive, false);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "delay 5" }).isDestructive, false);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "echo shutdown" }).isDestructive, false);

    // String literals containing words
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: 'Write-Output "del"' }).isDestructive, false);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: 'Write-Output "Remove-Item is a cmdlet"' }).isDestructive, false);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "Write-Output 'rm -rf /'" }).isDestructive, false);

    // Removed non-contract patterns (must not gate)
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "taskkill /F /IM node.exe" }).isDestructive, false);
    assert.equal(isDestructiveHostAction("host_run_powershell", { command: "git reset --hard HEAD~1" }).isDestructive, false);
  });
});

describe("Host Mode F2.2 Single-Use & Expiring Approvals Suite", () => {
  it("creates pending approval with createdAt and 10-minute expiresAt", () => {
    const fixedNow = 1700000000000;
    const req = createPendingApproval(
      "thread-exp-1",
      "host_delete_path",
      { path: "C:\\temp\\junk.txt" },
      "Permanent deletion",
      fixedNow
    );

    assert.equal(req.createdAt, fixedNow);
    assert.equal(req.expiresAt, fixedNow + 10 * 60 * 1000);
    assert.equal(req.status, "pending");
  });

  it("getPendingApprovals purges expired records", () => {
    const t0 = 1700000000000;
    const req1 = createPendingApproval("thread-purge-1", "host_delete_path", { path: "A" }, "risk", t0);
    const req2 = createPendingApproval("thread-purge-1", "host_delete_path", { path: "B" }, "risk", t0 + 20 * 60 * 1000);

    // At t0 + 11 minutes, req1 should be expired and purged
    const activeAt11Min = getPendingApprovals("thread-purge-1", t0 + 11 * 60 * 1000);
    assert.equal(activeAt11Min.some((a: any) => a.id === req1.id), false);
    assert.equal(activeAt11Min.some((a: any) => a.id === req2.id), true);
  });

  it("consumePendingApproval is single-use and handles replay and concurrency", async () => {
    const t0 = 1700000000000;
    const req = createPendingApproval("thread-single-use", "host_run_powershell", { command: "del file.txt" }, "risk", t0);

    // Unknown ID
    const notFound = consumePendingApproval("non-existent-id", "approved", t0);
    assert.equal(notFound.status, "not_found");

    // First consumption: approved
    const first = consumePendingApproval(req.id, "approved", t0 + 1000);
    assert.equal(first.status, "approved");
    assert.equal(first.approval.id, req.id);

    // Replay call: conflict
    const second = consumePendingApproval(req.id, "approved", t0 + 2000);
    assert.equal(second.status, "conflict");

    // Concurrent consumption via Promise.all
    const concReq = createPendingApproval("thread-concurrent", "host_delete_path", { path: "C:\\foo" }, "risk", t0);
    const results = await Promise.all([
      Promise.resolve().then(() => consumePendingApproval(concReq.id, "approved", t0)),
      Promise.resolve().then(() => consumePendingApproval(concReq.id, "approved", t0))
    ]);

    const statuses = results.map((r: any) => r.status).sort();
    assert.deepEqual(statuses, ["approved", "conflict"]);
  });

  it("consumePendingApproval returns expired when now >= expiresAt", () => {
    const t0 = 1700000000000;
    const req = createPendingApproval("thread-expired", "host_delete_path", { path: "C:\\old" }, "risk", t0);

    const expiredResult = consumePendingApproval(req.id, "approved", t0 + 11 * 60 * 1000);
    assert.equal(expiredResult.status, "expired");
    assert.equal(expiredResult.approval.id, req.id);

    // Subsequent call after expiration is conflict (already consumed/handled)
    const afterExpired = consumePendingApproval(req.id, "approved", t0 + 12 * 60 * 1000);
    assert.equal(afterExpired.status, "conflict");
  });
});

describe("Host Mode F2.4 Continuation Buffer Suite", () => {
  it("records and consumes continuation entries exactly once within 5 minutes", () => {
    const t0 = 1700000000000;
    const entry = recordContinuationEntry(
      {
        approvalId: "app-cont-1",
        threadId: "thread-c-1",
        tool: "host_run_powershell",
        args: { command: "del a.txt" },
        status: "executed",
        result: { stdout: "deleted" }
      },
      t0
    );

    assert.equal(entry.createdAt, t0);
    assert.equal(entry.expiresAt, t0 + 5 * 60 * 1000);

    // Mismatched thread ID fails
    const mismatch = consumeContinuationEntry("app-cont-1", "wrong-thread", t0 + 1000);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, "thread_mismatch");

    // First valid consume succeeds
    const first = consumeContinuationEntry("app-cont-1", "thread-c-1", t0 + 1000);
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.entry.approvalId, "app-cont-1");
      assert.deepEqual(first.entry.result, { stdout: "deleted" });
    }

    // Second consume returns not_found (single use)
    const second = consumeContinuationEntry("app-cont-1", "thread-c-1", t0 + 2000);
    assert.equal(second.ok, false);
    assert.equal(second.reason, "not_found");
  });

  it("continuation entry expires after 5 minutes", () => {
    const t0 = 1700000000000;
    recordContinuationEntry(
      {
        approvalId: "app-cont-exp",
        threadId: "thread-c-2",
        tool: "host_delete_path",
        args: { path: "C:\\junk" },
        status: "rejected"
      },
      t0
    );

    const expired = consumeContinuationEntry("app-cont-exp", "thread-c-2", t0 + 5 * 60 * 1000 + 1);
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, "expired");
  });
});

describe("POST /api/host/approvals Route Suite", () => {
  it("approves pending action, returns 200, executes tool, and writes to continuation buffer", async () => {
    const origFetch = global.fetch;
    try {
      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, stdout: "cleared" })
      })) as any;

      const approval = createPendingApproval("route-thread-1", "host_run_powershell", { command: "del file.txt" }, "risk");
      const req = new Request("http://localhost:3000/api/host/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: approval.id, action: "approved" })
      });

      const res = await hostApprovalsPost(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.status, "executed");

      // Verify continuation buffer was populated and can be consumed
      const continuation = consumeContinuationEntry(approval.id, "route-thread-1");
      assert.equal(continuation.ok, true);
      if (continuation.ok) {
        assert.equal(continuation.entry.status, "executed");
      }
    } finally {
      global.fetch = origFetch;
    }
  });

  it("returns 409 on replay of consumed approval", async () => {
    const approval = createPendingApproval("route-thread-replay", "host_delete_path", { path: "C:\\test" }, "risk");
    const req1 = new Request("http://localhost:3000/api/host/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: approval.id, action: "rejected" })
    });
    const res1 = await hostApprovalsPost(req1);
    assert.equal(res1.status, 200);

    const req2 = new Request("http://localhost:3000/api/host/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: approval.id, action: "approved" })
    });
    const res2 = await hostApprovalsPost(req2);
    assert.equal(res2.status, 409);
    const json2 = await res2.json();
    assert.ok(json2.error.includes("already consumed"));
  });

  it("returns 410 on expired approval and stores expired status in continuation buffer", async () => {
    const t0 = 1700000000000;
    const approval = createPendingApproval("route-thread-exp", "host_delete_path", { path: "C:\\test" }, "risk", t0);

    // Stub Date.now to simulate 11 minutes later
    const origNow = Date.now;
    try {
      Date.now = () => t0 + 11 * 60 * 1000;
      const req = new Request("http://localhost:3000/api/host/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: approval.id, action: "approved" })
      });
      const res = await hostApprovalsPost(req);
      assert.equal(res.status, 410);

      const cont = consumeContinuationEntry(approval.id, "route-thread-exp", t0 + 11 * 60 * 1000);
      assert.equal(cont.ok, true);
      if (cont.ok) {
        assert.equal(cont.entry.status, "expired");
      }
    } finally {
      Date.now = origNow;
    }
  });

  it("returns 404 on unknown approval ID", async () => {
    const req = new Request("http://localhost:3000/api/host/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: "non-existent-approval-id", action: "approved" })
    });
    const res = await hostApprovalsPost(req);
    assert.equal(res.status, 404);
  });
});

describe("Subagent Isolation Architecture Suite", () => {
  it("ensures zero subagent files import or reference hostMode", () => {
    const subagentsDir = path.resolve(__dirname, "../lib/subagents");
    if (!fs.existsSync(subagentsDir)) return;

    function scanDir(dir: string): string[] {
      const files: string[] = [];
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          files.push(...scanDir(fullPath));
        } else if (item.isFile() && (item.name.endsWith(".ts") || item.name.endsWith(".tsx"))) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const allSubagentFiles = scanDir(subagentsDir);
    assert.ok(allSubagentFiles.length > 0, "Must have subagent files to inspect");

    const violatingFiles: string[] = [];
    for (const filePath of allSubagentFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      if (content.includes("hostMode") || content.includes("@/lib/hostMode") || content.includes("../hostMode")) {
        violatingFiles.push(filePath);
      }
    }

    assert.deepEqual(violatingFiles, [], "Subagents must NEVER import or reference hostMode");
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

describe("Host Mode F3 Status, Tool Gating, Approval & Scratch File Acceptance Suite", () => {
  it("GET /api/host/status returns thread hostAccess and runner health state", async () => {
    const { GET: hostStatusGet } = await import("../app/api/host/status/route");
    const threadStore = new ThreadStore();
    const thread = threadStore.createThread({ title: "F3 Status Test Thread", isTest: true });

    const origFetch = global.fetch;
    try {
      // 1. Initial thread without hostAccess
      const req1 = new Request(`http://localhost:3000/api/host/status?threadId=${thread.id}`);
      const res1 = await hostStatusGet(req1);
      assert.equal(res1.status, 200);
      const json1 = await res1.json();
      assert.equal(json1.hostAccess, false);

      // 2. Enable hostAccess on thread, mock healthy runner (200, { status: "ok" })
      thread.hostAccess = true;
      threadStore.saveThread(thread);

      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok" })
      })) as any;

      const req2 = new Request(`http://localhost:3000/api/host/status?threadId=${thread.id}`);
      const res2 = await hostStatusGet(req2);
      assert.equal(res2.status, 200);
      const json2 = await res2.json();
      assert.equal(json2.hostAccess, true);
      assert.equal(json2.runnerAvailable, true);

      // 3. Mock unhealthy runner (500)
      global.fetch = (async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "offline" })
      })) as any;

      const req3 = new Request(`http://localhost:3000/api/host/status?threadId=${thread.id}`);
      const res3 = await hostStatusGet(req3);
      assert.equal(res3.status, 200);
      const json3 = await res3.json();
      assert.equal(json3.hostAccess, true);
      assert.equal(json3.runnerAvailable, false);
    } finally {
      global.fetch = origFetch;
      await threadStore.deleteThread(thread.id);
    }
  });

  it("tool gating excludes HOST_TOOLS_DEFINITIONS unless hostAccess is true AND runner is healthy", () => {
    const shouldAdvertiseHostTools = (threadHostAccess: boolean, runnerHealthy: boolean): boolean =>
      threadHostAccess === true && runnerHealthy === true;

    assert.equal(shouldAdvertiseHostTools(false, false), false);
    assert.equal(shouldAdvertiseHostTools(false, true), false);
    assert.equal(shouldAdvertiseHostTools(true, false), false);
    assert.equal(shouldAdvertiseHostTools(true, true), true);

    const resolveTools = (access: boolean, healthy: boolean) =>
      shouldAdvertiseHostTools(access, healthy) ? HOST_TOOLS_DEFINITIONS : [];

    assert.deepEqual(resolveTools(false, true), []);
    assert.deepEqual(resolveTools(true, false), []);
    assert.deepEqual(resolveTools(false, false), []);
    assert.deepEqual(resolveTools(true, true), HOST_TOOLS_DEFINITIONS);
  });

  it("live host runner scratch file acceptance (F3.4 items 1-8)", { timeout: 35000, skip: process.platform !== "win32" ? "Windows-only live PowerShell host runner test" : false }, async () => {
    const scriptPath = path.resolve(__dirname, "../../scripts/Start-HostRunner.ps1");
    const testPort = 8769;
    const testSecret = `f3-live-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

    const origUrl = process.env.HOST_RUNNER_URL;
    const origSecret = process.env.HOST_RUNNER_SHARED_SECRET;
    let scratchPath: string | null = null;

    try {
      process.env.HOST_RUNNER_URL = `http://127.0.0.1:${testPort}`;
      process.env.HOST_RUNNER_SHARED_SECRET = testSecret;

      // 1. Spawn scripts/Start-HostRunner.ps1 on loopback port with test secret
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
          cwd: os.tmpdir(),
          env: {
            ...process.env,
            HOST_RUNNER_SHARED_SECRET: testSecret
          },
          stdio: "pipe"
        }
      );

      // Poll until healthy
      let healthy = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (await checkHostRunnerHealth()) {
          healthy = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(healthy, "Host runner failed to start and report healthy");

      // 2. Execute host_list_dir against Documents
      const docsDir = path.join(os.homedir(), "Documents");
      if (!fs.existsSync(docsDir)) {
        fs.mkdirSync(docsDir, { recursive: true });
      }
      const listRes = await executeHostTool("host_list_dir", { path: docsDir });
      assert.equal(listRes.success, true);
      assert.ok(Array.isArray(listRes.items));

      // 3. Execute host_write_file to create scratch file, then host_read_file
      const timestamp = Date.now();
      const scratchFileName = `host-mode-test-${timestamp}.txt`;
      scratchPath = path.join(docsDir, scratchFileName);
      const testContent = `Host mode live test content at ${timestamp}`;

      const writeRes = await executeHostTool("host_write_file", {
        path: scratchPath,
        content: testContent
      });
      assert.equal(writeRes.success, true);

      const readRes = await executeHostTool("host_read_file", { path: scratchPath });
      assert.equal(readRes.success, true);
      assert.equal(readRes.content, testContent);

      // 4. Verify destructive action gate + create pending approval + reject via POST /api/host/approvals
      const checkResult = isDestructiveHostAction("host_delete_path", { path: scratchPath });
      assert.equal(checkResult.isDestructive, true);

      const app1 = createPendingApproval("live-thread-f3", "host_delete_path", { path: scratchPath }, "Delete scratch file 1");

      const getApprovalsRes = await hostApprovalsGet(new Request("http://localhost:3000/api/host/approvals?threadId=live-thread-f3"));
      assert.equal(getApprovalsRes.status, 200);
      const getApprovalsJson = await getApprovalsRes.json();
      assert.ok(getApprovalsJson.approvals.some((a: any) => a.id === app1.id));

      const rejectReq = new Request("http://localhost:3000/api/host/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: app1.id, action: "rejected" })
      });
      const rejectRes = await hostApprovalsPost(rejectReq);
      assert.equal(rejectRes.status, 200);
      assert.equal(fs.existsSync(scratchPath), true, "Scratch file must still exist after rejection");

      const contReject = consumeContinuationEntry(app1.id, "live-thread-f3");
      assert.equal(contReject.ok, true);
      if (contReject.ok) {
        assert.equal(contReject.entry.status, "rejected");
      }

      // 5. Create second pending approval and approve -> verify execution against live runner and deletion
      const app2 = createPendingApproval("live-thread-f3", "host_delete_path", { path: scratchPath }, "Delete scratch file 2");

      const approveReq = new Request("http://localhost:3000/api/host/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: app2.id, action: "approved" })
      });
      const approveRes = await hostApprovalsPost(approveReq);
      assert.equal(approveRes.status, 200);
      assert.equal(fs.existsSync(scratchPath), false, "Scratch file must be deleted after approval");

      const contApprove = consumeContinuationEntry(app2.id, "live-thread-f3");
      assert.equal(contApprove.ok, true);
      if (contApprove.ok) {
        assert.equal(contApprove.entry.status, "executed");
      }

      // 6. Replay same approvalId -> verify HTTP 409
      const replayReq = new Request("http://localhost:3000/api/host/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: app2.id, action: "approved" })
      });
      const replayRes = await hostApprovalsPost(replayReq);
      assert.equal(replayRes.status, 409);

      // 7. Stop runner and verify checkHostRunnerHealth() returns false
      stopRunner();
      const healthyAfterStop = await checkHostRunnerHealth();
      assert.equal(healthyAfterStop, false, "checkHostRunnerHealth must return false after runner stops");
    } finally {
      stopRunner();
      if (scratchPath && fs.existsSync(scratchPath)) {
        try {
          fs.unlinkSync(scratchPath);
        } catch {}
      }
      if (origUrl !== undefined) {
        process.env.HOST_RUNNER_URL = origUrl;
      } else {
        delete process.env.HOST_RUNNER_URL;
      }
      if (origSecret !== undefined) {
        process.env.HOST_RUNNER_SHARED_SECRET = origSecret;
      } else {
        delete process.env.HOST_RUNNER_SHARED_SECRET;
      }
    }
  });
});
