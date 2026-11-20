import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FLOW_MONITOR_STAGE2_DEFAULT,
  isFlowMonitorStage2Enabled,
  evaluatePrChecks,
  isVerdictValidForHead,
  composeFixCycleBrief,
  monitorPrToConclusion,
  type PrCheckResult,
  type FlowMonitorBoardItem,
} from "../lib/board/flowMonitor";

function makeItem(overrides: Partial<FlowMonitorBoardItem> = {}): FlowMonitorBoardItem {
  return {
    id: "item-23",
    key: "S4-23",
    title: "flow-monitor",
    brief: "Watch open PR checks to conclusion.",
    status: "pr-open",
    dependencies: [],
    author: "Owner",
    source: "manual",
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    prNumber: 124,
    branch: "feature/flow-monitor",
    worktreePath: "C:\\Users\\zackm\\Desktop\\repos\\flowmonitor-wt",
    ...overrides,
  };
}

const REAL_CI_CHECK_NAMES = [
  "Typecheck (full error report)",
  "Unit Tests & Static Analysis",
  "Code Coverage Report",
  "Container Build & Docker Scout Scan",
  "Playwright UI (Shard 1/3)",
  "Playwright UI (Shard 2/3)",
  "Playwright UI (Shard 3/3)",
] as const;

function allSevenGreenChecks(): PrCheckResult[] {
  return REAL_CI_CHECK_NAMES.map((name) => ({
    name,
    status: "COMPLETED",
    conclusion: "SUCCESS",
  }));
}

