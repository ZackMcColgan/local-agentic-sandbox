import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  BoardOrchestrator,
  extractJobOutcomeMetadata,
  type BoardOrchestratorDeps,
  type JobExecutionOutcome,
} from "../lib/board/boardOrchestrator";
import { BoardStore } from "../lib/board/boardStore";
import { composeDispatcherBrief } from "../lib/board/dispatcher";
import {
  classifyJobSummary,
  createProductionIssueAndWait,
  createProductionWorkingItemLivenessCheck,
} from "../lib/board/productionDrain";
import type { BoardControlRecord } from "../lib/board/boardControlStore";
import { POST as drainPost } from "../app/api/board/drain/route";

function makeTempEnv(): {
  rootDir: string;
  boardDir: string;
  threadsDir: string;
  cleanup: () => void;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "aud05-drain-test-"));
  const boardDir = path.join(rootDir, "board");
  const threadsDir = path.join(rootDir, "threads");
  fs.mkdirSync(boardDir, { recursive: true });
  fs.mkdirSync(threadsDir, { recursive: true });

  const prevBoardDir = process.env.BOARD_DIR;
  const prevThreadsDir = process.env.THREADS_DIR;
  process.env.BOARD_DIR = boardDir;
  process.env.THREADS_DIR = threadsDir;

  return {
    rootDir,
    boardDir,
    threadsDir,
    cleanup: () => {
      if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
      else process.env.BOARD_DIR = prevBoardDir;
      if (prevThreadsDir === undefined) delete process.env.THREADS_DIR;
      else process.env.THREADS_DIR = prevThreadsDir;
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function makeControl(state: BoardControlRecord["state"] = "running"): BoardControlRecord {
  return {
    state,
    drainBudget: null,
    stopAtBoundary: false,
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
}

test("(a) one-job rule: maxItems > 1 never marks multiple items working concurrently", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const first = store.create({
      title: "First queued job",
      brief: "Execute first job.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });
    const second = store.create({
      title: "Second queued job",
      brief: "Execute second job.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    const issuedIds: string[] = [];
    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      maxItems: 5,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      issueAndWait: async ({ item }): Promise<JobExecutionOutcome> => {
        issuedIds.push(item.id);
        return {
          status: "in-progress",
          threadId: `thread-${item.id}`,
          reason: "Job still executing",
        };
      },
    });

    const report = await orchestrator.drain();
    const afterFirst = store.get(first.id);
    const afterSecond = store.get(second.id);

    assert.deepEqual(issuedIds, [first.id], "Only the head eligible item may be issued");
    assert.equal(afterFirst?.status, "working", "Head item should be working");
    assert.equal(afterSecond?.status, "queued", "Second item must remain queued");
    assert.equal(report.inProgressCount, 1);
    assert.equal(report.stopReason, "job-already-running");
  } finally {
    env.cleanup();
  }
});

test("(a) one-job rule: drain refuses to start a second item when one is already working in BoardStore", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    store.create({
      title: "Already working job",
      brief: "Currently running.",
      status: "working",
      author: "Owner",
      source: "manual",
    });
    const queued = store.create({
      title: "Queued next job",
      brief: "Must wait.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    let issuedCount = 0;
    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      maxItems: 3,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      issueAndWait: async () => {
        issuedCount += 1;
        return { status: "completed", threadId: "t-unexpected" };
      },
    });

    const report = await orchestrator.drain();
    assert.equal(issuedCount, 0, "Must not issue any job while another board item is working");
    assert.equal(store.get(queued.id)?.status, "queued");
    assert.equal(report.stopReason, "job-already-running");
  } finally {
    env.cleanup();
  }
});

test("(b) dryRun: true leaves BoardStore byte-identical and creates zero thread files", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    store.create({
      title: "Dry-run fixture 1",
      brief: "Do not mutate me.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });
    store.create({
      title: "Dry-run fixture 2",
      brief: "Do not mutate me either.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    fs.writeFileSync(
      path.join(env.boardDir, "board.meta.json"),
      JSON.stringify({ control: makeControl("running") }, null, 2),
      "utf8"
    );

    const boardFilePath = path.join(env.boardDir, "board.json");
    const beforeBytes = fs.readFileSync(boardFilePath);

    const req = new NextRequest("http://localhost/api/board/drain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true, maxItems: 5 }),
    });
    const res = await drainPost(req);
    assert.equal(res.status, 200);

    const afterBytes = fs.readFileSync(boardFilePath);
    assert.deepEqual(
      afterBytes,
      beforeBytes,
      "BoardStore file must be byte-identical after dryRun: true"
    );

    const threadFiles = fs.readdirSync(env.threadsDir);
    assert.equal(threadFiles.length, 0, "dryRun: true must create zero thread files");
  } finally {
    env.cleanup();
  }
});

test("(c) completed drained job reaches shadow-stage hooks (flowMonitor, reviewerGate, selfDeploy)", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const item = store.create({
      title: "Shadow stage fixture",
      brief: "Open PR and merge.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    let flowMonitorCalled = false;
    let reviewerGateCalled = false;
    let selfDeployCalled = false;

    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      boardDir: env.boardDir,
      maxItems: 1,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      stageFlags: {
        flowMonitor: false,
        reviewerGate: false,
        selfDeploy: false,
      },
      flowMonitor: {
        pollChecks: async () => {
          flowMonitorCalled = true;
          return {
            headSha: "abc1234",
            checks: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
          };
        },
      },
      reviewerGate: {
        getMechanicalInput: async () => ({
          diff: "diff --git a/web-ui/lib/board/boardOrchestrator.ts b/web-ui/lib/board/boardOrchestrator.ts",
          allowlist: ["web-ui/lib/board/boardOrchestrator.ts"],
          commitSubjects: ["Fix board drain execution"],
          branchName: "feature/audit-05-drain-executes",
        }),
        issueReviewerThread: async () => {
          reviewerGateCalled = true;
          return {
            threadId: "rev-thread-1",
            verdict: "PASS",
            evidence: ["All checks passed."],
          };
        },
      },
      selfDeploy: {
        deps: {
          readCurrentState: async () => {
            selfDeployCalled = true;
            return {
              image: "local-agentic-sandbox-web-ui:old",
              podStatus: "Running",
              podRestarts: 0,
            };
          },
          bankRollbackTarget: async (tag) => ({ banked: true, tag }),
          buildAndImport: async (tag) => ({
            built: false,
            imported: false,
            imagePresentInNode: false,
            detail: `shadow ${tag}`,
          }),
          setImage: async () => ({ ok: false }),
          verifyDeployment: async (expectedTag) => ({
            ok: false,
            rolloutSuccess: false,
            podRunningZeroRestarts: false,
            gatewayStatus: 0,
            threadListLoads: false,
            observedTag: expectedTag,
          }),
        },
      },
      issueAndWait: async (): Promise<JobExecutionOutcome> => ({
        status: "completed",
        threadId: "t-shadow-1",
        summary: "Opened PR #99 and merged commit deadbeef",
        prNumber: 99,
        headSha: "abc1234",
        merged: true,
        mergeSha: "deadbeef",
      }),
    } as BoardOrchestratorDeps);

    const report = await orchestrator.drain();
    assert.equal(report.completedCount, 1);
    assert.equal(store.get(item.id)?.status, "done");
    assert.equal(flowMonitorCalled, true, "flowMonitor shadow stage must be invoked");
    assert.equal(reviewerGateCalled, true, "reviewerGate shadow stage must be invoked");
    assert.equal(selfDeployCalled, true, "selfDeploy shadow stage must be invoked");
    assert.ok(report.outcomes[0]?.shadowStages?.flowMonitor, "flowMonitor outcome recorded");
    assert.ok(report.outcomes[0]?.shadowStages?.reviewerGate, "reviewerGate outcome recorded");
    assert.ok(report.outcomes[0]?.shadowStages?.selfDeploy, "selfDeploy outcome recorded");
  } finally {
    env.cleanup();
  }
});

