import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgreementLedgerStore } from "../lib/board/agreementLedger";
import { runMechanicalChecks } from "../lib/board/reviewerGate";
import { evaluatePrShadowVerdict } from "../lib/board/reviewerAuditEvaluate";
import {
  isFlowMonitorArmEnabled,
  isFlowMonitorObserveEnabled,
  FLOW_MONITOR_STAGE2_DEFAULT,
} from "../lib/board/flowMonitor";
import {
  runSelfDeployVerified,
  resolveDeployedCommitSha,
  computeProdEqualsDevelop,
} from "../lib/deploy/selfDeployVerified";
import { GET as sandboxStatusGet } from "../app/api/sandbox-status/route";
import { POST as boardPost } from "../app/api/board/route";
import { BoardOrchestrator } from "../lib/board/boardOrchestrator";
import { BoardStore } from "../lib/board/boardStore";
import { NextRequest } from "next/server";

describe("Batch 6 — Handover Prerequisites (HO-9, HO-10, HO-7, HO-5, HO-4, HO-2)", () => {
  it("HO-9: AgreementLedgerStore keys by (prNumber, headSha) and rejects mismatched driver SHA", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ho9-ledger-"));
    try {
      const store = new AgreementLedgerStore(dir);
      const sha1 = "1111111111111111111111111111111111111111";
      const sha2 = "2222222222222222222222222222222222222222";

      store.recordShadowVerdict({ prNumber: 42, headSha: sha1, reviewerVerdict: "PASS" });
      store.recordShadowVerdict({ prNumber: 42, headSha: sha2, reviewerVerdict: "FAIL" });

      const ledger = store.read();
      assert.equal(
        ledger.entries.length,
        2,
        "Distinct (prNumber, headSha) pairs must be stored separately"
      );

      // Mismatched SHA must throw
      assert.throws(
        () =>
          store.recordDriverVerdict({
            prNumber: 42,
            headSha: "3333333333333333333333333333333333333333",
            driverVerdict: "PASS",
          }),
        /headSha|mismatch|not found/i
      );

      // Exact (prNumber, headSha) match succeeds
      const updated = store.recordDriverVerdict({
        prNumber: 42,
        headSha: sha2,
        driverVerdict: "FAIL",
      });
      assert.ok(updated);
      const matched = updated!.entries.find((e) => e.prNumber === 42 && e.headSha === sha2);
      assert.equal(matched?.driverVerdict, "FAIL");
      assert.equal(matched?.agreed, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("HO-10: mechanical checks fail CLOSED on empty or errored PR diff, and POST /api/board forwards allowlist", async () => {
    const emptyRes = runMechanicalChecks({
      diff: "",
      allowlist: [],
      commitSubjects: ["feat: test"],
      branchName: "feature/test",
    });
    assert.equal(emptyRes.verdict, "FAIL", "Empty diff must fail closed");
    assert.ok(emptyRes.failures.length > 0);

    const errRes = runMechanicalChecks({
      diff: "",
      diffError: "gh pr diff failed: auth error",
      allowlist: [],
      commitSubjects: [],
      branchName: "feature/test",
    });
    assert.equal(errRes.verdict, "FAIL");
    assert.ok(errRes.failures.some((f) => f.evidence.includes("gh pr diff failed")));

    const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "ho10-board-"));
    const prevBoardDir = process.env.BOARD_DIR;
    process.env.BOARD_DIR = boardDir;
    try {
      const req = new NextRequest("http://localhost:3000/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Scoped change",
          brief: "Only touch foo.ts",
          allowlist: ["web-ui/lib/foo.ts"],
        }),
      });
      const res = await boardPost(req);
      assert.equal(res.status, 201);
      const data = (await res.json()) as { item: { allowlist?: string[] } };
      assert.deepEqual(data.item.allowlist, ["web-ui/lib/foo.ts"]);
    } finally {
      if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
      else process.env.BOARD_DIR = prevBoardDir;
      fs.rmSync(boardDir, { recursive: true, force: true });
    }
  });

  it("HO-7: evaluatePrShadowVerdict records engineMinutes and orchestrator sheds shadow review when build slot is busy", async () => {
    const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "ho7-board-"));
    const prevBoardDir = process.env.BOARD_DIR;
    process.env.BOARD_DIR = boardDir;
    try {
      const res = await evaluatePrShadowVerdict(
        {
          getMechanicalInput: async () => ({
            diff: "diff --git a/a.ts b/a.ts\n+export const a = 1;\n",
            allowlist: ["a.ts"],
            commitSubjects: ["feat: a"],
            branchName: "feature/a",
          }),
          resolveHeadSha: async () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          issueReviewerThread: async () => ({
            threadId: "thr-rev-1",
            verdict: "PASS",
            evidence: ["ok"],
          }),
        },
        { prNumber: 77, brief: "Test engineMinutes" }
      );
      assert.equal(typeof res.entry.engineMinutes, "number");
      assert.ok(res.entry.engineMinutes! >= 0);

      // Shedding when build slot is busy
      const logs: string[] = [];
      let reviewerCalled = false;
      const store = new BoardStore(boardDir);
      const item = store.create({
        title: "Busy shed",
        brief: "b",
        author: "Owner",
        source: "manual",
      });
      const orch = new BoardOrchestrator({
        boardDir,
        log: (m) => logs.push(m),
        issueAndWait: async () => ({ status: "completed", threadId: "t" }),
        isBuildSlotBusy: () => true,
        reviewerGate: {
          getMechanicalInput: async () => ({
            diff: "diff --git a/a.ts b/a.ts\n+1\n",
            allowlist: [],
            commitSubjects: [],
            branchName: "feature/x",
          }),
          issueReviewerThread: async () => {
            reviewerCalled = true;
            return { threadId: "t", verdict: "PASS", evidence: [] };
          },
        },
      });
      await orch.runPrOpenShadowStages(item, {
        prNumber: 78,
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      });
      assert.equal(reviewerCalled, false, "Shadow reviewer must shed when build slot is busy");
      assert.ok(logs.some((l) => /shed/i.test(l)));
    } finally {
      if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
      else process.env.BOARD_DIR = prevBoardDir;
      fs.rmSync(boardDir, { recursive: true, force: true });
    }
  });

  it("HO-5: Flow monitor splits OBSERVE and ARM flags, both default OFF", () => {
    assert.equal(FLOW_MONITOR_STAGE2_DEFAULT, false);
    assert.equal(isFlowMonitorObserveEnabled(undefined, {}), false);
    assert.equal(isFlowMonitorArmEnabled(undefined, {}), false);
    assert.equal(
      isFlowMonitorObserveEnabled(undefined, { BOARD_STAGE_FLOW_MONITOR_OBSERVE: "true" }),
      true
    );
    assert.equal(
      isFlowMonitorArmEnabled(undefined, { BOARD_STAGE_FLOW_MONITOR_OBSERVE: "true" }),
      false
    );
    assert.equal(
      isFlowMonitorArmEnabled(undefined, { BOARD_STAGE_FLOW_MONITOR_ARM: "true" }),
      true
    );
  });

  it("HO-4: sandbox-status exposes deployed_commit_sha and selfDeployVerified computes real prodEqualsDevelop", async () => {
    const prevSha = process.env.DEPLOYED_COMMIT_SHA;
    process.env.DEPLOYED_COMMIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";
    try {
      assert.equal(resolveDeployedCommitSha(), "abcdef1234567890abcdef1234567890abcdef12");
      assert.equal(
        computeProdEqualsDevelop(
          "abcdef1234567890abcdef1234567890abcdef12",
          "local-agentic-sandbox-web-ui:abcdef1"
        ),
        true
      );
      assert.equal(
        computeProdEqualsDevelop(
          "abcdef1234567890abcdef1234567890abcdef12",
          "local-agentic-sandbox-web-ui:9999999"
        ),
        false
      );

      const res = await runSelfDeployVerified(
        {
          targetTag: "local-agentic-sandbox-web-ui:9999999",
          developSha: "abcdef1234567890abcdef1234567890abcdef12",
        },
        {
          readCurrentState: async () => ({
            image: "img:old",
            podStatus: "Running",
            podRestarts: 0,
          }),
          bankRollbackTarget: async (tag) => ({ banked: true, tag }),
          buildAndImport: async (tag) => ({
            built: true,
            imported: true,
            imagePresentInNode: true,
            builtTag: tag,
            detail: "ok",
          }),
          setImage: async () => ({ ok: true }),
          verifyDeployment: async (tag) => ({
            ok: true,
            rolloutSuccess: true,
            podRunningZeroRestarts: true,
            gatewayStatus: 200,
            threadListLoads: true,
            observedTag: tag,
          }),
        },
        { stageEnabled: true }
      );
      assert.equal(res.status, "deployed");
      assert.equal(
        res.prodEqualsDevelop,
        false,
        "Mismatched tag SHA vs developSha must yield prodEqualsDevelop=false"
      );

      const statusRes = await sandboxStatusGet();
      const statusJson = (await statusRes.json()) as { deployed_commit_sha?: string | null };
      assert.equal(statusJson.deployed_commit_sha, "abcdef1234567890abcdef1234567890abcdef12");
    } finally {
      if (prevSha === undefined) delete process.env.DEPLOYED_COMMIT_SHA;
      else process.env.DEPLOYED_COMMIT_SHA = prevSha;
    }
  });

  it("HO-2: BoardOrchestrator wires finishVerificationClean from verifyFinish into reviewer gate", async () => {
    const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "ho2-board-"));
    try {
      const store = new BoardStore(boardDir);
      const item = store.create({
        title: "HO-2 wiring",
        brief: "verify",
        author: "Owner",
        source: "manual",
      });
      let verifyCalled = false;
      const orch = new BoardOrchestrator({
        boardDir,
        issueAndWait: async () => ({ status: "completed", threadId: "t" }),
        isBuildSlotBusy: () => false,
        verifyFinish: () => {
          verifyCalled = true;
          return { ok: true, reasons: [] };
        },
        reviewerGate: {
          getMechanicalInput: async () => ({
            diff: "diff --git a/a.ts b/a.ts\n+export const x = 1;\n",
            allowlist: [],
            commitSubjects: ["feat: x"],
            branchName: "feature/x",
          }),
          issueReviewerThread: async () => ({
            threadId: "thr-ho2",
            verdict: "PASS",
            evidence: ["clean"],
          }),
        },
      });
      const res = await orch.runPrOpenShadowStages(item, {
        prNumber: 91,
        headSha: "cccccccccccccccccccccccccccccccccccccccc",
      });
      assert.equal(verifyCalled, true, "verifyFinish must be invoked during shadow reviewer stage");
      assert.equal(res.reviewerGate?.mergeAuthorized, false, "Stage 3 stays shadow OFF");
    } finally {
      fs.rmSync(boardDir, { recursive: true, force: true });
    }
  });
});
