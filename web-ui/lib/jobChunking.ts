import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  readMilestoneHandoff,
  writeMilestoneHandoff,
  type MilestoneHandoffState,
} from "./subagents/finishVerificationGate";
import { getCanonicalCheckpointDir } from "./subagents/morningReport";

export const DEFAULT_CHUNK_MAX_ROUNDS = 25;
export const DEFAULT_CHUNK_MAX_DURATION_MS = 45 * 60 * 1000;
export const MAX_AUTO_RESUMES_PER_JOB = 2;
export const TURN_CHUNK_COMPLETE_MARKER = "[[CHUNK_COMPLETE]]";

export type ChunkEndState = "completed" | "chunk-complete";

export interface ChunkBudgetConfig {
  maxRounds?: number;
  maxDurationMs?: number;
  marathonOptOut?: boolean;
}

export interface ChunkBudgetEvaluation {
  exceeded: boolean;
  reason: "rounds" | "time" | null;
}

export interface ChunkHandoffBrief extends MilestoneHandoffState {
  chunkComplete: true;
  currentState: string;
  branch: string;
  headSha: string;
  nextStep: string;
  openQuestions: string[];
  completedSteps: number;
}

/**
 * Evaluates whether a job turn has hit its chunk budget (rounds or wall-clock).
 * Owner-marked marathons with `marathonOptOut: true` never hit the chunk budget.
 */
export function evaluateChunkBudget(
  roundsUsed: number,
  elapsedMs: number,
  config?: ChunkBudgetConfig
): ChunkBudgetEvaluation {
  if (config?.marathonOptOut === true) {
    return { exceeded: false, reason: null };
  }
  const maxRounds = config?.maxRounds ?? DEFAULT_CHUNK_MAX_ROUNDS;
  const maxDurationMs = config?.maxDurationMs ?? DEFAULT_CHUNK_MAX_DURATION_MS;

  if (roundsUsed >= maxRounds) {
    return { exceeded: true, reason: "rounds" };
  }
  if (elapsedMs >= maxDurationMs) {
    return { exceeded: true, reason: "time" };
  }
  return { exceeded: false, reason: null };
}

function getGitBranch(cwd: string): string {
  try {
    return (
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd,
        encoding: "utf8",
      }).trim() || "HEAD"
    );
  } catch {
    return "HEAD";
  }
}

function getGitHeadSha(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function bankGitWork(cwd: string, jobId: string): { branch: string; headSha: string } {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
  }).trim();

  if (status.length > 0) {
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["commit", "-m", `chore(chunk): bank state for ${jobId}`], { cwd });
  }

  // Push if a remote is configured; local-only test repos have no remote.
  try {
    const remotes = execFileSync("git", ["remote"], { cwd, encoding: "utf8" }).trim();
    if (remotes.length > 0) {
      const branch = getGitBranch(cwd);
      execFileSync("git", ["push", "-u", "origin", branch], { cwd });
    }
  } catch {
    // Non-fatal if remote push is unavailable in offline/test environments.
  }

  return {
    branch: getGitBranch(cwd),
    headSha: getGitHeadSha(cwd),
  };
}

export interface BankChunkHandoffInput {
  jobId: string;
  workspaceRoot: string;
  handoffPath: string;
  runlogPath?: string;
  currentState: string;
  nextStep: string;
  openQuestions: string[];
  completedSteps: number;
}

/**
 * Banks current git work, appends a runlog entry, and writes a ChunkHandoffBrief
 * using the existing MilestoneHandoffState persistence path.
 */
export async function bankAndWriteChunkHandoff(
  input: BankChunkHandoffInput
): Promise<ChunkHandoffBrief> {
  const { branch, headSha } = bankGitWork(input.workspaceRoot, input.jobId);
  const updatedAt = new Date().toISOString();

  if (input.runlogPath) {
    fs.mkdirSync(path.dirname(input.runlogPath), { recursive: true });
    const entry = `- [${updatedAt}] job=${input.jobId} branch=${branch} sha=${headSha} state="${input.currentState}" next="${input.nextStep}"\n`;
    fs.appendFileSync(input.runlogPath, entry, "utf8");
  }

  const brief: ChunkHandoffBrief = {
    jobId: input.jobId,
    completedMilestones: [],
    nextMilestone: input.nextStep,
    summary: input.currentState,
    updatedAt,
    chunkComplete: true,
    currentState: input.currentState,
    branch,
    headSha,
    nextStep: input.nextStep,
    openQuestions: input.openQuestions,
    completedSteps: input.completedSteps,
  };

  writeMilestoneHandoff(input.handoffPath, brief);
  return brief;
}