test("(c) extractJobOutcomeMetadata parses PR, headSha, mergeSha, and deployTag for shadow stages", () => {
  const meta = extractJobOutcomeMetadata(
    "Opened https://github.com/org/repo/pull/142 (headSha: abc1234def). Merged commit deadbeef99 with deployTag: v2026.11.20."
  );
  assert.equal(meta.prNumber, 142);
  assert.equal(meta.headSha, "abc1234def");
  assert.equal(meta.merged, true);
  assert.equal(meta.mergeSha, "deadbeef99");
  assert.equal(meta.deployTag, "v2026.11.20.");

  const prOnly = extractJobOutcomeMetadata("Created PR #77 for review.");
  assert.equal(prOnly.prNumber, 77);
  assert.equal(prOnly.merged, undefined);

  const empty = extractJobOutcomeMetadata("Completed refactoring with no PR.");
  assert.deepEqual(empty, {});
});

test("Fix 2: issueAndWait returns host-checkout-unavailable and creates no thread when bridge check fails", async () => {
  let createThreadCalls = 0;
  let dispatchCalls = 0;

  const issueAndWait = createProductionIssueAndWait({
    hostCheckoutPath: "C:\\Users\\zackm\\Desktop\\repos\\local-agentic-sandbox",
    executeHostTool: async () => ({
      ok: false,
      exitCode: 128,
      stderr: "fatal: not a git repository",
    }),
    threadStore: {
      createThread: () => {
        createThreadCalls += 1;
        throw new Error("should not create thread");
      },
      getThread: async () => null,
    },
    dispatchChatTurn: async () => {
      dispatchCalls += 1;
      return { ok: true, status: 200, rawStream: "" };
    },
  });

  const outcome = await issueAndWait({
    item: {
      id: "item-grounding-fail",
      key: "#54",
      title: "Eval harness fix",
      brief: "Fix eval/run.mjs",
      status: "queued",
      dependencies: [],
      author: "Owner",
      source: "manual",
      createdAt: "2026-11-21T00:00:00.000Z",
      updatedAt: "2026-11-21T00:00:00.000Z",
    },
    brief: "Test brief",
  });

  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.equal(outcome.issue?.code, "host-checkout-unavailable");
    assert.equal(outcome.issue?.autoFixable, false);
  }
  assert.equal(createThreadCalls, 0, "No thread may be created when host checkout check fails");
  assert.equal(dispatchCalls, 0, "No chat turn may be dispatched when host checkout check fails");
});

