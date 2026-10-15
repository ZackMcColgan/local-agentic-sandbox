import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeLedgerRuns } from "../lib/ledger/ledgerStats.js";
import { RunLedgerEntry } from "../lib/ledger/runLedger.js";

describe("Sprint 6 — Ledger Telemetry Analytics Utility (ledgerStats.test.ts)", () => {
  it("returns zeroed summary for empty run list", () => {
    const summary = summarizeLedgerRuns([]);
    assert.deepEqual(summary, {
      totalRuns: 0,
      completedRuns: 0,
      failedOrParkedRuns: 0,
      successRatePct: 0,
      totalCommits: 0,
      averageDurationMs: 0
    });
  });

  it("calculates accurate summary across completed, failed, and parked runs with commits and duration", () => {
    const sampleRuns: RunLedgerEntry[] = [
      {
        runId: "run-1",
        threadId: "t-1",
        prompt: "Task 1",
        status: "completed",
        startedAt: "2026-10-14T10:00:00.000Z",
        updatedAt: "2026-10-14T10:02:00.000Z",
        completedAt: "2026-10-14T10:02:00.000Z", // 120,000 ms
        lastHeartbeatAt: "2026-10-14T10:02:00.000Z",
        model: "swift-15-27b-mtp",
        gitShas: ["abc1234", "def5678"],
        milestoneSummary: [],
        deploymentRef: "",
        resumable: false
      },
      {
        runId: "run-2",
        threadId: "t-2",
        prompt: "Task 2",
        status: "failed",
        startedAt: "2026-10-14T10:05:00.000Z",
        updatedAt: "2026-10-14T10:06:00.000Z",
        completedAt: "2026-10-14T10:06:00.000Z", // 60,000 ms
        lastHeartbeatAt: "2026-10-14T10:06:00.000Z",
        model: "swift-15-27b-mtp",
        gitShas: ["def5678"], // Duplicate sha across runs
        milestoneSummary: [],
        deploymentRef: "",
        resumable: true
      },
      {
        runId: "run-3",
        threadId: "t-3",
        prompt: "Task 3",
        status: "parked",
        startedAt: "2026-10-14T10:10:00.000Z",
        updatedAt: "2026-10-14T10:11:00.000Z",
        lastHeartbeatAt: "2026-10-14T10:11:00.000Z",
        model: "swift-15-27b-mtp",
        gitShas: ["ghi9012"],
        milestoneSummary: [],
        deploymentRef: "",
        resumable: true
      }
    ];

    const summary = summarizeLedgerRuns(sampleRuns);

    assert.equal(summary.totalRuns, 3);
    assert.equal(summary.completedRuns, 1);
    assert.equal(summary.failedOrParkedRuns, 2);
    // 1 / 3 = 33.3%
    assert.equal(summary.successRatePct, 33.3);
    // abc1234, def5678, ghi9012 => 3 unique
    assert.equal(summary.totalCommits, 3);
    // (120,000 + 60,000) / 2 = 90,000 ms
    assert.equal(summary.averageDurationMs, 90000);
  });
});
