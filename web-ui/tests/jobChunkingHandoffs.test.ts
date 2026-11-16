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
  type ChunkBudgetConfig,
  type ChunkHandoffBrief,
} from "../lib/jobChunking";
import { readMilestoneHandoff } from "../lib/subagents/finishVerificationGate";

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
        fs.writeFileSync(path.join(repoDir, `step-${stepIndex}.txt`), `step ${stepIndex}\n`, "utf8");
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
        fs.writeFileSync(path.join(repoDir, `time-step-${stepIndex}.txt`), `step ${stepIndex}\n`, "utf8");
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

  const evalOptOut = evaluateChunkBudget(DEFAULT_CHUNK_MAX_ROUNDS + 10, DEFAULT_CHUNK_MAX_DURATION_MS + 10_000, {
    marathonOptOut: true,
  });
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
        fs.writeFileSync(path.join(uninterruptedRepo, `artifact-${stepIndex}.txt`), `val-${stepIndex}\n`, "utf8");
        return { currentState: `step ${stepIndex}`, nextStep: `step ${stepIndex + 1}`, openQuestions: [] };
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
        fs.writeFileSync(path.join(chunkedRepo, `artifact-${stepIndex}.txt`), `val-${stepIndex}\n`, "utf8");
        return { currentState: `step ${stepIndex}`, nextStep: `step ${stepIndex + 1}`, openQuestions: [] };
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
        fs.writeFileSync(path.join(chunkedRepo, `artifact-${stepIndex}.txt`), `val-${stepIndex}\n`, "utf8");
        return { currentState: `step ${stepIndex}`, nextStep: `step ${stepIndex + 1}`, openQuestions: [] };
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
  assert.deepEqual(resolveSupervisorChunkResume(2), { action: "needs-attention", nextResumeCount: 2 });
});
