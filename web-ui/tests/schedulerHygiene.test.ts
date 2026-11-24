import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";

import { POST as boardIntakePost } from "../app/api/board/intake/route";
import { POST as deployPost } from "../app/api/deploy/route";
import { POST as hostSettingsPost } from "../app/api/settings/host/route";
import { PUT as memorySettingsPut } from "../app/api/settings/memory/route";
import { POST as notificationsPost } from "../app/api/settings/notifications/route";
import { POST as skillsPost } from "../app/api/skills/route";
import { POST as tasksPost } from "../app/api/tasks/route";
import { POST as schedulesPost } from "../app/api/schedules/route";
import { POST as threadsPost } from "../app/api/threads/route";
import { POST as threadByIdPost } from "../app/api/threads/[id]/route";
import { POST as projectsBrowsePost } from "../app/api/projects/browse/route";
import { POST as chatPost } from "../app/api/chat/route";

import * as jobChunking from "../lib/jobChunking";
import { connectMcpClient } from "../lib/chat/mcpClients";
import { BoardStore } from "../lib/board/boardStore";
import { BoardOrchestrator } from "../lib/board/boardOrchestrator";
import { ThreadStore } from "../lib/threads/threadStore";
import { resolveAffectedTests } from "../lib/testGate";

describe("Rank 17: Scheduler hygiene, timeouts, malformed JSON 400s, triage reload & testGate mapping", () => {
  it("malformed JSON body returns HTTP 400 across all listed API routes", async () => {
    const cases: Array<{
      name: string;
      invoke: () => Promise<Response>;
    }> = [
      {
        name: "POST /api/board/intake",
        invoke: () =>
          boardIntakePost(
            new NextRequest("http://localhost/api/board/intake", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{bad-json",
            })
          ),
      },
      {
        name: "POST /api/deploy",
        invoke: () =>
          deployPost(
            new NextRequest("http://localhost/api/deploy", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{bad-json",
            })
          ),
      },
      {
        name: "POST /api/settings/host",
        invoke: () =>
          hostSettingsPost(
            new Request("http://localhost/api/settings/host", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{bad-json",
            })
          ),
      },
      {
        name: "PUT /api/settings/memory",
        invoke: () =>
          memorySettingsPut(
            new Request("http://localhost/api/settings/memory", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: "{bad-json",
            })
          ),
      },
      {
        name: "POST /api/settings/notifications",
        invoke: () =>
          notificationsPost(
            new Request("http://localhost/api/settings/notifications", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{bad-json",
            })
          ),
      },
      {
        name: "POST /api/skills",
        invoke: () =>
          skillsPost(
            new NextRequest("http://localhost/api/skills", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{bad-json",
            })
          ),
      },
      {
        name: "POST /api/tasks",
        invoke: () =>
          tasksPost(
            new Request("http://localhost/api/tasks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{bad-json",
            })
          ),
      },
      {
        name: "POST /api/schedules",
        invoke: () =>
          schedulesPost(
            new Request("http://localhost/api/schedules", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{bad-json",
            })
          ),
      },
      {
        name: "POST /api/threads",
        invoke: () =>
          threadsPost(
            new Request("http://localhost/api/threads", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{bad-json",
            })
          ),
      },
      {
        name: "POST /api/threads/[id]",
        invoke: () =>
          threadByIdPost(
            new Request("http://localhost/api/threads/thread-malformed", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{bad-json",
            }),
            { params: Promise.resolve({ id: "thread-malformed" }) }
          ),
      },
      {
        name: "POST /api/projects/browse",
        invoke: () =>
          projectsBrowsePost(
            new NextRequest("http://localhost/api/projects/browse", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{bad-json",
            })
          ),
      },
    ];

    for (const c of cases) {
      const res = await c.invoke();
      assert.equal(res.status, 400, `${c.name} must return HTTP 400 on malformed JSON`);
      const payload = (await res.json()) as { error?: string };
      assert.equal(
        payload.error,
        "Invalid JSON body",
        `${c.name} must return { error: "Invalid JSON body" }`
      );
    }
  });

  it("bankGitWork passes an explicit timeout to git push and git exec calls", () => {
    const bankGitWorkFn = (jobChunking as Record<string, unknown>).bankGitWork as
      | ((
          cwd: string,
          jobId: string,
          options?: {
            timeoutMs?: number;
            execSyncFn?: (
              file: string,
              args?: readonly string[],
              opts?: { cwd?: string; encoding?: string; timeout?: number }
            ) => string;
          }
        ) => { branch: string; headSha: string })
      | undefined;

    assert.equal(typeof bankGitWorkFn, "function", "bankGitWork must be exported from jobChunking");

    const calls: Array<{ args: readonly string[]; timeout?: number }> = [];
    const spyExec = (
      _file: string,
      args: readonly string[] = [],
      opts: { cwd?: string; encoding?: string; timeout?: number } = {}
    ) => {
      calls.push({ args, timeout: opts.timeout });
      if (args[0] === "status") return "";
      if (args[0] === "remote") return "origin\n";
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feat/test\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      return "";
    };

    const res = bankGitWorkFn!("/tmp/fake-repo", "job-timeout-1", { execSyncFn: spyExec });
    assert.equal(res.branch, "feat/test");
    assert.equal(res.headSha, "deadbeef");

    const pushCall = calls.find((c) => c.args[0] === "push");
    assert.ok(pushCall, "git push must have been invoked when remote exists");
    assert.equal(typeof pushCall.timeout, "number", "git push must specify an explicit timeout");
    assert.ok(pushCall.timeout! >= 10_000, `expected timeout >= 10000ms, got ${pushCall.timeout}`);
  });

  it("connectMcpClient times out on hung connect, closes handles, and returns null", async () => {
    let clientClosed = false;
    let transportClosed = false;
    const warnings: unknown[][] = [];

    const start = Date.now();
    const session = await connectMcpClient("http://mcp-server:8080/sse", "hung-test", {
      connectTimeoutMs: 40,
      createTransport: () => ({
        close: async () => {
          transportClosed = true;
        },
      }),
      createClient: () => ({
        connect: () => new Promise<void>(() => {}),
        listTools: async () => ({ tools: [] }),
        close: async () => {
          clientClosed = true;
        },
      }),
      log: () => {},
      warn: (...args: unknown[]) => warnings.push(args),
    } as Parameters<typeof connectMcpClient>[2]);
    const elapsed = Date.now() - start;

    assert.equal(session, null);
    assert.ok(elapsed < 1000, `connectMcpClient must abort promptly on timeout, took ${elapsed}ms`);
    assert.equal(clientClosed, true);
    assert.equal(transportClosed, true);
    assert.equal(warnings.length, 1);
  });

  it("BoardOrchestrator reloads store.get(head.id) before triage retry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-triage-reload-"));
    try {
      const store = new BoardStore(dir);
      store.create({
        key: "#T1",
        title: "Reload test item",
        brief: "Original stale brief",
        status: "queued",
        author: "Owner",
        source: "manual",
      });

      const observedBriefs: string[] = [];
      let attempts = 0;

      const orchestrator = new BoardOrchestrator({
        boardStore: store,
        getControlState: () => ({
          state: "running",
          drainBudget: null,
          stopAtBoundary: false,
          updatedAt: new Date().toISOString(),
        }),
        getLiveJobState: () => ({ isRunning: false }),
        getOwnerState: () => ({ isMidTurn: false }),
        triageAutoFix: async () => true,
        issueAndWait: async ({ item, brief }) => {
          attempts += 1;
          observedBriefs.push(brief);
          if (attempts === 1) {
            store.update(item.id, { brief: "Freshly updated brief from store" });
            return {
              status: "failed",
              threadId: "t-retry-1",
              error: "transient failure",
              issue: {
                code: "transient",
                message: "auto-fixable failure",
                autoFixable: true,
              },
            };
          }
          return {
            status: "completed",
            threadId: "t-retry-2",
            summary: "Completed on retry",
          };
        },
        log: () => {},
      });

      const report = await orchestrator.drain();
      assert.equal(attempts, 2);
      assert.equal(report.completedCount, 1);
      assert.ok(
        observedBriefs[1].includes("Freshly updated brief from store"),
        `Expected retry brief to use reloaded store.get(head.id), got: ${observedBriefs[1]}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("roundLoop persists an error assistant message before returning early on invalid approvalContinuationId", async () => {
    const tmpThreadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cont-err-"));
    const prevThreadsDir = process.env.THREADS_DIR;
    const prevMcp = process.env.MCP_SERVER_URL;
    const prevBrowserMcp = process.env.BROWSER_MCP_URL;
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.MCP_SERVER_URL = "http://127.0.0.1:59997/mcp/sse";
    process.env.BROWSER_MCP_URL = "http://127.0.0.1:59996/browser/sse";

    try {
      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-invalid-continuation",
          approvalContinuationId: "nonexistent-continuation-id",
          messages: [{ role: "user", content: "Proceed after approval" }],
        }),
      });

      const res = await chatPost(req);
      const text = await res.text();
      assert.ok(
        text.includes("Approval continuation failed"),
        "SSE stream must emit approval continuation error"
      );

      const store = new ThreadStore(tmpThreadsDir);
      const thread = await store.getThread("thread-invalid-continuation");
      assert.ok(thread, "thread must exist");
      const errorAssistant = thread.messages.find(
        (m) => m.role === "assistant" && m.status === "error"
      );
      assert.ok(
        errorAssistant,
        "an error assistant message must be persisted before returning early on invalid approvalContinuationId"
      );
      assert.ok(errorAssistant.content.includes("Approval continuation failed"));
    } finally {
      if (prevThreadsDir === undefined) delete process.env.THREADS_DIR;
      else process.env.THREADS_DIR = prevThreadsDir;
      if (prevMcp === undefined) delete process.env.MCP_SERVER_URL;
      else process.env.MCP_SERVER_URL = prevMcp;
      if (prevBrowserMcp === undefined) delete process.env.BROWSER_MCP_URL;
      else process.env.BROWSER_MCP_URL = prevBrowserMcp;
      fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
    }
  });

  it("testGate maps lib/chat/roundLoop.ts to chat honesty/budget suites and schedulerHygiene.test.ts", () => {
    const res = resolveAffectedTests(["web-ui/lib/chat/roundLoop.ts"]);
    assert.ok(
      res.tests.includes("tests/chatTurnHonesty.test.ts"),
      "lib/chat/roundLoop.ts must map to tests/chatTurnHonesty.test.ts"
    );
    assert.ok(
      res.tests.includes("tests/chatTextTruth.test.ts"),
      "lib/chat/roundLoop.ts must map to tests/chatTextTruth.test.ts"
    );
    assert.ok(
      res.tests.includes("tests/chatRoundBudget.test.ts"),
      "lib/chat/roundLoop.ts must map to tests/chatRoundBudget.test.ts"
    );
    assert.ok(
      res.tests.includes("tests/chatToolDegradation.test.ts"),
      "lib/chat/roundLoop.ts must map to tests/chatToolDegradation.test.ts"
    );
    assert.ok(
      res.tests.includes("tests/schedulerHygiene.test.ts"),
      "lib/chat/roundLoop.ts must map to tests/schedulerHygiene.test.ts"
    );
  });
});
