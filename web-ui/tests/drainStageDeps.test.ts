import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BoardOrchestrator,
  type JobExecutionOutcome,
} from "../lib/board/boardOrchestrator";
import type { DispatcherBoardItem } from "../lib/board/dispatcher";
import type { BoardControlRecord } from "../lib/board/boardControlStore";
import {
  evaluatePrChecks,
  isVerdictValidForHead,
  REQUIRED_PR_CHECKS,
  type FlowMonitorBoardItem,
} from "../lib/board/flowMonitor";
import {
  createProductionStageDeps,
  type HostBridgeExecutor,
  type StageThreadStore,
} from "../lib/board/productionStageDeps";
import type { Thread } from "../lib/threads/threadStore";

function makeBoardItem(overrides: Partial<DispatcherBoardItem> = {}): DispatcherBoardItem {
  return {
    id: "item-drain-1",
    key: "#201",
    title: "Wire production stage deps",
    brief: "Wire production stage dependencies into the board drain route.",
    dependencies: [],
    status: "queued",
    author: "Owner",
    source: "manual",
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

function makeControl(): BoardControlRecord {
  return {
    state: "running",
    drainBudget: null,
    stopAtBoundary: false,
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
}

function makeStubThreadStore(initialThreads: Thread[] = []): {
  store: StageThreadStore;
  threads: Map<string, Thread>;
  created: Array<{ title?: string; initialPrompt?: string }>;
} {
  const threads = new Map<string, Thread>();
  for (const t of initialThreads) {
    threads.set(t.id, t);
  }
  const created: Array<{ title?: string; initialPrompt?: string }> = [];
  let seq = 0;

  const store: StageThreadStore = {
    createThread(input) {
      seq += 1;
      const id = `thread-stub-${seq}`;
      const now = new Date().toISOString();
      const thread: Thread = {
        id,
        title: input.title ?? "Untitled",
        status: "running",
        createdAt: now,
        updatedAt: now,
        model: "default",
        reasoningEffort: "medium",
        messages: input.initialPrompt
          ? [
              {
                id: `msg-u-${seq}`,
                role: "user",
                content: input.initialPrompt,
                timestamp: now,
              },
            ]
          : [],
      };
      threads.set(id, thread);
      created.push(input);
      return thread;
    },
    getThread(id) {
      return threads.get(id) ?? null;
    },
  };

  return { store, threads, created };
}

test("pollChecks maps gh pr checks JSON payload onto PrChecksSnapshot with required checks identifiable", async () => {
  const fixtureChecks = [
    ...REQUIRED_PR_CHECKS.map((name) => ({ name, state: "SUCCESS", bucket: "pass" })),
    { name: "Extra Advisory", state: "PENDING", bucket: "pending" },
  ];

  const commands: string[] = [];
  const bridge: HostBridgeExecutor = async (tool, args) => {
    assert.equal(tool, "host_run_powershell");
    const cmd = String(args.command);
    commands.push(cmd);
    if (cmd.includes("gh pr view 175 --json headRefOid")) {
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({ headRefOid: "abc123headsha" }),
        stderr: "",
      };
    }
    return {
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify(fixtureChecks),
      stderr: "",
    };
  };

  const { store } = makeStubThreadStore();
  const deps = createProductionStageDeps({
    executeHostTool: bridge,
    threadStore: store,
  });

  const item: FlowMonitorBoardItem = {
    ...makeBoardItem(),
    prNumber: 175,
  };

  const snapshot = await deps.flowMonitor.pollChecks(item);
  assert.equal(commands.length, 2);
  assert.ok(commands.some((c) => c.includes("gh pr checks 175 --json name,state,bucket")));
  assert.ok(commands.some((c) => c.includes("gh pr view 175 --json headRefOid")));
  assert.equal(snapshot.headSha, "abc123headsha");
  assert.equal(snapshot.checks.length, REQUIRED_PR_CHECKS.length + 1);

  for (const reqName of REQUIRED_PR_CHECKS) {
    const found = snapshot.checks.find((c) => c.name === reqName);
    assert.ok(found, `required check ${reqName} must be present`);
    assert.equal(found.status, "COMPLETED");
    assert.equal(found.conclusion, "SUCCESS");
  }

  const pendingCheck = snapshot.checks.find((c) => c.name === "Extra Advisory");
  assert.ok(pendingCheck);
  assert.equal(pendingCheck.status, "IN_PROGRESS");
  assert.equal(pendingCheck.conclusion, null);

  const verdict = evaluatePrChecks(snapshot.headSha, snapshot.checks);
  assert.equal(verdict.status, "green");
  assert.equal(isVerdictValidForHead(verdict, "abc123headsha"), true);
  assert.equal(isVerdictValidForHead(verdict, "other-sha"), false);
});

test("pollChecks fails closed with empty checks and running verdict when headRefOid fetch fails", async () => {
  const fixtureChecks = [
    { name: "Unit Tests", state: "SUCCESS", bucket: "pass" },
    { name: "Coverage", state: "SUCCESS", bucket: "pass" },
    { name: "Container Build", state: "SUCCESS", bucket: "pass" },
    { name: "Playwright", state: "SUCCESS", bucket: "pass" },
    { name: "Typecheck", state: "SUCCESS", bucket: "pass" },
  ];

  const bridge: HostBridgeExecutor = async (_tool, args) => {
    const cmd = String(args.command);
    if (cmd.includes("gh pr view") && cmd.includes("headRefOid")) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "gh: failed to fetch headRefOid",
      };
    }
    return {
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify(fixtureChecks),
      stderr: "",
    };
  };

  const { store } = makeStubThreadStore();
  const deps = createProductionStageDeps({
    executeHostTool: bridge,
    threadStore: store,
  });

  const item: FlowMonitorBoardItem = {
    ...makeBoardItem(),
    prNumber: 177,
  };

  const snapshot = await deps.flowMonitor.pollChecks(item);
  assert.equal(snapshot.headSha, "unknown");
  assert.deepEqual(snapshot.checks, []);
  const verdict = evaluatePrChecks(snapshot.headSha, snapshot.checks);
  assert.equal(verdict.status, "running");
});