test("Fix 2: issueAndWait issues thread when bridge check succeeds", async () => {
  let createThreadCalls = 0;
  let bridgeToolName = "";
  let bridgeArgs: Record<string, unknown> = {};

  const issueAndWait = createProductionIssueAndWait({
    hostCheckoutPath: "C:\\Users\\zackm\\Desktop\\repos\\local-agentic-sandbox",
    executeHostTool: async (tool, args) => {
      bridgeToolName = tool;
      bridgeArgs = args;
      return { ok: true, exitCode: 0, stdout: "develop\n" };
    },
    threadStore: {
      createThread: () => {
        createThreadCalls += 1;
        return {
          id: "thread-grounded-1",
          title: "#54 Eval harness fix",
          status: "active",
          model: "test-model",
          reasoningEffort: "medium",
          messages: [],
          createdAt: "2026-11-21T00:00:00.000Z",
          updatedAt: "2026-11-21T00:00:00.000Z",
        };
      },
      getThread: async () => ({
        id: "thread-grounded-1",
        title: "#54 Eval harness fix",
        status: "completed",
        model: "test-model",
        reasoningEffort: "medium",
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: "Opened PR #204 and verified.",
            timestamp: "2026-11-21T00:00:01.000Z",
          },
        ],
        createdAt: "2026-11-21T00:00:00.000Z",
        updatedAt: "2026-11-21T00:00:00.000Z",
      }),
    },
    dispatchChatTurn: async () => ({ ok: true, status: 200, rawStream: "" }),
  });

  const outcome = await issueAndWait({
    item: {
      id: "item-grounding-ok",
      key: "#54",
      title: "Eval harness fix",
      brief: "Fix eval/run.mjs",
      status: "queued",
      dependencies: [],
      author: "Owner",
      source: "manual",
      createdAt: "2026-11-21T00:00:00.000Z",
      updatedAt: "2026-11-21T00:00:00.000Z",
    },
    brief: "Test brief",
  });

  assert.equal(bridgeToolName, "host_run_powershell");
  assert.equal(bridgeArgs.command, "git rev-parse --abbrev-ref HEAD");
  assert.equal(bridgeArgs.cwd, "C:\\Users\\zackm\\Desktop\\repos\\local-agentic-sandbox");
  assert.equal(createThreadCalls, 1);
  assert.equal(outcome.status, "completed");
  if (outcome.status === "completed") {
    assert.equal(outcome.threadId, "thread-grounded-1");
    assert.equal(outcome.prNumber, 204);
  }
});

