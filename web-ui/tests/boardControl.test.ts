import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  BoardControlStore,
  type BoardControlState,
} from "../lib/board/boardControlStore";
import { GET as getBoardControl, POST as postBoardControl } from "../app/api/board/control/route";
import {
  registerTurnAbortController,
  clearTurnAbortController,
  markTurnActive,
  clearTurnActive,
  activeExecutionSet,
} from "../lib/threads/threadStore";

describe("BoardControlStore & /api/board/control", () => {
  let tmpBoardDir: string;
  let originalBoardDir: string | undefined;
  let originalEnvAutoIssue: string | undefined;

  beforeEach(() => {
    tmpBoardDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-control-test-"));
    originalBoardDir = process.env.BOARD_DIR;
    originalEnvAutoIssue = process.env.DISPATCHER_AUTO_ISSUE;
    process.env.BOARD_DIR = tmpBoardDir;
    delete process.env.DISPATCHER_AUTO_ISSUE;
  });

  afterEach(() => {
    if (originalBoardDir === undefined) delete process.env.BOARD_DIR;
    else process.env.BOARD_DIR = originalBoardDir;
    if (originalEnvAutoIssue === undefined) delete process.env.DISPATCHER_AUTO_ISSUE;
    else process.env.DISPATCHER_AUTO_ISSUE = originalEnvAutoIssue;
    fs.rmSync(tmpBoardDir, { recursive: true, force: true });
  });

  it("defaults to stopped and supports stopped -> running -> paused -> stopped transitions", async () => {
    const store = new BoardControlStore(tmpBoardDir, {
      unloadModels: async () => [],
    });

    const initial = store.getState();
    assert.equal(initial.state, "stopped" satisfies BoardControlState);
    assert.equal(initial.stopAtBoundary, false);

    const started = await store.applyAction("start", { drainBudget: 3 });
    assert.equal(started.control.state, "running");
    assert.equal(started.control.drainBudget, 3);
    assert.equal(started.control.stopAtBoundary, false);

    const paused = await store.applyAction("pause");
    assert.equal(paused.control.state, "paused");
    assert.equal(paused.control.stopAtBoundary, true);

    const stopped = await store.applyAction("stop");
    assert.equal(stopped.control.state, "stopped");
    assert.equal(stopped.control.stopAtBoundary, false);
  });

  it("persists state in board.meta.json across store reload and preserves existing meta fields", async () => {
    const metaPath = path.join(tmpBoardDir, "board.meta.json");
    fs.writeFileSync(metaPath, JSON.stringify({ version: 2 }, null, 2), "utf8");

    const store1 = new BoardControlStore(tmpBoardDir, {
      unloadModels: async () => [],
    });
    await store1.applyAction("start", { drainBudget: 5 });

    // Fresh store instance reading the same board.meta.json
    const store2 = new BoardControlStore(tmpBoardDir, {
      unloadModels: async () => [],
    });
    const reloaded = store2.getState();
    assert.equal(reloaded.state, "running");
    assert.equal(reloaded.drainBudget, 5);

    const rawMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    assert.equal(rawMeta.version, 2, "must preserve existing board.meta.json version");
    assert.equal(rawMeta.control.state, "running");
    assert.equal(rawMeta.control.drainBudget, 5);
  });

  it("Pause marks stopAtBoundary without aborting active turn or task", async () => {
    const threadId = `thread-pause-${Date.now()}`;
    const taskId = `task-pause-${Date.now()}`;
    const turnController = new AbortController();
    const taskController = new AbortController();

    markTurnActive(threadId);
    registerTurnAbortController(threadId, turnController);
    activeExecutionSet.add(threadId);

    const supState =
      (globalThis as any).__supervisorGlobalState ||
      ((globalThis as any).__supervisorGlobalState = {
        pausedTasks: new Set<string>(),
        abortControllers: new Map<string, AbortController>(),
      });
    supState.abortControllers.set(taskId, taskController);

    let unloadCalled = 0;
    const store = new BoardControlStore(tmpBoardDir, {
      unloadModels: async () => {
        unloadCalled += 1;
        return [];
      },
    });

    try {
      await store.applyAction("start");
      const paused = await store.applyAction("pause");

      assert.equal(paused.control.state, "paused");
      assert.equal(paused.control.stopAtBoundary, true);
      assert.equal(turnController.signal.aborted, false, "Pause must NOT abort active turn");
      assert.equal(taskController.signal.aborted, false, "Pause must NOT cancel active task");
      assert.equal(unloadCalled, 0, "Pause must NOT unload models");
    } finally {
      clearTurnAbortController(threadId);
      clearTurnActive(threadId);
      activeExecutionSet.delete(threadId);
      supState.abortControllers.delete(taskId);
    }
  });

  it("Stop fires abortActiveTurn, cancelTask, and unloadAllModels immediately", async () => {
    const threadId = `thread-stop-${Date.now()}`;
    const taskId = `task-stop-${Date.now()}`;
    const turnController = new AbortController();
    const taskController = new AbortController();

    markTurnActive(threadId);
    registerTurnAbortController(threadId, turnController);
    activeExecutionSet.add(threadId);

    const supState =
      (globalThis as any).__supervisorGlobalState ||
      ((globalThis as any).__supervisorGlobalState = {
        pausedTasks: new Set<string>(),
        abortControllers: new Map<string, AbortController>(),
      });
    supState.abortControllers.set(taskId, taskController);

    let unloadCalled = 0;
    const store = new BoardControlStore(tmpBoardDir, {
      unloadModels: async () => {
        unloadCalled += 1;
        return ["test-model"];
      },
    });

    try {
      await store.applyAction("start");
      const stopped = await store.applyAction("stop");

      assert.equal(stopped.control.state, "stopped");
      assert.equal(stopped.control.stopAtBoundary, false);
      assert.equal(turnController.signal.aborted, true, "Stop MUST abort active turn");
      assert.equal(taskController.signal.aborted, true, "Stop MUST cancel active task");
      assert.equal(unloadCalled, 1, "Stop MUST call unloadAllModels");
      assert.ok(stopped.abortResult);
      assert.ok(stopped.abortResult.abortedTurns.includes(threadId));
      assert.ok(stopped.abortResult.cancelledTasks.includes(taskId));
      assert.deepEqual(stopped.abortResult.unloadedModels, ["test-model"]);
    } finally {
      clearTurnAbortController(threadId);
      clearTurnActive(threadId);
      activeExecutionSet.delete(threadId);
      supState.abortControllers.delete(taskId);
    }
  });

  it("GET and POST /api/board/control validate input and persist control state", async () => {
    const getRes1 = await getBoardControl();
    assert.equal(getRes1.status, 200);
    const getBody1 = await getRes1.json();
    assert.equal(getBody1.control.state, "stopped");

    const badReq = new NextRequest("http://localhost/api/board/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invalid" }),
    });
    const badRes = await postBoardControl(badReq);
    assert.equal(badRes.status, 400);

    const startReq = new NextRequest("http://localhost/api/board/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start", drainBudget: 2 }),
    });
    const startRes = await postBoardControl(startReq);
    assert.equal(startRes.status, 200);
    const startBody = await startRes.json();
    assert.equal(startBody.control.state, "running");
    assert.equal(startBody.control.drainBudget, 2);

    const getRes2 = await getBoardControl();
    assert.equal(getRes2.status, 200);
    const getBody2 = await getRes2.json();
    assert.equal(getBody2.control.state, "running");
    assert.equal(getBody2.control.drainBudget, 2);
  });
});
