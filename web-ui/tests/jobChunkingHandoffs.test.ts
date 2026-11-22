import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  DEFAULT_CHUNK_MAX_ROUNDS,
  DEFAULT_CHUNK_MAX_DURATION_MS,
  TURN_CHUNK_COMPLETE_MARKER,
  evaluateChunkBudget,
  bankAndWriteChunkHandoff,
  runChunkedJobLoop,
  continueJobFromHandoff,
  resolveSupervisorChunkResume,
  handleLiveTurnChunkBudget,
  resolveThreadChunkBudget,
  resolveChunkHandoffTarget,
  type ChunkHandoffBrief,
} from "../lib/jobChunking";
import { readMilestoneHandoff } from "../lib/subagents/finishVerificationGate";
import { getCanonicalCheckpointDir } from "../lib/subagents/supervisor";

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chunking-test-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# init\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
  return dir;
}

test("(a) fixture job hitting round budget banks commit + complete handoff and ends chunk-complete", async () => {
  const repoDir = initTempGitRepo();
  const handoffPath = path.join(repoDir, ".handoff.json");
  const runlogPath = path.join(repoDir, "runlog.md");

  try {
    const result = await runChunkedJobLoop({
      jobId: "job-round-budget",
      workspaceRoot: repoDir,
      handoffPath,
      runlogPath,
      budget: { maxRounds: 3, maxDurationMs: 60_000 },
      totalSteps: 5,
      stepExecutor: async (stepIndex) => {
        fs.writeFileSync(
          path.join(repoDir, `step-${stepIndex}.txt`),
          `step ${stepIndex}\n`,
          "utf8"
        );
        return {
          currentState: `completed step ${stepIndex}`,
          nextStep: `step ${stepIndex + 1}`,
          openQuestions: [],
        };
      },
    });

    assert.equal(result.endState, "chunk-complete");
    assert.equal(result.marker, TURN_CHUNK_COMPLETE_MARKER);
    assert.ok(result.handoff, "handoff should be written");
    assert.equal(result.handoff.currentState.length > 0, true);
    assert.equal(result.handoff.branch.length > 0, true);
    assert.equal(result.handoff.headSha.length >= 7, true);
    assert.equal(result.handoff.nextStep.length > 0, true);
    assert.ok(Array.isArray(result.handoff.openQuestions));

    const persisted = readMilestoneHandoff(handoffPath) as ChunkHandoffBrief | null;
    assert.ok(persisted);
    assert.equal(persisted.headSha, result.handoff.headSha);
    assert.ok(fs.existsSync(runlogPath), "runlog entry should be appended");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("(b) fixture job hitting time budget banks commit + complete handoff and ends chunk-complete", async () => {
  const repoDir = initTempGitRepo();
  const handoffPath = path.join(repoDir, ".handoff.json");
  const runlogPath = path.join(repoDir, "runlog.md");
  let fakeNow = 1_000_000;

  try {
    const result = await runChunkedJobLoop({
      jobId: "job-time-budget",
      workspaceRoot: repoDir,
      handoffPath,
      runlogPath,
      budget: { maxRounds: 25, maxDurationMs: 1000 },
      now: () => fakeNow,
      totalSteps: 5,
      stepExecutor: async (stepIndex) => {
        fakeNow += 600; // 2 steps -> 1200ms > 1000ms
        fs.writeFileSync(
          path.join(repoDir, `time-step-${stepIndex}.txt`),
          `step ${stepIndex}\n`,
          "utf8"
        );
        return {
          currentState: `time step ${stepIndex}`,
          nextStep: `step ${stepIndex + 1}`,
          openQuestions: ["check timing"],
        };
      },
    });

    assert.equal(result.endState, "chunk-complete");
    assert.equal(result.marker, TURN_CHUNK_COMPLETE_MARKER);
    assert.ok(result.handoff);
    assert.equal(result.handoff.openQuestions[0], "check timing");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("(c) job under budget runs to normal completion with no handoff and no chunk-complete marker", async () => {
  const repoDir = initTempGitRepo();
  const handoffPath = path.join(repoDir, ".handoff.json");
  const runlogPath = path.join(repoDir, "runlog.md");

  try {
    const result = await runChunkedJobLoop({
      jobId: "job-under-budget",
      workspaceRoot: repoDir,
      handoffPath,
      runlogPath,
      budget: { maxRounds: 10, maxDurationMs: 60_000 },
      totalSteps: 3,
      stepExecutor: async (stepIndex) => {
        fs.writeFileSync(path.join(repoDir, `ok-${stepIndex}.txt`), `ok ${stepIndex}\n`, "utf8");
        return {
          currentState: `ok ${stepIndex}`,
          nextStep: `step ${stepIndex + 1}`,
          openQuestions: [],
        };
      },
    });

    assert.equal(result.endState, "completed");
    assert.equal(result.marker, undefined);
    assert.equal(result.handoff, undefined);
    assert.equal(fs.existsSync(handoffPath), false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("(d) marathon-opt-out job exceeds default budget without chunking", async () => {
  const evalDefault = evaluateChunkBudget(DEFAULT_CHUNK_MAX_ROUNDS, 0, {});
  assert.equal(evalDefault.exceeded, true);
  assert.equal(evalDefault.reason, "rounds");

  const evalOptOut = evaluateChunkBudget(
    DEFAULT_CHUNK_MAX_ROUNDS + 10,
    DEFAULT_CHUNK_MAX_DURATION_MS + 10_000,
    {
      marathonOptOut: true,
    }
  );
  assert.equal(evalOptOut.exceeded, false);
  assert.equal(evalOptOut.reason, null);
});

test("(e) continuation from banked handoff reaches the same gate result as uninterrupted run", async () => {
  const uninterruptedRepo = initTempGitRepo();
  const chunkedRepo = initTempGitRepo();
  const handoffPath = path.join(chunkedRepo, ".handoff.json");
  const runlogPath = path.join(chunkedRepo, "runlog.md");

  try {
    const uninterrupted = await runChunkedJobLoop({
      jobId: "job-uninterrupted",
      workspaceRoot: uninterruptedRepo,
      handoffPath: path.join(uninterruptedRepo, ".handoff.json"),
      runlogPath: path.join(uninterruptedRepo, "runlog.md"),
      budget: { marathonOptOut: true },
      totalSteps: 4,
      stepExecutor: async (stepIndex) => {
        fs.writeFileSync(
          path.join(uninterruptedRepo, `artifact-${stepIndex}.txt`),
          `val-${stepIndex}\n`,
          "utf8"
        );
        return {
          currentState: `step ${stepIndex}`,
          nextStep: `step ${stepIndex + 1}`,
          openQuestions: [],
        };
      },
    });

    const firstChunk = await runChunkedJobLoop({
      jobId: "job-chunked",
      workspaceRoot: chunkedRepo,
      handoffPath,
      runlogPath,
      budget: { maxRounds: 2, maxDurationMs: 60_000 },
      totalSteps: 4,
      stepExecutor: async (stepIndex) => {
        fs.writeFileSync(
          path.join(chunkedRepo, `artifact-${stepIndex}.txt`),
          `val-${stepIndex}\n`,
          "utf8"
        );
        return {
          currentState: `step ${stepIndex}`,
          nextStep: `step ${stepIndex + 1}`,
          openQuestions: [],
        };
      },
    });
    assert.equal(firstChunk.endState, "chunk-complete");

    const continuation = await continueJobFromHandoff({
      handoffPath,
      workspaceRoot: chunkedRepo,
      runlogPath,
      budget: { maxRounds: 10, maxDurationMs: 60_000 },
      totalSteps: 4,
      stepExecutor: async (stepIndex) => {
        fs.writeFileSync(
          path.join(chunkedRepo, `artifact-${stepIndex}.txt`),
          `val-${stepIndex}\n`,
          "utf8"
        );
        return {
          currentState: `step ${stepIndex}`,
          nextStep: `step ${stepIndex + 1}`,
          openQuestions: [],
        };
      },
    });

    assert.equal(continuation.endState, uninterrupted.endState);
    for (let i = 0; i < 4; i++) {
      assert.equal(
        fs.existsSync(path.join(chunkedRepo, `artifact-${i}.txt`)),
        fs.existsSync(path.join(uninterruptedRepo, `artifact-${i}.txt`))
      );
    }
  } finally {
    fs.rmSync(uninterruptedRepo, { recursive: true, force: true });
    fs.rmSync(chunkedRepo, { recursive: true, force: true });
  }
});

test("(f) handoff HEAD SHA resolves in git log", async () => {
  const repoDir = initTempGitRepo();
  const handoffPath = path.join(repoDir, ".handoff.json");
  const runlogPath = path.join(repoDir, "runlog.md");

  try {
    fs.writeFileSync(path.join(repoDir, "work.txt"), "in progress\n", "utf8");
    const handoff = await bankAndWriteChunkHandoff({
      jobId: "job-sha-check",
      workspaceRoot: repoDir,
      handoffPath,
      runlogPath,
      currentState: "wrote work.txt",
      nextStep: "finish work",
      openQuestions: [],
      completedSteps: 1,
    });

    const resolved = execFileSync("git", ["rev-parse", "--verify", handoff.headSha], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    assert.equal(resolved, handoff.headSha);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("supervisor chunk resume enforces max 2 auto-resumes then needs-attention", () => {
  assert.deepEqual(resolveSupervisorChunkResume(0), { action: "auto-resume", nextResumeCount: 1 });
  assert.deepEqual(resolveSupervisorChunkResume(1), { action: "auto-resume", nextResumeCount: 2 });
  assert.deepEqual(resolveSupervisorChunkResume(2), {
    action: "needs-attention",
    nextResumeCount: 2,
  });
});

test("live turn budget hit banks commit, writes complete handoff, and returns chunk-complete marker", async () => {
  const repoDir = initTempGitRepo();
  const handoffPath = path.join(repoDir, ".agent", "checkpoints", "thread-live-1.handoff.json");
  const runlogPath = path.join(repoDir, "docs", "internal", "queue-steer-runlog.md");

  try {
    fs.writeFileSync(path.join(repoDir, "live-work.txt"), "uncommitted round work\n", "utf8");

    const notYet = await handleLiveTurnChunkBudget({
      roundsUsed: 1,
      elapsedMs: 100,
      budget: { maxRounds: 2 },
      jobId: "thread-live-1",
      workspaceRoot: repoDir,
      handoffPath,
      runlogPath,
      currentState: "round 1 done",
      nextStep: "resume from round 1",
      openQuestions: [],
    });
    assert.equal(notYet.exceeded, false);

    const hit = await handleLiveTurnChunkBudget({
      roundsUsed: 2,
      elapsedMs: 200,
      budget: { maxRounds: 2 },
      jobId: "thread-live-1",
      workspaceRoot: repoDir,
      handoffPath,
      runlogPath,
      currentState: "round 2 done",
      nextStep: "resume from round 2",
      openQuestions: ["verify edge case"],
    });
    assert.equal(hit.exceeded, true);
    if (hit.exceeded) {
      assert.equal(hit.marker, TURN_CHUNK_COMPLETE_MARKER);
      assert.equal(hit.handoff.chunkComplete, true);
      assert.equal(hit.handoff.currentState, "round 2 done");
      assert.ok(hit.handoff.branch.length > 0);
      assert.ok(hit.handoff.headSha.length >= 7);
      assert.equal(hit.handoff.nextStep, "resume from round 2");
      assert.deepEqual(hit.handoff.openQuestions, ["verify edge case"]);
    }

    const written = readMilestoneHandoff(handoffPath) as ChunkHandoffBrief | null;
    assert.ok(written);
    assert.equal(written?.chunkComplete, true);
    assert.equal(written?.headSha, hit.exceeded ? hit.handoff.headSha : "");
    assert.ok(fs.existsSync(runlogPath));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("resolveThreadChunkBudget plumbs per-job config and marathonOptOut from thread record", () => {
  assert.equal(resolveThreadChunkBudget(null), undefined);
  assert.deepEqual(
    resolveThreadChunkBudget({
      chunkBudget: { maxRounds: 5, maxDurationMs: 12000, marathonOptOut: true },
    }),
    { maxRounds: 5, maxDurationMs: 12000, marathonOptOut: true }
  );
  assert.deepEqual(resolveThreadChunkBudget({ marathonOptOut: true }), {
    maxRounds: undefined,
    maxDurationMs: undefined,
    marathonOptOut: true,
  });
});

test("rendezvous: route handoff path resolves to supervisor checkpoint dir + taskId", () => {
  const prevDir = process.env.AGENT_CHECKPOINT_DIR;
  const tmpCheckpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "chunk-rendezvous-dir-"));
  process.env.AGENT_CHECKPOINT_DIR = tmpCheckpointDir;
  try {
    const taskTarget = resolveChunkHandoffTarget({
      taskId: "task-1794817009999",
      threadId: "thread-abc-123",
      fallbackJobId: "job-fallback",
    });
    const supervisorHandoffPath = path.join(
      getCanonicalCheckpointDir(),
      "task-1794817009999.handoff.json"
    );
    assert.equal(taskTarget.jobId, "task-1794817009999");
    assert.equal(path.resolve(taskTarget.handoffPath), path.resolve(supervisorHandoffPath));

    const threadOnlyTarget = resolveChunkHandoffTarget({
      threadId: "thread-abc-123",
      fallbackJobId: "job-fallback",
    });
    assert.equal(threadOnlyTarget.jobId, "thread-abc-123");
    assert.equal(
      path.resolve(threadOnlyTarget.handoffPath),
      path.resolve(path.join(getCanonicalCheckpointDir(), "thread-abc-123.handoff.json"))
    );
  } finally {
    if (prevDir === undefined) {
      delete process.env.AGENT_CHECKPOINT_DIR;
    } else {
      process.env.AGENT_CHECKPOINT_DIR = prevDir;
    }
    fs.rmSync(tmpCheckpointDir, { recursive: true, force: true });
  }
});

test("rendezvous: chunkComplete handoff written via route target is seen by supervisor resume decision", async () => {
  const repoDir = initTempGitRepo();
  const tmpCheckpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "chunk-rendezvous-resume-"));
  const prevDir = process.env.AGENT_CHECKPOINT_DIR;
  process.env.AGENT_CHECKPOINT_DIR = tmpCheckpointDir;
  const runlogPath = path.join(repoDir, "docs", "internal", "queue-steer-runlog.md");

  try {
    fs.writeFileSync(path.join(repoDir, "work.txt"), "chunk work\n", "utf8");
    const target = resolveChunkHandoffTarget({
      taskId: "task-1794817009888",
      threadId: "thread-live-rendezvous",
    });

    const hit = await handleLiveTurnChunkBudget({
      roundsUsed: 2,
      elapsedMs: 200,
      budget: { maxRounds: 2 },
      jobId: target.jobId,
      workspaceRoot: repoDir,
      handoffPath: target.handoffPath,
      runlogPath,
      currentState: "round 2 done",
      nextStep: "resume from round 2",
      openQuestions: [],
    });
    assert.equal(hit.exceeded, true);

    const supervisorPath = path.join(
      getCanonicalCheckpointDir(),
      "task-1794817009888.handoff.json"
    );
    const priorHandoff = readMilestoneHandoff(supervisorPath) as ChunkHandoffBrief | null;
    assert.ok(priorHandoff);
    assert.equal(priorHandoff?.chunkComplete, true);
    assert.equal(priorHandoff?.jobId, "task-1794817009888");

    const resume1 = resolveSupervisorChunkResume(0);
    assert.equal(resume1.action, "auto-resume");
    assert.equal(resume1.nextResumeCount, 1);

    const resumeCap = resolveSupervisorChunkResume(2);
    assert.equal(resumeCap.action, "needs-attention");
    assert.equal(resumeCap.nextResumeCount, 2);
  } finally {
    if (prevDir === undefined) {
      delete process.env.AGENT_CHECKPOINT_DIR;
    } else {
      process.env.AGENT_CHECKPOINT_DIR = prevDir;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(tmpCheckpointDir, { recursive: true, force: true });
  }
});