test("Fix 2: composeDispatcherBrief includes concrete hostCheckoutPath when resolved", () => {
  const concretePath = "C:\\Users\\zackm\\Desktop\\repos\\local-agentic-sandbox";
  const brief = composeDispatcherBrief(
    {
      id: "item-brief-path",
      key: "#54",
      title: "Eval harness fix",
      brief: "Fix eval/run.mjs",
      status: "queued",
      dependencies: [],
      author: "Owner",
      source: "manual",
      createdAt: "2026-11-21T00:00:00.000Z",
      updatedAt: "2026-11-21T00:00:00.000Z",
    },
    { operatorMemory: "", hostCheckoutPath: concretePath }
  );

  assert.ok(
    brief.includes(concretePath),
    `Expected composed brief to include concrete hostCheckoutPath ${concretePath}`
  );
  assert.ok(
    !brief.includes("the configured host checkout"),
    "Composed brief must not fall back to generic placeholder when hostCheckoutPath is set"
  );
});

test("Fix 3: classifyJobSummary distinguishes blocked, turn-ended, and completed summaries", () => {
  assert.equal(
    classifyJobSummary(
      "**BLOCKED — target files are not present in this sandbox checkout, and host access is withheld.**\n\nDetails follow."
    ),
    "blocked"
  );
  assert.equal(
    classifyJobSummary("Partial output...\n\n⚠️ [Turn ended: maximum tool rounds reached]"),
    "turn-ended"
  );
  assert.equal(
    classifyJobSummary(
      "Opened PR #205. Resolved the issue that previously blocked the nightly eval run."
    ),
    "completed"
  );
});

test("Fix 3: orchestrator marks item needs-attention and counts failed when job summary declares BLOCKED", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const item = store.create({
      title: "Eval harness fix",
      brief: "Fix eval/run.mjs",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    const blockedFirstLine =
      "**BLOCKED — target files are not present in this sandbox checkout, and host access is withheld.**";

    const issueAndWait = createProductionIssueAndWait({
      hostCheckoutPath: "C:\\Users\\zackm\\Desktop\\repos\\local-agentic-sandbox",
      executeHostTool: async () => ({ ok: true, exitCode: 0, stdout: "develop\n" }),
      threadStore: {
        createThread: () => ({
          id: "thread-blocked-54",
          title: "#1 Eval harness fix",
          status: "active",
          model: "test-model",
          reasoningEffort: "medium",
          messages: [],
          createdAt: "2026-11-21T00:00:00.000Z",
          updatedAt: "2026-11-21T00:00:00.000Z",
        }),
        getThread: async () => ({
          id: "thread-blocked-54",
          title: "#1 Eval harness fix",
          status: "completed",
          model: "test-model",
          reasoningEffort: "medium",
          messages: [
            {
              id: "msg-blocked-1",
              role: "assistant",
              content: `${blockedFirstLine}\n\nStopping per standing job protocol.`,
              timestamp: "2026-11-21T00:00:01.000Z",
            },
          ],
          createdAt: "2026-11-21T00:00:00.000Z",
          updatedAt: "2026-11-21T00:00:00.000Z",
        }),
      },
      dispatchChatTurn: async () => ({ ok: true, status: 200, rawStream: "" }),
    });

    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      boardDir: env.boardDir,
      maxItems: 1,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      issueAndWait,
    });

    const report = await orchestrator.drain();
    const afterItem = store.get(item.id);

    assert.equal(afterItem?.status, "needs-attention");
    assert.equal(afterItem?.needsAttention, true);
    assert.equal(afterItem?.parkedReason, blockedFirstLine);
    assert.equal(report.failedCount, 1);
    assert.equal(report.completedCount, 0);
    assert.equal(report.surfacedIssues[0]?.code, "job-blocked");
  } finally {
    env.cleanup();
  }
});