test("pollChecks on bridge failure or unparseable output returns non-green still-running/unknown snapshot", async () => {
  const { store } = makeStubThreadStore();
  const item: FlowMonitorBoardItem = { ...makeBoardItem(), prNumber: 176 };

  // Case 1: bridge throws
  const throwingDeps = createProductionStageDeps({
    executeHostTool: async () => {
      throw new Error("Host runner daemon disconnected");
    },
    threadStore: store,
  });
  const snap1 = await throwingDeps.flowMonitor.pollChecks(item);
  assert.equal(evaluatePrChecks(snap1.headSha, snap1.checks).status, "running");

  // Case 2: non-zero exit code
  const failedCmdDeps = createProductionStageDeps({
    executeHostTool: async () => ({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "gh: not authenticated",
    }),
    threadStore: store,
  });
  const snap2 = await failedCmdDeps.flowMonitor.pollChecks(item);
  assert.equal(evaluatePrChecks(snap2.headSha, snap2.checks).status, "running");

  // Case 3: unparseable JSON
  const badJsonDeps = createProductionStageDeps({
    executeHostTool: async () => ({
      ok: true,
      exitCode: 0,
      stdout: "not valid json {{{",
      stderr: "",
    }),
    threadStore: store,
  });
  const snap3 = await badJsonDeps.flowMonitor.pollChecks(item);
  assert.equal(evaluatePrChecks(snap3.headSha, snap3.checks).status, "running");
});