export interface StepExecutionOutput {
  currentState: string;
  nextStep: string;
  openQuestions: string[];
}

export interface RunChunkedJobLoopInput {
  jobId: string;
  workspaceRoot: string;
  handoffPath: string;
  runlogPath?: string;
  budget?: ChunkBudgetConfig;
  totalSteps: number;
  startStep?: number;
  now?: () => number;
  stepExecutor: (stepIndex: number) => Promise<StepExecutionOutput>;
}

export interface RunChunkedJobLoopResult {
  endState: ChunkEndState;
  marker?: string;
  handoff?: ChunkHandoffBrief;
  completedSteps: number;
}

/**
 * Executes a multi-step job turn under a chunk budget, banking state and
 * returning `chunk-complete` if the round or time budget is hit mid-job.
 */
export async function runChunkedJobLoop(
  input: RunChunkedJobLoopInput
): Promise<RunChunkedJobLoopResult> {
  const now = input.now ?? (() => Date.now());
  const startTime = now();
  let stepIndex = input.startStep ?? 0;
  let roundsUsed = 0;
  let lastOutput: StepExecutionOutput = {
    currentState: "initialized",
    nextStep: `step ${stepIndex}`,
    openQuestions: [],
  };

  while (stepIndex < input.totalSteps) {
    const budgetCheck = evaluateChunkBudget(roundsUsed, now() - startTime, input.budget);
    if (budgetCheck.exceeded) {
      const handoff = await bankAndWriteChunkHandoff({
        jobId: input.jobId,
        workspaceRoot: input.workspaceRoot,
        handoffPath: input.handoffPath,
        runlogPath: input.runlogPath,
        currentState: lastOutput.currentState,
        nextStep: lastOutput.nextStep,
        openQuestions: lastOutput.openQuestions,
        completedSteps: stepIndex,
      });
      return {
        endState: "chunk-complete",
        marker: TURN_CHUNK_COMPLETE_MARKER,
        handoff,
        completedSteps: stepIndex,
      };
    }

    lastOutput = await input.stepExecutor(stepIndex);
    stepIndex++;
    roundsUsed++;
  }

  return {
    endState: "completed",
    completedSteps: stepIndex,
  };
}

export interface ContinueJobFromHandoffInput {
  handoffPath: string;
  workspaceRoot: string;
  runlogPath?: string;
  budget?: ChunkBudgetConfig;
  totalSteps: number;
  now?: () => number;
  stepExecutor: (stepIndex: number) => Promise<StepExecutionOutput>;
}

/**
 * Reads a banked chunk handoff and resumes execution from `completedSteps`.
 */
export async function continueJobFromHandoff(
  input: ContinueJobFromHandoffInput
): Promise<RunChunkedJobLoopResult> {
  const handoff = readMilestoneHandoff(input.handoffPath) as ChunkHandoffBrief | null;
  if (!handoff) {
    throw new Error(`No chunk handoff found at ${input.handoffPath}`);
  }

  return runChunkedJobLoop({
    jobId: handoff.jobId,
    workspaceRoot: input.workspaceRoot,
    handoffPath: input.handoffPath,
    runlogPath: input.runlogPath,
    budget: input.budget,
    totalSteps: input.totalSteps,
    startStep: handoff.completedSteps ?? 0,
    now: input.now,
    stepExecutor: input.stepExecutor,
  });
}

export interface SupervisorChunkResumeDecision {
  action: "auto-resume" | "needs-attention";
  nextResumeCount: number;
}

/**
 * Enforces the supervisor's auto-resume budget for chunk-complete jobs:
 * at most 2 auto-resumes per job, then `needs-attention`.
 */
