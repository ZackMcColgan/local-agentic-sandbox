import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

describe("Sprint 12 Phase 9 — Worker CI Feedback Loop (workerCiFeedback.test.ts)", () => {
  it("queries check runs, waits through pending, and marks task completed when CI passes", async () => {
    const { WorkerCiFeedbackLoop } = await import("../lib/ci/workerCiFeedback.js");

    let pollCount = 0;
    const loop = new WorkerCiFeedbackLoop({
      checkRunsFetcher: async () => {
        pollCount++;
        if (pollCount === 1) {
          return {
            state: "running",
            actionsUrl: "https://github.com/ZackMcColgan/local-agentic-sandbox/actions/runs/1001"
          };
        }
        return {
          state: "passed",
          actionsUrl: "https://github.com/ZackMcColgan/local-agentic-sandbox/actions/runs/1001"
        };
      },
      pollIntervalMs: 5
    });

    const outcome = await loop.evaluateAndHealCi({
      taskId: "task-ci-pass",
      branchName: "feature/weather-ui",
      milestones: [
        { id: "M1", title: "Implement UI", status: "completed" }
      ],
      fixExecutor: async () => ({ fixed: true, commitSha: "sha-fix" })
    });

    assert.equal(outcome.finalStatus, "completed");
    assert.equal(outcome.ciState, "passed");
    assert.equal(outcome.fixAttempts, 0);
    assert.equal(pollCount, 2);
  });

  it("extracts failing test from CI logs and creates 'Fix CI failure in <test>' milestone", async () => {
    const {
      WorkerCiFeedbackLoop,
      extractFailingTestFromCiLog
    } = await import("../lib/ci/workerCiFeedback.js");

    const sampleLog = `
      TAP version 13
      not ok 1 - tests/weatherApi.test.ts
      Error: Expected 200 but got 500
    `;
    const failingTarget = extractFailingTestFromCiLog(sampleLog);
    assert.equal(failingTarget, "tests/weatherApi.test.ts");

    let attempt = 0;
    const loop = new WorkerCiFeedbackLoop({
      checkRunsFetcher: async () => {
        attempt++;
        if (attempt === 1) {
          return {
            state: "failed",
            actionsUrl: "https://github.com/ZackMcColgan/local-agentic-sandbox/actions/runs/1002",
            logExcerpt: sampleLog
          };
        }
        return {
          state: "passed",
          actionsUrl: "https://github.com/ZackMcColgan/local-agentic-sandbox/actions/runs/1003"
        };
      },
      pollIntervalMs: 5
    });

    const milestones = [{ id: "M1", title: "Initial build", status: "completed" as const }];
    const outcome = await loop.evaluateAndHealCi({
      taskId: "task-ci-heal",
      branchName: "feature/weather-api",
      milestones,
      fixExecutor: async (milestoneTitle) => {
        assert.equal(milestoneTitle, "Fix CI failure in tests/weatherApi.test.ts");
        return { fixed: true, commitSha: "sha-fixed-1" };
      }
    });

    assert.equal(outcome.finalStatus, "completed");
    assert.equal(outcome.fixAttempts, 1);
    assert.ok(
      outcome.milestones.some((m) => m.title === "Fix CI failure in tests/weatherApi.test.ts"),
      "Must append 'Fix CI failure in <test>' milestone"
    );
  });

  it("parks task with clear reason after 3 consecutive CI failures", async () => {
    const { WorkerCiFeedbackLoop } = await import("../lib/ci/workerCiFeedback.js");

    const loop = new WorkerCiFeedbackLoop({
      checkRunsFetcher: async () => ({
        state: "failed",
        actionsUrl: "https://github.com/ZackMcColgan/local-agentic-sandbox/actions/runs/1004",
        logExcerpt: "FAIL tests/brokenModule.test.ts: AssertionError"
      }),
      pollIntervalMs: 5,
      maxFixAttempts: 3
    });

    const outcome = await loop.evaluateAndHealCi({
      taskId: "task-ci-park",
      branchName: "feature/broken",
      milestones: [{ id: "M1", title: "Build module", status: "completed" }],
      fixExecutor: async () => ({ fixed: true, commitSha: "sha-try" })
    });

    assert.equal(outcome.finalStatus, "parked");
    assert.equal(outcome.fixAttempts, 3);
    assert.ok(
      outcome.parkedReason?.includes("3"),
      "Parked reason must mention max 3 CI fix attempts"
    );
  });

  it("renders CI status badge and clickable GitHub Actions link in LiveRunBlock", async () => {
    const { LiveRunBlock } = await import("../components/LiveRunBlock.js");

    const html = renderToStaticMarkup(
      React.createElement(LiveRunBlock, {
        task: {
          taskId: "task-ci-ui",
          goal: "Verify CI badge",
          toolchain: "node:22",
          branchName: "feature/ci-ui",
          status: "parked",
          milestones: [],
          currentMilestoneIndex: 0,
          checkpoints: [],
          ambiguityFlags: [],
          journal: [],
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ciStatus: {
            state: "failed",
            actionsUrl: "https://github.com/ZackMcColgan/local-agentic-sandbox/actions/runs/999",
            failingStep: "tests/brokenModule.test.ts",
            summary: "Fix CI failure in tests/brokenModule.test.ts"
          }
        }
      })
    );

    assert.ok(html.includes("https://github.com/ZackMcColgan/local-agentic-sandbox/actions/runs/999"));
    assert.ok(html.includes("tests/brokenModule.test.ts"));
  });
});