test("getMechanicalInput assembles diff, allowlist, commit subjects, and branch name from stubbed bridge outputs", async () => {
  const diffOutput = [
    "diff --git a/web-ui/lib/board/productionStageDeps.ts b/web-ui/lib/board/productionStageDeps.ts",
    "--- a/web-ui/lib/board/productionStageDeps.ts",
    "+++ b/web-ui/lib/board/productionStageDeps.ts",
    "@@ -0,0 +1,2 @@",
    "+export const ready = true;",
  ].join("\n");

  const bridge: HostBridgeExecutor = async (_tool, args) => {
    const cmd = String(args.command);
    if (cmd.includes("gh pr diff 180")) {
      return { ok: true, exitCode: 0, stdout: diffOutput, stderr: "" };
    }
    if (cmd.includes("gh pr view 180 --json commits")) {
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({
          commits: [
            { messageHeadline: "test(board): add drain stage deps tests" },
            { messageHeadline: "feat(board): implement production stage deps" },
          ],
        }),
        stderr: "",
      };
    }
    if (cmd.includes("gh pr view 180 --json headRefName")) {
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({ headRefName: "feature/drain-stage-deps-wiring" }),
        stderr: "",
      };
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };

  const { store } = makeStubThreadStore();
  const deps = createProductionStageDeps({
    executeHostTool: bridge,
    threadStore: store,
  });

  // Item with no allowlist field -> empty array (never invented)
  const itemNoAllowlist = makeBoardItem();
  const resultNoAllowlist = await deps.reviewerGate.getMechanicalInput(itemNoAllowlist, {
    prNumber: 180,
    headSha: "abc1234",
  });
  assert.equal(resultNoAllowlist.diff, diffOutput);
  assert.deepEqual(resultNoAllowlist.allowlist, []);
  assert.deepEqual(resultNoAllowlist.commitSubjects, [
    "test(board): add drain stage deps tests",
    "feat(board): implement production stage deps",
  ]);
  assert.equal(resultNoAllowlist.branchName, "feature/drain-stage-deps-wiring");

  // Item carrying an allowlist field -> preserved verbatim
  const itemWithAllowlist = Object.assign(makeBoardItem(), {
    allowlist: ["web-ui/lib/board/productionStageDeps.ts"],
  });
  const resultWithAllowlist = await deps.reviewerGate.getMechanicalInput(itemWithAllowlist, {
    prNumber: 180,
    headSha: "abc1234",
  });
  assert.deepEqual(resultWithAllowlist.allowlist, [
    "web-ui/lib/board/productionStageDeps.ts",
  ]);
});

test("issueReviewerThread parses PASS and FAIL verdicts and fails closed on timeout or unparseable output", async () => {
  const noopBridge: HostBridgeExecutor = async () => ({
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
  });

  // Case 1: PASS verdict
  {
    const { store, threads } = makeStubThreadStore();
    let polls = 0;
    const wrappedStore: StageThreadStore = {
      createThread: (input) => store.createThread(input),
      getThread: (id) => {
        polls += 1;
        const t = threads.get(id);
        if (t && polls >= 2) {
          t.status = "completed";
          t.messages.push({
            id: "msg-a-1",
            role: "assistant",
            content: [
              "VERDICT: PASS",
              "- All behavioral acceptance criteria satisfied.",
              "- No banned patterns in diff.",
            ].join("\n"),
            timestamp: new Date().toISOString(),
          });
        }
        return t ?? null;
      },
    };

    const deps = createProductionStageDeps({
      executeHostTool: noopBridge,
      threadStore: wrappedStore,
      dispatchChatTurn: async () => ({ ok: true, status: 200 }),
      reviewerPollIntervalMs: 1,
      reviewerTimeoutMs: 500,
    });

    const res = await deps.reviewerGate.issueReviewerThread({
      itemId: "item-pass",
      brief: "Review this PR",
    });
    assert.equal(res.verdict, "PASS");
    assert.ok(res.threadId.startsWith("thread-stub-"));
    assert.ok(res.evidence.length >= 1);
  }

  // Case 2: FAIL verdict
  {
    const { store, threads } = makeStubThreadStore();
    const wrappedStore: StageThreadStore = {
      createThread: (input) => {
        const t = store.createThread(input);
        t.status = "completed";
        t.messages.push({
          id: "msg-a-2",
          role: "assistant",
          content: [
            "VERDICT: FAIL",
            "- Missing error handling on bridge disconnect.",
          ].join("\n"),
          timestamp: new Date().toISOString(),
        });
        return t;
      },
      getThread: (id) => threads.get(id) ?? null,
    };

    const deps = createProductionStageDeps({
      executeHostTool: noopBridge,
      threadStore: wrappedStore,
      dispatchChatTurn: async () => ({ ok: true, status: 200 }),
      reviewerPollIntervalMs: 1,
      reviewerTimeoutMs: 500,
    });

    const res = await deps.reviewerGate.issueReviewerThread({
      itemId: "item-fail",
      brief: "Review this PR",
    });
    assert.equal(res.verdict, "FAIL");
    assert.ok(res.evidence.some((e) => e.includes("Missing error handling")));
  }

  // Case 3: Unparseable assistant message -> FAIL-CLOSED
  {
    const { store, threads } = makeStubThreadStore();
    const wrappedStore: StageThreadStore = {
      createThread: (input) => {
        const t = store.createThread(input);
        t.status = "completed";
        t.messages.push({
          id: "msg-a-3",
          role: "assistant",
          content: "Looks mostly okay, maybe ship it?",
          timestamp: new Date().toISOString(),
        });
        return t;
      },
      getThread: (id) => threads.get(id) ?? null,
    };

    const deps = createProductionStageDeps({
      executeHostTool: noopBridge,
      threadStore: wrappedStore,
      dispatchChatTurn: async () => ({ ok: true, status: 200 }),
      reviewerPollIntervalMs: 1,
      reviewerTimeoutMs: 500,
    });

    const res = await deps.reviewerGate.issueReviewerThread({
      itemId: "item-unparseable",
      brief: "Review this PR",
    });
    assert.equal(res.verdict, "FAIL");
    assert.ok(res.evidence.some((e) => /unparseable/i.test(e)));
  }

  // Case 4: Timeout -> FAIL-CLOSED
  {
    const { store } = makeStubThreadStore();
    const deps = createProductionStageDeps({
      executeHostTool: noopBridge,
      threadStore: store,
      dispatchChatTurn: async () => ({ ok: true, status: 200 }),
      reviewerPollIntervalMs: 5,
      reviewerTimeoutMs: 20,
    });

    const res = await deps.reviewerGate.issueReviewerThread({
      itemId: "item-timeout",
      brief: "Review this PR",
    });
    assert.equal(res.verdict, "FAIL");
    assert.ok(res.evidence.some((e) => /timed out/i.test(e)));
  }
});