describe("flow-monitor", () => {
  it("defaults stage 2 flag to OFF (shadow mode)", () => {
    assert.equal(FLOW_MONITOR_STAGE2_DEFAULT, false);
    assert.equal(isFlowMonitorStage2Enabled(undefined, {}), false);
    assert.equal(isFlowMonitorStage2Enabled(undefined, { FLOW_MONITOR_STAGE2: "false" }), false);
    assert.equal(isFlowMonitorStage2Enabled(undefined, { FLOW_MONITOR_STAGE2: "true" }), true);
    assert.equal(isFlowMonitorStage2Enabled(true, { FLOW_MONITOR_STAGE2: "false" }), true);
  });

  it("returns green verdict only when ALL SEVEN real CI checks pass on the PR head SHA, and voids on head change", () => {
    const verdict = evaluatePrChecks("sha-abc123", allSevenGreenChecks());
    assert.equal(verdict.status, "green");
    assert.equal(verdict.headSha, "sha-abc123");
    assert.equal(isVerdictValidForHead(verdict, "sha-abc123"), true);
    assert.equal(isVerdictValidForHead(verdict, "sha-def456"), false);

    // Any one of the 7 missing -> running
    for (const missingName of REAL_CI_CHECK_NAMES) {
      const incomplete = allSevenGreenChecks().filter((c) => c.name !== missingName);
      const incompleteVerdict = evaluatePrChecks("sha-abc123", incomplete);
      assert.equal(incompleteVerdict.status, "running", `missing ${missingName} must evaluate to running`);
    }
  });

  it("reports a PR whose checks are still running as running, never green or red", () => {
    for (const runningName of REAL_CI_CHECK_NAMES) {
      const checks = allSevenGreenChecks().map((c) =>
        c.name === runningName ? { name: c.name, status: "IN_PROGRESS", conclusion: null } : c
      );
      const verdict = evaluatePrChecks("sha-running", checks);
      assert.equal(verdict.status, "running", `running ${runningName} must evaluate to running`);
      assert.equal(verdict.headSha, "sha-running");
    }
  });

  it("reports red when any one of the 7 real CI checks fails", () => {
    for (const failingName of REAL_CI_CHECK_NAMES) {
      const checks = allSevenGreenChecks().map((c) =>
        c.name === failingName
          ? { name: c.name, status: "COMPLETED", conclusion: "FAILURE", error: `${failingName} failed` }
          : c
      );
      const verdict = evaluatePrChecks("sha-red", checks);
      assert.equal(verdict.status, "red", `failing ${failingName} must evaluate to red`);
      assert.equal(verdict.failingJob, failingName);
    }
  });

  it("composes exactly one bounded fix-cycle brief on red naming failing job, step/test, and exact error on the same PR", async () => {
    const item = makeItem();
    const checks: PrCheckResult[] = [
      { name: "Unit Tests", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Coverage", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Container Build", status: "COMPLETED", conclusion: "SUCCESS" },
      {
        name: "Playwright",
        status: "COMPLETED",
        conclusion: "FAILURE",
        failingStep: "board smoke test",
        error: "Expected #status-badge to be visible, timed out after 5000ms",
      },
      { name: "Typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
    ];

    const brief = composeFixCycleBrief(item, {
      headSha: "sha-red1",
      failingJob: "Playwright",
      failingStep: "board smoke test",
      error: "Expected #status-badge to be visible, timed out after 5000ms",
    });

    assert.ok(brief.includes("Playwright"));
    assert.ok(brief.includes("board smoke test"));
    assert.ok(brief.includes("Expected #status-badge to be visible, timed out after 5000ms"));
    assert.ok(brief.includes("feature/flow-monitor"));
    assert.ok(brief.includes("PR #124"));
    assert.match(brief, /same PR/i);

    const issuedCalls: Array<{ item: FlowMonitorBoardItem; brief: string }> = [];
    const result = await monitorPrToConclusion({
      item,
      stage2Enabled: true,
      pollChecks: async () => ({ headSha: "sha-red1", checks }),
      issueThread: async (params) => {
        issuedCalls.push(params);
        return { threadId: "thread-fix-1" };
      },
      log: () => {},
    });

    assert.equal(result.action, "fix-cycle-issued");
    assert.equal(result.verdict.status, "red");
    assert.equal(issuedCalls.length, 1);
    assert.equal(issuedCalls[0].item, item);
    assert.ok(issuedCalls[0].brief.includes("Playwright"));
  });

  it("escalates to needs-attention on second red with same root cause and never parks", async () => {
    const item = makeItem({
      previousFailure: {
        job: "Unit Tests",
        error: "TypeError: Cannot read properties of undefined (reading 'headSha')",
        attemptedFix: "Added null guard in evaluatePrChecks",
      },
    });
    const checks: PrCheckResult[] = [
      {
        name: "Unit Tests",
        status: "COMPLETED",
        conclusion: "FAILURE",
        failingStep: "flowMonitor.test.ts",
        error: "TypeError: Cannot read properties of undefined (reading 'headSha')",
      },
      { name: "Coverage", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Container Build", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Playwright", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
    ];

    let issuedCount = 0;
    const result = await monitorPrToConclusion({
      item,
      stage2Enabled: true,
      pollChecks: async () => ({ headSha: "sha-red2", checks }),
      issueThread: async () => {
        issuedCount += 1;
        return { threadId: "thread-esc-1" };
      },
      log: () => {},
    });

    assert.equal(result.action, "needs-attention");
    assert.ok(result.escalation);
    assert.equal(result.escalation.failingJob, "Unit Tests");
    assert.ok(result.escalation.error.includes("Cannot read properties of undefined"));
    assert.equal(result.escalation.alreadyTried, "Added null guard in evaluatePrChecks");
    assert.match(result.escalation.strategy, /micro-steps/i);
    assert.doesNotMatch(JSON.stringify(result), /parked/i);
    assert.equal(issuedCount, 0);
  });

  it("in shadow mode (default OFF), logs the decision and issues NOTHING and changes NO board status", async () => {
    const item = makeItem();
    const checks: PrCheckResult[] = [
      {
        name: "Typecheck",
        status: "COMPLETED",
        conclusion: "FAILURE",
        failingStep: "tsc --noEmit",
        error: "TS2322: Type 'string' is not assignable to type 'number'",
      },
      { name: "Unit Tests", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Coverage", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Container Build", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Playwright", status: "COMPLETED", conclusion: "SUCCESS" },
    ];

    let issuedCount = 0;
    const logs: string[] = [];

    const result = await monitorPrToConclusion({
      item,
      pollChecks: async () => ({ headSha: "sha-shadow", checks }),
      issueThread: async () => {
        issuedCount += 1;
        return { threadId: "should-not-issue" };
      },
      log: (msg) => logs.push(msg),
    });

    assert.equal(result.action, "shadow");
    assert.equal(result.verdict.status, "red");
    assert.ok(result.brief?.includes("Typecheck"));
    assert.equal(issuedCount, 0);
    assert.ok(logs.length > 0);
    assert.equal(item.status, "pr-open");
  });
});
