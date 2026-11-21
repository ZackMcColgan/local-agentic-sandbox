import assert from "node:assert/strict";
import test from "node:test";
import {
  composeDispatcherBrief,
  dispatchNextBoardItem,
  DISPATCHER_AUTO_ISSUE_DEFAULT,
  isDispatcherAutoIssueEnabled,
  selectHeadEligibleItem,
  type DispatcherBoardItem,
} from "../lib/board/dispatcher";

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
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    ...overrides,
  };
}

test("stage flag defaults to OFF (shadow mode)", () => {
  assert.equal(DISPATCHER_AUTO_ISSUE_DEFAULT, false);
  assert.equal(isDispatcherAutoIssueEnabled(undefined, {}), false);
  assert.equal(isDispatcherAutoIssueEnabled(undefined, { DISPATCHER_AUTO_ISSUE: "true" }), true);
  assert.equal(isDispatcherAutoIssueEnabled(true, {}), true);
});

test("selects exactly the head eligible item, skipping parked and unmet dependencies", () => {
  const board: DispatcherBoardItem[] = [
    makeItem({ id: "done-1", key: "#1", status: "done", title: "Already done" }),
    makeItem({
      id: "parked-1",
      key: "#2",
      status: "parked",
      parkedReason: "Waiting on owner",
      title: "Parked",
    }),
    makeItem({
      id: "blocked-1",
      key: "#3",
      status: "queued",
      dependencies: ["missing-or-unmet"],
      title: "Blocked on dep",
    }),
    makeItem({
      id: "eligible-1",
      key: "#4",
      status: "queued",
      dependencies: ["done-1"],
      title: "Head eligible",
    }),
    makeItem({
      id: "eligible-2",
      key: "#5",
      status: "queued",
      dependencies: [],
      title: "Second eligible",
    }),
  ];

  const selected = selectHeadEligibleItem(board);
  assert.equal(selected?.id, "eligible-1");
});

test("one-job rule: refuses to start a second job while live job state is running", async () => {
  const board = [makeItem({ id: "item-1", title: "Ready item" })];
  const logs: string[] = [];
  let issued = 0;

  const result = await dispatchNextBoardItem({
    items: board,
    liveJobState: { isRunning: true, runningJobId: "job-99" },
    ownerState: { isMidTurn: false },
    autoIssue: true,
    issueThread: async () => {
      issued += 1;
      return { threadId: "t-1" };
    },
    log: (msg) => logs.push(msg),
  });

  assert.equal(result.action, "refused");
  assert.match(result.reason, /running/i);
  assert.equal(issued, 0);
  assert.ok(logs.some((l) => /running/i.test(l)));
});

test("owner preemption: blocks start when owner is mid-turn", async () => {
  const board = [makeItem({ id: "item-1", title: "Ready item" })];
  const logs: string[] = [];
  let issued = 0;

  const result = await dispatchNextBoardItem({
    items: board,
    liveJobState: { isRunning: false },
    ownerState: { isMidTurn: true, reason: "streaming owner thread" },
    autoIssue: true,
    issueThread: async () => {
      issued += 1;
      return { threadId: "t-1" };
    },
    log: (msg) => logs.push(msg),
  });

  assert.equal(result.action, "refused");
  assert.match(result.reason, /owner/i);
  assert.equal(issued, 0);
  assert.ok(logs.some((l) => /owner/i.test(l)));
});

test("chunk-complete item yields continuation brief from handoff, not fresh composition", () => {
  const item = makeItem({
    id: "item-chunk",
    title: "Chunked item",
    brief: "Original fresh brief that should not be used as primary.",
    handoff: {
      state: "chunk-complete",
      branch: "feature/chunked-item",
      headSha: "abc1234",
      nextStep: "Wire Phase 2 and run test:gate",
      openQuestions: ["Confirm edge case X"],
    },
  });

  const brief = composeDispatcherBrief(item, {
    operatorMemory: "Host checkout: C:\\repos\\sandbox",
    hostCheckoutPath: "C:\\repos\\sandbox",
  });

  assert.match(brief, /CONTINUATION FROM HANDOFF/i);
  assert.match(brief, /feature\/chunked-item/);
  assert.match(brief, /abc1234/);
  assert.match(brief, /Wire Phase 2 and run test:gate/);
  assert.match(brief, /Confirm edge case X/);
  assert.doesNotMatch(brief, /Original fresh brief that should not be used as primary/);
});

test("shadow mode (default OFF) logs decision and issues NOTHING; flag ON issues thread", async () => {
  const board = [makeItem({ id: "item-1", title: "Ready item", brief: "Build it." })];
  const shadowLogs: string[] = [];
  let shadowIssued = 0;

  const shadowResult = await dispatchNextBoardItem({
    items: board,
    liveJobState: { isRunning: false },
    ownerState: { isMidTurn: false },
    operatorMemory: "Standing memory fact",
    hostCheckoutPath: "C:\\repos\\sandbox",
    issueThread: async () => {
      shadowIssued += 1;
      return { threadId: "t-shadow" };
    },
    log: (msg) => shadowLogs.push(msg),
  });

  assert.equal(shadowResult.action, "shadow");
  assert.equal(shadowResult.item?.id, "item-1");
  assert.ok(shadowResult.brief && shadowResult.brief.includes("Build it."));
  assert.ok(shadowResult.brief.includes("Standing memory fact"));
  assert.ok(shadowResult.brief.includes("npm run test:gate"));
  assert.equal(shadowIssued, 0);
  assert.ok(shadowLogs.some((l) => l.includes("shadow") && l.includes("item-1")));

  let liveIssued = 0;
  const liveResult = await dispatchNextBoardItem({
    items: board,
    liveJobState: { isRunning: false },
    ownerState: { isMidTurn: false },
    autoIssue: true,
    issueThread: async () => {
      liveIssued += 1;
      return { threadId: "t-live-1" };
    },
    log: () => {},
  });

  assert.equal(liveResult.action, "issued");
  assert.equal(liveResult.threadId, "t-live-1");
  assert.equal(liveIssued, 1);
});
