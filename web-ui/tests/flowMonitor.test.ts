import { describe, it, expect, vi } from "vitest";
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
    prNumber: 124,
    branch: "feature/flow-monitor",
    worktreePath: "C:\\Users\\zackm\\Desktop\\repos\\flowmonitor-wt",
    ...overrides,
  };
}

function allFiveGreenChecks(): PrCheckResult[] {
  return [
    { name: "Unit Tests", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "Coverage", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "Container Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "Playwright", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "Typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
  ];
}

describe("flow-monitor", () => {
  it("defaults stage 2 flag to OFF (shadow mode)", () => {
    expect(FLOW_MONITOR_STAGE2_DEFAULT).toBe(false);
    expect(isFlowMonitorStage2Enabled(undefined, {})).toBe(false);
    expect(isFlowMonitorStage2Enabled(undefined, { FLOW_MONITOR_STAGE2: "false" })).toBe(false);
    expect(isFlowMonitorStage2Enabled(undefined, { FLOW_MONITOR_STAGE2: "true" })).toBe(true);
    expect(isFlowMonitorStage2Enabled(true, { FLOW_MONITOR_STAGE2: "false" })).toBe(true);
  });

  it("returns green verdict only when ALL FIVE checks pass on the PR head SHA, and voids on head change", () => {
    const verdict = evaluatePrChecks("sha-abc123", allFiveGreenChecks());
    expect(verdict.status).toBe("green");
    expect(verdict.headSha).toBe("sha-abc123");
    expect(isVerdictValidForHead(verdict, "sha-abc123")).toBe(true);
    expect(isVerdictValidForHead(verdict, "sha-def456")).toBe(false);

    // Missing Typecheck -> not green
    const missingTypecheck = allFiveGreenChecks().filter((c) => c.name !== "Typecheck");
    const incompleteVerdict = evaluatePrChecks("sha-abc123", missingTypecheck);
    expect(incompleteVerdict.status).toBe("running");
  });

  it("reports a PR whose checks are still running as running, never green or red", () => {
    const checks: PrCheckResult[] = [
      { name: "Unit Tests", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Coverage", status: "IN_PROGRESS", conclusion: null },
      { name: "Container Build", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Playwright", status: "QUEUED", conclusion: null },
      { name: "Typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
    ];
    const verdict = evaluatePrChecks("sha-running", checks);
    expect(verdict.status).toBe("running");
    expect(verdict.headSha).toBe("sha-running");
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

    expect(brief).toContain("Playwright");
    expect(brief).toContain("board smoke test");
    expect(brief).toContain("Expected #status-badge to be visible, timed out after 5000ms");
    expect(brief).toContain("feature/flow-monitor");
    expect(brief).toContain("PR #124");
    expect(brief).toMatch(/same PR/i);

    const issueThread = vi.fn().mockResolvedValue({ threadId: "thread-fix-1" });
    const result = await monitorPrToConclusion({
      item,
      stage2Enabled: true,
      pollChecks: vi.fn().mockResolvedValue({ headSha: "sha-red1", checks }),
      issueThread,
      log: vi.fn(),
    });

    expect(result.action).toBe("fix-cycle-issued");
    expect(result.verdict.status).toBe("red");
    expect(issueThread).toHaveBeenCalledTimes(1);
    expect(issueThread).toHaveBeenCalledWith({
      item,
      brief: expect.stringContaining("Playwright"),
    });
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

    const issueThread = vi.fn().mockResolvedValue({ threadId: "thread-esc-1" });
    const result = await monitorPrToConclusion({
      item,
      stage2Enabled: true,
      pollChecks: vi.fn().mockResolvedValue({ headSha: "sha-red2", checks }),
      issueThread,
      log: vi.fn(),
    });

    expect(result.action).toBe("needs-attention");
    expect(result.escalation).toBeDefined();
    expect(result.escalation?.failingJob).toBe("Unit Tests");
    expect(result.escalation?.error).toContain("Cannot read properties of undefined");
    expect(result.escalation?.alreadyTried).toBe("Added null guard in evaluatePrChecks");
    expect(result.escalation?.strategy).toMatch(/micro-steps/i);
    expect(JSON.stringify(result)).not.toMatch(/parked/i);
    expect(issueThread).not.toHaveBeenCalled();
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

    const issueThread = vi.fn();
    const log = vi.fn();

    const result = await monitorPrToConclusion({
      item,
      pollChecks: vi.fn().mockResolvedValue({ headSha: "sha-shadow", checks }),
      issueThread,
      log,
    });

    expect(result.action).toBe("shadow");
    expect(result.verdict.status).toBe("red");
    expect(result.brief).toContain("Typecheck");
    expect(issueThread).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    expect(item.status).toBe("pr-open");
  });
});
