import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BoardOrchestrator,
  MAX_ORPHAN_AUTO_RESUMES,
  type JobExecutionOutcome,
} from "../lib/board/boardOrchestrator";
import { BoardStore } from "../lib/board/boardStore";
import type { BoardControlRecord } from "../lib/board/boardControlStore";
import {
  createProductionBoardOrchestrator,
  createProductionIssueAndWait,
  createProductionWorkingItemLivenessCheck,
  evaluateSettledThreadOutcome,
} from "../lib/board/productionDrain";
import { TURN_CHUNK_COMPLETE_MARKER } from "../lib/jobChunking";
import { writeMilestoneHandoff } from "../lib/subagents/finishVerificationGate";
import {
  STALL_WINDOW_MS,
  superviseStalledThread,
  type SupervisorJobStore,
  type SupervisorThreadAdapter,
} from "../lib/threads/inAppSupervisor";
import {
  ThreadStore,
  clearTurnActive,
  markTurnActive,
  type Thread,
} from "../lib/threads/threadStore";

function makeTempEnv(): {
  rootDir: string;
  boardDir: string;
  threadsDir: string;
  checkpointDir: string;
  cleanup: () => void;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "drain-recovery-test-"));
  const boardDir = path.join(rootDir, "board");
  const threadsDir = path.join(rootDir, "threads");
  const checkpointDir = path.join(rootDir, "checkpoints");
  fs.mkdirSync(boardDir, { recursive: true });
  fs.mkdirSync(threadsDir, { recursive: true });
  fs.mkdirSync(checkpointDir, { recursive: true });

  const prevBoardDir = process.env.BOARD_DIR;
  const prevThreadsDir = process.env.THREADS_DIR;
  const prevCheckpointDir = process.env.AGENT_CHECKPOINT_DIR;
  process.env.BOARD_DIR = boardDir;
  process.env.THREADS_DIR = threadsDir;
  process.env.AGENT_CHECKPOINT_DIR = checkpointDir;

  return {
    rootDir,
    boardDir,
    threadsDir,
    checkpointDir,
    cleanup: () => {
      if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
      else process.env.BOARD_DIR = prevBoardDir;
      if (prevThreadsDir === undefined) delete process.env.THREADS_DIR;
      else process.env.THREADS_DIR = prevThreadsDir;
      if (prevCheckpointDir === undefined) delete process.env.AGENT_CHECKPOINT_DIR;
      else process.env.AGENT_CHECKPOINT_DIR = prevCheckpointDir;
      fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

function makeControl(state: BoardControlRecord["state"] = "running"): BoardControlRecord {
  return {
    state,
    drainBudget: null,
    stopAtBoundary: false,
    updatedAt: "2026-11-22T00:00:00.000Z",
  };
}

function makeThreadRecord(overrides: Partial<Thread> = {}): Thread {
  const nowIso = "2026-11-22T00:00:00.000Z";
  return {
    id: overrides.id ?? "thread-rec-1",
    title: overrides.title ?? "#1 Test job",
    status: overrides.status ?? "active",
    model: overrides.model ?? "test-model",
    reasoningEffort: overrides.reasoningEffort ?? "medium",
    messages: overrides.messages ?? [],
    createdAt: overrides.createdAt ?? nowIso,
    updatedAt: overrides.updatedAt ?? nowIso,
    ...overrides,
  };
}

test("A1: threadLink is persisted in BoardStore before dispatchChatTurn / issueAndWait resolves", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const item = store.create({
      key: "#61",
      title: "Persist threadLink immediately",
      brief: "Implement feature and open PR.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    let persistedStatusDuringTurn: string | undefined;
    let persistedLinkDuringTurn: string | undefined;
    let createdThreadBoardItemId: string | undefined;
    let createdThreadTaskId: string | undefined;

    const threadStore = new ThreadStore(env.threadsDir);
    threadStore.stopSupervisorSweep();

    const issueAndWait = createProductionIssueAndWait({
      hostCheckoutPath: "/tmp/repo",
      executeHostTool: async () => ({ ok: true, exitCode: 0, stdout: "develop\n" }),
      threadStore,
      dispatchChatTurn: async ({ threadId }) => {
        // Read directly from disk via a fresh BoardStore BEFORE the turn settles
        const onDisk = new BoardStore(env.boardDir).get(item.id);
        persistedStatusDuringTurn = onDisk?.status;
        persistedLinkDuringTurn = onDisk?.threadLink;

        const created = await threadStore.getThread(threadId);
        createdThreadBoardItemId = created?.boardItemId;
        createdThreadTaskId = created?.taskId;

        threadStore.addMessage(threadId, {
          id: "msg-a1",
          role: "assistant",
          content: "Opened PR #221.",
          status: "completed",
          timestamp: new Date().toISOString(),
        });
        return { ok: true, status: 200, rawStream: "" };
      },
    });

    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      maxItems: 1,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      issueAndWait,
    });

    const report = await orchestrator.drain();
    assert.equal(report.completedCount, 1);
    assert.equal(
      persistedStatusDuringTurn,
      "working",
      "item must be marked working once thread is created"
    );
    assert.ok(
      persistedLinkDuringTurn && persistedLinkDuringTurn.startsWith("/?thread=thread-"),
      `threadLink must be persisted on disk before dispatchChatTurn resolves, got: ${persistedLinkDuringTurn}`
    );
    assert.equal(createdThreadBoardItemId, item.id, "drain thread must record boardItemId");
    assert.equal(
      createdThreadTaskId,
      undefined,
      "drain thread must NOT set taskId (which strips host tools)"
    );
    const finalItem = new BoardStore(env.boardDir).get(item.id);
    assert.equal(finalItem?.status, "done");
    assert.equal(finalItem?.threadLink, persistedLinkDuringTurn);
  } finally {
    env.cleanup();
  }
});

