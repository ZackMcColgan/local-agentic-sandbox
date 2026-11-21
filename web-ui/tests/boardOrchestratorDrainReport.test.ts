import assert from "node:assert/strict";
import test from "node:test";
import {
  BoardOrchestrator,
  type DrainReport,
  type JobExecutionOutcome,
} from "../lib/board/boardOrchestrator";
import { formatDrainReportMarkdown } from "../lib/subagents/morningReport";
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
    stopAtBoundary: false,
    updatedAt: "2026-11-18T00:00:00.000Z",
  };
}

function makeSlotMetrics(): SlotUtilizationMetrics {
  return {
    generatingMs: 4500,
    waitingToolMs: 500,
    waitingCiMs: 1000,
    idleGapMs: 2000,
    totalObservedMs: 8000,
    slotUtilizationPct: 75,
    preemptionsCount: 2,
    ownerWaitMs: { p50: 35, p95: 90, count: 2 },
    completedJobs: 1,
    jobsPerHour: 15,
  };
}

test("drain report counts completed, failed, and in-progress accurately with slot utilization", async () => {
  const board: DispatcherBoardItem[] = [
    makeItem({ id: "i-ok", key: "#21", title: "Completed item" }),
    makeItem({ id: "i-fail", key: "#22", title: "Failed item" }),
    makeItem({ id: "i-active", key: "#23", title: "In-progress item" }),
  ];

  let liveRunning = false;
  let clock = 10_000;

  const orchestrator = new BoardOrchestrator({
    items: board,
    now: () => clock,
    getControlState: () => makeControl("running"),
    getLiveJobState: () => ({
      isRunning: liveRunning,
      runningJobId: liveRunning ? "t-23" : undefined,
    }),
    getOwnerState: () => ({ isMidTurn: false }),
    getSlotMetrics: () => makeSlotMetrics(),
    issueAndWait: async ({ item }): Promise<JobExecutionOutcome> => {
      clock += 250;
      if (item.id === "i-ok") {
        return { status: "completed", threadId: "t-21" };
      }
      if (item.id === "i-fail") {
        return {
          status: "failed",
          threadId: "t-22",
          error: "Test suite failed",
          issue: {
            code: "test-failure",
            message: "Test suite failed",
            autoFixable: false,
          },
        };
      }
      liveRunning = true;
      return { status: "in-progress", threadId: "t-23", reason: "Streaming chunk 1" };
    },
  });

  const report: DrainReport = await orchestrator.drain();
  assert.equal(report.completedCount, 1);
  assert.equal(report.failedCount, 1);
  assert.equal(report.inProgressCount, 1);
  assert.equal(report.surfacedCount, 1);
  assert.equal(report.itemsProcessed, 3);
  assert.equal(report.outcomes.length, 3);

  assert.equal(report.outcomes[0].itemId, "i-ok");
  assert.equal(report.outcomes[0].outcome, "completed");
  assert.equal(report.outcomes[1].itemId, "i-fail");
  assert.equal(report.outcomes[1].outcome, "failed");
  assert.equal(report.outcomes[2].itemId, "i-active");
  assert.equal(report.outcomes[2].outcome, "in-progress");

  assert.equal(report.slotUtilization.slotUtilizationPct, 75);
  assert.equal(report.slotUtilization.preemptionsCount, 2);
  assert.equal(report.slotUtilization.ownerWaitMs.p95, 90);
});

test("formatDrainReportMarkdown renders counts, per-item outcomes, surfaced issues, and slot metrics", async () => {
  const board: DispatcherBoardItem[] = [
    makeItem({ id: "i-1", key: "#31", title: "Ship feature A" }),
    makeItem({ id: "i-2", key: "#32", title: "Fix issue B" }),
  ];

  const orchestrator = new BoardOrchestrator({
    items: board,
    getControlState: () => makeControl("running"),
    getLiveJobState: () => ({ isRunning: false }),
    getOwnerState: () => ({ isMidTurn: false }),
    getSlotMetrics: () => makeSlotMetrics(),
    issueAndWait: async ({ item }) => {
      if (item.id === "i-1") {
        return { status: "completed", threadId: "t-31" };
      }
      return {
        status: "failed",
        threadId: "t-32",
        error: "Ambiguous spec requirement",
        issue: {
          code: "ambiguous-spec",
          message: "Ambiguous spec requirement",
          autoFixable: false,
        },
      };
    },
  });

  const report = await orchestrator.drain();
  const md = formatDrainReportMarkdown(report);

  assert.match(md, /Board Drain Report/);
  assert.match(md, /Completed.*1/);
  assert.match(md, /Failed.*1/);
  assert.match(md, /In Progress.*0/);
  assert.match(md, /#31/);
  assert.match(md, /Ship feature A/);
  assert.match(md, /#32/);
  assert.match(md, /Ambiguous spec requirement/);
  assert.match(md, /75%/);
  assert.match(md, /Preemptions.*2/);
});
