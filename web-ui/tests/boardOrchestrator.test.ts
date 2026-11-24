import assert from "node:assert/strict";
import test from "node:test";
import {
  BoardOrchestrator,
  MAX_DRAIN_DURATION_MS,
  MAX_DRAIN_ITEMS,
  type DrainReport,
  type JobExecutionOutcome,
} from "../lib/board/boardOrchestrator";
import type { DispatcherBoardItem } from "../lib/board/dispatcher";
import type { BoardControlRecord } from "../lib/board/boardControlStore";
import type { SlotUtilizationMetrics } from "../lib/slotScheduler";

function makeItem(overrides: Partial<DispatcherBoardItem> = {}): DispatcherBoardItem {
  return {
    id: "item-1",
    key: "#1",
    title: "Default item",
    brief: "Implement default behavior.",
    dependencies: [],
    status: "queued",
    author: "Owner",
    source: "manual",
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:00.000Z",
    ...overrides,
  };
}

function makeControl(state: BoardControlRecord["state"] = "running"): BoardControlRecord {
  return {
    state,
    drainBudget: null,
    stopAtBoundary: state === "paused",
    updatedAt: "2026-11-18T00:00:00.000Z",
  };
}

function makeSlotMetrics(overrides: Partial<SlotUtilizationMetrics> = {}): SlotUtilizationMetrics {
  return {
    generatingMs: 1200,
    waitingToolMs: 300,
    waitingCiMs: 100,
    idleGapMs: 400,
    totalObservedMs: 2000,
    slotUtilizationPct: 80,
    preemptionsCount: 1,
    ownerWaitMs: { p50: 40, p95: 80, count: 1 },
    completedJobs: 1,
    jobsPerHour: 12,
    ...overrides,
  };
}