test("A1: working item without threadLink is impossible when grounding fails before thread creation", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const item = store.create({
      key: "#62",
      title: "Grounding failure before thread",
      brief: "Do work.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    let statusDuringGrounding: string | undefined;
    const issueAndWait = createProductionIssueAndWait({
      hostCheckoutPath: "/tmp/missing",
      executeHostTool: async () => {
        statusDuringGrounding = new BoardStore(env.boardDir).get(item.id)?.status;
        return { ok: false, exitCode: 128, stderr: "not a git repo" };
      },
      threadStore: {
        createThread: () => {
          throw new Error("should not create thread");
        },
        getThread: async () => null,
      },
    });

    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      maxItems: 1,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      issueAndWait,
    });

    const report = await orchestrator.drain();
    assert.equal(statusDuringGrounding, "queued", "must not stamp working before thread exists");
    assert.equal(report.failedCount, 1);
    assert.equal(store.get(item.id)?.status, "needs-attention");
  } finally {
    env.cleanup();
  }
});

test("A2: restart-orphaned working item requeues on strike 1 (count 1), requeues on strike 2 (count 2), and parks only on strike 3", async () => {
  assert.equal(MAX_ORPHAN_AUTO_RESUMES, 2);
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const item = store.create({
      key: "#63",
      title: "Interrupted marathon job",
      brief: "Refactor worker loop and verify tests.",
      status: "working",
      threadLink: "/?thread=thread-attempt-0",
      autoResumeCount: 0,
      author: "Owner",
      source: "manual",
    });

    const threads = new Map<string, Thread>([
      [
        "thread-attempt-0",
        makeThreadRecord({
          id: "thread-attempt-0",
          status: "stopped",
          messages: [
            {
              id: "m0",
              role: "assistant",
              content:
                "Inspected worker loop and drafted tests.\n\n⚠️ [Turn incomplete: Server restarted or turn interrupted.]",
              status: "incomplete",
              timestamp: "2026-11-22T00:01:00.000Z",
            },
          ],
        }),
      ],
    ]);

    const seenBriefs: string[] = [];
    let attemptNum = 0;

    const makeOrchestrator = () =>
      new BoardOrchestrator({
        boardStore: new BoardStore(env.boardDir),
        maxItems: 5,
        getControlState: () => makeControl("running"),
        getLiveJobState: () => ({ isRunning: false }),
        getOwnerState: () => ({ isMidTurn: false }),
        checkWorkingItemLiveness: createProductionWorkingItemLivenessCheck({
          threadStore: {
            createThread: () => {
              throw new Error("unexpected");
            },
            getThread: async (id) => threads.get(id) ?? null,
          },
          isThreadLive: () => false,
        }),
        issueAndWait: async ({ brief, onThreadCreated }): Promise<JobExecutionOutcome> => {
          attemptNum += 1;
          seenBriefs.push(brief);
          const nextThreadId = `thread-attempt-${attemptNum}`;
          onThreadCreated?.(nextThreadId);
          // Simulate pod restart killing this turn mid-flight before settling
          threads.set(
            nextThreadId,
            makeThreadRecord({
              id: nextThreadId,
              status: "stopped",
              messages: [
                {
                  id: `m-${attemptNum}`,
                  role: "assistant",
                  content: `Attempt ${attemptNum} progress before restart.\n\n⚠️ [Turn incomplete: Server restarted or turn interrupted.]`,
                  status: "incomplete",
                  timestamp: "2026-11-22T00:05:00.000Z",
                },
              ],
            })
          );
          return { status: "in-progress", threadId: nextThreadId, reason: "simulated restart" };
        },
      });

    // Strike 1: count 0 -> requeued (count 1) with re-grounding handoff, then re-dispatched
    const r1 = await makeOrchestrator().drain();
    assert.equal(r1.requeuedCount, 1);
    assert.equal(r1.failedCount, 0);
    assert.equal(attemptNum, 1);
    const after1 = new BoardStore(env.boardDir).get(item.id)!;
    assert.equal(after1.autoResumeCount, 1);
    assert.equal(after1.threadLink, "/?thread=thread-attempt-1");
    assert.ok(after1.handoff, "handoff must be persisted on BoardItem");
    assert.match(seenBriefs[0], /CONTINUATION FROM HANDOFF/i);
    assert.match(seenBriefs[0], /continue.*do not restart/i);
    assert.match(seenBriefs[0], /Inspected worker loop/i);

    // Strike 2: count 1 -> requeued (count 2) with updated re-grounding handoff, then re-dispatched
    const r2 = await makeOrchestrator().drain();
    assert.equal(r2.requeuedCount, 1);
    assert.equal(r2.failedCount, 0);
    assert.equal(attemptNum, 2);
    const after2 = new BoardStore(env.boardDir).get(item.id)!;
    assert.equal(after2.autoResumeCount, 2);
    assert.equal(after2.threadLink, "/?thread=thread-attempt-2");
    assert.match(seenBriefs[1], /Attempt 1 progress before restart/i);

    // Strike 3: count 2 (budget exhausted) -> parked at needs-attention, NOT re-dispatched
    const r3 = await makeOrchestrator().drain();
    assert.equal(r3.requeuedCount, 0);
    assert.equal(r3.failedCount, 1);
    assert.equal(attemptNum, 2, "must not dispatch a third auto-resume after budget exhaustion");
    const after3 = new BoardStore(env.boardDir).get(item.id)!;
    assert.equal(after3.status, "needs-attention");
    assert.equal(after3.needsAttention, true);
    assert.equal(after3.autoResumeCount, 2);
    assert.match(after3.parkedReason ?? "", /auto-resume|budget|exhausted|2\/2/i);
  } finally {
    env.cleanup();
  }
});