export function resolveSupervisorChunkResume(
  currentResumeCount: number
): SupervisorChunkResumeDecision {
  if (currentResumeCount < MAX_AUTO_RESUMES_PER_JOB) {
    return {
      action: "auto-resume",
      nextResumeCount: currentResumeCount + 1,
    };
  }
  return {
    action: "needs-attention",
    nextResumeCount: currentResumeCount,
  };
}

export interface ThreadRecordChunkFields {
  chunkBudget?: ChunkBudgetConfig | null;
  maxRounds?: number;
  maxDurationMs?: number;
  marathonOptOut?: boolean;
}

/**
 * Extracts per-job chunk budget configuration from a thread record when present.
 * Returns undefined when no per-job overrides are set so defaults apply.
 */
export function resolveThreadChunkBudget(
  threadRecord: ThreadRecordChunkFields | null | undefined
): ChunkBudgetConfig | undefined {
  if (!threadRecord) return undefined;
  const nested = threadRecord.chunkBudget;
  const maxRounds = nested?.maxRounds ?? threadRecord.maxRounds;
  const maxDurationMs = nested?.maxDurationMs ?? threadRecord.maxDurationMs;
  const marathonOptOut = nested?.marathonOptOut ?? threadRecord.marathonOptOut;
  if (maxRounds === undefined && maxDurationMs === undefined && marathonOptOut === undefined) {
    return undefined;
  }
  return { maxRounds, maxDurationMs, marathonOptOut };
}

export interface LiveTurnChunkBudgetInput {
  roundsUsed: number;
  elapsedMs: number;
  budget?: ChunkBudgetConfig;
  jobId: string;
  workspaceRoot: string;
  handoffPath: string;
  runlogPath?: string;
  currentState: string;
  nextStep: string;
  openQuestions: string[];
}

export type LiveTurnChunkBudgetResult =
  | { exceeded: false }
  | {
      exceeded: true;
      reason: "rounds" | "time";
      marker: string;
      handoff: ChunkHandoffBrief;
    };

/**
 * Evaluates the live turn's chunk budget and, on budget hit, banks git work
 * and writes the chunk handoff before returning the chunk-complete marker.
 */
export async function handleLiveTurnChunkBudget(
  input: LiveTurnChunkBudgetInput
): Promise<LiveTurnChunkBudgetResult> {
  const chunkEval = evaluateChunkBudget(input.roundsUsed, input.elapsedMs, input.budget);
  if (!chunkEval.exceeded || !chunkEval.reason) {
    return { exceeded: false };
  }

  const handoff = await bankAndWriteChunkHandoff({
    jobId: input.jobId,
    workspaceRoot: input.workspaceRoot,
    handoffPath: input.handoffPath,
    runlogPath: input.runlogPath,
    currentState: input.currentState,
    nextStep: input.nextStep,
    openQuestions: input.openQuestions,
    completedSteps: input.roundsUsed,
  });

  return {
    exceeded: true,
    reason: chunkEval.reason,
    marker: TURN_CHUNK_COMPLETE_MARKER,
    handoff,
  };
}

export interface ChunkHandoffTargetInput {
  taskId?: string | null;
  threadId?: string | null;
  fallbackJobId?: string | null;
  checkpointDir?: string;
}

export interface ChunkHandoffTarget {
  jobId: string;
  checkpointDir: string;
  handoffPath: string;
}

/**
 * Resolves the canonical handoff target for a live turn so it lands in the
 * exact checkpoint directory and `<taskId>.handoff.json` filename the
 * OvernightSupervisor reads (falling back to threadId when no taskId exists).
 */
export function resolveChunkHandoffTarget(input: ChunkHandoffTargetInput): ChunkHandoffTarget {
  const jobId =
    (input.taskId && input.taskId.trim()) ||
    (input.threadId && input.threadId.trim()) ||
    (input.fallbackJobId && input.fallbackJobId.trim()) ||
    "unknown-job";
  const checkpointDir = input.checkpointDir ?? getCanonicalCheckpointDir();
  return {
    jobId,
    checkpointDir,
    handoffPath: path.join(checkpointDir, `${jobId}.handoff.json`),
  };
}