test("starts exactly the head eligible item and never starts a second job while one runs", async () => {
  const board: DispatcherBoardItem[] = [
    makeItem({ id: "done-0", key: "#0", status: "done", title: "Done dep" }),
    makeItem({
      id: "blocked-1",
      key: "#1",
      status: "queued",
      dependencies: ["missing"],
      title: "Blocked",
    }),
    makeItem({
      id: "eligible-1",
      key: "#2",
      status: "queued",
      dependencies: ["done-0"],
      title: "Head eligible",
    }),
    makeItem({
      id: "eligible-2",
      key: "#3",
      status: "queued",
      dependencies: [],
      title: "Second eligible",
    }),
  ];

  let liveRunning = false;
  let concurrentRuns = 0;
  let maxConcurrentRuns = 0;
  const startedIds: string[] = [];

  const orchestrator = new BoardOrchestrator({
    items: board,
    getControlState: () => makeControl("running"),
    getLiveJobState: () => ({
      isRunning: liveRunning,
      runningJobId: liveRunning ? "job-active" : undefined,
    }),
    getOwnerState: () => ({ isMidTurn: false }),
    getSlotMetrics: () => makeSlotMetrics(),
    operatorMemory: "Keep diffs small.",
    issueAndWait: async ({ item, brief }): Promise<JobExecutionOutcome> => {
      concurrentRuns += 1;
      maxConcurrentRuns = Math.max(maxConcurrentRuns, concurrentRuns);
      liveRunning = true;
      startedIds.push(item.id);
      assert.match(brief, /BOARD ITEM — #2 Head eligible/);
      assert.match(brief, /OPERATOR MEMORY:\nKeep diffs small\./);
      assert.match(brief, /STANDING JOB PROTOCOL:/);
      // Simulate second item checking while first is still marked running if it were concurrent
      concurrentRuns -= 1;
      // Leave liveRunning = true after the first job to verify one-job rule blocks the second item
      return { status: "in-progress", threadId: "t-head-1", reason: "still active" };
    },
  });

  const report: DrainReport = await orchestrator.drain();
  assert.deepEqual(startedIds, ["eligible-1"]);
  assert.equal(maxConcurrentRuns, 1);
  assert.equal(report.stopReason, "job-already-running");
  assert.equal(report.inProgressCount, 1);
});

test("owner preemption: owner mid-turn blocks job start", async () => {
  const board = [makeItem({ id: "item-1", title: "Ready item" })];
  let issued = 0;

  const orchestrator = new BoardOrchestrator({
    items: board,
    getControlState: () => makeControl("running"),
    getLiveJobState: () => ({ isRunning: false }),
    getOwnerState: () => ({ isMidTurn: true, reason: "Interactive chat turn active" }),
    getSlotMetrics: () => makeSlotMetrics(),
    issueAndWait: async () => {
      issued += 1;
      return { status: "completed", threadId: "t-1" };
    },
  });

  const report = await orchestrator.drain();
  assert.equal(issued, 0);
  assert.equal(report.stopReason, "owner-preempted");
  assert.equal(report.itemsProcessed, 0);
});

test("paused and stopped control states block the drain", async () => {
  for (const state of ["paused", "stopped"] as const) {
    const board = [makeItem({ id: "item-1", title: "Ready item" })];
    let issued = 0;

    const orchestrator = new BoardOrchestrator({
      items: board,
      getControlState: () => makeControl(state),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      getSlotMetrics: () => makeSlotMetrics(),
      issueAndWait: async () => {
        issued += 1;
        return { status: "completed", threadId: "t-1" };
      },
    });

    const report = await orchestrator.drain();
    assert.equal(issued, 0);
    assert.equal(report.stopReason, state === "paused" ? "control-paused" : "control-stopped");
    assert.equal(report.itemsProcessed, 0);
  }
});

test("chunk-complete item re-queues its continuation from the handoff", async () => {
  const board = [
    makeItem({ id: "chunked-1", key: "#10", title: "Multi-chunk task", brief: "Original brief" }),
  ];

  const seenBriefs: string[] = [];
  let callCount = 0;

  const orchestrator = new BoardOrchestrator({
    items: board,
    getControlState: () => makeControl("running"),
    getLiveJobState: () => ({ isRunning: false }),
    getOwnerState: () => ({ isMidTurn: false }),
    getSlotMetrics: () => makeSlotMetrics(),
    issueAndWait: async ({ brief }) => {
      callCount += 1;
      seenBriefs.push(brief);
      if (callCount === 1) {
        return {
          status: "chunk-complete",
          threadId: "t-chunk-1",
          handoff: {
            state: "chunk-1-complete",
            branch: "feature/chunked-1",
            headSha: "abc1234",
            nextStep: "Implement phase 2 verification",
            openQuestions: ["Confirm edge case X"],
          },
        };
      }
      return { status: "completed", threadId: "t-chunk-2" };
    },
  });

  const report = await orchestrator.drain();
  assert.equal(callCount, 2);
  assert.match(seenBriefs[0], /BOARD ITEM — #10 Multi-chunk task/);
  assert.match(seenBriefs[1], /CONTINUATION FROM HANDOFF — #10 Multi-chunk task/);
  assert.match(seenBriefs[1], /Branch: feature\/chunked-1/);
  assert.match(seenBriefs[1], /HEAD SHA: abc1234/);
  assert.match(seenBriefs[1], /Next step: Implement phase 2 verification/);
  assert.equal(report.requeuedCount, 1);
  assert.equal(report.completedCount, 1);
  assert.equal(board[0].status, "done");
});

test("bounded triage: auto-fixes auto-fixable issues and surfaces non-auto-fixable issues", async () => {
  const board = [
    makeItem({ id: "auto-fix-item", key: "#11", title: "Stale lock item" }),
    makeItem({ id: "non-fix-item", key: "#12", title: "Conflict item" }),
  ];

  let autoFixCalls = 0;
  let attemptsForItem1 = 0;

  const orchestrator = new BoardOrchestrator({
    items: board,
    getControlState: () => makeControl("running"),
    getLiveJobState: () => ({ isRunning: false }),
    getOwnerState: () => ({ isMidTurn: false }),
    getSlotMetrics: () => makeSlotMetrics(),
    triageAutoFix: async (issue) => {
      if (issue.autoFixable) {
        autoFixCalls += 1;
        return true;
      }
      return false;
    },
    issueAndWait: async ({ item }) => {
      if (item.id === "auto-fix-item") {
        attemptsForItem1 += 1;
        if (attemptsForItem1 === 1) {
          return {
            status: "failed",
            threadId: "t-fix-1",
            error: "Stale git index.lock",
            issue: {
              code: "stale-lock",
              message: "Stale git index.lock",
              autoFixable: true,
            },
          };
        }
        return { status: "completed", threadId: "t-fix-2" };
      }

      return {
        status: "failed",
        threadId: "t-conflict-1",
        error: "Merge conflict in dispatcher.ts",
        issue: {
          code: "merge-conflict",
          message: "Merge conflict in dispatcher.ts",
          autoFixable: false,
        },
      };
    },
  });

  const report = await orchestrator.drain();
  assert.equal(autoFixCalls, 1);
  assert.equal(attemptsForItem1, 2);
  assert.equal(report.completedCount, 1);
  assert.equal(report.failedCount, 1);
  assert.equal(report.surfacedCount, 1);
  assert.equal(report.surfacedIssues.length, 1);
  assert.equal(report.surfacedIssues[0].itemId, "non-fix-item");
  assert.equal(report.surfacedIssues[0].code, "merge-conflict");
  assert.equal(board[1].status, "needs-attention");
  assert.equal(board[1].needsAttention, true);
});

test("enforces hard 5-item cap and 10-minute duration cap without interrupting mid-item", async () => {
  assert.equal(MAX_DRAIN_ITEMS, 5);
  assert.equal(MAX_DRAIN_DURATION_MS, 10 * 60 * 1000);

  // 1. Test 5-item cap even if caller requests more
  const sevenItems = Array.from({ length: 7 }, (_, i) =>
    makeItem({ id: `item-${i + 1}`, key: `#${i + 1}`, title: `Item ${i + 1}` })
  );
  const orchestratorFive = new BoardOrchestrator({
    items: sevenItems,
    maxItems: 99,
    getControlState: () => makeControl("running"),
    getLiveJobState: () => ({ isRunning: false }),
    getOwnerState: () => ({ isMidTurn: false }),
    getSlotMetrics: () => makeSlotMetrics(),
    issueAndWait: async ({ item }) => ({ status: "completed", threadId: `t-${item.id}` }),
  });
  const reportFive = await orchestratorFive.drain();
  assert.equal(reportFive.completedCount, 5);
  assert.equal(reportFive.stopReason, "max-items-reached");
  assert.equal(sevenItems[5].status, "queued");

  // 2. Test 10-minute cap
  let fakeNow = 1_000_000;
  const threeItems = Array.from({ length: 3 }, (_, i) =>
    makeItem({ id: `timed-${i + 1}`, key: `#${i + 1}`, title: `Timed ${i + 1}` })
  );
  const orchestratorTimed = new BoardOrchestrator({
    items: threeItems,
    maxDurationMs: 99_999_999,
    now: () => fakeNow,
    getControlState: () => makeControl("running"),
    getLiveJobState: () => ({ isRunning: false }),
    getOwnerState: () => ({ isMidTurn: false }),
    getSlotMetrics: () => makeSlotMetrics(),
    issueAndWait: async ({ item }) => {
      // Advance clock past 10 minutes during the first item; first item still finishes cleanly
      fakeNow += MAX_DRAIN_DURATION_MS + 1000;
      return { status: "completed", threadId: `t-${item.id}` };
    },
  });
  const reportTimed = await orchestratorTimed.drain();
  assert.equal(reportTimed.completedCount, 1);
  assert.equal(reportTimed.stopReason, "time-cap-reached");
  assert.equal(threeItems[1].status, "queued");
});

test("writes deep-link threadLink (/?thread=<id>) for failed, completed, chunk-complete, and in-progress outcomes", async () => {
  const failedItem = makeItem({ id: "link-fail", key: "#51", title: "Failed link" });
  const completedItem = makeItem({ id: "link-done", key: "#52", title: "Done link" });
  const chunkItem = makeItem({ id: "link-chunk", key: "#53", title: "Chunk link" });
  const inProgressItem = makeItem({ id: "link-prog", key: "#54", title: "In-progress link" });

  let chunkCalls = 0;
  let chunkLinkAfterFirst = "";

  const orchestrator = new BoardOrchestrator({
    items: [failedItem, completedItem, chunkItem, inProgressItem],
    getControlState: () => makeControl("running"),
    getLiveJobState: () => ({ isRunning: false }),
    getOwnerState: () => ({ isMidTurn: false }),
    getSlotMetrics: () => makeSlotMetrics(),
    issueAndWait: async ({ item }) => {
      if (item.id === "link-fail") {
        return { status: "failed", threadId: "t-fail", error: "boom" };
      }
      if (item.id === "link-done") {
        return { status: "completed", threadId: "t-done" };
      }
      if (item.id === "link-chunk") {
        chunkCalls += 1;
        if (chunkCalls === 1) {
          return {
            status: "chunk-complete",
            threadId: "t-chunk-1",
            handoff: {
              state: "c1",
              branch: "b1",
              headSha: "abc1234",
              nextStep: "next",
            },
          };
        }
        chunkLinkAfterFirst = item.threadLink ?? "";
        return { status: "completed", threadId: "t-chunk-2" };
      }
      return { status: "in-progress", threadId: "t-prog" };
    },
  });

  await orchestrator.drain();
  assert.equal(failedItem.threadLink, "/?thread=t-fail");
  assert.equal(completedItem.threadLink, "/?thread=t-done");
  assert.equal(chunkLinkAfterFirst, "/?thread=t-chunk-1");
  assert.equal(chunkItem.threadLink, "/?thread=t-chunk-2");
  assert.equal(inProgressItem.threadLink, "/?thread=t-prog");
});

test("rolled-back selfDeploy with needsAttention=true marks item needs-attention, never done", async () => {
  const item = makeItem({
    id: "deploy-rollback-1",
    key: "#99",
    title: "Deploy rollback test",
  });

  const orchestrator = new BoardOrchestrator({
    items: [item],
    stageFlags: { selfDeploy: true },
    getControlState: () => makeControl("running"),
    getLiveJobState: () => ({ isRunning: false }),
    getOwnerState: () => ({ isMidTurn: false }),
    getSlotMetrics: () => makeSlotMetrics(),
    issueAndWait: async () => ({
      status: "completed",
      threadId: "t-deploy-rb",
      merged: true,
      mergeSha: "abc1234",
      deployTag: "v-abc1234",
    }),
    selfDeploy: {
      deps: {
        readCurrentState: async () => ({
          image: "local-agentic-sandbox-web-ui:v-prev",
          podStatus: "Running",
          podRestarts: 0,
        }),
        bankRollbackTarget: async (tag) => ({ banked: true, tag }),
        buildAndImport: async () => ({
          built: true,
          imported: true,
          imagePresentInNode: true,
          detail: "ok",
        }),
        setImage: async () => ({ ok: true }),
        verifyDeployment: async (tag) =>
          tag === "local-agentic-sandbox-web-ui:v-prev"
            ? {
                ok: true,
                rolloutSuccess: true,
                podRunningZeroRestarts: true,
                gatewayStatus: 200,
                threadListLoads: true,
                observedTag: tag,
              }
            : {
                ok: false,
                rolloutSuccess: true,
                podRunningZeroRestarts: false,
                gatewayStatus: 502,
                threadListLoads: false,
                observedTag: tag,
                failedStep: "gateway_200",
                observed: "gateway=502",
              },
      },
    },
  });

  const prevSelfDeploy = process.env.SELF_DEPLOY_ENABLED;
  process.env.SELF_DEPLOY_ENABLED = "true";
  try {
    const report = await orchestrator.drain();
    assert.equal(item.status, "needs-attention");
    assert.equal(report.completedCount, 0);
    assert.equal(report.outcomes[0].outcome, "failed");
    assert.match(report.outcomes[0].reason ?? "", /S4 verification failed|gateway_200/);
  } finally {
    if (prevSelfDeploy === undefined) delete process.env.SELF_DEPLOY_ENABLED;
    else process.env.SELF_DEPLOY_ENABLED = prevSelfDeploy;
  }
});

test("R8: paused and stopped control states still reconcile dead working items without launching queued items", async () => {
  for (const state of ["paused", "stopped"] as const) {
    const deadWorking = makeItem({
      id: "working-dead-1",
      key: "#101",
      title: "Completed while paused",
      status: "working",
      threadLink: "/?thread=t-dead-1",
    });
    const queuedItem = makeItem({
      id: "queued-next-1",
      key: "#102",
      title: "Must not launch while paused/stopped",
      status: "queued",
    });

    let issued = 0;
    const orchestrator = new BoardOrchestrator({
      items: [deadWorking, queuedItem],
      getControlState: () => makeControl(state),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      getSlotMetrics: () => makeSlotMetrics(),
      checkWorkingItemLiveness: async () => ({
        status: "completed",
        outcome: { status: "completed", threadId: "t-dead-1", prNumber: 311 },
        reason: "Settled before control pause/stop",
      }),
      issueAndWait: async () => {
        issued += 1;
        return { status: "completed", threadId: "t-unexpected" };
      },
    });

    const report = await orchestrator.drain();
    assert.equal(issued, 0, `must not launch queued item when control is ${state}`);
    assert.equal(deadWorking.status, "done", `dead working item must settle when control is ${state}`);
    assert.equal(deadWorking.evidence?.prNumber, 311);
    assert.equal(queuedItem.status, "queued");
    assert.equal(report.stopReason, state === "paused" ? "control-paused" : "control-stopped");
    assert.equal(report.completedCount, 1);
  }
});

test("R8: shadow stage exceptions do not leave items stuck in working and selfDeploy needsAttention sets parkedReason", async () => {
  const itemShadowErr = makeItem({
    id: "shadow-err-1",
    key: "#103",
    title: "Shadow stage throws",
  });
  const orchestratorErr = new BoardOrchestrator({
    items: [itemShadowErr],
    getControlState: () => makeControl("running"),
    getLiveJobState: () => ({ isRunning: false }),
    getOwnerState: () => ({ isMidTurn: false }),
    getSlotMetrics: () => makeSlotMetrics(),
    flowMonitor: {
      pollChecks: async () => {
        throw new Error("GitHub API 502");
      },
    },
    selfDeploy: {
      deps: {
        readCurrentState: async () => {
          throw new Error("kubectl unavailable");
        },
        bankRollbackTarget: async (tag) => ({ banked: true, tag }),
        buildAndImport: async () => ({
          built: false,
          imported: false,
          imagePresentInNode: false,
          detail: "noop",
        }),
        setImage: async () => ({ ok: false }),
        verifyDeployment: async (observedTag) => ({
          ok: false,
          rolloutSuccess: false,
          podRunningZeroRestarts: false,
          gatewayStatus: 0,
          threadListLoads: false,
          observedTag,
        }),
      },
    },
    issueAndWait: async () => ({
      status: "completed",
      threadId: "t-shadow-err",
      prNumber: 312,
      headSha: "abc1234",
      merged: true,
      mergeSha: "def5678",
    }),
  });

  const errReport = await orchestratorErr.drain();
  assert.equal(itemShadowErr.status, "done");
  assert.equal(itemShadowErr.evidence?.prNumber, 312);
  assert.equal(itemShadowErr.evidence?.mergeSha, "def5678");
  assert.equal(errReport.completedCount, 1);

  const itemDeployFail = makeItem({
    id: "deploy-fail-flag-1",
    key: "#104",
    title: "Deploy rollback sets needsAttention and parkedReason",
  });
  const prevSelfDeploy = process.env.SELF_DEPLOY_ENABLED;
  process.env.SELF_DEPLOY_ENABLED = "true";
  try {
    const orchestratorDeployFail = new BoardOrchestrator({
      items: [itemDeployFail],
      stageFlags: { selfDeploy: true },
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      getSlotMetrics: () => makeSlotMetrics(),
      issueAndWait: async () => ({
        status: "completed",
        threadId: "t-deploy-rb-2",
        merged: true,
        mergeSha: "deadbee",
      }),
      selfDeploy: {
        deps: {
          readCurrentState: async () => ({
            image: "local-agentic-sandbox-web-ui:v-prev",
            podStatus: "Running",
            podRestarts: 0,
          }),
          bankRollbackTarget: async (tag) => ({ banked: true, tag }),
          buildAndImport: async () => ({
            built: true,
            imported: true,
            imagePresentInNode: true,
            detail: "ok",
          }),
          setImage: async () => ({ ok: true }),
          verifyDeployment: async (tag) =>
            tag === "local-agentic-sandbox-web-ui:v-prev"
              ? {
                  ok: true,
                  rolloutSuccess: true,
                  podRunningZeroRestarts: true,
                  gatewayStatus: 200,
                  threadListLoads: true,
                  observedTag: tag,
                }
              : {
                  ok: false,
                  rolloutSuccess: true,
                  podRunningZeroRestarts: false,
                  gatewayStatus: 502,
                  threadListLoads: false,
                  observedTag: tag,
                  failedStep: "gateway_200",
                  observed: "gateway=502",
                },
        },
      },
    });
    const deployReport = await orchestratorDeployFail.drain();
    assert.equal(itemDeployFail.status, "needs-attention");
    assert.equal(itemDeployFail.needsAttention, true);
    assert.match(itemDeployFail.parkedReason ?? "", /S4 verification failed|gateway_200/);
    assert.equal(deployReport.failedCount, 1);
  } finally {
    if (prevSelfDeploy === undefined) delete process.env.SELF_DEPLOY_ENABLED;
    else process.env.SELF_DEPLOY_ENABLED = prevSelfDeploy;
  }
});

test("R8: chunk-complete requeues are capped and park to needs-attention when exceeded", async () => {
  const mod = await import("../lib/board/boardOrchestrator");
  const MAX_CHUNK_REQUEUES = (mod as { MAX_CHUNK_REQUEUES?: number }).MAX_CHUNK_REQUEUES;
  assert.equal(MAX_CHUNK_REQUEUES, 10);

  const item = makeItem({
    id: "chunk-cap-1",
    key: "#105",
    title: "Runaway chunk loop",
    brief: "Complete within chunk cap.",
  });

  let calls = 0;
  const orchestrator = new BoardOrchestrator({
    items: [item],
    maxItems: 5,
    maxChunkRequeues: 2,
    getControlState: () => makeControl("running"),
    getLiveJobState: () => ({ isRunning: false }),
    getOwnerState: () => ({ isMidTurn: false }),
    getSlotMetrics: () => makeSlotMetrics(),
    issueAndWait: async () => {
      calls += 1;
      return {
        status: "chunk-complete",
        threadId: `t-chunk-cap-${calls}`,
        handoff: {
          state: `chunk-${calls}`,
          branch: "feat/chunk-cap",
          headSha: "abc1234",
          nextStep: "Keep going",
        },
      };
    },
  });

  const report = await orchestrator.drain();
  assert.equal(calls, 3, "2 requeues + 1 final hit exhausting cap = 3 turns");
  assert.equal(item.status, "needs-attention");
  assert.equal(item.needsAttention, true);
  assert.match(item.parkedReason ?? "", /chunk requeue/i);
  assert.equal(report.requeuedCount, 2);
  assert.equal(report.failedCount, 1);
});