test("A2: orphaned working item with PR/commit evidence parks immediately with specific reason even at count 0", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const item = store.create({
      key: "#64",
      title: "Orphaned after opening PR",
      brief: "Open PR.",
      status: "working",
      threadLink: "/?thread=thread-with-pr",
      autoResumeCount: 0,
      author: "Owner",
      source: "manual",
    });

    let issuedCount = 0;
    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      maxItems: 2,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      checkWorkingItemLiveness: createProductionWorkingItemLivenessCheck({
        threadStore: {
          createThread: () => {
            throw new Error("unexpected");
          },
          getThread: async () =>
            makeThreadRecord({
              id: "thread-with-pr",
              status: "stopped",
              messages: [
                {
                  id: "m-pr",
                  role: "assistant",
                  content:
                    "Opened https://github.com/org/repo/pull/225 before restart.\n\n⚠️ [Turn incomplete: Server restarted or turn interrupted.]",
                  status: "incomplete",
                  timestamp: "2026-11-22T00:02:00.000Z",
                },
              ],
            }),
        },
        isThreadLive: () => false,
      }),
      issueAndWait: async () => {
        issuedCount += 1;
        return { status: "completed", threadId: "t-unexpected" };
      },
    });

    const report = await orchestrator.drain();
    assert.equal(issuedCount, 0, "must not auto-requeue when PR/commit evidence already exists");
    assert.equal(report.requeuedCount, 0);
    assert.equal(report.failedCount, 1);
    const after = store.get(item.id)!;
    assert.equal(after.status, "needs-attention");
    assert.equal(after.needsAttention, true);
    assert.match(after.parkedReason ?? "", /PR #225|PR\/commit/i);
  } finally {
    env.cleanup();
  }
});

test("A2: working item whose linked thread settled completed is inspected through normal completion path (never orphaned)", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const item = store.create({
      key: "#65",
      title: "Completed right before pod restart",
      brief: "Ship fix.",
      status: "working",
      threadLink: "/?thread=thread-done-before-crash",
      author: "Owner",
      source: "manual",
    });

    let issuedCount = 0;
    const orchestrator = new BoardOrchestrator({
      boardStore: store,
      maxItems: 2,
      getControlState: () => makeControl("running"),
      getLiveJobState: () => ({ isRunning: false }),
      getOwnerState: () => ({ isMidTurn: false }),
      checkWorkingItemLiveness: createProductionWorkingItemLivenessCheck({
        threadStore: {
          createThread: () => {
            throw new Error("unexpected");
          },
          getThread: async () =>
            makeThreadRecord({
              id: "thread-done-before-crash",
              status: "completed",
              messages: [
                {
                  id: "m-done",
                  role: "assistant",
                  content: "Finished implementation and opened PR #230 (headSha: deadbee).",
                  status: "completed",
                  timestamp: "2026-11-22T00:03:00.000Z",
                },
              ],
            }),
        },
        isThreadLive: () => false,
      }),
      issueAndWait: async () => {
        issuedCount += 1;
        return { status: "completed", threadId: "t-unexpected" };
      },
    });

    const report = await orchestrator.drain();
    assert.equal(issuedCount, 0, "must not re-dispatch an already completed thread");
    assert.equal(report.completedCount, 1);
    assert.equal(report.failedCount, 0);
    assert.equal(report.surfacedCount, 0);
    const after = store.get(item.id)!;
    assert.equal(after.status, "done");
    assert.equal(after.needsAttention, undefined);
  } finally {
    env.cleanup();
  }
});

test("A2: BoardStore persists handoff and autoResumeCount across reloads without clobbering", () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const item = store.create({
      key: "#66",
      title: "Persistence check",
      brief: "Verify fields survive reload.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    store.update(item.id, {
      autoResumeCount: 1,
      handoff: {
        state: "banked chunk 1",
        branch: "feature/drain-recovery",
        headSha: "1234abc",
        nextStep: "Finish step 2",
        openQuestions: ["Check edge case"],
      },
    });

    // Unrelated update (status only, plus explicit undefined fields) must NOT clobber handoff or autoResumeCount
    store.update(item.id, {
      status: "working",
      threadLink: "/?thread=t-persist",
      handoff: undefined,
      autoResumeCount: undefined,
    });

    const reloaded = new BoardStore(env.boardDir).get(item.id);
    assert.equal(reloaded?.status, "working");
    assert.equal(reloaded?.autoResumeCount, 1);
    assert.deepEqual(reloaded?.handoff, {
      state: "banked chunk 1",
      branch: "feature/drain-recovery",
      headSha: "1234abc",
      nextStep: "Finish step 2",
      openQuestions: ["Check edge case"],
    });
  } finally {
    env.cleanup();
  }
});

