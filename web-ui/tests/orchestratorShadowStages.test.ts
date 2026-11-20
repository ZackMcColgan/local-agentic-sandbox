import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  BoardOrchestrator,
  type JobExecutionOutcome,
} from "../lib/board/boardOrchestrator";
import type { DispatcherBoardItem } from "../lib/board/dispatcher";
import type { BoardControlRecord } from "../lib/board/boardControlStore";
import {
  AgreementLedgerStore,
} from "../lib/board/agreementLedger";
import {
  isReviewerGateStage3Enabled,
  type MechanicalCheckInput,
} from "../lib/board/reviewerGate";
import {
  isSelfDeployVerifiedEnabled,
  runSelfDeployVerified,
  type SelfDeployVerifiedDeps,
} from "../lib/deploy/selfDeployVerified";
import { POST as postReviewerAudit } from "../app/api/board/reviewer-audit/route";

function makeTempBoardDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "item9-shadow-"));
}

function makeItem(overrides: Partial<DispatcherBoardItem> = {}): DispatcherBoardItem {
  return {
    id: "item-9",
    key: "#9",
    title: "Shadow stage wiring",
    brief: "Wire shadow lifecycle stages into board orchestrator.",
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

function makeCleanMechanicalInput(): MechanicalCheckInput {
  return {
    diff: [
      "diff --git a/web-ui/lib/board/boardOrchestrator.ts b/web-ui/lib/board/boardOrchestrator.ts",
      "--- a/web-ui/lib/board/boardOrchestrator.ts",
      "+++ b/web-ui/lib/board/boardOrchestrator.ts",
      "@@ -1,1 +1,2 @@",
      " export const ok = true;",
      "+export const shadow = true;",
    ].join("\n"),
    allowlist: ["web-ui/lib/board/boardOrchestrator.ts"],
    commitSubjects: ["feat(board): wire shadow lifecycle stages"],
    branchName: "feature/orchestrator-shadow-stages",
  };
}

test("stage flags default to OFF when unset or non-true", () => {
  assert.equal(isReviewerGateStage3Enabled(undefined, {}), false);
  assert.equal(isReviewerGateStage3Enabled(undefined, { BOARD_STAGE_REVIEWER_GATE: "false" }), false);
  assert.equal(isReviewerGateStage3Enabled(undefined, { BOARD_STAGE_REVIEWER_GATE: "1" }), false);
  assert.equal(isReviewerGateStage3Enabled(undefined, { BOARD_STAGE_REVIEWER_GATE: "true" }), true);

  assert.equal(isSelfDeployVerifiedEnabled(undefined, {}), false);
  assert.equal(isSelfDeployVerifiedEnabled(undefined, { BOARD_STAGE_SELF_DEPLOY: "false" }), false);
  assert.equal(isSelfDeployVerifiedEnabled(undefined, { BOARD_STAGE_SELF_DEPLOY: "yes" }), false);
  assert.equal(isSelfDeployVerifiedEnabled(undefined, { BOARD_STAGE_SELF_DEPLOY: "true" }), true);
});

test("1. PR opened triggers shadow monitorPrToConclusion: logs CI state and never merges or mutates PR when stage is off", async () => {
  const boardDir = makeTempBoardDir();
  const logs: string[] = [];
  let issueThreadCalled = 0;
  let pollCount = 0;

  try {
    const item = makeItem({ id: "item-pr-1", key: "#101", title: "Shadow flow monitor" });
    const orchestrator = new BoardOrchestrator({
      boardDir,
      items: [item],
      getControlState: () => makeControl(),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      log: (msg) => logs.push(msg),
      issueAndWait: async (): Promise<JobExecutionOutcome> => ({
        status: "completed",
        threadId: "t-pr-1",
        summary: "Opened PR #101",
        prNumber: 101,
        headSha: "sha-pr-101",
      }),
      flowMonitor: {
        pollChecks: async () => {
          pollCount += 1;
          return {
            headSha: "sha-pr-101",
            checks: [
              { name: "Unit Tests", status: "COMPLETED", conclusion: "SUCCESS" },
              { name: "Coverage", status: "COMPLETED", conclusion: "SUCCESS" },
              { name: "Container Build", status: "COMPLETED", conclusion: "SUCCESS" },
              { name: "Playwright", status: "COMPLETED", conclusion: "SUCCESS" },
              { name: "Typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
            ],
          };
        },
        issueThread: async () => {
          issueThreadCalled += 1;
          return { threadId: "should-not-run" };
        },
      },
    });

    const report = await orchestrator.drain();
    assert.equal(pollCount, 1);
    assert.equal(issueThreadCalled, 0, "must never issue fix-cycle or mutate PR while stage is off");
    assert.equal(report.outcomes.length, 1);
    assert.equal(report.outcomes[0].shadowStages?.flowMonitor?.action, "shadow");
    assert.equal(report.outcomes[0].shadowStages?.flowMonitor?.verdict.status, "green");
    assert.ok(logs.some((l) => l.includes("[flow-monitor] shadow")));
  } finally {
    fs.rmSync(boardDir, { recursive: true, force: true });
  }
});

test("2. PR opened triggers evaluateReviewerGate in shadow mode with mergeAuthorized: false and records shadow ledger entry", async () => {
  const boardDir = makeTempBoardDir();
  const logs: string[] = [];

  try {
    const item = makeItem({ id: "item-pr-2", key: "#102", title: "Shadow reviewer gate" });
    const orchestrator = new BoardOrchestrator({
      boardDir,
      items: [item],
      getControlState: () => makeControl(),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      log: (msg) => logs.push(msg),
      issueAndWait: async (): Promise<JobExecutionOutcome> => ({
        status: "completed",
        threadId: "t-pr-2",
        summary: "Opened PR #102",
        prNumber: 102,
        headSha: "sha-pr-102",
      }),
      reviewerGate: {
        getMechanicalInput: () => makeCleanMechanicalInput(),
        issueReviewerThread: async () => ({
          threadId: "rev-thread-102",
          verdict: "PASS",
          evidence: ["All behavioral checks passed."],
        }),
      },
    });

    const report = await orchestrator.drain();
    const gateResult = report.outcomes[0].shadowStages?.reviewerGate;
    assert.ok(gateResult, "reviewerGate shadow result must be recorded");
    assert.equal(gateResult.verdict, "PASS");
    assert.equal(gateResult.shadowMode, true);
    assert.equal(gateResult.mergeAuthorized, false);

    const ledgerStore = new AgreementLedgerStore(boardDir);
    const ledger = ledgerStore.read();
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].prNumber, 102);
    assert.equal(ledger.entries[0].headSha, "sha-pr-102");
    assert.equal(ledger.entries[0].reviewerVerdict, "PASS");
    assert.equal(ledger.entries[0].driverVerdict, null);
    assert.equal(ledger.entries[0].agreed, null);
  } finally {
    fs.rmSync(boardDir, { recursive: true, force: true });
  }
});

test("3. POST /api/board/reviewer-audit persists agreement ledger, tracks escapes, and enforces stage3Eligible boundaries", async () => {
  const boardDir = makeTempBoardDir();
  const prevBoardDir = process.env.BOARD_DIR;
  process.env.BOARD_DIR = boardDir;

  try {
    const store = new AgreementLedgerStore(boardDir);

    // Reject unknown PR with 404
    const missingRes = await postReviewerAudit(
      new NextRequest("http://localhost/api/board/reviewer-audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pr: 999, driverVerdict: "PASS" }),
      })
    );
    assert.equal(missingRes.status, 404);

    // Reject malformed verdict with 400
    store.recordShadowVerdict({ prNumber: 1, headSha: "sha-1", reviewerVerdict: "PASS" });
    const badVerdictRes = await postReviewerAudit(
      new NextRequest("http://localhost/api/board/reviewer-audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pr: 1, driverVerdict: "APPROVE" }),
      })
    );
    assert.equal(badVerdictRes.status, 400);

    // Record 9 agreeing PRs -> stage3Eligible must remain false
    for (let pr = 1; pr <= 9; pr += 1) {
      store.recordShadowVerdict({ prNumber: pr, headSha: `sha-${pr}`, reviewerVerdict: "PASS" });
      const res = await postReviewerAudit(
        new NextRequest("http://localhost/api/board/reviewer-audit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pr, headSha: `sha-${pr}`, driverVerdict: "PASS" }),
        })
      );
      assert.equal(res.status, 200);
      const payload = (await res.json()) as {
        ledger: { totalPrs: number; agreementRate: number; escapes: unknown[]; stage3Eligible: boolean };
      };
      assert.equal(payload.ledger.totalPrs, pr);
      assert.equal(payload.ledger.stage3Eligible, false, `9 PRs boundary: pr=${pr} must not be eligible`);
    }

    // 10th PR with an escape (reviewer PASS, driver FAIL) -> lands in escapes, stage3Eligible = false
    store.recordShadowVerdict({ prNumber: 10, headSha: "sha-10", reviewerVerdict: "PASS" });
    const escapeRes = await postReviewerAudit(
      new NextRequest("http://localhost/api/board/reviewer-audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pr: 10,
          headSha: "sha-10",
          driverVerdict: "FAIL",
          reason: "Missed regression in edge case",
        }),
      })
    );
    assert.equal(escapeRes.status, 200);
    const escapePayload = (await escapeRes.json()) as {
      ledger: {
        totalPrs: number;
        agreementRate: number;
        escapes: Array<{ prNumber: number; reviewerVerdict: string; driverVerdict: string }>;
        stage3Eligible: boolean;
      };
    };
    assert.equal(escapePayload.ledger.totalPrs, 10);
    assert.equal(escapePayload.ledger.escapes.length, 1);
    assert.equal(escapePayload.ledger.escapes[0].prNumber, 10);
    assert.equal(escapePayload.ledger.stage3Eligible, false, "10 PRs with an escape must NOT be eligible");

    // Clean ledger with 10 PRs, >=95% agreement, 0 escapes -> stage3Eligible flips true
    const cleanDir = makeTempBoardDir();
    process.env.BOARD_DIR = cleanDir;
    try {
      const cleanStore = new AgreementLedgerStore(cleanDir);
      for (let pr = 1; pr <= 10; pr += 1) {
        cleanStore.recordShadowVerdict({ prNumber: pr, headSha: `clean-${pr}`, reviewerVerdict: "PASS" });
        const res = await postReviewerAudit(
          new NextRequest("http://localhost/api/board/reviewer-audit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pr, driverVerdict: "PASS" }),
          })
        );
        assert.equal(res.status, 200);
      }
      const finalLedger = cleanStore.read();
      assert.equal(finalLedger.totalPrs, 10);
      assert.equal(finalLedger.agreementRate, 1);
      assert.equal(finalLedger.escapes.length, 0);
      assert.equal(finalLedger.stage3Eligible, true);
      assert.ok(fs.existsSync(path.join(cleanDir, "reviewer-agreement-ledger.json")));
    } finally {
      fs.rmSync(cleanDir, { recursive: true, force: true });
    }
  } finally {
    if (prevBoardDir === undefined) {
      delete process.env.BOARD_DIR;
    } else {
      process.env.BOARD_DIR = prevBoardDir;
    }
    fs.rmSync(boardDir, { recursive: true, force: true });
  }
});

