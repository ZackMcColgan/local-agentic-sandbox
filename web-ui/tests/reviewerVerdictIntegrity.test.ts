import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  AgreementLedgerStore,
  getAgreementLedgerStore,
  isValidGateVerdict,
} from "../lib/board/agreementLedger";
import { evaluateReviewerGate, parseReviewerVerdictContent } from "../lib/board/reviewerGate";
import {
  createProductionStageDeps,
  type HostBridgeExecutor,
  type StageThreadStore,
} from "../lib/board/productionStageDeps";
import { withMockReviewerEvaluateDeps } from "../lib/board/reviewerAuditEvaluate";
import { postReviewerAudit } from "../app/api/board/reviewer-audit/route";
import type { Thread } from "../lib/threads/threadStore";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeCleanInput() {
  return {
    diff: [
      "diff --git a/web-ui/lib/foo.ts b/web-ui/lib/foo.ts",
      "index 1111111..2222222 100644",
      "--- a/web-ui/lib/foo.ts",
      "+++ b/web-ui/lib/foo.ts",
      "@@ -1,1 +1,2 @@",
      " export const foo = 1;",
      "+export const bar = 2;",
    ].join("\n"),
    allowlist: ["web-ui/lib/foo.ts"],
    commitSubjects: ["feat: add bar"],
    branchName: "feature/item-137-verdict-integrity",
  };
}

function makeStubThreadStore() {
  const threads = new Map<string, Thread>();
  let seq = 0;
  const store: StageThreadStore = {
    createThread: (input) => {
      const id = `thread-stub-${(seq += 1)}`;
      const record = {
        id,
        title: input.title,
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
        toolCalls: [],
        tokenUsage: { input: 0, output: 0, total: 0 },
        model: "stub",
        tags: [],
        pinned: false,
        archived: false,
        lastVerifiedAt: null,
        verificationOutcome: null,
        handoffSummary: null,
        handoffTimestamp: null,
        handoffOutcome: null,
        handoffNextStep: null,
        handoffOpenQuestions: [],
        handoffAttempt: 1,
        handoffPreviousThreadId: null,
        handoffMemory: [],
        parentThreadId: null,
        subagentMode: null,
        goal: null,
        phase: null,
        phaseHistory: [],
        budget: null,
        consumedTokens: 0,
        toolPolicy: null,
      } as unknown as Thread;
      threads.set(id, record);
      return record;
    },
    getThread: (id) => threads.get(id) ?? null,
  };
  return { store, threads };
}

const noopBridge: HostBridgeExecutor = async () => ({
  ok: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
});

