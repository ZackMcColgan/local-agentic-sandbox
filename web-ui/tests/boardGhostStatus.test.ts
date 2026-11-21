import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  mapThreadStatusToBoardStatus,
  mergeThreadsIntoBoard,
} from "../lib/board/mergeThreadsIntoBoard";
import { selectHeadEligibleItem, type DispatcherBoardItem } from "../lib/board/dispatcher";

function writeJson(filePath: string, data: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

test("mapThreadStatusToBoardStatus never collapses dead/paused/needs_input states to queued", () => {
  assert.equal(mapThreadStatusToBoardStatus("failed"), "needs-attention");
  assert.equal(mapThreadStatusToBoardStatus("stopped"), "needs-attention");
  assert.equal(mapThreadStatusToBoardStatus("crashed"), "needs-attention");
  assert.equal(mapThreadStatusToBoardStatus("needs_input"), "needs-attention");
  assert.equal(mapThreadStatusToBoardStatus("paused"), "parked");
  assert.equal(mapThreadStatusToBoardStatus("parked"), "parked");
  assert.equal(mapThreadStatusToBoardStatus("active"), "working");
  assert.equal(mapThreadStatusToBoardStatus("completed"), "done");
});

test("mergeThreadsIntoBoard maps failed/stopped/paused/crashed/needs_input threads and checkpoint ghosts honestly with zero queued ghosts", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "board-ghost-test-"));
  const threadsDir = path.join(tmpRoot, "threads");
  const checkpointDir = path.join(tmpRoot, "checkpoints");
  const prevThreadsDir = process.env.THREADS_DIR;
  const prevCheckpointDir = process.env.AGENT_CHECKPOINT_DIR;
  const prevCwd = process.cwd();

  try {
    process.env.THREADS_DIR = threadsDir;
    process.env.AGENT_CHECKPOINT_DIR = checkpointDir;
    process.chdir(tmpRoot);

    const now = "2026-11-18T12:00:00.000Z";
    const threadCases = [
      {
        id: "t-failed",
        taskId: "task-failed",
        status: "failed",
        title: "Failed job",
        error: "Build exited 1",
      },
      {
        id: "t-stopped",
        taskId: "task-stopped",
        status: "stopped",
        title: "Stopped job",
        error: "Stopped by operator",
      },
      { id: "t-paused", taskId: "task-paused", status: "paused", title: "Paused job" },
      {
        id: "t-crashed",
        taskId: "task-crashed",
        status: "crashed",
        title: "Crashed job",
        error: "SIGKILL",
      },
      {
        id: "t-needs-input",
        taskId: "task-needs-input",
        status: "needs_input",
        title: "Needs input job",
        error: "Awaiting approval",
      },
    ];

    for (const tc of threadCases) {
      writeJson(path.join(threadsDir, `${tc.id}.json`), {
        id: tc.id,
        title: tc.title,
        status: tc.status,
        taskId: tc.taskId,
        error: tc.error,
        createdAt: now,
        updatedAt: now,
        messages: [],
      });
    }

    // Standalone chat thread without taskId must never enter queued on the board
    writeJson(path.join(threadsDir, "t-standalone.json"), {
      id: "t-standalone",
      title: "Standalone chat",
      status: "stopped",
      createdAt: now,
      updatedAt: now,
      messages: [],
    });

    // Checkpoint ghosts without matching thread files
    const ghostCases = [
      {
        taskId: "ghost-failed",
        status: "failed",
        goal: "Ghost failed goal",
        error: "Checkpoint failed",
      },
      {
        taskId: "ghost-parked",
        status: "parked",
        goal: "Ghost parked goal",
        parkedReason: "Waiting on dependency",
      },
      { taskId: "ghost-paused", status: "paused", goal: "Ghost paused goal" },
      { taskId: "ghost-active", status: "active", goal: "Ghost active goal" },
    ];
    for (const gc of ghostCases) {
      writeJson(path.join(checkpointDir, `${gc.taskId}-checkpoint.json`), {
        taskId: gc.taskId,
        goal: gc.goal,
        status: gc.status,
        error: gc.error,
        parkedReason: gc.parkedReason,
        startedAt: now,
        updatedAt: now,
      });
    }

    const merged = await mergeThreadsIntoBoard([]);
    const queuedItems = merged.filter((item) => item.status === "queued");
    assert.equal(
      queuedItems.length,
      0,
      `Expected 0 queued ghosts, got: ${JSON.stringify(queuedItems)}`
    );

    // Standalone chat thread must not appear on the board
    assert.equal(
      merged.some((item) => item.id === "t-standalone"),
      false
    );

    // Failed/stopped/crashed/needs_input threads -> needs-attention with needsAttention: true and parkedReason
    for (const id of ["t-failed", "t-stopped", "t-crashed", "t-needs-input"]) {
      const item = merged.find((i) => i.id === id);
      assert.ok(item, `Missing board item for ${id}`);
      assert.equal(item.status, "needs-attention");
      assert.equal(item.needsAttention, true);
      assert.ok(
        item.parkedReason && item.parkedReason.length > 0,
        `Expected parkedReason for ${id}`
      );
    }

    const failedItem = merged.find((i) => i.id === "t-failed");
    assert.equal(failedItem?.parkedReason, "Build exited 1");

    // Paused thread -> parked (never queued)
    const pausedItem = merged.find((i) => i.id === "t-paused");
    assert.ok(pausedItem);
    assert.equal(pausedItem.status, "parked");

    // Checkpoint ghosts
    const ghostFailed = merged.find((i) => i.id === "thread-ghost-failed");
    assert.ok(ghostFailed);
    assert.equal(ghostFailed.status, "needs-attention");
    assert.equal(ghostFailed.needsAttention, true);
    assert.equal(ghostFailed.parkedReason, "Checkpoint failed");

    const ghostParked = merged.find((i) => i.id === "thread-ghost-parked");
    assert.ok(ghostParked);
    assert.equal(ghostParked.status, "parked");
    assert.equal(ghostParked.parkedReason, "Waiting on dependency");

    const ghostPaused = merged.find((i) => i.id === "thread-ghost-paused");
    assert.ok(ghostPaused);
    assert.equal(ghostPaused.status, "parked");

    const ghostActive = merged.find((i) => i.id === "thread-ghost-active");
    assert.ok(ghostActive);
    assert.equal(ghostActive.status, "needs-attention");

    // selectHeadEligibleItem must NEVER pick any of these
    const eligible = selectHeadEligibleItem(merged as DispatcherBoardItem[]);
    assert.equal(eligible, null);
  } finally {
    process.chdir(prevCwd);
    if (prevThreadsDir === undefined) {
      delete process.env.THREADS_DIR;
    } else {
      process.env.THREADS_DIR = prevThreadsDir;
    }
    if (prevCheckpointDir === undefined) {
      delete process.env.AGENT_CHECKPOINT_DIR;
    } else {
      process.env.AGENT_CHECKPOINT_DIR = prevCheckpointDir;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
