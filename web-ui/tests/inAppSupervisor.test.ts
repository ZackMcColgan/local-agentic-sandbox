import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STALL_WINDOW_MS,
  MAX_AUTO_RESUMES,
  detectStalledTurn,
  endStalledTurnHonestly,
  superviseStalledThread,
  buildRegroundingBrief,
  type SupervisorJobStore,
  type SupervisorThreadAdapter,
} from "../lib/threads/inAppSupervisor";
import type { Thread } from "../lib/threads/threadStore";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  const now = Date.now();
  return {
    id: overrides.id ?? "thread-1",
    title: overrides.title ?? "Test Thread",
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? new Date(now - 20 * 60_000).toISOString(),
    updatedAt: overrides.updatedAt ?? new Date(now - 15 * 60_000).toISOString(),
    messages: overrides.messages ?? [
      {
        id: "msg-user-1",
        role: "user",
        content: "Run the job",
        timestamp: new Date(now - 20 * 60_000).toISOString(),
      },
      {
        id: "msg-asst-1",
        role: "assistant",
        content: "Working on step 1...",
        status: "streaming",
        timestamp: new Date(now - 15 * 60_000).toISOString(),
      },
    ],
    ...overrides,
  };
}

function makeMemoryAdapters(initialThreads: Thread[], bankedJobs: Set<string> = new Set()) {
  const threads = new Map<string, Thread>(initialThreads.map((t) => [t.id, structuredClone(t)]));
  const jobResumeCounts = new Map<string, number>();
  const jobNeedsAttention = new Map<string, boolean>();
  const createdThreads: Thread[] = [];
  const dispatchedTurns: Array<{ threadId: string; prompt: string }> = [];

  const threadAdapter: SupervisorThreadAdapter = {
    saveThread: (t) => {
      threads.set(t.id, structuredClone(t));
    },
    createFreshThread: ({ title, taskId, resumedFromThreadId }) => {
      const fresh: Thread = {
        id: `thread-fresh-${createdThreads.length + 1}`,
        title,
        status: "active",
        taskId,
        resumedFromThreadId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      };
      threads.set(fresh.id, fresh);
      createdThreads.push(fresh);
      return fresh;
    },
    dispatchTurn: (threadId, prompt) => {
      dispatchedTurns.push({ threadId, prompt });
    },
  };

  const jobStore: SupervisorJobStore = {
    hasBankedState: (jobId) => bankedJobs.has(jobId),
    getAutoResumeCount: (jobId) => jobResumeCounts.get(jobId) ?? 0,
    incrementAutoResumeCount: (jobId) => {
      const next = (jobResumeCounts.get(jobId) ?? 0) + 1;
      jobResumeCounts.set(jobId, next);
      return next;
    },
    markNeedsAttention: (jobId, reason) => {
      jobNeedsAttention.set(jobId, true);
      void reason;
    },
  };

  return { threads, createdThreads, dispatchedTurns, jobResumeCounts, jobNeedsAttention, threadAdapter, jobStore };
}

describe("inAppSupervisor — 1. Stall detection", () => {
  it("flags streaming turn with activity older than STALL_WINDOW_MS as stalled", () => {
    const now = Date.now();
    const thread = makeThread({
      status: "active",
      updatedAt: new Date(now - STALL_WINDOW_MS - 1_000).toISOString(),
    });
    const result = detectStalledTurn(thread, now);
    assert.equal(result.stalled, true);
    assert.ok(result.inactiveMs > STALL_WINDOW_MS);
  });

  it("does not flag streaming turn with fresh activity", () => {
    const now = Date.now();
    const thread = makeThread({
      status: "active",
      updatedAt: new Date(now - 30_000).toISOString(),
    });
    const result = detectStalledTurn(thread, now);
    assert.equal(result.stalled, false);
  });

  it("never flags a completed turn", () => {
    const now = Date.now();
    const thread = makeThread({
      status: "completed",
      updatedAt: new Date(now - STALL_WINDOW_MS - 60_000).toISOString(),
      messages: [
        {
          id: "msg-asst-1",
          role: "assistant",
          content: "Done.",
          status: "completed",
          timestamp: new Date(now - STALL_WINDOW_MS - 60_000).toISOString(),
        },
      ],
    });
    const result = detectStalledTurn(thread, now);
    assert.equal(result.stalled, false);
  });
});

describe("inAppSupervisor — 2. Honest end", () => {
  it("ends a stalled turn with a clear stalled marker and no longer reads streaming", () => {
    const now = Date.now();
    const thread = makeThread({
      status: "active",
      updatedAt: new Date(now - STALL_WINDOW_MS - 5_000).toISOString(),
    });
    const ended = endStalledTurnHonestly(thread, now);
    assert.equal(ended, true);
    assert.notEqual(thread.status, "active");
    assert.notEqual(thread.status, "running");
    assert.notEqual(thread.status, "completed");
    assert.ok(thread.stalledReason && thread.stalledReason.toLowerCase().includes("no activity"));
    const lastMsg = thread.messages[thread.messages.length - 1];
    assert.notEqual(lastMsg.status, "streaming");
    assert.ok(lastMsg.content.includes("Turn stalled"));
  });
});