describe("#137 reviewer-gate verdict integrity — ledger records only concluded verdicts", () => {
  it("(a) explicit PASS from a completed turn records PASS", () => {
    const dir = makeTempDir("item137-pass-");
    const store = new AgreementLedgerStore(dir);
    store.recordShadowVerdict({
      prNumber: 279,
      headSha: "aaaa1111",
      driverVerdict: "PASS",
      reviewerVerdict: "PASS",
      turnState: "completed",
      reason: "defect-by-defect audit concluded PASS",
    });
    const entry = store.read().entries[0];
    assert.equal(entry.reviewerVerdict, "PASS");
    assert.equal(entry.turnState, "completed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(b) explicit FAIL from a completed turn records FAIL", () => {
    const dir = makeTempDir("item137-fail-");
    const store = new AgreementLedgerStore(dir);
    store.recordShadowVerdict({
      prNumber: 279,
      headSha: "aaaa1111",
      driverVerdict: "PASS",
      reviewerVerdict: "FAIL",
      turnState: "completed",
    });
    const entry = store.read().entries[0];
    assert.equal(entry.reviewerVerdict, "FAIL");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(c) interrupted / empty / unparseable / timeout turns record NO_VERDICT, never FAIL", () => {
    const dir = makeTempDir("item137-abstain-");
    const store = new AgreementLedgerStore(dir);
    for (const turnState of ["interrupted", "empty", "unparseable", "timeout"] as const) {
      store.recordShadowVerdict({
        prNumber: 280,
        headSha: `head-${turnState}`,
        driverVerdict: "PASS",
        reviewerVerdict: "NO_VERDICT",
        turnState,
        reason: `reviewer turn ended ${turnState}; no verdict token emitted`,
      });
    }
    const entries = store.read().entries;
    assert.equal(entries.length, 4);
    for (const e of entries) {
      assert.equal(e.reviewerVerdict, "NO_VERDICT", `${e.headSha} must abstain`);
      assert.equal(e.turnState, turnStateFor(e.headSha));
    }
    assert.ok(!entries.some((e) => e.reviewerVerdict === "FAIL"), "abstain must never record FAIL");

    // Agreement stats exclude abstentions from the agreement-rate denominator.
    store.recordDriverVerdict({
      prNumber: 281,
      headSha: "bbbb2222",
      driverVerdict: "PASS",
      reason: "driver agrees",
    });
    const ledger = store.read();
    assert.equal(ledger.entries.length, 5);
    assert.equal(ledger.totalPrs, 1, "abstained entries must not count toward the agreement rate");
    assert.equal(ledger.agreements, 1);
    assert.equal(ledger.agreementRate, 1, "abstentions must not poison the agreement rate");
    assert.equal(
      ledger.entries.filter((e) => e.reviewerVerdict === "NO_VERDICT").length,
      3,
      "abstentions remain visible on the ledger with turn state"
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(d) a later completed turn supersedes an earlier verdict-less record for the same PR+head", () => {
    const dir = makeTempDir("item137-supersede-");
    const store = new AgreementLedgerStore(dir);
    store.recordShadowVerdict({
      prNumber: 280,
      headSha: "6cdf4010",
      driverVerdict: "PASS",
      reviewerVerdict: "NO_VERDICT",
      turnState: "interrupted",
      reason: "interrupted mid-report; audit table all pass, no verdict line",
    });
    store.recordShadowVerdict({
      prNumber: 280,
      headSha: "6cdf4010",
      driverVerdict: "PASS",
      reviewerVerdict: "PASS",
      turnState: "completed",
      reason: "completed reviewer turn concluded PASS",
    });
    const entries = store.read().entries.filter((e) => e.prNumber === 280 && e.headSha === "6cdf4010");
    assert.equal(entries.length, 1, "same PR+head must hold exactly one entry");
    assert.equal(entries[0].reviewerVerdict, "PASS");
    assert.equal(entries[0].turnState, "completed");

    // An earlier explicit verdict is NOT overwritten by a later verdict-less turn.
    store.recordShadowVerdict({
      prNumber: 279,
      headSha: "eed88c55",
      driverVerdict: "PASS",
      reviewerVerdict: "PASS",
      turnState: "completed",
    });
    store.recordShadowVerdict({
      prNumber: 279,
      headSha: "eed88c55",
      driverVerdict: "PASS",
      reviewerVerdict: "NO_VERDICT",
      turnState: "empty",
    });
    const pr279 = store.read().entries.filter((e) => e.prNumber === 279 && e.headSha === "eed88c55");
    assert.equal(pr279.length, 1);
    assert.equal(pr279[0].reviewerVerdict, "PASS", "completed verdict must survive a later abstain");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function turnStateFor(headSha: string): string {
    return headSha.replace("head-", "");
  }

  it("isValidGateVerdict accepts NO_VERDICT", () => {
    assert.equal(isValidGateVerdict("NO_VERDICT"), true);
    assert.equal(isValidGateVerdict("MAYBE"), false);
  });

  it("parseReviewerVerdictContent abstains on empty and unparseable content with turn state", () => {
    assert.deepEqual(parseReviewerVerdictContent("VERDICT: PASS\nok"), {
      verdict: "PASS",
      evidence: ["ok"],
      turnState: "completed",
    });
    assert.deepEqual(parseReviewerVerdictContent("VERDICT: FAIL\nno"), {
      verdict: "FAIL",
      evidence: ["no"],
      turnState: "completed",
    });
    assert.deepEqual(parseReviewerVerdictContent(""), {
      verdict: "NO_VERDICT",
      evidence: ["reviewer turn produced no assistant content"],
      turnState: "empty",
    });
    assert.deepEqual(parseReviewerVerdictContent("Looks mostly okay, maybe ship it?"), {
      verdict: "NO_VERDICT",
      evidence: ["reviewer verdict unparseable: no explicit VERDICT: PASS/FAIL token"],
      turnState: "unparseable",
    });
  });

  it("issueReviewerThread abstains (never FAIL) on empty, unparseable, stopped-interrupted, and timed-out turns", async () => {
    // Empty final assistant message
    {
      const { store, threads } = makeStubThreadStore();
      const deps = createProductionStageDeps({
        executeHostTool: noopBridge,
        threadStore: store,
        dispatchChatTurn: async ({ threadId }) => {
          const rec = threads.get(threadId)!;
          rec.status = "completed";
          rec.messages.push({
            id: "m-empty",
            role: "assistant",
            content: "",
            timestamp: new Date().toISOString(),
          });
          return { ok: true, status: 200 };
        },
        reviewerPollIntervalMs: 1,
        reviewerTimeoutMs: 500,
      });
      const res = await deps.reviewerGate.issueReviewerThread({ itemId: "i1", brief: "b" });
      assert.equal(res.verdict, "NO_VERDICT");
      assert.equal(res.turnState, "empty");
    }

    // Unparseable content
    {
      const { store, threads } = makeStubThreadStore();
      const deps = createProductionStageDeps({
        executeHostTool: noopBridge,
        threadStore: store,
        dispatchChatTurn: async ({ threadId }) => {
          const rec = threads.get(threadId)!;
          rec.status = "completed";
          rec.messages.push({
            id: "m-unparse",
            role: "assistant",
            content: "Looks mostly okay, maybe ship it?",
            timestamp: new Date().toISOString(),
          });
          return { ok: true, status: 200 };
        },
        reviewerPollIntervalMs: 1,
        reviewerTimeoutMs: 500,
      });
      const res = await deps.reviewerGate.issueReviewerThread({ itemId: "i2", brief: "b" });
      assert.equal(res.verdict, "NO_VERDICT");
      assert.equal(res.turnState, "unparseable");
    }

    // Stopped without assistant content -> interrupted
    {
      const { store, threads } = makeStubThreadStore();
      const deps = createProductionStageDeps({
        executeHostTool: noopBridge,
        threadStore: store,
        dispatchChatTurn: async ({ threadId }) => {
          const rec = threads.get(threadId)!;
          rec.status = "stopped";
          return { ok: true, status: 200 };
        },
        reviewerPollIntervalMs: 1,
        reviewerTimeoutMs: 500,
      });
      const res = await deps.reviewerGate.issueReviewerThread({ itemId: "i3", brief: "b" });
      assert.equal(res.verdict, "NO_VERDICT");
      assert.equal(res.turnState, "interrupted");
    }

    // Timeout -> abstain, not FAIL
    {
      const { store } = makeStubThreadStore();
      const deps = createProductionStageDeps({
        executeHostTool: noopBridge,
        threadStore: store,
        dispatchChatTurn: async () => ({ ok: true, status: 200 }),
        reviewerPollIntervalMs: 5,
        reviewerTimeoutMs: 20,
      });
      const res = await deps.reviewerGate.issueReviewerThread({ itemId: "i4", brief: "b" });
      assert.equal(res.verdict, "NO_VERDICT");
      assert.equal(res.turnState, "timeout");
    }
  });

  it("evaluateReviewerGate yields NO_VERDICT (abstain) when the reviewer turn concluded nothing", async () => {
    const result = await evaluateReviewerGate({
      itemId: "item-137",
      brief: "Implement verdict integrity",
      mechanicalInput: makeCleanInput(),
      issueReviewerThread: async () => ({
        threadId: "rev-abstain",
        verdict: "NO_VERDICT",
        evidence: ["reviewer turn ended interrupted"],
        turnState: "interrupted",
      }),
    });
    assert.equal(result.verdict, "NO_VERDICT");
    assert.equal(result.reviewer.verdict, "NO_VERDICT");
    assert.equal(result.mergeAuthorized, false);
  });

  it("evaluateReviewerGate still FAILs on a mechanical failure even when the reviewer abstains", async () => {
    const banned = makeCleanInput();
    banned.diff = [
      "diff --git a/web-ui/lib/foo.ts b/web-ui/lib/foo.ts",
      "index 1111111..2222222 100644",
      "--- a/web-ui/lib/foo.ts",
      "+++ b/web-ui/lib/foo.ts",
      "@@ -1,1 +1,2 @@",
      "+process.env.API_TOKEN",
    ].join("\n");
    const result = await evaluateReviewerGate({
      itemId: "item-137b",
      brief: "b",
      mechanicalInput: banned,
      issueReviewerThread: async () => ({
        threadId: "rev-abstain-2",
        verdict: "NO_VERDICT",
        evidence: [],
        turnState: "empty",
      }),
    });
    assert.equal(result.verdict, "FAIL");
  });

  it("reviewer-audit evaluate records NO_VERDICT with turn state when the reviewer turn abstains", async () => {
    const boardDir = makeTempDir("item137-route-abstain-");
    const prevBoardDir = process.env.BOARD_DIR;
    process.env.BOARD_DIR = boardDir;
    const mock = {
      getMechanicalInput: async () => makeCleanInput(),
      resolveHeadSha: async () => "deadbeef",
      issueReviewerThread: async () => ({
        threadId: "rev-route-abstain",
        verdict: "NO_VERDICT" as const,
        evidence: ["final assistant message empty"],
        turnState: "empty" as const,
      }),
    };
    try {
      await withMockReviewerEvaluateDeps(mock, async () => {
        const res = await postReviewerAudit(
          new Request("http://localhost/api/board/reviewer-audit", {
            method: "POST",
            body: JSON.stringify({ action: "evaluate", pr: 280, brief: "b" }),
            headers: { "content-type": "application/json" },
          })
        );
        assert.equal(res.status, 200);
        const payload = (await res.json()) as {
          verdict: string;
          entry: { reviewerVerdict: string; turnState?: string };
        };
        assert.equal(payload.verdict, "NO_VERDICT");
        assert.equal(payload.entry.reviewerVerdict, "NO_VERDICT");
        assert.equal(payload.entry.turnState, "empty");
        const ledger = getAgreementLedgerStore().read();
        assert.equal(ledger.entries[0].reviewerVerdict, "NO_VERDICT");
      });
    } finally {
      if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
      else process.env.BOARD_DIR = prevBoardDir;
      fs.rmSync(boardDir, { recursive: true, force: true });
    }
  });
});
