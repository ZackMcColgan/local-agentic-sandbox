import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { AgreementLedgerStore } from "../lib/board/agreementLedger";
import { evaluatePrShadowVerdict } from "../lib/board/reviewerAuditEvaluate";
import { POST as postReviewerAudit } from "../app/api/board/reviewer-audit/route";

// Stage 0 measurement repair: the reviewer-audit route gains an "evaluate"
// action so operator-flowed PRs (built outside the drain) get a shadow verdict
// in the same ledger. No merge authority is granted; Stage 3 stays OFF.

interface MockReviewerEvaluateDeps {
  getMechanicalInput: (prNumber: number) => Promise<{
    diff: string;
    allowlist: string[];
    commitSubjects: string[];
    branchName: string;
  }>;
  resolveHeadSha: (prNumber: number) => Promise<string | null>;
  resolveHeadShaDetailed?: (
    prNumber: number
  ) => Promise<{ ok: true; headSha: string } | { ok: false; reason: string }>;
  issueReviewerThread: (params: { itemId: string; brief: string }) => Promise<{
    threadId: string;
    verdict: "PASS" | "FAIL";
    evidence: string[];
  }>;
}

function withMock(deps: MockReviewerEvaluateDeps | null, run: () => Promise<void>): Promise<void> {
  const g = globalThis as { __mockReviewerEvaluateDeps?: MockReviewerEvaluateDeps | null };
  const prev = g.__mockReviewerEvaluateDeps;
  g.__mockReviewerEvaluateDeps = deps ?? undefined;
  return run().finally(() => {
    if (prev === undefined) delete g.__mockReviewerEvaluateDeps;
    else g.__mockReviewerEvaluateDeps = prev;
  });
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/board/reviewer-audit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("evaluate action records a shadow ledger entry for a PR built outside the drain", async () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "item134-evaluate-"));
  const prevBoardDir = process.env.BOARD_DIR;
  process.env.BOARD_DIR = boardDir;
  const SHA = "b1b2b3b4b5b6b7b8b9b0c1c2c3c4c5c6c7c8c9d0";

  const dispatched: Array<{ itemId: string; brief: string }> = [];
  const mock: MockReviewerEvaluateDeps = {
    getMechanicalInput: async (prNumber) => ({
      diff: [
        `diff --git a/web-ui/lib/board/x.ts b/web-ui/lib/board/x.ts`,
        "--- a/web-ui/lib/board/x.ts",
        "+++ b/web-ui/lib/board/x.ts",
        "@@ -0,0 +1,1 @@",
        `+// PR ${prNumber} change`,
      ].join("\n"),
      allowlist: [],
      commitSubjects: ["feat(board): operator-flowed change"],
      branchName: "feature/operator-flowed",
    }),
    resolveHeadSha: async () => SHA,
    issueReviewerThread: async ({ itemId, brief }) => {
      dispatched.push({ itemId, brief });
      return { threadId: "rev-eval-1", verdict: "PASS", evidence: ["Diff satisfies brief."] };
    },
  };

  try {
    await withMock(mock, async () => {
      const res = await postReviewerAudit(
        makeRequest({ action: "evaluate", pr: 300, brief: "Review the operator-flowed PR." })
      );
      assert.equal(res.status, 200);
      const payload = (await res.json()) as {
        entry: { prNumber: number; headSha: string; reviewerVerdict: string };
        mergeAuthorized: boolean;
      };
      assert.equal(payload.entry.prNumber, 300);
      assert.equal(payload.entry.headSha, SHA);
      assert.equal(payload.entry.reviewerVerdict, "PASS");
      assert.equal(payload.mergeAuthorized, false, "evaluate grants NO merge authority");

      const ledger = new AgreementLedgerStore(boardDir).read();
      assert.equal(ledger.entries.length, 1);
      assert.equal(ledger.entries[0].prNumber, 300);
      assert.equal(ledger.entries[0].headSha, SHA);
      assert.equal(ledger.entries[0].reviewerVerdict, "PASS");
      assert.equal(ledger.entries[0].driverVerdict, null);
    });

    assert.equal(dispatched.length, 1);
    assert.ok(dispatched[0].brief.includes("Review the operator-flowed PR."));
    assert.ok(dispatched[0].brief.includes("PR 300 change"));
  } finally {
    if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
    else process.env.BOARD_DIR = prevBoardDir;
    fs.rmSync(boardDir, { recursive: true, force: true });
  }
});