test("Fix 1: orphaned working item (budget exhausted, stopped thread + no live job) is marked needs-attention and drain issues next queued item", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const orphaned = store.create({
      title: "Interrupted job",
      brief: "Died during container OOMKill.",
      status: "working",
      threadLink: "/?thread=thread-orphaned-1",
      autoResumeCount: 2,
      author: "Owner",
      source: "manual",
    });
    const nextQueued = store.create({
      title: "Next queued job",
      brief: "Should run after orphaned item is recovered.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    const issuedIds: string[] = [];
    const checkWorkingItemLiveness = createProductionWorkingItemLivenessCheck({
      threadStore: {
        createThread: () => {
          throw new Error("unexpected createThread");
        },
        getThread: async (id: string) =>
          id === "thread-orphaned-1"
            ? {
                id: "thread-orphaned-1",
                title: "#1 Interrupted job",
                status: "stopped",
                model: "test-model",
                reasoningEffort: "medium",
                messages: [],
                error: "Turn incomplete: Server restarted or turn interrupted",
                createdAt: "2026-11-21T00:00:00.000Z",
                updatedAt: "2026-11-21T00:00:05.000Z",
              }
            : null,
      },
      isThreadLive: () => false,
    });

    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      maxItems: 1,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      checkWorkingItemLiveness,
      issueAndWait: async ({ item }): Promise<JobExecutionOutcome> => {
        issuedIds.push(item.id);
        return {
          status: "completed",
          threadId: `thread-${item.id}`,
          summary: "Completed next queued job.",
        };
      },
    });

    const report = await orchestrator.drain();
    const afterOrphaned = store.get(orphaned.id);
    const afterNext = store.get(nextQueued.id);

    assert.equal(afterOrphaned?.status, "needs-attention");
    assert.equal(afterOrphaned?.needsAttention, true);
    assert.match(afterOrphaned?.parkedReason ?? "", /without an outcome|restart/i);
    assert.deepEqual(issuedIds, [nextQueued.id]);
    assert.equal(afterNext?.status, "done");
    assert.equal(report.completedCount, 1);
  } finally {
    env.cleanup();
  }
});

test("Fix 1: working item with a live job stops the drain and issues nothing", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const liveItem = store.create({
      title: "Live running job",
      brief: "Still actively executing.",
      status: "working",
      threadLink: "/?thread=thread-live-1",
      author: "Owner",
      source: "manual",
    });
    const queued = store.create({
      title: "Queued next job",
      brief: "Must wait while live job runs.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    let issuedCount = 0;
    const checkWorkingItemLiveness = createProductionWorkingItemLivenessCheck({
      threadStore: {
        createThread: () => {
          throw new Error("unexpected createThread");
        },
        getThread: async () => ({
          id: "thread-live-1",
          title: "#1 Live running job",
          status: "active",
          model: "test-model",
          reasoningEffort: "medium",
          messages: [],
          createdAt: "2026-11-21T00:00:00.000Z",
          updatedAt: "2026-11-21T00:00:05.000Z",
        }),
      },
      isThreadLive: (id) => id === "thread-live-1",
    });

    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      maxItems: 2,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      checkWorkingItemLiveness,
      issueAndWait: async () => {
        issuedCount += 1;
        return { status: "completed", threadId: "t-unexpected" };
      },
    });

    const report = await orchestrator.drain();
    assert.equal(issuedCount, 0);
    assert.equal(store.get(liveItem.id)?.status, "working");
    assert.equal(store.get(queued.id)?.status, "queued");
    assert.equal(report.stopReason, "job-already-running");
  } finally {
    env.cleanup();
  }
});

test("Fix 1: working item whose liveness check errors stops the drain (fail-safe)", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const workingItem = store.create({
      title: "Unknown liveness job",
      brief: "Liveness check throws.",
      status: "working",
      threadLink: "/?thread=thread-err-1",
      author: "Owner",
      source: "manual",
    });
    const queued = store.create({
      title: "Queued next job",
      brief: "Must not start when liveness check errors.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    let issuedCount = 0;
    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      maxItems: 2,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      checkWorkingItemLiveness: async () => {
        throw new Error("thread store read failed");
      },
      issueAndWait: async () => {
        issuedCount += 1;
        return { status: "completed", threadId: "t-unexpected" };
      },
    });

    const report = await orchestrator.drain();
    assert.equal(issuedCount, 0);
    assert.equal(store.get(workingItem.id)?.status, "working");
    assert.equal(store.get(queued.id)?.status, "queued");
    assert.equal(report.stopReason, "job-already-running");
  } finally {
    env.cleanup();
  }
});
