import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { OvernightSupervisor } from "../lib/subagents/supervisor";
import { TaskManifest } from "../lib/subagents/types";
import { setPlanSpecGenerator } from "../lib/subagents/planner";
import { POST as postThreads } from "../app/api/threads/route";
import { POST as postThreadAction } from "../app/api/threads/[id]/route";
import { ThreadStore } from "../lib/threads/threadStore";

function makeTempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("AUD-04: test:gate before completion stamp, terminal evidence, and planning abort", () => {
  let tmpCheckpoints: string;
  let tmpThreads: string;
  let prevThreadsDir: string | undefined;

  beforeEach(() => {
    tmpCheckpoints = makeTempDir("aud04-ckpt");
    tmpThreads = makeTempDir("aud04-threads");
    prevThreadsDir = process.env.THREADS_DIR;
    process.env.THREADS_DIR = tmpThreads;
  });

  afterEach(() => {
    setPlanSpecGenerator(null);
    if (prevThreadsDir === undefined) {
      delete process.env.THREADS_DIR;
    } else {
      process.env.THREADS_DIR = prevThreadsDir;
    }
    fs.rmSync(tmpCheckpoints, { recursive: true, force: true });
    fs.rmSync(tmpThreads, { recursive: true, force: true });
  });

  it("(a) failed test:gate blocks completed status, runs before stamp, and records gate gap", async () => {
    const supervisor = new OvernightSupervisor({
      checkpointDirectory: tmpCheckpoints,
      stallTimeoutMs: 10_000,
    });

    const task: TaskManifest = {
      taskId: `aud04-gate-fail-${Date.now()}`,
      goal: "Verify gate failure blocks completion stamp",
      toolchain: "node:22",
      branchName: "feat/aud04-gate-fail",
      status: "active",
      gitOpsBranchCreated: true,
      milestones: [
        {
          id: "M1",
          title: "Milestone 1",
          description: "Complete work",
          acceptanceCriteria: [{ id: "AC-1", assertion: "Done" }],
          status: "pending",
          builderIterations: 0,
          criticRounds: 0,
        },
      ],
      currentMilestoneIndex: 0,
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    let statusWhenGateRan: string | undefined;
    let stampWhenGateRan: string | undefined;

    const fakeGitOps: any = {
      ensureTaskBranch: async () => ({ success: true, branchName: task.branchName }),
      runGateTest: async () => ({ exitCode: 1, stdout: "", stderr: "gate failed" }),
      isPushConfigured: async () => ({ configured: false, reason: "test" }),
      pushBranch: async () => ({ success: false }),
    };

    const result = await supervisor.executeTaskWithRecovery(task, {
      gitOps: fakeGitOps,
      gateRunner: async () => {
        statusWhenGateRan = task.status;
        stampWhenGateRan = task.completionStamp;
        return { exitCode: 1, stdout: "", stderr: "1 test failed in test:gate" };
      },
      stepExecutor: async () => ({
        status: "completed",
        gitSha: "abc1234",
        builderIterations: 1,
        criticRounds: 1,
      }),
    });

    assert.notEqual(statusWhenGateRan, "completed", "test:gate must run BEFORE task.status is stamped completed");
    assert.equal(stampWhenGateRan, undefined, "test:gate must run BEFORE completionStamp is written");
    assert.equal(result.gatePassed, false, "gatePassed must be false");
    assert.notEqual(result.status, "completed", "failed gate must never leave task status as completed");
    assert.equal(result.status, "failed", "failed gate must transition task to failed");
    assert.equal(result.completionStamp, "completed-unverified", "completionStamp must be completed-unverified on gate failure");
    assert.ok(
      Array.isArray(result.verificationGaps) && result.verificationGaps.some((g) => g.kind === "gate"),
      "verificationGaps must include a gate gap"
    );
  });

  it("(b) terminal thread message carries completionStamp and verificationGaps on gate failure", async () => {
    const origExecute = OvernightSupervisor.prototype.executeTaskWithRecovery;
    OvernightSupervisor.prototype.executeTaskWithRecovery = async function (task: TaskManifest) {
      task.gatePassed = false;
      task.status = "failed";
      task.completionStamp = "completed-unverified";
      task.verificationGaps = [
        {
          kind: "gate",
          claim: "test:gate",
          checked: "persisted gate result",
          found: "gate did not pass",
        },
      ];
      task.errorSummary = "Pre-merge gate test:gate failed with exit code 1.";
      return task;
    };

    setPlanSpecGenerator(async (input) => ({
      taskId: input.taskId || "t-1",
      goal: input.goal,
      toolchain: input.toolchain || "node:22",
      complexity: "SINGLE_ARTIFACT",
      milestones: [
        {
          id: "M1",
          title: "Single step",
          description: "Single step",
          acceptanceCriteria: [{ id: "AC-1", assertion: "ok" }],
          status: "pending",
          builderIterations: 0,
          criticRounds: 0,
        },
      ],
      toMarkdown: () => "# Plan",
    }));

    try {
      const req = new Request("http://localhost:3000/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Run a task whose gate fails", action: "launchTask" }),
      });
      const res = await postThreads(req);
      assert.ok(res.status === 200 || res.status === 201);
      const data = await res.json();
      const threadId = data.thread?.id || data.threadId;
      assert.ok(threadId, "response must include threadId");

      const store = new ThreadStore(tmpThreads);
      let terminalMsg: any = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const t = await store.getThread(threadId);
        if (t && t.status === "failed") {
          terminalMsg = [...t.messages].reverse().find((m) => m.role === "assistant" && m.id.endsWith("-term"));
          if (terminalMsg) break;
        }
        await new Promise((r) => setTimeout(r, 30));
      }

      assert.ok(terminalMsg, "terminal assistant message must be recorded");
      assert.equal(terminalMsg.completionStamp, "completed-unverified", "terminal message must carry completionStamp");
      assert.ok(
        Array.isArray(terminalMsg.verificationGaps) && terminalMsg.verificationGaps.some((g: any) => g.kind === "gate"),
        "terminal message must carry verificationGaps with the gate failure"
      );
    } finally {
      OvernightSupervisor.prototype.executeTaskWithRecovery = origExecute;
    }
  });

  it("(c) Stop during planning aborts planning promptly and never launches execution or stamps completed", async () => {
    let executeCalled = false;
    let planStartedResolve!: () => void;
    const planStarted = new Promise<void>((resolve) => {
      planStartedResolve = resolve;
    });
    let releasePlan!: () => void;
    const planHold = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });

    const origExecute = OvernightSupervisor.prototype.executeTaskWithRecovery;
    OvernightSupervisor.prototype.executeTaskWithRecovery = async function (task: TaskManifest) {
      executeCalled = true;
      task.status = "completed";
      return task;
    };

    setPlanSpecGenerator(async (input) => {
      planStartedResolve();
      await planHold;
      return {
        taskId: input.taskId || "t-2",
        goal: input.goal,
        toolchain: input.toolchain || "node:22",
        complexity: "SINGLE_ARTIFACT",
        milestones: [
          {
            id: "M1",
            title: "Should never run",
            description: "Should never run",
            acceptanceCriteria: [{ id: "AC-1", assertion: "ok" }],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0,
          },
        ],
        toMarkdown: () => "# Plan",
      };
    });

    try {
      const req = new Request("http://localhost:3000/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Long planning task to abort", action: "launchTask" }),
      });
      const res = await postThreads(req);
      assert.ok(res.status === 200 || res.status === 201);
      const data = await res.json();
      const threadId = data.thread?.id || data.threadId;
      assert.ok(threadId, "response must include threadId");

      // Wait until planning is actively in flight
      await planStarted;

      // User clicks Stop during planning
      const stopReq = new Request(`http://localhost:3000/api/threads/${threadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      const stopRes = await postThreadAction(stopReq, { params: Promise.resolve({ id: threadId }) });
      assert.equal(stopRes.status, 200);

      // Give abort handler a moment to settle BEFORE releasing the stuck planner promise
      const store = new ThreadStore(tmpThreads);
      let settledStopped = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const t = await store.getThread(threadId);
        if (t && t.status === "stopped" && t.messages.some((m) => /abort|cancel/i.test(m.content))) {
          settledStopped = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 30));
      }

      // Now release the underlying planner promise to ensure it cannot later stamp completed
      releasePlan();
      await new Promise((r) => setTimeout(r, 100));

      const finalThread = await store.getThread(threadId);
      assert.ok(settledStopped, "Stop during planning must abort planning promptly before planner resolves");
      assert.equal(executeCalled, false, "executeTaskWithRecovery must NOT be called after Stop during planning");
      assert.notEqual(finalThread?.status, "completed", "thread must never be stamped completed after Stop");
    } finally {
      releasePlan();
      OvernightSupervisor.prototype.executeTaskWithRecovery = origExecute;
    }
  });
});