test("A2: supervisor skips drain-owned threads (boardItemId and BoardStore threadLink) while preserving milestone-task behavior", async () => {
  const env = makeTempEnv();
  try {
    const now = Date.now();
    const staleIso = new Date(now - STALL_WINDOW_MS - 60_000).toISOString();

    // 1. Direct unit proof on superviseStalledThread
    const drainThreadDirect = makeThreadRecord({
      id: "thread-drain-direct",
      boardItemId: "item-direct",
      status: "active",
      updatedAt: staleIso,
      messages: [
        { id: "u1", role: "user", content: "work", timestamp: staleIso },
        {
          id: "a1",
          role: "assistant",
          content: "streaming...",
          status: "streaming",
          timestamp: staleIso,
        },
      ],
    });
    let savedDirect = false;
    let dispatchedDirect = false;
    const adapter: SupervisorThreadAdapter = {
      saveThread: () => {
        savedDirect = true;
      },
      createFreshThread: () => {
        throw new Error("must not create resume thread for drain-owned thread");
      },
      dispatchTurn: () => {
        dispatchedDirect = true;
      },
    };
    const jobStore: SupervisorJobStore = {
      hasBankedState: () => true,
      getAutoResumeCount: () => 0,
      incrementAutoResumeCount: () => 1,
      markNeedsAttention: () => {
        throw new Error("must not mark needs attention for drain-owned thread");
      },
    };

    const directOutcome = superviseStalledThread(drainThreadDirect, {
      now,
      threadAdapter: adapter,
      jobStore,
    });
    assert.equal(directOutcome.action, "skipped_drain_owned");
    assert.equal(savedDirect, false);
    assert.equal(dispatchedDirect, false);
    assert.equal(drainThreadDirect.status, "active");
    assert.equal(drainThreadDirect.messages[1].status, "streaming");

    // 2. End-to-end ThreadStore.sweepStalledThreads with:
    //    - Drain thread A (has boardItemId)
    //    - Drain thread B (legacy: NO boardItemId, linked only via BoardStore.threadLink)
    //    - Milestone-task thread C (taskId + banked runlog, NOT drain-owned)
    const boardStore = new BoardStore(env.boardDir);
    boardStore.create({
      id: "board-legacy-item",
      key: "#67",
      title: "Legacy drain item",
      brief: "Owned by board drain.",
      status: "working",
      threadLink: "/?thread=thread-drain-legacy",
      author: "Owner",
      source: "manual",
    });

    const threadStore = new ThreadStore(env.threadsDir);
    threadStore.stopSupervisorSweep();
    const dispatchedSupervisor: Array<{ threadId: string; prompt: string }> = [];
    threadStore.setSupervisorDispatchTurn((threadId, prompt) => {
      dispatchedSupervisor.push({ threadId, prompt });
    });

    // Write threads directly to disk with stale timestamps
    const writeStale = (thread: Thread) => {
      fs.writeFileSync(
        path.join(env.threadsDir, `${thread.id}.json`),
        JSON.stringify(thread, null, 2),
        "utf8"
      );
      markTurnActive(thread.id);
    };

    writeStale(
      makeThreadRecord({
        id: "thread-drain-marked",
        title: "#68 Marked drain thread",
        boardItemId: "board-marked-item",
        status: "active",
        createdAt: staleIso,
        updatedAt: staleIso,
        messages: [
          { id: "u1", role: "user", content: "drain job", timestamp: staleIso },
          {
            id: "a1",
            role: "assistant",
            content: "working...",
            status: "streaming",
            timestamp: staleIso,
          },
        ],
      })
    );

    writeStale(
      makeThreadRecord({
        id: "thread-drain-legacy",
        title: "#67 Legacy drain thread",
        status: "active",
        createdAt: staleIso,
        updatedAt: staleIso,
        messages: [
          { id: "u1", role: "user", content: "legacy drain job", timestamp: staleIso },
          {
            id: "a1",
            role: "assistant",
            content: "working...",
            status: "streaming",
            timestamp: staleIso,
          },
        ],
      })
    );

    const milestoneJobId = "milestone-job-99";
    const taskDir = path.join(env.threadsDir, "tasks", milestoneJobId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "runlog.md"), "# Banked progress\n", "utf8");

    writeStale(
      makeThreadRecord({
        id: "thread-milestone-task",
        title: "Milestone Task",
        taskId: milestoneJobId,
        autoResumeCount: 0,
        status: "active",
        createdAt: staleIso,
        updatedAt: staleIso,
        messages: [
          { id: "u1", role: "user", content: "milestone work", timestamp: staleIso },
          {
            id: "a1",
            role: "assistant",
            content: "working...",
            status: "streaming",
            timestamp: staleIso,
          },
        ],
      })
    );

    try {
      const acted = await threadStore.sweepStalledThreads(now + STALL_WINDOW_MS + 60_000);
      assert.equal(acted, 1, "only the milestone-task thread should be supervised");

      // Drain-owned threads remain untouched
      const markedAfter = await threadStore.getThread("thread-drain-marked");
      assert.equal(markedAfter?.status, "active");
      assert.equal(markedAfter?.stalledReason, undefined);
      assert.equal(markedAfter?.messages[1]?.status, "streaming");

      const legacyAfter = await threadStore.getThread("thread-drain-legacy");
      assert.equal(legacyAfter?.status, "active");
      assert.equal(legacyAfter?.stalledReason, undefined);
      assert.equal(legacyAfter?.messages[1]?.status, "streaming");

      // Milestone-task thread still gets honest end + auto-resume
      const milestoneAfter = await threadStore.getThread("thread-milestone-task");
      assert.equal(milestoneAfter?.status, "stopped");
      assert.equal(milestoneAfter?.autoResumeCount, 1);
      assert.ok(milestoneAfter?.resumedToThreadId);
      assert.equal(dispatchedSupervisor.length, 1);
      assert.equal(dispatchedSupervisor[0].threadId, milestoneAfter?.resumedToThreadId);
    } finally {
      clearTurnActive("thread-drain-marked");
      clearTurnActive("thread-drain-legacy");
      clearTurnActive("thread-milestone-task");
    }
  } finally {
    env.cleanup();
  }
});