test("4. runSelfDeployVerified with stage OFF returns shadow_prepared and never invokes deploy pipeline", async () => {
  const boardDir = makeTempBoardDir();
  const executedSteps: string[] = [];

  const spyDeps: SelfDeployVerifiedDeps = {
    readCurrentState: async () => ({
      image: "local-agentic-sandbox:v1.0.0",
      podStatus: "Running",
      podRestarts: 0,
    }),
    bankRollbackTarget: async (tag) => ({ banked: true, tag }),
    buildAndImport: async (tag, dryRun) => {
      if (!dryRun) {
        executedSteps.push(`buildAndImport:${tag}`);
      }
      return {
        built: !dryRun,
        imported: !dryRun,
        imagePresentInNode: !dryRun,
        detail: dryRun ? "shadow preparation only" : "executed",
      };
    },
    setImage: async (tag) => {
      executedSteps.push(`setImage:${tag}`);
      return { ok: true };
    },
    verifyDeployment: async (tag) => {
      executedSteps.push(`verifyDeployment:${tag}`);
      return {
        ok: true,
        rolloutSuccess: true,
        podRunningZeroRestarts: true,
        gatewayStatus: 200,
        threadListLoads: true,
        observedTag: tag,
      };
    },
  };

  try {
    // Direct check
    const direct = await runSelfDeployVerified(
      { targetTag: "local-agentic-sandbox:v1.1.0", developSha: "0ce7103" },
      spyDeps
    );
    assert.equal(direct.mode, "shadow");
    assert.equal(direct.status, "shadow_prepared");
    assert.deepEqual(executedSteps, [], "no deploy step may execute when stage is OFF");

    // Orchestrator merged-state wiring check
    const item = makeItem({ id: "item-merged-1", key: "#103", title: "Merged item" });
    const orchestrator = new BoardOrchestrator({
      boardDir,
      items: [item],
      getControlState: () => makeControl(),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      issueAndWait: async (): Promise<JobExecutionOutcome> => ({
        status: "completed",
        threadId: "t-merged-1",
        summary: "Merged PR #103",
        merged: true,
        mergeSha: "0ce7103",
        deployTag: "local-agentic-sandbox:v1.1.0",
      }),
      selfDeploy: {
        deps: spyDeps,
      },
    });

    const report = await orchestrator.drain();
    const deployResult = report.outcomes[0].shadowStages?.selfDeploy;
    assert.ok(deployResult, "selfDeploy shadow result must be recorded on merged item");
    assert.equal(deployResult.mode, "shadow");
    assert.equal(deployResult.status, "shadow_prepared");
    assert.deepEqual(executedSteps, [], "orchestrator must never invoke deploy steps when stage is OFF");
  } finally {
    fs.rmSync(boardDir, { recursive: true, force: true });
  }
});
