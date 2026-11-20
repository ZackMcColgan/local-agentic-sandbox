import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  BoardOrchestrator,
  extractJobOutcomeMetadata,
  type BoardOrchestratorDeps,
  type JobExecutionOutcome,
} from "../lib/board/boardOrchestrator";
import { BoardStore } from "../lib/board/boardStore";
import type { BoardControlRecord } from "../lib/board/boardControlStore";
import { POST as drainPost } from "../app/api/board/drain/route";

function makeTempEnv(): {
  rootDir: string;
  boardDir: string;
  threadsDir: string;
  cleanup: () => void;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "aud05-drain-test-"));
  const boardDir = path.join(rootDir, "board");
  const threadsDir = path.join(rootDir, "threads");
  fs.mkdirSync(boardDir, { recursive: true });
  fs.mkdirSync(threadsDir, { recursive: true });

  const prevBoardDir = process.env.BOARD_DIR;
  const prevThreadsDir = process.env.THREADS_DIR;
  process.env.BOARD_DIR = boardDir;
  process.env.THREADS_DIR = threadsDir;

  return {
    rootDir,
    boardDir,
    threadsDir,
    cleanup: () => {
      if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
      else process.env.BOARD_DIR = prevBoardDir;
      if (prevThreadsDir === undefined) delete process.env.THREADS_DIR;
      else process.env.THREADS_DIR = prevThreadsDir;
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function makeControl(state: BoardControlRecord["state"] = "running"): BoardControlRecord {
  return {
    state,
    drainBudget: null,
    stopAtBoundary: false,
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
}

test("(a) one-job rule: maxItems > 1 never marks multiple items working concurrently", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const first = store.create({
      title: "First queued job",
      brief: "Execute first job.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });
    const second = store.create({
      title: "Second queued job",
      brief: "Execute second job.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    const issuedIds: string[] = [];
    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      maxItems: 5,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      issueAndWait: async ({ item }): Promise<JobExecutionOutcome> => {
        issuedIds.push(item.id);
        return {
          status: "in-progress",
          threadId: `thread-${item.id}`,
          reason: "Job still executing",
        };
      },
    });

    const report = await orchestrator.drain();
    const afterFirst = store.get(first.id);
    const afterSecond = store.get(second.id);

    assert.deepEqual(issuedIds, [first.id], "Only the head eligible item may be issued");
    assert.equal(afterFirst?.status, "working", "Head item should be working");
    assert.equal(afterSecond?.status, "queued", "Second item must remain queued");
    assert.equal(report.inProgressCount, 1);
    assert.equal(report.stopReason, "job-already-running");
  } finally {
    env.cleanup();
  }
});

test("(a) one-job rule: drain refuses to start a second item when one is already working in BoardStore", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    store.create({
      title: "Already working job",
      brief: "Currently running.",
      status: "working",
      author: "Owner",
      source: "manual",
    });
    const queued = store.create({
      title: "Queued next job",
      brief: "Must wait.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    let issuedCount = 0;
    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      maxItems: 3,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      issueAndWait: async () => {
        issuedCount += 1;
        return { status: "completed", threadId: "t-unexpected" };
      },
    });

    const report = await orchestrator.drain();
    assert.equal(issuedCount, 0, "Must not issue any job while another board item is working");
    assert.equal(store.get(queued.id)?.status, "queued");
    assert.equal(report.stopReason, "job-already-running");
  } finally {
    env.cleanup();
  }
});

test("(b) dryRun: true leaves BoardStore byte-identical and creates zero thread files", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    store.create({
      title: "Dry-run fixture 1",
      brief: "Do not mutate me.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });
    store.create({
      title: "Dry-run fixture 2",
      brief: "Do not mutate me either.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    fs.writeFileSync(
      path.join(env.boardDir, "board.meta.json"),
      JSON.stringify({ control: makeControl("running") }, null, 2),
      "utf8"
    );

    const boardFilePath = path.join(env.boardDir, "board.json");
    const beforeBytes = fs.readFileSync(boardFilePath);

    const req = new NextRequest("http://localhost/api/board/drain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true, maxItems: 5 }),
    });
    const res = await drainPost(req);
    assert.equal(res.status, 200);

    const afterBytes = fs.readFileSync(boardFilePath);
    assert.deepEqual(
      afterBytes,
      beforeBytes,
      "BoardStore file must be byte-identical after dryRun: true"
    );

    const threadFiles = fs.readdirSync(env.threadsDir);
    assert.equal(threadFiles.length, 0, "dryRun: true must create zero thread files");
  } finally {
    env.cleanup();
  }
});

test("(c) completed drained job reaches shadow-stage hooks (flowMonitor, reviewerGate, selfDeploy)", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const item = store.create({
      title: "Shadow stage fixture",
      brief: "Open PR and merge.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    let flowMonitorCalled = false;
    let reviewerGateCalled = false;
    let selfDeployCalled = false;

    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      boardDir: env.boardDir,
      maxItems: 1,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      stageFlags: {
        flowMonitor: false,
        reviewerGate: false,
        selfDeploy: false,
      },
      flowMonitor: {
        pollChecks: async () => {
          flowMonitorCalled = true;
          return {
            headSha: "abc1234",
            checks: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
          };
        },
      },
      reviewerGate: {
        getMechanicalInput: async () => ({
          diff: "diff --git a/web-ui/lib/board/boardOrchestrator.ts b/web-ui/lib/board/boardOrchestrator.ts",
          allowlist: ["web-ui/lib/board/boardOrchestrator.ts"],
          commitSubjects: ["Fix board drain execution"],
          branchName: "feature/audit-05-drain-executes",
        }),
        issueReviewerThread: async () => {
          reviewerGateCalled = true;
          return {
            threadId: "rev-thread-1",
            verdict: "PASS",
            evidence: ["All checks passed."],
          };
        },
      },
      selfDeploy: {
        deps: {
          readCurrentState: async () => {
            selfDeployCalled = true;
            return {
              image: "local-agentic-sandbox-web-ui:old",
              podStatus: "Running",
              podRestarts: 0,
            };
          },
          bankRollbackTarget: async (tag) => ({ banked: true, tag }),
          buildAndImport: async (tag) => ({
            built: false,
            imported: false,
            imagePresentInNode: false,
            detail: `shadow ${tag}`,
          }),
          setImage: async () => ({ ok: false }),
          verifyDeployment: async (expectedTag) => ({
            ok: false,
            rolloutSuccess: false,
            podRunningZeroRestarts: false,
            gatewayStatus: 0,
            threadListLoads: false,
            observedTag: expectedTag,
          }),
        },
      },
      issueAndWait: async (): Promise<JobExecutionOutcome> => ({
        status: "completed",
        threadId: "t-shadow-1",
        summary: "Opened PR #99 and merged commit deadbeef",
        prNumber: 99,
        headSha: "abc1234",
        merged: true,
        mergeSha: "deadbeef",
      }),
    } as BoardOrchestratorDeps);

    const report = await orchestrator.drain();
    assert.equal(report.completedCount, 1);
    assert.equal(store.get(item.id)?.status, "done");
    assert.equal(flowMonitorCalled, true, "flowMonitor shadow stage must be invoked");
    assert.equal(reviewerGateCalled, true, "reviewerGate shadow stage must be invoked");
    assert.equal(selfDeployCalled, true, "selfDeploy shadow stage must be invoked");
    assert.ok(report.outcomes[0]?.shadowStages?.flowMonitor, "flowMonitor outcome recorded");
    assert.ok(report.outcomes[0]?.shadowStages?.reviewerGate, "reviewerGate outcome recorded");
    assert.ok(report.outcomes[0]?.shadowStages?.selfDeploy, "selfDeploy outcome recorded");
  } finally {
    env.cleanup();
  }
});

test("(c) extractJobOutcomeMetadata parses PR, headSha, mergeSha, and deployTag for shadow stages", () => {
  const meta = extractJobOutcomeMetadata(
    "Opened https://github.com/org/repo/pull/142 (headSha: abc1234def). Merged commit deadbeef99 with deployTag: v2026.11.20."
  );
  assert.equal(meta.prNumber, 142);
  assert.equal(meta.headSha, "abc1234def");
  assert.equal(meta.merged, true);
  assert.equal(meta.mergeSha, "deadbeef99");
  assert.equal(meta.deployTag, "v2026.11.20.");

  const prOnly = extractJobOutcomeMetadata("Created PR #77 for review.");
  assert.equal(prOnly.prNumber, 77);
  assert.equal(prOnly.merged, undefined);

  const empty = extractJobOutcomeMetadata("Completed refactoring with no PR.");
  assert.deepEqual(empty, {});
});