test("A3: stopped job records real assistant error/marker text (never generic HTTP 200) and runs classifyJobSummary before stopped short-circuit", async () => {
  const env = makeTempEnv();
  try {
    const cases = [
      {
        name: "Turn error marker on stopped thread with HTTP 200",
        content: "Ran tests.\n\n⚠️ [Turn error: Tool host_run_powershell is not registered]",
        expectedSubstring: "Tool host_run_powershell is not registered",
        expectedCode: "execution-failed",
      },
      {
        name: "Turn incomplete marker on stopped thread with HTTP 200",
        content: "⚠️ [Turn incomplete: Generation truncated (length).]",
        expectedSubstring: "Generation truncated (length)",
        expectedCode: "execution-failed",
      },
      {
        name: "BLOCKED summary on stopped thread hits classifyJobSummary first",
        content: "**BLOCKED — missing database migration file.**\n\nCannot continue.",
        expectedSubstring: "BLOCKED — missing database migration file",
        expectedCode: "job-blocked",
      },
      {
        name: "Turn ended marker on stopped thread hits classifyJobSummary first",
        content: "Partial progress...\n\n⚠️ [Turn ended: maximum tool rounds reached]",
        expectedSubstring: "maximum tool rounds reached",
        expectedCode: "job-turn-ended",
      },
    ];

    for (const tc of cases) {
      const store = new BoardStore(env.boardDir);
      const item = store.create({
        title: tc.name,
        brief: "Run test case.",
        status: "queued",
        author: "Owner",
        source: "manual",
      });

      const issueAndWait = createProductionIssueAndWait({
        hostCheckoutPath: "/tmp/repo",
        executeHostTool: async () => ({ ok: true, exitCode: 0, stdout: "develop\n" }),
        threadStore: {
          createThread: () => makeThreadRecord({ id: `t-${item.id}`, status: "active" }),
          getThread: async () =>
            makeThreadRecord({
              id: `t-${item.id}`,
              status: "stopped",
              error: undefined,
              messages: [
                {
                  id: "m-err",
                  role: "assistant",
                  content: tc.content,
                  status: "incomplete",
                  timestamp: "2026-11-22T00:00:05.000Z",
                },
              ],
            }),
        },
        dispatchChatTurn: async () => ({ ok: true, status: 200, rawStream: "" }),
      });

      const orchestrator = new BoardOrchestrator({
        boardStore: store,
        maxItems: 1,
        getControlState: () => makeControl("running"),
        getLiveJobState: () => ({ isRunning: false }),
        getOwnerState: () => ({ isMidTurn: false }),
        issueAndWait,
      });

      const report = await orchestrator.drain();
      const after = store.get(item.id)!;
      assert.equal(after.status, "needs-attention", tc.name);
      assert.ok(
        after.parkedReason?.includes(tc.expectedSubstring),
        `${tc.name}: expected parkedReason to include "${tc.expectedSubstring}", got "${after.parkedReason}"`
      );
      assert.ok(
        !after.parkedReason?.includes("HTTP 200"),
        `${tc.name}: parkedReason must NEVER contain generic "(HTTP 200)", got "${after.parkedReason}"`
      );
      assert.equal(report.surfacedIssues[0]?.code, tc.expectedCode, tc.name);
    }
  } finally {
    env.cleanup();
  }
});

test("A3: createProductionBoardOrchestrator wires triageAutoFix for auto-fixable stale git lock failures", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const item = store.create({
      key: "#70",
      title: "Stale git lock recovery",
      brief: "Commit changes.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    fs.writeFileSync(
      path.join(env.boardDir, "board.meta.json"),
      JSON.stringify({ control: makeControl("running") }, null, 2),
      "utf8"
    );

    const threadStore = new ThreadStore(env.threadsDir);
    threadStore.stopSupervisorSweep();

    const hostCommands: string[] = [];
    let dispatchCount = 0;

    const orchestrator = createProductionBoardOrchestrator({
      threadStore,
      maxItems: 1,
      hostCheckoutPath: "/tmp/repo",
      executeHostTool: async (_tool, args) => {
        const cmd = String(args.command ?? "");
        hostCommands.push(cmd);
        return { ok: true, exitCode: 0, stdout: "develop\n" };
      },
      dispatchChatTurn: async ({ threadId }) => {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          threadStore.addMessage(threadId, {
            id: "m-lock",
            role: "assistant",
            content:
              "⚠️ [Turn error: fatal: Unable to create '/tmp/repo/.git/index.lock': File exists.]",
            status: "error",
            timestamp: new Date().toISOString(),
          });
        } else {
          threadStore.addMessage(threadId, {
            id: "m-ok",
            role: "assistant",
            content: "Cleared lock and opened PR #240.",
            status: "completed",
            timestamp: new Date().toISOString(),
          });
        }
        return { ok: true, status: 200, rawStream: "" };
      },
    });

    const report = await orchestrator.drain();
    assert.equal(dispatchCount, 2, "triageAutoFix should clear stale lock and retry once");
    assert.ok(
      hostCommands.some((c) => c.includes("index.lock")),
      `expected triageAutoFix to clear .git/index.lock, saw commands: ${JSON.stringify(hostCommands)}`
    );
    assert.equal(report.completedCount, 1);
    assert.equal(store.get(item.id)?.status, "done");
  } finally {
    env.cleanup();
  }
});