test("issueReviewerThread dispatches the reviewer brief for execution and parses verdict from returned content", async () => {
  const noopBridge: HostBridgeExecutor = async () => ({
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
  });

  const { store, threads } = makeStubThreadStore();
  const dispatched: Array<{ threadId: string; brief: string }> = [];

  const deps = createProductionStageDeps({
    executeHostTool: noopBridge,
    threadStore: store,
    dispatchChatTurn: async ({ threadId, brief }) => {
      dispatched.push({ threadId, brief });
      const record = threads.get(threadId);
      assert.ok(record, "thread must exist before chat dispatch");
      record.status = "completed";
      record.messages.push({
        id: "msg-dispatched-1",
        role: "assistant",
        content: [
          "VERDICT: PASS",
          "- Dispatched reviewer turn verified the diff.",
        ].join("\n"),
        timestamp: new Date().toISOString(),
      });
      return { ok: true, status: 200 };
    },
    reviewerPollIntervalMs: 1,
    reviewerTimeoutMs: 500,
  });

  const res = await deps.reviewerGate.issueReviewerThread({
    itemId: "item-exec-1",
    brief: "Adversarial review brief for PR #42",
  });

  assert.equal(dispatched.length, 1, "dispatchChatTurn must be invoked once");
  assert.equal(dispatched[0].threadId, res.threadId);
  assert.equal(dispatched[0].brief, "Adversarial review brief for PR #42");
  assert.equal(res.verdict, "PASS");
  assert.ok(res.evidence.some((e) => e.includes("Dispatched reviewer turn verified the diff.")));
});

