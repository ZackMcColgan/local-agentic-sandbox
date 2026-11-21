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
    makeItem({ id: "blocked-1", key: "#1", status: "queued", dependencies: ["missing"], title: "Blocked" }),
    makeItem({ id: "eligible-1", key: "#2", status: "queued", dependencies: ["done-0"], title: "Head eligible" }),
    makeItem({ id: "eligible-2", key: "#3", status: "queued", dependencies: [], title: "Second eligible" }),
  ];

  let liveRunning = false;
  let concurrentRuns = 0;
  let maxConcurrentRuns = 0;
  const startedIds: string[] = [];

  const orchestrator = new BoardOrchestrator({
    items: board,
    getControlState: () => makeControl("running"),
    getLiveJobState: () => ({ isRunning: liveRunning, runningJobId: liveRunning ? "job-active" : undefined }),
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