test("A4: chunk-complete settle returns chunk-complete with handoff, persists handoff in BoardStore, and continues on next drain pass", async () => {
  const env = makeTempEnv();
  try {
    const store = new BoardStore(env.boardDir);
    const item = store.create({
      key: "#71",
      title: "Multi-chunk refactor",
      brief: "Refactor large subsystem across two chunks.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });

    const threadStore = new ThreadStore(env.threadsDir);
    threadStore.stopSupervisorSweep();

    const seenBriefs: string[] = [];
    let turnCount = 0;

    const makeOrchestrator = () =>
      new BoardOrchestrator({
        boardStore: new BoardStore(env.boardDir),
        maxItems: 1,
        getControlState: () => makeControl("running"),
        getLiveJobState: () => ({ isRunning: false }),
        getOwnerState: () => ({ isMidTurn: false }),
        issueAndWait: createProductionIssueAndWait({
          hostCheckoutPath: "/tmp/repo",
          checkpointDir: env.checkpointDir,
          executeHostTool: async () => ({ ok: true, exitCode: 0, stdout: "develop\n" }),
          threadStore,
          dispatchChatTurn: async ({ threadId, brief }) => {
            turnCount += 1;
            seenBriefs.push(brief);
            if (turnCount === 1) {
              // Simulate roundLoop banking chunk handoff and settling incomplete with [[CHUNK_COMPLETE]]
              writeMilestoneHandoff(path.join(env.checkpointDir, `${threadId}.handoff.json`), {
                jobId: threadId,
                completedMilestones: [],
                nextMilestone: "Wire chunk 2 verification",
                summary: "Banked chunk 1 edits",
                updatedAt: new Date().toISOString(),
                chunkComplete: true,
                currentState: "Banked chunk 1 edits",
                branch: "feature/multi-chunk",
                headSha: "abc9876",
                nextStep: "Wire chunk 2 verification",
                openQuestions: ["Confirm test gate passes"],
                completedSteps: 25,
              } as Parameters<typeof writeMilestoneHandoff>[1]);
              threadStore.addMessage(threadId, {
                id: "m-chunk-1",
                role: "assistant",
                content: `Banked chunk 1 work.\n\n${TURN_CHUNK_COMPLETE_MARKER}`,
                status: "incomplete",
                timestamp: new Date().toISOString(),
              });
            } else {
              threadStore.addMessage(threadId, {
                id: "m-chunk-2",
                role: "assistant",
                content: "Finished chunk 2 and opened PR #245.",
                status: "completed",
                timestamp: new Date().toISOString(),
              });
            }
            return { ok: true, status: 200, rawStream: "" };
          },
        }),
      });

    // Pass 1 (maxItems: 1): hits chunk-complete, requeues with handoff durably persisted
    const pass1 = await makeOrchestrator().drain();
    assert.equal(pass1.requeuedCount, 1);
    assert.equal(pass1.completedCount, 0);
    assert.equal(pass1.failedCount, 0);
    const afterPass1 = new BoardStore(env.boardDir).get(item.id)!;
    assert.equal(afterPass1.status, "queued");
    assert.deepEqual(afterPass1.handoff, {
      state: "Banked chunk 1 edits",
      branch: "feature/multi-chunk",
      headSha: "abc9876",
      nextStep: "Wire chunk 2 verification",
      openQuestions: ["Confirm test gate passes"],
    });

    // Pass 2 (fresh BoardStore reload): dispatches continuation brief from persisted handoff and completes
    const pass2 = await makeOrchestrator().drain();
    assert.equal(pass2.completedCount, 1);
    assert.equal(turnCount, 2);
    assert.match(seenBriefs[1], /CONTINUATION FROM HANDOFF/i);
    assert.match(seenBriefs[1], /Branch: feature\/multi-chunk/);
    assert.match(seenBriefs[1], /HEAD SHA: abc9876/);
    assert.match(seenBriefs[1], /Next step: Wire chunk 2 verification/);
    const afterPass2 = new BoardStore(env.boardDir).get(item.id)!;
    assert.equal(afterPass2.status, "done");
  } finally {
    env.cleanup();
  }
});

test("R2: evaluateSettledThreadOutcome fails closed when thread is missing or has non-completed status", async () => {
  const okResponse = { ok: true, status: 200, rawStream: "" };

  const missingOutcome = evaluateSettledThreadOutcome({
    thread: null,
    threadId: "thread-missing-r2",
    response: okResponse,
  });
  assert.equal(missingOutcome.status, "failed");
  if (missingOutcome.status === "failed") {
    assert.ok(missingOutcome.error.trim().length > 0);
    assert.match(missingOutcome.error, /Thread missing at settlement/);
    assert.equal(missingOutcome.issue?.code, "execution-failed");
    assert.equal(missingOutcome.issue?.message, missingOutcome.error);
  }

  const nonTerminalStatuses: Array<Thread["status"]> = [
    "paused",
    "active",
    "running",
    "needs_input",
  ];
  for (const status of nonTerminalStatuses) {
    const outcome = evaluateSettledThreadOutcome({
      thread: makeThreadRecord({
        id: `thread-${status}-r2`,
        status,
        messages: [
          {
            id: "m-1",
            role: "assistant",
            content: "Partial output before unexpected non-terminal state.",
            status: "streaming",
            timestamp: "2026-11-23T00:00:00.000Z",
          },
        ],
      }),
      threadId: `thread-${status}-r2`,
      response: okResponse,
    });
    assert.equal(outcome.status, "failed", `status '${status}' must fail closed`);
    if (outcome.status === "failed") {
      assert.ok(outcome.error.trim().length > 0);
      assert.equal(outcome.error, `Unexpected thread status '${status}'`);
      assert.equal(outcome.issue?.code, "execution-failed");
      assert.equal(outcome.issue?.message, outcome.error);
    }
  }

  const failedWithReason = evaluateSettledThreadOutcome({
    thread: makeThreadRecord({
      id: "thread-failed-r2",
      status: "failed",
      error: "Explicit failure reason preserved",
    }),
    threadId: "thread-failed-r2",
    response: okResponse,
  });
  assert.equal(failedWithReason.status, "failed");
  if (failedWithReason.status === "failed") {
    assert.equal(failedWithReason.error, "Explicit failure reason preserved");
  }

  const completedOutcome = evaluateSettledThreadOutcome({
    thread: makeThreadRecord({
      id: "thread-completed-r2",
      status: "completed",
      messages: [
        {
          id: "m-done",
          role: "assistant",
          content: "Opened PR #301.",
          status: "completed",
          timestamp: "2026-11-23T00:00:00.000Z",
        },
      ],
    }),
    threadId: "thread-completed-r2",
    response: okResponse,
  });
  assert.equal(completedOutcome.status, "completed");

  const issueAndWaitMissing = createProductionIssueAndWait({
    hostCheckoutPath: "/tmp/repo",
    executeHostTool: async () => ({ ok: true, exitCode: 0, stdout: "develop\n" }),
    threadStore: {
      createThread: () => makeThreadRecord({ id: "thread-deleted-midrun", status: "active" }),
      getThread: async () => null,
    },
    dispatchChatTurn: async () => okResponse,
  });
  const deletedMidRun = await issueAndWaitMissing({
    item: {
      id: "item-deleted-r2",
      key: "#90",
      title: "Deleted thread mid-run",
      brief: "Do work.",
      status: "queued",
      dependencies: [],
      author: "Owner",
      source: "manual",
      createdAt: "2026-11-23T00:00:00.000Z",
      updatedAt: "2026-11-23T00:00:00.000Z",
    },
    brief: "Do work.",
  });
  assert.equal(deletedMidRun.status, "failed");
  if (deletedMidRun.status === "failed") {
    assert.match(deletedMidRun.error, /Thread missing at settlement/);
  }
});

test("R7: concurrent POST /api/board/drain calls deduplicate via shared globalThis.__boardDrainInFlight mutex", async () => {
  const env = makeTempEnv();
  const g = globalThis as typeof globalThis & { __boardDrainInFlight?: Promise<unknown> | null };
  const prevMutex = g.__boardDrainInFlight;
  try {
    const store = new BoardStore(env.boardDir);
    store.create({
      key: "#91",
      title: "Mutex test item",
      brief: "Verify concurrent drains deduplicate.",
      status: "queued",
      author: "Owner",
      source: "manual",
    });
    fs.writeFileSync(
      path.join(env.boardDir, "board.meta.json"),
      JSON.stringify({ version: 2, control: makeControl("running") }, null, 2),
      "utf8"
    );

    const { POST: drainPost } = await import("../app/api/board/drain/route");
    const { NextRequest } = await import("next/server");

    // 1. Simulate an in-flight daemon/leader drain via globalThis.__boardDrainInFlight
    let releaseLeader!: () => void;
    const leaderGate = new Promise<void>((resolve) => {
      releaseLeader = resolve;
    });
    const sharedReport = {
      drainId: "drain-shared-leader",
      startedAt: "2026-11-24T00:00:00.000Z",
      completedAt: "2026-11-24T00:00:01.000Z",
      durationMs: 1000,
      stopReason: "idle",
      completedCount: 0,
      failedCount: 0,
      inProgressCount: 0,
      requeuedCount: 0,
      surfacedCount: 0,
      itemsProcessed: 0,
      outcomes: [],
      surfacedIssues: [],
      slotUtilization: {
        generatingMs: 0,
        waitingToolMs: 0,
        waitingCiMs: 0,
        idleGapMs: 0,
        totalObservedMs: 0,
        slotUtilizationPct: 0,
        preemptionsCount: 0,
        ownerWaitMs: { p50: 0, p95: 0, count: 0 },
        completedJobs: 0,
        jobsPerHour: 0,
      },
    };
    g.__boardDrainInFlight = (async () => {
      await leaderGate;
      return sharedReport;
    })();

    const req = new NextRequest("http://localhost/api/board/drain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true, maxItems: 1 }),
    });
    const pendingRes = drainPost(req);
    await new Promise((r) => setTimeout(r, 15));
    releaseLeader();
    const res = await pendingRes;
    assert.equal(res.status, 200);
    const body = (await res.json()) as { report?: { drainId?: string }; deduplicated?: boolean };
    assert.equal(
      body.report?.drainId,
      "drain-shared-leader",
      "POST /api/board/drain must coalesce onto globalThis.__boardDrainInFlight"
    );
    assert.equal(body.deduplicated, true);

    // 2. Also verify SchedulerDaemon skips tick when globalThis.__boardDrainInFlight is active
    const { SchedulerDaemon } = await import("../lib/subagents/schedulerDaemon");
    const { UnattendedScheduler } = await import("../lib/subagents/scheduler");
    let daemonDrainCalls = 0;
    let releaseDaemonGate!: () => void;
    const daemonGate = new Promise<void>((resolve) => {
      releaseDaemonGate = resolve;
    });
    g.__boardDrainInFlight = daemonGate;
    const daemon = new SchedulerDaemon({
      workspaceDir: env.rootDir,
      scheduler: new UnattendedScheduler({ workspaceDir: env.rootDir }),
      registerSignalHandlers: false,
      boardDrain: {
        isRunning: () => true,
        drain: async () => {
          daemonDrainCalls += 1;
        },
      },
    });
    await daemon.tick();
    assert.equal(
      daemonDrainCalls,
      0,
      "SchedulerDaemon must skip drain when globalThis.__boardDrainInFlight is active"
    );
    releaseDaemonGate();
  } finally {
    if (prevMutex === undefined) delete g.__boardDrainInFlight;
    else g.__boardDrainInFlight = prevMutex;
    env.cleanup();
  }
});

test("R7: POST /api/threads/[id] re-reads thread JSON after awaits instead of writing stale snapshots", async () => {
  const env = makeTempEnv();
  try {
    const threadStore = new ThreadStore(env.threadsDir);
    threadStore.stopSupervisorSweep();
    const created = threadStore.createThread({
      id: "thread-rmw-1",
      title: "Original title",
    });

    const { POST: threadPost } = await import("../app/api/threads/[id]/route");

    // Simulate a concurrent message write happening while await req.json() yields
    const req = {
      json: async () => {
        threadStore.addMessage(created.id, {
          id: "msg-concurrent",
          role: "assistant",
          content: "Concurrent streamed message",
          status: "completed",
          timestamp: new Date().toISOString(),
        });
        return { action: "rename", title: "Renamed title" };
      },
    } as unknown as Request;

    const res = await threadPost(req, { params: Promise.resolve({ id: created.id }) });
    assert.equal(res.status, 200);

    const onDisk = await threadStore.getThread(created.id);
    assert.equal(onDisk?.title, "Renamed title");
    assert.ok(
      onDisk?.messages.some((m) => m.id === "msg-concurrent"),
      "concurrently appended message must not be erased by stale RMW"
    );
  } finally {
    env.cleanup();
  }
});

test("R8: non-live paused/running/needs_input threads are treated as orphaned, ThreadStore reconciles running, and host_git_pr_create + git_commit match evidence", async () => {
  const env = makeTempEnv();
  try {
    for (const status of ["paused", "running", "needs_input"] as const) {
      const check = createProductionWorkingItemLivenessCheck({
        threadStore: {
          createThread: () => {
            throw new Error("unexpected");
          },
          getThread: async () =>
            makeThreadRecord({
              id: `t-nonlive-${status}`,
              status,
              messages: [
                {
                  id: "m1",
                  role: "assistant",
                  content: "Executed host_git_pr_create before interruption.",
                  status: "incomplete",
                  timestamp: "2026-11-24T00:00:00.000Z",
                  traces: [
                    {
                      tool: "host_git_pr_create",
                      args: {},
                      result: "Created PR #355",
                    } as never,
                  ],
                },
              ],
            }),
        },
        isThreadLive: () => false,
      });

      const liveness = await check({
        id: `item-${status}`,
        key: "#92",
        title: `Non-live ${status}`,
        brief: "Work",
        dependencies: [],
        status: "working",
        threadLink: `/?thread=t-nonlive-${status}`,
        author: "Owner",
        source: "manual",
        createdAt: "2026-11-24T00:00:00.000Z",
        updatedAt: "2026-11-24T00:00:00.000Z",
      });
      assert.equal(
        liveness.status,
        "orphaned",
        `non-live thread with status '${status}' must be orphaned, not live`
      );
      if (liveness.status === "orphaned") {
        assert.equal(
          liveness.evidence?.hasPrOrCommitEvidence,
          true,
          "host_git_pr_create trace must count as PR/commit evidence"
        );
        assert.match(liveness.evidence?.evidenceSummary ?? "", /PR #355/);
      }
    }

    // Also verify git_commit trace matches evidence
    const checkGitCommit = createProductionWorkingItemLivenessCheck({
      threadStore: {
        createThread: () => {
          throw new Error("unexpected");
        },
        getThread: async () =>
          makeThreadRecord({
            id: "t-git-commit-trace",
            status: "stopped",
            messages: [
              {
                id: "m1",
                role: "assistant",
                content: "Committed changes.",
                status: "incomplete",
                timestamp: "2026-11-24T00:00:00.000Z",
                traces: [
                  {
                    tool: "git_commit",
                    args: {},
                    result: { ok: true },
                  } as never,
                ],
              },
            ],
          }),
      },
      isThreadLive: () => false,
    });
    const gitCommitLiveness = await checkGitCommit({
      id: "item-git-commit",
      key: "#93",
      title: "git_commit trace",
      brief: "Work",
      dependencies: [],
      status: "working",
      threadLink: "/?thread=t-git-commit-trace",
      author: "Owner",
      source: "manual",
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    });
    assert.equal(gitCommitLiveness.status, "orphaned");
    if (gitCommitLiveness.status === "orphaned") {
      assert.equal(gitCommitLiveness.evidence?.hasPrOrCommitEvidence, true);
    }

    // ThreadStore.reconcileThread reconciles dead "running" threads
    const ts = new ThreadStore(env.threadsDir);
    ts.stopSupervisorSweep();
    const deadRunning = makeThreadRecord({ id: "t-dead-running", status: "running" });
    const changed = ts.reconcileThread(deadRunning);
    assert.equal(changed, true);
    assert.equal(deadRunning.status, "stopped");
  } finally {
    env.cleanup();
  }
});

test("R8: resolveChunkRunlogPath writes under PVC AGENT_CHECKPOINT_DIR when worktree is null", async () => {
  const env = makeTempEnv();
  try {
    const jobChunking = await import("../lib/jobChunking");
    const resolveChunkRunlogPath = (
      jobChunking as {
        resolveChunkRunlogPath?: (opts: {
          worktreePath?: string | null;
          jobId: string;
          checkpointDir?: string;
        }) => string;
      }
    ).resolveChunkRunlogPath;
    assert.ok(
      typeof resolveChunkRunlogPath === "function",
      "resolveChunkRunlogPath must be exported"
    );

    const runlogNoWorktree = resolveChunkRunlogPath({
      worktreePath: null,
      jobId: "job-pvc-1",
      checkpointDir: env.checkpointDir,
    });
    assert.ok(
      runlogNoWorktree.startsWith(env.checkpointDir),
      `expected runlog path under AGENT_CHECKPOINT_DIR (${env.checkpointDir}), got ${runlogNoWorktree}`
    );

    const runlogWithWorktree = resolveChunkRunlogPath({
      worktreePath: "/tmp/wt-1",
      jobId: "job-wt-1",
      checkpointDir: env.checkpointDir,
    });
    assert.equal(runlogWithWorktree, path.join("/tmp/wt-1", "docs/internal/queue-steer-runlog.md"));
  } finally {
    env.cleanup();
  }
});