test("shadow guarantee: with stage flags OFF, drain with production deps never calls deploy-cluster or set image and never authorizes a merge", async () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "drain-stage-shadow-"));
  const executedCommands: string[] = [];

  const bridge: HostBridgeExecutor = async (_tool, args) => {
    const cmd = String(args.command);
    executedCommands.push(cmd);

    if (cmd.includes("gh pr checks")) {
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify(
          REQUIRED_PR_CHECKS.map((name) => ({ name, state: "SUCCESS", bucket: "pass" }))
        ),
        stderr: "",
      };
    }
    if (cmd.includes("gh pr view") && cmd.includes("headRefOid")) {
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({ headRefOid: "deadbeef" }),
        stderr: "",
      };
    }
    if (cmd.includes("gh pr diff")) {
      return {
        ok: true,
        exitCode: 0,
        stdout: [
          "diff --git a/web-ui/lib/board/productionStageDeps.ts b/web-ui/lib/board/productionStageDeps.ts",
          "--- a/web-ui/lib/board/productionStageDeps.ts",
          "+++ b/web-ui/lib/board/productionStageDeps.ts",
          "@@ -0,0 +1,1 @@",
          "+export const x = 1;",
        ].join("\n"),
        stderr: "",
      };
    }
    if (cmd.includes("gh pr view") && cmd.includes("commits")) {
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({ commits: [{ messageHeadline: "feat: wire deps" }] }),
        stderr: "",
      };
    }
    if (cmd.includes("gh pr view") && cmd.includes("headRefName")) {
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({ headRefName: "feature/drain-stage-deps-wiring" }),
        stderr: "",
      };
    }
    if (cmd.includes("get deployment web-ui")) {
      return {
        ok: true,
        exitCode: 0,
        stdout: "local-agentic-sandbox-web-ui:v-prev",
        stderr: "",
      };
    }
    if (cmd.includes("get pods")) {
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({
          items: [
            {
              status: {
                phase: "Running",
                containerStatuses: [{ restartCount: 0, image: "local-agentic-sandbox-web-ui:v-prev" }],
              },
            },
          ],
        }),
        stderr: "",
      };
    }
    if (cmd.includes("queue-steer-runlog.md")) {
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    }
    return { ok: true, exitCode: 0, stdout: "", stderr: "" };
  };

  const { store, threads } = makeStubThreadStore();
  const autoCompletingStore: StageThreadStore = {
    createThread: (input) => {
      const t = store.createThread(input);
      t.status = "completed";
      t.messages.push({
        id: `msg-auto-${t.id}`,
        role: "assistant",
        content: "VERDICT: PASS\n- All checks verified.",
        timestamp: new Date().toISOString(),
      });
      return t;
    },
    getThread: (id) => threads.get(id) ?? null,
  };

  const stageDeps = createProductionStageDeps({
    executeHostTool: bridge,
    threadStore: autoCompletingStore,
    dispatchChatTurn: async () => ({ ok: true, status: 200 }),
    reviewerPollIntervalMs: 1,
    reviewerTimeoutMs: 500,
  });

  try {
    const item = makeBoardItem({ id: "item-shadow-1", key: "#205" });
    const orchestrator = new BoardOrchestrator({
      boardDir,
      items: [item],
      getControlState: () => makeControl(),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      issueAndWait: async (): Promise<JobExecutionOutcome> => ({
        status: "completed",
        threadId: "t-shadow-1",
        summary: "Merged PR #205",
        prNumber: 205,
        headSha: "deadbeef",
        merged: true,
        mergeSha: "deadbeef",
      }),
      ...stageDeps,
    });

    const report = await orchestrator.drain();
    assert.equal(report.outcomes.length, 1);
    const shadow = report.outcomes[0].shadowStages;
    assert.ok(shadow?.flowMonitor);
    assert.equal(shadow.flowMonitor.action, "shadow");
    assert.ok(shadow?.reviewerGate);
    assert.equal(shadow.reviewerGate.mergeAuthorized, false);
    assert.ok(shadow?.selfDeploy);
    assert.equal(shadow.selfDeploy.mode, "shadow");
    assert.equal(shadow.selfDeploy.status, "shadow_prepared");

    assert.ok(
      !executedCommands.some((c) => c.includes("deploy-cluster.js")),
      "buildAndImport must never execute deploy-cluster.js when stage flag is OFF"
    );
    assert.ok(
      !executedCommands.some((c) => c.includes("set image")),
      "setImage must never execute when stage flag is OFF"
    );
  } finally {
    fs.rmSync(boardDir, { recursive: true, force: true });
  }
});
