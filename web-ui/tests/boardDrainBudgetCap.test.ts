import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  BoardOrchestrator,
  type BoardOrchestratorDeps,
  type JobExecutionOutcome,
} from "../lib/board/boardOrchestrator";
import { BoardStore } from "../lib/board/boardStore";
import type { BoardControlRecord } from "../lib/board/boardControlStore";
import { POST as drainPost } from "../app/api/board/drain/route";

/**
 * AUD-06 (#61): control.drainBudget persisted by /api/board/control must be the
 * effective per-drain item cap when set. Before this pass, POST /api/board/drain
 * and BoardOrchestrator ignored the persisted budget entirely and always used
 * MAX_DRAIN_ITEMS (or the request body), so a board started with drainBudget: 2
 * would drain far more items than the owner asked for.
 */

function makeTempEnv(): {
  rootDir: string;
  boardDir: string;
  threadsDir: string;
  cleanup: () => void;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "drain-budget-test-"));
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

function makeControl(
  state: BoardControlRecord["state"] = "running",
  drainBudget: number | null = null
): BoardControlRecord {
  return {
    state,
    drainBudget,
    stopAtBoundary: false,
    updatedAt: "2026-11-25T00:00:00.000Z",
  };
}

function seedQueuedItems(store: BoardStore, count: number): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const item = store.create({
      title: `Queued job ${i}`,
      brief: `Execute queued job ${i}.`,
      status: "queued",
      author: "Owner",
      source: "manual",
    });
    ids.push(item.id);
  }
  return ids;
}

test("drainBudget caps the orchestrator loop below MAX_DRAIN_ITEMS", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    seedQueuedItems(store, 5);

    const issuedIds: string[] = [];
    const deps: BoardOrchestratorDeps = {
      boardStore: store,
      getControlState: () => makeControl("running", 2),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      issueAndWait: async ({ item }): Promise<JobExecutionOutcome> => {
        issuedIds.push(item.id);
        return { status: "completed", threadId: `thread-${item.id}` };
      },
    };
    const orchestrator = new BoardOrchestrator(deps);
    const report = await orchestrator.drain();

    assert.equal(issuedIds.length, 2, "drainBudget: 2 must stop after two items");
    assert.equal(report.itemsProcessed, 2);
    assert.equal(report.stopReason, "max-items-reached");
    const remaining = store
      .list()
      .filter((item) => item.status === "queued").length;
    assert.equal(remaining, 3, "items beyond the budget must stay queued");
  } finally {
    env.cleanup();
  }
});

test("drainBudget null leaves the default cap untouched", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    seedQueuedItems(store, 3);

    let issuedCount = 0;
    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      getControlState: () => makeControl("running", null),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      issueAndWait: async (): Promise<JobExecutionOutcome> => {
        issuedCount += 1;
        return { status: "completed", threadId: "thread-budget-null" };
      },
    });
    const report = await orchestrator.drain();
    assert.equal(issuedCount, 3, "null budget must not impose an extra cap");
    assert.equal(report.itemsProcessed, 3);
    assert.equal(report.stopReason, "idle");
  } finally {
    env.cleanup();
  }
});

test("body maxItems smaller than drainBudget still wins (effective cap is the min)", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    seedQueuedItems(store, 5);
    fs.writeFileSync(
      path.join(env.boardDir, "board.meta.json"),
      JSON.stringify({ control: makeControl("running", 4) }, null, 2),
      "utf8"
    );

    const req = new NextRequest("http://localhost/api/board/drain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true, maxItems: 1 }),
    });
    const res = await drainPost(req);
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { report: { itemsProcessed: number; stopReason: string } };
    assert.equal(payload.report.itemsProcessed, 1, "body maxItems: 1 must cap below drainBudget: 4");
    assert.equal(payload.report.stopReason, "max-items-reached");
  } finally {
    env.cleanup();
  }
});

test("POST /api/board/drain honors persisted drainBudget when body omits maxItems", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    seedQueuedItems(store, 5);
    fs.writeFileSync(
      path.join(env.boardDir, "board.meta.json"),
      JSON.stringify({ control: makeControl("running", 2) }, null, 2),
      "utf8"
    );

    const req = new NextRequest("http://localhost/api/board/drain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    const res = await drainPost(req);
    assert.equal(res.status, 200);
    const payload = (await res.json()) as {
      report: { itemsProcessed: number; stopReason: string };
    };
    assert.equal(
      payload.report.itemsProcessed,
      2,
      "persisted drainBudget: 2 must be the effective cap for a body-less drain"
    );
    assert.equal(payload.report.stopReason, "max-items-reached");
  } finally {
    env.cleanup();
  }
});