describe("inAppSupervisor — 3. Bounded auto-resume", () => {
  it("issues exactly one resume turn in a fresh thread with re-grounding brief when job has banked state", () => {
    const now = Date.now();
    const thread = makeThread({
      id: "job-thread-1",
      taskId: "job-123",
      status: "active",
      updatedAt: new Date(now - STALL_WINDOW_MS - 5_000).toISOString(),
    });
    const { createdThreads, dispatchedTurns, jobResumeCounts, threadAdapter, jobStore } = makeMemoryAdapters(
      [thread],
      new Set(["job-123"])
    );

    const outcome = superviseStalledThread(thread, { now, threadAdapter, jobStore });
    assert.equal(outcome.action, "resumed");
    assert.equal(createdThreads.length, 1);
    assert.equal(dispatchedTurns.length, 1);
    assert.equal(dispatchedTurns[0].threadId, createdThreads[0].id);
    assert.match(dispatchedTurns[0].prompt, /runlog/i);
    assert.match(dispatchedTurns[0].prompt, /git log/i);
    assert.match(dispatchedTurns[0].prompt, /never.*restart|do not restart/i);
    assert.equal(jobResumeCounts.get("job-123"), 1);
  });

  it("allows second stall -> second resume, then third stall -> no resume + needsAttention", () => {
    assert.equal(MAX_AUTO_RESUMES, 2);
    const now = Date.now();
    const t1 = makeThread({ id: "t1", taskId: "job-cap", updatedAt: new Date(now - STALL_WINDOW_MS - 1_000).toISOString() });
    const { createdThreads, dispatchedTurns, jobNeedsAttention, threadAdapter, jobStore } = makeMemoryAdapters(
      [t1],
      new Set(["job-cap"])
    );

    // 1st stall -> resume 1
    const r1 = superviseStalledThread(t1, { now, threadAdapter, jobStore });
    assert.equal(r1.action, "resumed");
    assert.equal(createdThreads.length, 1);

    // 2nd stall -> resume 2
    const t2 = makeThread({ id: createdThreads[0].id, taskId: "job-cap", updatedAt: new Date(now - STALL_WINDOW_MS - 1_000).toISOString() });
    const r2 = superviseStalledThread(t2, { now, threadAdapter, jobStore });
    assert.equal(r2.action, "resumed");
    assert.equal(createdThreads.length, 2);
    assert.equal(dispatchedTurns.length, 2);

    // 3rd stall -> cap reached, no resume, needsAttention surfaced
    const t3 = makeThread({ id: createdThreads[1].id, taskId: "job-cap", updatedAt: new Date(now - STALL_WINDOW_MS - 1_000).toISOString() });
    const r3 = superviseStalledThread(t3, { now, threadAdapter, jobStore });
    assert.equal(r3.action, "needs_attention");
    assert.equal(createdThreads.length, 2);
    assert.equal(dispatchedTurns.length, 2);
    assert.equal(t3.needsAttention, true);
    assert.equal(jobNeedsAttention.get("job-cap"), true);
  });

  it("does not auto-resume when there is no banked state and surfaces needsAttention", () => {
    const now = Date.now();
    const thread = makeThread({
      id: "job-no-bank",
      taskId: "job-empty",
      updatedAt: new Date(now - STALL_WINDOW_MS - 1_000).toISOString(),
    });
    const { createdThreads, dispatchedTurns, jobNeedsAttention, threadAdapter, jobStore } = makeMemoryAdapters(
      [thread],
      new Set()
    );

    const outcome = superviseStalledThread(thread, { now, threadAdapter, jobStore });
    assert.equal(outcome.action, "needs_attention");
    assert.equal(createdThreads.length, 0);
    assert.equal(dispatchedTurns.length, 0);
    assert.equal(thread.needsAttention, true);
    assert.equal(jobNeedsAttention.get("job-empty"), true);
  });

  it("never auto-resumes an interactive owner turn", () => {
    const now = Date.now();
    const thread = makeThread({
      id: "owner-turn-1",
      taskId: undefined,
      updatedAt: new Date(now - STALL_WINDOW_MS - 1_000).toISOString(),
    });
    const { createdThreads, dispatchedTurns, threadAdapter, jobStore } = makeMemoryAdapters([thread], new Set());

    const outcome = superviseStalledThread(thread, { now, threadAdapter, jobStore });
    assert.equal(outcome.action, "ended_only");
    assert.equal(createdThreads.length, 0);
    assert.equal(dispatchedTurns.length, 0);
  });

  it("buildRegroundingBrief instructs reading runlog and git log first", () => {
    const brief = buildRegroundingBrief("job-xyz", 1);
    assert.match(brief, /runlog/i);
    assert.match(brief, /git log/i);
    assert.match(brief, /job-xyz/);
  });
});