test("evaluate action rejects a missing or non-integer pr with 400", async () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "item134-evaluate-400-"));
  const prevBoardDir = process.env.BOARD_DIR;
  process.env.BOARD_DIR = boardDir;

  const mock: MockReviewerEvaluateDeps = {
    getMechanicalInput: async () => ({
      diff: "",
      allowlist: [],
      commitSubjects: [],
      branchName: "",
    }),
    resolveHeadSha: async () => null,
    issueReviewerThread: async () => ({ threadId: "x", verdict: "PASS", evidence: [] }),
  };

  try {
    await withMock(mock, async () => {
      const missingRes = await postReviewerAudit(makeRequest({ action: "evaluate", brief: "b" }));
      assert.equal(missingRes.status, 400);

      const nonIntegerRes = await postReviewerAudit(
        makeRequest({ action: "evaluate", pr: 12.5, brief: "b" })
      );
      assert.equal(nonIntegerRes.status, 400);

      const stringPrRes = await postReviewerAudit(
        makeRequest({ action: "evaluate", pr: "300", brief: "b" })
      );
      assert.equal(stringPrRes.status, 400);

      const ledger = new AgreementLedgerStore(boardDir).read();
      assert.equal(ledger.entries.length, 0, "rejected requests must not touch the ledger");
    });
  } finally {
    if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
    else process.env.BOARD_DIR = prevBoardDir;
    fs.rmSync(boardDir, { recursive: true, force: true });
  }
});

test("evaluate action records the placeholder head SHA with a note when head resolution fails", async () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "item134-evaluate-fallback-"));
  const prevBoardDir = process.env.BOARD_DIR;
  process.env.BOARD_DIR = boardDir;

  const mock: MockReviewerEvaluateDeps = {
    getMechanicalInput: async () => ({
      diff: "diff --git a/x b/x\n+ok",
      allowlist: [],
      commitSubjects: [],
      branchName: "",
    }),
    resolveHeadSha: async () => null,
    issueReviewerThread: async () => ({
      threadId: "rev-eval-2",
      verdict: "FAIL",
      evidence: ["no"],
    }),
  };

  try {
    await withMock(mock, async () => {
      const res = await postReviewerAudit(makeRequest({ action: "evaluate", pr: 301, brief: "b" }));
      assert.equal(res.status, 200);
      const payload = (await res.json()) as {
        entry: { headSha: string; reason?: string };
      };
      assert.equal(payload.entry.headSha, "unknown-head");
      assert.ok(
        payload.entry.reason && /head sha/i.test(payload.entry.reason),
        "unresolved head SHA must be noted on the entry"
      );
    });
  } finally {
    if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
    else process.env.BOARD_DIR = prevBoardDir;
    fs.rmSync(boardDir, { recursive: true, force: true });
  }
});

test("evaluate action surfaces and logs specific head-SHA resolution failure reason", async () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "item134-evaluate-reason-"));
  const prevBoardDir = process.env.BOARD_DIR;
  process.env.BOARD_DIR = boardDir;

  const failureReason =
    "gh pr view 302 --json headRefOid failed (exit 1): fatal: not a git repository";
  const mock: MockReviewerEvaluateDeps = {
    getMechanicalInput: async () => ({
      diff: "diff --git a/x b/x\n+ok",
      allowlist: [],
      commitSubjects: [],
      branchName: "",
    }),
    resolveHeadSha: async () => null,
    resolveHeadShaDetailed: async () => ({ ok: false, reason: failureReason }),
    issueReviewerThread: async () => ({
      threadId: "rev-eval-3",
      verdict: "PASS",
      evidence: ["ok"],
    }),
  };

  try {
    await withMock(mock, async () => {
      const res = await postReviewerAudit(makeRequest({ action: "evaluate", pr: 302, brief: "b" }));
      assert.equal(res.status, 200);
      const payload = (await res.json()) as {
        headSha: string;
        headShaResolved: boolean;
        headShaError?: string;
        entry: { headSha: string; reason?: string };
      };
      assert.equal(payload.headSha, "unknown-head");
      assert.equal(payload.headShaResolved, false);
      assert.equal(payload.headShaError, failureReason);
      assert.ok(
        payload.entry.reason && payload.entry.reason.includes(failureReason),
        `ledger entry reason must carry specific resolution failure, got: ${payload.entry.reason}`
      );
    });

    const logs: string[] = [];
    const direct = await evaluatePrShadowVerdict(mock, {
      prNumber: 303,
      brief: "direct visibility check",
      log: (msg) => logs.push(msg),
    });
    assert.equal(direct.headShaResolved, false);
    assert.equal(direct.headShaError, failureReason);
    assert.ok(
      logs.some((line) => line.includes(failureReason)),
      `expected log to include specific failure reason, got: ${JSON.stringify(logs)}`
    );
  } finally {
    if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
    else process.env.BOARD_DIR = prevBoardDir;
    fs.rmSync(boardDir, { recursive: true, force: true });
  }
});
