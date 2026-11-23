import type { Thread } from "./threadStore";

/**
 * Default inactivity window before a streaming turn is declared stalled.
 * 10 minutes (600,000 ms) gives legitimate long tool or model rounds enough
 * headroom when they heartbeat via touchActiveTurn, while catching hung turns.
 */
export const STALL_WINDOW_MS = 600_000;

/** Hard cap on automatic resume turns per job before surfacing needs-attention. */
export const MAX_AUTO_RESUMES = 2;

export interface StallDetectionResult {
  stalled: boolean;
  inactiveMs: number;
  lastActivityAtMs: number;
}

export interface SupervisorThreadAdapter {
  saveThread: (thread: Thread) => void;
  createFreshThread: (opts: {
    title: string;
    taskId: string;
    resumedFromThreadId: string;
  }) => Thread;
  dispatchTurn: (threadId: string, prompt: string) => void;
}

export interface SupervisorJobStore {
  hasBankedState: (jobId: string) => boolean;
  getAutoResumeCount: (jobId: string) => number;
  incrementAutoResumeCount: (jobId: string) => number;
  markNeedsAttention: (jobId: string, reason: string) => void;
}

export type SuperviseOutcome =
  | { action: "not_stalled" }
  | { action: "skipped_drain_owned" }
  | { action: "ended_only" }
  | { action: "needs_attention"; reason: string }
  | { action: "resumed"; freshThreadId: string; attempt: number };

function isTurnStreaming(thread: Thread): boolean {
  if (thread.status === "active" || thread.status === "running") return true;
  return Boolean(thread.messages?.some((m) => m.role === "assistant" && m.status === "streaming"));
}

/**
 * Detects whether a streaming turn has gone without record activity past windowMs.
 * Completed or settled turns are never flagged.
 */
export function detectStalledTurn(
  thread: Thread,
  now: number = Date.now(),
  windowMs: number = STALL_WINDOW_MS
): StallDetectionResult {
  const lastActivityAtMs = Date.parse(thread.updatedAt || thread.createdAt || "");
  if (thread.queuedForExecution) {
    return {
      stalled: false,
      inactiveMs: 0,
      lastActivityAtMs: Number.isFinite(lastActivityAtMs) ? lastActivityAtMs : now,
    };
  }
  if (!isTurnStreaming(thread)) {
    return {
      stalled: false,
      inactiveMs: Number.isFinite(lastActivityAtMs) ? Math.max(0, now - lastActivityAtMs) : 0,
      lastActivityAtMs: Number.isFinite(lastActivityAtMs) ? lastActivityAtMs : now,
    };
  }
  if (!Number.isFinite(lastActivityAtMs)) {
    return { stalled: true, inactiveMs: windowMs + 1, lastActivityAtMs: 0 };
  }
  const inactiveMs = Math.max(0, now - lastActivityAtMs);
  return {
    stalled: inactiveMs > windowMs,
    inactiveMs,
    lastActivityAtMs,
  };
}

/**
 * Ends a stalled turn honestly: stamps a non-streaming status, records the
 * stall cause, and marks any streaming assistant message as incomplete.
 */
export function endStalledTurnHonestly(
  thread: Thread,
  now: number = Date.now(),
  windowMs: number = STALL_WINDOW_MS
): boolean {
  const detection = detectStalledTurn(thread, now, windowMs);
  if (!detection.stalled) return false;

  const mins = Math.max(1, Math.round(windowMs / 60_000));
  const reason = `Turn stalled: no activity for ${mins}m`;

  thread.status = "stopped";
  thread.liveness = "stalled";
  thread.stalledReason = reason;

  if (thread.messages && thread.messages.length > 0) {
    for (const msg of thread.messages) {
      if (msg.role === "assistant" && msg.status === "streaming") {
        msg.status = "incomplete";
        msg.isStopped = true;
        const trimmed = (msg.content || "").trim();
        if (!trimmed.includes("Turn stalled:")) {
          msg.content = trimmed ? `${trimmed}\n\n⚠️ [${reason}]` : `⚠️ [${reason}]`;
        }
      }
    }
  }

  return true;
}

/**
 * Builds the re-grounding brief for an auto-resumed job turn.
 */
export function buildRegroundingBrief(jobId: string, attempt: number): string {
  return [
    `Auto-resume attempt ${attempt}/${MAX_AUTO_RESUMES} for job ${jobId}.`,
    "FIRST: read the job runlog and `git log` to inspect what is already banked.",
    "Continue from the banked state. Do not restart the job from scratch.",
  ].join("\n");
}

/**
 * Supervises a single thread: detects stall, ends it honestly, and for job
 * threads with banked state within the hard cap, issues one resume turn in a
 * fresh thread.
 */
export function superviseStalledThread(
  thread: Thread,
  deps: {
    now?: number;
    windowMs?: number;
    threadAdapter: SupervisorThreadAdapter;
    jobStore: SupervisorJobStore;
    isDrainOwnedThread?: (threadId: string) => boolean;
  }
): SuperviseOutcome {
  // Board-drain-owned threads are recovered exclusively by BoardOrchestrator.
  // The in-app stall supervisor must never end or resume them.
  if (thread.boardItemId || deps.isDrainOwnedThread?.(thread.id)) {
    return { action: "skipped_drain_owned" };
  }

  const now = deps.now ?? Date.now();
  const windowMs = deps.windowMs ?? STALL_WINDOW_MS;

  const ended = endStalledTurnHonestly(thread, now, windowMs);
  if (!ended) return { action: "not_stalled" };

  // Interactive owner turns are never auto-resumed.
  if (!thread.taskId) {
    deps.threadAdapter.saveThread(thread);
    return { action: "ended_only" };
  }

  const jobId = thread.taskId;

  if (!deps.jobStore.hasBankedState(jobId)) {
    const reason = "Stalled with no banked state to resume from";
    thread.needsAttention = true;
    deps.jobStore.markNeedsAttention(jobId, reason);
    deps.threadAdapter.saveThread(thread);
    return { action: "needs_attention", reason };
  }

  const currentCount = deps.jobStore.getAutoResumeCount(jobId);
  if (currentCount >= MAX_AUTO_RESUMES) {
    const reason = `Auto-resume cap (${MAX_AUTO_RESUMES}) reached`;
    thread.needsAttention = true;
    deps.jobStore.markNeedsAttention(jobId, reason);
    deps.threadAdapter.saveThread(thread);
    return { action: "needs_attention", reason };
  }

  const attempt = deps.jobStore.incrementAutoResumeCount(jobId);
  const baseTitle = thread.title.replace(/\s*\(Resume \d+\/\d+\)\s*$/i, "").trimEnd();
  const fresh = deps.threadAdapter.createFreshThread({
    title: `${baseTitle} (Resume ${attempt}/${MAX_AUTO_RESUMES})`,
    taskId: jobId,
    resumedFromThreadId: thread.id,
  });
  fresh.autoResumeCount = attempt;
  thread.resumedToThreadId = fresh.id;
  thread.autoResumeCount = attempt;

  deps.threadAdapter.saveThread(thread);
  deps.threadAdapter.saveThread(fresh);
  deps.threadAdapter.dispatchTurn(fresh.id, buildRegroundingBrief(jobId, attempt));

  return { action: "resumed", freshThreadId: fresh.id, attempt };
}
