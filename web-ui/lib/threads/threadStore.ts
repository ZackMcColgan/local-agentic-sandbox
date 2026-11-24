import fs from "fs";
import path from "path";
import { TaskManifest, TaskScope } from "../subagents/types";
import { OvernightSupervisor } from "../subagents/supervisor";
import { estimateTokens, CHAT_CONTEXT_BUDGET_TOKENS } from "../contextBudget";
import { COMPACTION_THRESHOLD_RATIO } from "../modelLimits";
import {
  summarizeTurnHistory,
  runHybridCompaction,
  resolveCompactionStrategy,
} from "../conversationCompaction";
import type {
  CompactionMessage,
  HybridFallbackReason,
  SummarizeRequest,
  SummarizeResult,
} from "../conversationCompaction";
import { computeThreadTokenEconomics, type JobTokenRollup } from "../tokenEconomics";
import { getHostSettings } from "../hostSettings";
import { superviseStalledThread } from "./inAppSupervisor";
import { listBoardOwnedThreadIds } from "../board/boardStore";
import { DEFAULT_PRIMARY_MODEL } from "../../config/models";
import type { ChunkBudgetConfig } from "../jobChunking";

import type {
  TurnConversationPreparation,
  TurnStartCompactionOptions,
  ThreadAttachment,
  ThreadMessage,
  ThreadLiveness,
  ThreadCompactionBoundary,
  ThreadSummary,
  Thread,
  ActiveTurnInfo,
} from "./types";

export type {
  TurnConversationPreparation,
  TurnStartCompactionOptions,
  ThreadAttachment,
  ThreadMessage,
  ThreadLiveness,
  ThreadCompactionBoundary,
  ThreadSummary,
  Thread,
  ActiveTurnInfo,
};

export const COMPACTION_TRIGGER_TOKENS = Math.floor(
  CHAT_CONTEXT_BUDGET_TOKENS * COMPACTION_THRESHOLD_RATIO
);

import { THREAD_TITLE_MAX_CHARS, deriveStoredThreadTitle, deriveThreadTitle } from "./titles";

export { THREAD_TITLE_MAX_CHARS, deriveStoredThreadTitle, deriveThreadTitle };

import {
  TURN_STALL_WINDOW_MS,
  ZOMBIE_TURN_AGE_CAP_MS,
  isRecordStaleBeyond,
  isZombiePresence,
  computeTurnLiveness as computeTurnLivenessPure,
} from "./liveness";

export { TURN_STALL_WINDOW_MS, ZOMBIE_TURN_AGE_CAP_MS, isRecordStaleBeyond, isZombiePresence };

/**
 * Derives liveness from the record's last-activity timestamp (updatedAt or in-memory
 * heartbeat) against the live-execution state. A live-but-stale turn is NEVER reconciled
 * to completed here; reconciliation stays owned by reconcileThread.
 */
export function computeTurnLiveness(thread: Thread, now: number = Date.now()): ThreadLiveness {
  const isLiveOverride = activeExecutionSet.has(thread.id) || Boolean(getActiveTurn(thread.id));
  if (isTurnQueued(thread.id) || thread.queuedForExecution) {
    return isLiveOverride || thread.status === "active" || thread.status === "running"
      ? "alive"
      : "settled";
  }
  const heartbeatMs = getActiveTurnHeartbeatMs(thread.id);
  const recordUpdatedMs = Date.parse(thread.updatedAt || thread.createdAt || "");
  if (
    typeof heartbeatMs === "number" &&
    heartbeatMs <= now &&
    (!Number.isFinite(recordUpdatedMs) || heartbeatMs > recordUpdatedMs)
  ) {
    return computeTurnLivenessPure(
      { ...thread, updatedAt: new Date(heartbeatMs).toISOString() },
      now,
      isLiveOverride
    );
  }
  return computeTurnLivenessPure(thread, now, isLiveOverride);
}

/**
 * TURN-LIVENESS heartbeat: updates the in-memory last-activity timestamp in
 * activeTurnRegistry without reading or rewriting the thread JSON file or
 * invalidating .summaries-index.json mtimes.
 */
export function touchActiveTurn(threadId: string, _threadsDir?: string): void {
  if (!threadId) return;
  const nowMs = Date.now();
  turnHeartbeatMsMap.set(threadId, nowMs);
  const existing = activeTurnRegistry.get(threadId);
  if (existing) {
    existing.lastActivityAtMs = nowMs;
  }
}

export function resolveThreadsDir(): string {
  let resolvedDir = process.env.THREADS_DIR;
  if (!resolvedDir) {
    const candidates = [
      process.env.WORKSPACE_DIR ? path.resolve(process.env.WORKSPACE_DIR, ".agent/threads") : null,
      fs.existsSync("/workspace") ? path.resolve("/workspace/.agent/threads") : null,
      fs.existsSync(path.resolve(process.cwd(), "../workspace"))
        ? path.resolve(process.cwd(), "../workspace/.agent/threads")
        : null,
      path.resolve(process.cwd(), ".agent/threads"),
      path.resolve("/tmp/.agent/threads"),
    ].filter(Boolean) as string[];

    for (const dir of candidates) {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
        }
        try {
          fs.chmodSync(dir, 0o770);
          fs.chmodSync(path.dirname(dir), 0o770);
        } catch {}
        fs.accessSync(dir, fs.constants.W_OK);
        resolvedDir = dir;
        break;
      } catch {}
    }
  }
  return resolvedDir || path.resolve("/tmp/.agent/threads");
}

// In-memory set of actively executing task/thread IDs in the current Node process.
// Attached to globalThis so Next.js / tsx module path aliases (@/lib/... vs ../lib/...) share the exact same singleton state.
const g = globalThis as {
  __sandboxActiveExecutionSet?: Set<string>;
  __sandboxActiveTurnRegistry?: Map<string, ActiveTurnInfo>;
  __sandboxTurnHeartbeatMsMap?: Map<string, number>;
  __sandboxQueuedTurnSet?: Set<string>;
  __sandboxActiveTurnAbortControllers?: Map<string, AbortController>;
  __sandboxActiveRoundAbortControllers?: Map<string, AbortController>;
  __sandboxDeletedThreadIds?: Set<string>;
  __sandboxSupervisorSweepTimer?: ReturnType<typeof setInterval> | null;
  [key: string]: unknown;
};
export const activeExecutionSet: Set<string> =
  g.__sandboxActiveExecutionSet || (g.__sandboxActiveExecutionSet = new Set<string>());

const activeTurnRegistry: Map<string, ActiveTurnInfo> =
  g.__sandboxActiveTurnRegistry ||
  (g.__sandboxActiveTurnRegistry = new Map<string, ActiveTurnInfo>());
const turnHeartbeatMsMap: Map<string, number> =
  g.__sandboxTurnHeartbeatMsMap || (g.__sandboxTurnHeartbeatMsMap = new Map<string, number>());

/** Returns the latest in-memory heartbeat timestamp (ms) recorded by touchActiveTurn, if any. */
export function getActiveTurnHeartbeatMs(threadId: string): number | undefined {
  const mapMs = turnHeartbeatMsMap.get(threadId);
  const regMs = activeTurnRegistry.get(threadId)?.lastActivityAtMs;
  if (typeof mapMs === "number" && typeof regMs === "number") {
    return Math.max(mapMs, regMs);
  }
  return mapMs ?? regMs;
}
const queuedTurnSet: Set<string> =
  g.__sandboxQueuedTurnSet || (g.__sandboxQueuedTurnSet = new Set<string>());
const activeTurnAbortControllers: Map<string, AbortController> =
  g.__sandboxActiveTurnAbortControllers ||
  (g.__sandboxActiveTurnAbortControllers = new Map<string, AbortController>());
const activeRoundAbortControllers: Map<string, AbortController> =
  g.__sandboxActiveRoundAbortControllers ||
  (g.__sandboxActiveRoundAbortControllers = new Map<string, AbortController>());
const deletedThreadIds: Set<string> =
  g.__sandboxDeletedThreadIds || (g.__sandboxDeletedThreadIds = new Set<string>());

export function registerTurnAbortController(threadId: string, controller: AbortController): void {
  activeTurnAbortControllers.set(threadId, controller);
}

export function registerRoundAbortController(threadId: string, controller: AbortController): void {
  activeRoundAbortControllers.set(threadId, controller);
}

export function clearRoundAbortController(threadId: string, controller?: AbortController): void {
  if (!controller || activeRoundAbortControllers.get(threadId) === controller) {
    activeRoundAbortControllers.delete(threadId);
  }
}

export function interruptActiveTurnStream(threadId: string): boolean {
  const controller = activeRoundAbortControllers.get(threadId);
  if (controller) {
    if (!controller.signal.aborted) {
      controller.abort();
    }
    activeRoundAbortControllers.delete(threadId);
    return true;
  }
  return false;
}

export function abortActiveTurn(threadId: string): boolean {
  const controller = activeTurnAbortControllers.get(threadId);
  if (controller) {
    if (!controller.signal.aborted) {
      controller.abort();
    }
    activeTurnAbortControllers.delete(threadId);
    return true;
  }
  return false;
}

export function clearTurnAbortController(threadId: string): void {
  activeTurnAbortControllers.delete(threadId);
}

export function markTurnActive(threadId: string, startedAtIso?: string): void {
  if (!activeTurnRegistry.has(threadId)) {
    activeTurnRegistry.set(threadId, {
      threadId,
      startedAt: startedAtIso ?? new Date().toISOString(),
      status: "streaming",
    });
  }
}

export function getActiveTurn(threadId: string): ActiveTurnInfo | null {
  return activeTurnRegistry.get(threadId) ?? null;
}

export function clearTurnActive(threadId: string): void {
  activeTurnRegistry.delete(threadId);
  queuedTurnSet.delete(threadId);
  turnHeartbeatMsMap.delete(threadId);
}

/**
 * Marks a thread as queued waiting for a queue/slot before round-0 execution starts.
 * Queued time does not age against the stall window.
 */
export function markTurnQueued(threadId: string, threadsDir?: string): void {
  queuedTurnSet.add(threadId);
  const existing = activeTurnRegistry.get(threadId);
  if (existing) {
    existing.queued = true;
  }
  try {
    const filePath = path.join(threadsDir ?? resolveThreadsDir(), `${threadId}.json`);
    if (!fs.existsSync(filePath)) return;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Thread;
    if (!raw || raw.id !== threadId) return;
    raw.queuedForExecution = true;
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), { encoding: "utf8", mode: 0o660 });
  } catch {}
}

/**
 * Transitions a queued thread into active execution, clearing queuedForExecution and
 * resetting updatedAt / presence startedAt so the stall clock starts at execution.
 */
export function markTurnExecuting(threadId: string, threadsDir?: string): void {
  queuedTurnSet.delete(threadId);
  const nowIso = new Date().toISOString();
  const existing = activeTurnRegistry.get(threadId);
  if (existing) {
    existing.queued = false;
    existing.startedAt = nowIso;
  }
  try {
    const filePath = path.join(threadsDir ?? resolveThreadsDir(), `${threadId}.json`);
    if (!fs.existsSync(filePath)) return;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Thread;
    if (!raw || raw.id !== threadId) return;
    delete raw.queuedForExecution;
    raw.updatedAt = nowIso;
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), { encoding: "utf8", mode: 0o660 });
  } catch {}
}

/**
 * Clears queued state (e.g. on pre-start abort before execution ever begins).
 */
export function clearTurnQueued(threadId: string, threadsDir?: string): void {
  queuedTurnSet.delete(threadId);
  try {
    const filePath = path.join(threadsDir ?? resolveThreadsDir(), `${threadId}.json`);
    if (!fs.existsSync(filePath)) return;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Thread;
    if (!raw || raw.id !== threadId || !raw.queuedForExecution) return;
    delete raw.queuedForExecution;
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), { encoding: "utf8", mode: 0o660 });
  } catch {}
}

export function isTurnQueued(threadId: string): boolean {
  return queuedTurnSet.has(threadId);
}

export class ThreadStore {
  private threadsDir: string;
  private supervisor: OvernightSupervisor;

  constructor(threadsDir?: string, supervisor?: OvernightSupervisor) {
    this.threadsDir = threadsDir || resolveThreadsDir();
    this.supervisor = supervisor || new OvernightSupervisor();
    if (!fs.existsSync(this.threadsDir)) {
      try {
        fs.mkdirSync(this.threadsDir, { recursive: true, mode: 0o770 });
      } catch {}
    }
    try {
      fs.chmodSync(path.dirname(this.threadsDir), 0o770);
    } catch {}
    try {
      fs.chmodSync(this.threadsDir, 0o770);
    } catch {}
    this.startSupervisorSweep();
  }

  getFilePath(threadId: string): string {
    return path.join(this.threadsDir, `${threadId}.json`);
  }

  getSteerFilePath(threadId: string): string {
    return path.join(this.threadsDir, `${threadId}.steer.json`);
  }

  appendSteer(threadId: string, text: string): number {
    const trimmed = text.trim();
    if (!trimmed) return this.getPendingSteers(threadId).length;
    const steerFile = this.getSteerFilePath(threadId);
    let pending: string[] = [];
    try {
      if (fs.existsSync(steerFile)) {
        const raw = fs.readFileSync(steerFile, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) pending = parsed.filter((s) => typeof s === "string");
      }
    } catch {}
    pending.push(trimmed);
    try {
      fs.writeFileSync(steerFile, JSON.stringify(pending, null, 2), {
        encoding: "utf8",
        mode: 0o660,
      });
    } catch {}
    return pending.length;
  }

  getPendingSteers(threadId: string): string[] {
    const steerFile = this.getSteerFilePath(threadId);
    try {
      if (fs.existsSync(steerFile)) {
        const raw = fs.readFileSync(steerFile, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === "string");
      }
    } catch {}
    return [];
  }

  consumeSteers(threadId: string): string[] {
    const steerFile = this.getSteerFilePath(threadId);
    const pending = this.getPendingSteers(threadId);
    if (fs.existsSync(steerFile)) {
      try {
        fs.unlinkSync(steerFile);
      } catch {}
    }
    return pending;
  }

  clearSteers(threadId: string): void {
    const steerFile = this.getSteerFilePath(threadId);
    if (fs.existsSync(steerFile)) {
      try {
        fs.unlinkSync(steerFile);
      } catch {}
    }
  }

  /**
   * Seeds the approved Mockup 1 & 3 initial threads if no threads exist yet.
   */
  async ensureSeeded(): Promise<void> {
    if (process.env.SEED_MOCKUP_THREADS !== "true") {
      return;
    }
    if (!fs.existsSync(this.threadsDir)) {
      try {
        fs.mkdirSync(this.threadsDir, { recursive: true, mode: 0o770 });
      } catch {}
      try {
        fs.chmodSync(this.threadsDir, 0o770);
      } catch {}
    }

    const files = fs.readdirSync(this.threadsDir).filter((f) => f.endsWith(".json"));
    if (files.length > 0) return;

    const now = Date.now();

    // 1. Task for "Rebuild settings in Material 3"
    const taskRebuildSettings: TaskManifest = {
      taskId: "task-rebuild-settings",
      goal: "Let's rebuild the settings experience using Material 3. Keep it clean, add the migration checklist and a way to stop the run.",
      toolchain: "node:22",
      branch: "feat/unified-ui",
      branchName: "feat/unified-ui",
      status: "active",
      startedAt: new Date(now - 1000 * 60 * 18).toISOString(),
      updatedAt: new Date(now - 1000 * 30).toISOString(),
      currentMilestoneIndex: 1,
      milestones: [
        {
          id: "m1",
          title: "Migrate config schema to M3 tokens",
          description: "Update theme definitions and config to use M3 tokens",
          acceptanceCriteria: [{ id: "ac1", assertion: "All tokens conform to M3" }],
          status: "completed",
          builderIterations: 1,
          criticRounds: 1,
          testsPassed: 4,
          testsFailed: 0,
          diffSummary: "Tokens refactored to M3 design tokens",
        },
        {
          id: "m2",
          title: "Update UI components to M3",
          description: "Refactor sidebar, cards, and input controls to M3 styles",
          acceptanceCriteria: [{ id: "ac2", assertion: "Components match M3 mockups" }],
          status: "in_progress",
          builderIterations: 2,
          criticRounds: 1,
          testsPassed: 6,
          testsFailed: 0,
          diffSummary: "Updated components with Material You styling",
        },
        {
          id: "m3",
          title: "Validate component theming & accessibility",
          description: "Run visual inspection and accessibility checks",
          acceptanceCriteria: [{ id: "ac3", assertion: "Contrast and layout pass accessibility" }],
          status: "pending",
          builderIterations: 0,
          criticRounds: 0,
        },
      ],
      journal: [
        {
          timestamp: new Date(now - 1000 * 60 * 15).toISOString(),
          role: "builder",
          message: "Analyzing config dependencies... ✨",
        },
        {
          timestamp: new Date(now - 1000 * 60 * 10).toISOString(),
          role: "builder",
          message: "Validating theme tokens... ✨",
        },
        {
          timestamp: new Date(now - 1000 * 60 * 2).toISOString(),
          role: "builder",
          message: "Reconciling M3 color scheme... ✨",
        },
      ],
      checkpoints: [],
      ambiguityFlags: [],
    };

    try {
      this.supervisor.saveCheckpoint(taskRebuildSettings);
    } catch {}

    activeExecutionSet.add("task-rebuild-settings");
    activeExecutionSet.add("thread-rebuild-settings");

    const thread1: Thread = {
      id: "thread-rebuild-settings",
      title: "Rebuild settings in Material 3",
      status: "active",
      workerInfo: "Worker 2",
      createdAt: new Date(now - 1000 * 60 * 18).toISOString(),
      updatedAt: new Date(now - 1000 * 30).toISOString(),
      model: "swift-15-27b-mtp",
      reasoningEffort: "medium",
      taskId: "task-rebuild-settings",
      messages: [
        {
          id: "msg-1",
          role: "user",
          content:
            "Let's rebuild the settings experience using Material 3. Keep it clean, add the migration checklist and a way to stop the run.",
          timestamp: "Today · 10:42 AM",
        },
      ],
    };

    const thread2: Thread = {
      id: "thread-critic-approval",
      title: "How does the critic decide?",
      status: "completed",
      timeLabel: "2h ago",
      createdAt: new Date(now - 1000 * 60 * 60 * 2).toISOString(),
      updatedAt: new Date(now - 1000 * 60 * 60 * 2).toISOString(),
      model: "swift-15-27b-mtp",
      reasoningEffort: "medium",
      messages: [
        {
          id: "msg-c1",
          role: "user",
          content: "How does the critic decide to approve?",
          timestamp: "Today · 8:42 AM",
        },
        {
          id: "msg-c2",
          role: "assistant",
          thought:
            "Checking critic diff acceptance criteria and synthetic marker checks in workerPool.ts...",
          content:
            "The critic checks the diff against each acceptance criterion, then verifies no synthetic markers exist. If the model is unreachable it abstains instead of approving.",
          timestamp: "Today · 8:43 AM",
          traces: [
            {
              tool: "file",
              args: { path: "workerPool.ts:342" },
              result: "Diff verified against acceptance criteria; no synthetic markers found",
              durationMs: 45,
              timestamp: new Date(now - 1000 * 60 * 60 * 2).toISOString(),
            },
          ],
        },
      ],
    };

    const thread3: Thread = {
      id: "thread-qdrant-eval",
      title: "Qdrant memory eval",
      status: "stopped",
      timeLabel: "Yesterday",
      createdAt: new Date(now - 1000 * 60 * 60 * 24).toISOString(),
      updatedAt: new Date(now - 1000 * 60 * 60 * 24).toISOString(),
      model: "swift-15-27b-mtp",
      reasoningEffort: "medium",
      messages: [
        {
          id: "msg-q1",
          role: "user",
          content: "Run vector recall evaluation against Qdrant collection",
          timestamp: "Yesterday",
        },
        {
          id: "msg-q2",
          role: "assistant",
          content: "Evaluation run stopped after 14 iterations.",
          isStopped: true,
          timestamp: "Yesterday",
        },
      ],
    };

    this.saveThread(thread1);
    this.saveThread(thread2);
    this.saveThread(thread3);
  }

  /**
   * Loads all threads from disk and reconciles status honestly against the
   * running process state.
   */
  /**
   * Starts a background interval that sweeps stalled threads and applies
   * honest-end / bounded auto-resume dispositions. Unreffed so it never
   * blocks process exit or test runners.
   */
  startSupervisorSweep(intervalMs = 60_000): void {
    if (g.__sandboxSupervisorSweepTimer) return;
    const timer = setInterval(() => {
      void this.sweepStalledThreads().catch(() => {
        // Never crash the process from a background sweep
      });
    }, intervalMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    g.__sandboxSupervisorSweepTimer = timer;
  }

  /**
   * Stops the background supervisor sweep timer.
   */
  stopSupervisorSweep(): void {
    if (g.__sandboxSupervisorSweepTimer) {
      clearInterval(g.__sandboxSupervisorSweepTimer);
      g.__sandboxSupervisorSweepTimer = null;
    }
  }

  /**
   * Explicit supervisor sweep: inspects all threads and applies honest-end /
   * bounded auto-resume dispositions to stalled turns. Passive reads
   * (`reconcileThread`) never flip a streaming turn to `stopped`.
   */
  async sweepStalledThreads(now: number = Date.now()): Promise<number> {
    let acted = 0;
    const summaries = await this.listThreadSummaries();
    let drainOwnedThreadIds: Set<string> | null = null;
    for (const s of summaries) {
      const isStreaming = s.status === "active" || s.status === "running" || s.hasStreamingMessage;
      const updatedAtMs = Date.parse(s.updatedAt);
      const isStale = Number.isFinite(updatedAtMs) && now - updatedAtMs > TURN_STALL_WINDOW_MS;
      if (!isStreaming || !isStale) {
        continue;
      }
      // Queued/pre-round-0 threads must not age against the stall window.
      if (s.queuedForExecution || isTurnQueued(s.id)) {
        continue;
      }
      // Board-drain-owned threads are recovered exclusively by BoardOrchestrator.
      if (s.boardItemId) {
        continue;
      }
      drainOwnedThreadIds ??= listBoardOwnedThreadIds();
      if (drainOwnedThreadIds.has(s.id)) {
        continue;
      }
      const thread = await this.getThread(s.id);
      if (!thread) {
        continue;
      }
      if (thread.boardItemId || drainOwnedThreadIds.has(thread.id)) {
        continue;
      }
      const outcome = superviseStalledThread(thread, {
        now,
        isDrainOwnedThread: (id) => Boolean(thread.boardItemId || drainOwnedThreadIds?.has(id)),
        threadAdapter: {
          saveThread: (t) => this.saveThread(t),
          createFreshThread: (opts) =>
            this.createThread({
              title: opts.title,
              taskId: opts.taskId,
              resumedFromThreadId: opts.resumedFromThreadId,
            }),
          dispatchTurn: (threadId, prompt) => this.dispatchSupervisorTurn(threadId, prompt),
        },
        jobStore: {
          hasBankedState: (jobId) => {
            const runlogPath = path.join(this.threadsDir, "tasks", jobId, "runlog.md");
            if (fs.existsSync(runlogPath)) return true;
            try {
              return fs.existsSync(this.supervisor.getCheckpointFilePath(jobId));
            } catch {
              return false;
            }
          },
          getAutoResumeCount: () => thread.autoResumeCount ?? 0,
          incrementAutoResumeCount: () => (thread.autoResumeCount ?? 0) + 1,
          markNeedsAttention: () => {
            thread.needsAttention = true;
          },
        },
      });
      if (outcome.action !== "not_stalled" && outcome.action !== "skipped_drain_owned") {
        acted += 1;
      }
    }
    return acted;
  }

  /**
   * Reconciles a thread's status against live activeExecutionSet (S2)
   * and derives title from content if "New thread" (S4).
   */
  reconcileThread(thread: Thread): boolean {
    let changed = false;

    // qa-6: reap zombie live signals first. A leaked presence entry older
    // than the hard cap with a stale record is deleted so it cannot keep a
    // dead turn "live" forever; a leaked execution-set entry is discounted
    // (not deleted — the set is shared bookkeeping) when the record has
    // been untouched past the same cap.
    const now = Date.now();
    const presence = getActiveTurn(thread.id);
    const heartbeatMs = getActiveTurnHeartbeatMs(thread.id);
    const diskUpdatedMs = Date.parse(thread.updatedAt || thread.createdAt || "");
    const hasFreshHeartbeat =
      typeof heartbeatMs === "number" &&
      (!Number.isFinite(diskUpdatedMs) || heartbeatMs > diskUpdatedMs);
    const effectiveThread = hasFreshHeartbeat
      ? { ...thread, updatedAt: new Date(heartbeatMs).toISOString() }
      : thread;
    const presenceZombie = isZombiePresence(presence, effectiveThread, now);
    if (presenceZombie) {
      clearTurnActive(thread.id);
    }
    let executionLive =
      activeExecutionSet.has(thread.id) ||
      (thread.taskId ? activeExecutionSet.has(thread.taskId) : false);
    if (executionLive && isRecordStaleBeyond(effectiveThread, now, ZOMBIE_TURN_AGE_CAP_MS)) {
      executionLive = false;
    }

    const isLive = executionLive || (Boolean(presence) && !presenceZombie);

    // S2: Reconcile active status against live activeExecutionSet / activeTurnRegistry
    if (thread.status === "active" && !isLive) {
      let isTaskPaused = false;
      if (thread.taskId) {
        try {
          const checkpointFile = this.supervisor.getCheckpointFilePath(thread.taskId);
          if (fs.existsSync(checkpointFile)) {
            const data = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
            if (data && data.status === "paused") {
              isTaskPaused = true;
            }
          }
        } catch {}
      }

      if (isTaskPaused) {
        thread.status = "paused";
      } else {
        thread.status = "stopped";
      }
      if (thread.queuedForExecution) {
        delete thread.queuedForExecution;
      }
      changed = true;
      if (thread.messages && thread.messages.length > 0) {
        const lastMsg = thread.messages[thread.messages.length - 1];
        if (
          lastMsg.role === "assistant" &&
          !lastMsg.content.includes("Stopped") &&
          !lastMsg.content.includes("Paused")
        ) {
          lastMsg.isStopped = !isTaskPaused;
        }
      }
    }

    // CHAT-10 & Deliverable 4: Reconcile any orphaned 'streaming' assistant message when turn is no longer live
    // On thread read, a message in "streaming" status with no live execution registered is finalized as "incomplete", content preserved.
    if (!isLive && thread.messages && thread.messages.length > 0) {
      for (const msg of thread.messages) {
        if (msg.role === "assistant" && msg.status === "streaming") {
          msg.status = "incomplete";
          msg.isStopped = true;
          if (!msg.content || !msg.content.includes("⚠️ [Turn incomplete:")) {
            const trimmed = (msg.content || "").trim();
            msg.content = trimmed
              ? `${trimmed}\n\n⚠️ [Turn incomplete: Server restarted or turn interrupted.]`
              : `⚠️ [Turn incomplete: Server restarted or turn interrupted.]`;
          }
          if (thread.status === "active" || thread.status === "completed") {
            thread.status = "stopped";
          }
          changed = true;
        }
      }
    }

    // S4: Titles from content: retroactively title if placeholder or chopped mid-word
    const firstUserMsg = thread.messages?.find((m) => m.role === "user");
    const isPlaceholderTitle =
      !thread.title ||
      thread.title.toLowerCase() === "new thread" ||
      thread.title.toLowerCase() === "untitled thread" ||
      thread.title.toLowerCase() === "new task" ||
      thread.title.toLowerCase() === "new session";

    if (firstUserMsg && firstUserMsg.content && firstUserMsg.content.trim()) {
      const derived = deriveStoredThreadTitle(firstUserMsg.content);
      const isChoppedPrefix =
        Boolean(thread.title) &&
        derived.length > thread.title.length &&
        derived.startsWith(thread.title);
      if ((isPlaceholderTitle || isChoppedPrefix) && derived && derived !== thread.title) {
        thread.title = derived;
        changed = true;
      }
    } else if (!thread.title) {
      thread.title = "New thread";
      changed = true;
    }

    if (changed) {
      this.saveThread(thread);
    } else if (isLive && hasFreshHeartbeat && typeof heartbeatMs === "number") {
      // Apply the in-memory heartbeat timestamp on read without rewriting disk JSON.
      thread.updatedAt = new Date(heartbeatMs).toISOString();
    }

    // TURN-LIVENESS: stamp the derived heartbeat state on the returned record. Derived
    // AFTER reconciliation and never counted as a change, so a stale updatedAt is not
    // rewritten (a save would refresh updatedAt and mask a stalled turn).
    thread.liveness = computeTurnLiveness(thread, Date.now());

    return changed;
  }

  /**
   * Loads all threads from disk and reconciles status honestly against the
   * running process state.
   */
  async listThreads(): Promise<Thread[]> {
    await this.ensureSeeded();

    const threads: Thread[] = [];
    try {
      const files = fs.readdirSync(this.threadsDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const raw = fs.readFileSync(path.join(this.threadsDir, file), "utf8");
            const thread = JSON.parse(raw) as Thread;
            if (thread && thread.id) {
              this.reconcileThread(thread);
              threads.push(thread);
            }
          } catch {}
        }
      }
    } catch {}

    // Also import any checkpointed tasks from supervisor that don't have a thread yet
    try {
      const tasks = await this.supervisor.listAllTasks();
      for (const task of tasks) {
        const matching = threads.find((t) => t.taskId === task.taskId || t.id === task.taskId);
        if (!matching) {
          const isActivelyRunning = activeExecutionSet.has(task.taskId);
          const honestStatus = isActivelyRunning
            ? "active"
            : task.status === "paused"
              ? "paused"
              : task.status === "parked"
                ? "parked"
                : task.status === "failed"
                  ? "failed"
                  : task.status === "completed"
                    ? "completed"
                    : "stopped";

          const newThread: Thread = {
            id: `thread-${task.taskId}`,
            title: deriveThreadTitle(task.goal),
            status: honestStatus as Thread["status"],
            createdAt: task.startedAt || new Date().toISOString(),
            updatedAt: task.updatedAt || task.startedAt || new Date().toISOString(),
            model: "swift-15-27b-mtp",
            reasoningEffort: "medium",
            taskId: task.taskId,
            messages: [
              {
                id: `msg-${Date.now()}-user`,
                role: "user",
                content: task.goal,
                timestamp: task.startedAt || new Date().toISOString(),
              },
              {
                id: `msg-${Date.now()}-assistant`,
                role: "assistant",
                content:
                  honestStatus === "completed"
                    ? "Task completed successfully."
                    : honestStatus === "stopped"
                      ? "Task stopped."
                      : "Task in progress.",
                timestamp: task.updatedAt || new Date().toISOString(),
                taskId: task.taskId,
                isStopped: honestStatus === "stopped",
              },
            ],
          };
          threads.push(newThread);
          this.saveThread(newThread);
        }
      }
    } catch {}

    // Sort descending by updatedAt
    return threads.sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt).getTime() -
        new Date(a.updatedAt || a.createdAt).getTime()
    );
  }

  private get summaryCache(): Map<string, { mtimeMs: number; summary: ThreadSummary }> {
    const g = globalThis as unknown as {
      __lasSummaryCache?: Map<string, Map<string, { mtimeMs: number; summary: ThreadSummary }>>;
    };
    if (!g.__lasSummaryCache) {
      g.__lasSummaryCache = new Map();
    }
    let cache = g.__lasSummaryCache.get(this.threadsDir);
    if (!cache) {
      cache = new Map();
      g.__lasSummaryCache.set(this.threadsDir, cache);
    }
    return cache;
  }
  private summaryIndexLoaded = false;

  private get summaryIndexPath(): string {
    return path.join(this.threadsDir, ".summaries-index.json");
  }

  private async loadSummaryIndex(): Promise<void> {
    if (this.summaryIndexLoaded) return;
    this.summaryIndexLoaded = true;
    try {
      const raw = await fs.promises.readFile(this.summaryIndexPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, { mtimeMs: number; summary: ThreadSummary }>;
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v.mtimeMs === "number" && v.summary && typeof v.summary.id === "string") {
            this.summaryCache.set(k, v);
          }
        }
      }
    } catch {
      // Index does not exist yet or is malformed; will be rebuilt
    }
  }

  private async saveSummaryIndex(): Promise<void> {
    try {
      const obj: Record<string, { mtimeMs: number; summary: ThreadSummary }> = {};
      for (const [k, v] of this.summaryCache.entries()) {
        obj[k] = v;
      }
      await fs.promises.writeFile(this.summaryIndexPath, JSON.stringify(obj), "utf8");
    } catch {
      // Best-effort sidecar persistence
    }
  }

  private reconcileSummaryStatus(summary: ThreadSummary): ThreadSummary {
    const hasActiveTurn = Boolean(getActiveTurn(summary.id));
    const isActivelyRunning =
      activeExecutionSet.has(summary.id) ||
      hasActiveTurn ||
      (summary.taskId ? activeExecutionSet.has(summary.taskId) : false);
    const heartbeatMs = getActiveTurnHeartbeatMs(summary.id);
    const summaryUpdatedMs = Date.parse(summary.updatedAt || summary.createdAt || "");
    const effectiveUpdatedAt =
      (isActivelyRunning ||
        summary.hasStreamingMessage ||
        summary.status === "active" ||
        summary.status === "running") &&
      typeof heartbeatMs === "number" &&
      (!Number.isFinite(summaryUpdatedMs) || heartbeatMs > summaryUpdatedMs)
        ? new Date(heartbeatMs).toISOString()
        : summary.updatedAt;
    const computeSummaryLiveness = (
      status: Thread["status"],
      isLiveOverride: boolean
    ): ThreadLiveness =>
      computeTurnLivenessPure(
        {
          id: summary.id,
          title: summary.title,
          status,
          createdAt: summary.createdAt,
          updatedAt: effectiveUpdatedAt,
          model: summary.model || "",
          reasoningEffort: summary.reasoningEffort || "low",
          messages: [],
        },
        Date.now(),
        isLiveOverride
      );

    if ((isActivelyRunning || summary.hasStreamingMessage) && summary.status !== "running") {
      return {
        ...summary,
        updatedAt: effectiveUpdatedAt,
        status: "running",
        liveness: computeSummaryLiveness("running", true),
      };
    }
    if (summary.status === "running" && !isActivelyRunning && !summary.hasStreamingMessage) {
      if (summary.error) {
        return { ...summary, status: "failed", liveness: "settled" };
      }
      if (summary.taskId) {
        try {
          const checkpointFile = this.supervisor.getCheckpointFilePath(summary.taskId);
          if (fs.existsSync(checkpointFile)) {
            const data = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
            if (
              data &&
              (data.status === "paused" ||
                data.status === "parked" ||
                data.status === "failed" ||
                data.status === "completed")
            ) {
              return { ...summary, status: data.status, liveness: "settled" };
            }
          }
        } catch {}
      }
      return { ...summary, status: "stopped", liveness: "settled" };
    }
    return {
      ...summary,
      updatedAt: effectiveUpdatedAt,
      liveness: computeSummaryLiveness(
        summary.status,
        isActivelyRunning || summary.hasStreamingMessage
      ),
    };
  }

  async listThreadSummaries(query?: string): Promise<ThreadSummary[]> {
    const q = query?.trim().toLowerCase() || "";
    if (!q) {
      if (!fs.existsSync(this.threadsDir)) return [];
      await this.ensureSeeded();
      await this.loadSummaryIndex();
      const files = (await fs.promises.readdir(this.threadsDir)).filter(
        (f) =>
          f.endsWith(".json") &&
          !f.startsWith(".") &&
          f !== ".summaries-index.json" &&
          !f.endsWith(".steer.json")
      );
      const summaries: ThreadSummary[] = [];
      const seen = new Set<string>();
      let indexDirty = false;
      for (const file of files) {
        seen.add(file);
        const fullPath = path.join(this.threadsDir, file);
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(fullPath);
        } catch {
          continue;
        }
        const cached = this.summaryCache.get(file);
        if (
          cached &&
          cached.mtimeMs === stat.mtimeMs &&
          typeof cached.summary.hasStreamingMessage === "boolean" &&
          typeof cached.summary.traceCount === "number"
        ) {
          summaries.push(this.reconcileSummaryStatus(cached.summary));
          continue;
        }
        try {
          const raw = await fs.promises.readFile(fullPath, "utf8");
          const t = JSON.parse(raw) as Thread;
          const msgs = Array.isArray(t.messages) ? t.messages : [];
          const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
          const fallbackRoundNarration =
            Array.isArray(lastMsg?.roundNarrations) && lastMsg.roundNarrations.length > 0
              ? lastMsg.roundNarrations[lastMsg.roundNarrations.length - 1]?.text || ""
              : "";
          const rawPreview = (lastMsg?.content || fallbackRoundNarration)
            .replace(/\s+/g, " ")
            .trim();
          const lastMessagePreview =
            rawPreview.length > 140 ? rawPreview.slice(0, 140) + "…" : rawPreview;
          const hasDiffs = msgs.some((m) => Array.isArray(m.diffs) && m.diffs.length > 0);
          const hasStreamingMessage = msgs.some(
            (m) => m.role === "assistant" && m.status === "streaming"
          );
          const traceCount = msgs.reduce(
            (sum, m) => sum + (Array.isArray(m.traces) ? m.traces.length : 0),
            0
          );
          const firstUserMsg = msgs.find((m) => m.role === "user" && m.content?.trim());
          const title =
            t.title && t.title !== "New session"
              ? t.title
              : firstUserMsg
                ? deriveStoredThreadTitle(firstUserMsg.content)
                : t.title || "New session";
          const summary: ThreadSummary = {
            id: t.id,
            title,
            status: t.status,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            ...(t.model !== undefined ? { model: t.model } : {}),
            ...(t.reasoningEffort !== undefined ? { reasoningEffort: t.reasoningEffort } : {}),
            ...(t.taskId !== undefined ? { taskId: t.taskId } : {}),
            ...(t.boardItemId !== undefined ? { boardItemId: t.boardItemId } : {}),
            ...((t as { error?: string }).error !== undefined
              ? { error: (t as { error?: string }).error }
              : {}),
            ...((t as { parkedReason?: string }).parkedReason !== undefined
              ? { parkedReason: (t as { parkedReason?: string }).parkedReason }
              : {}),
            ...(t.needsAttention !== undefined ? { needsAttention: t.needsAttention } : {}),
            ...(t.stalledReason !== undefined ? { stalledReason: t.stalledReason } : {}),
            ...(t.autoResumeCount !== undefined ? { autoResumeCount: t.autoResumeCount } : {}),
            ...(t.scope !== undefined ? { scope: t.scope } : {}),
            ...(t.hostAccess !== undefined ? { hostAccess: t.hostAccess } : {}),
            traceCount,
            messageCount: msgs.length,
            lastMessagePreview,
            hasDiffs,
            hasStreamingMessage,
            ...(t.queuedForExecution ? { queuedForExecution: true } : {}),
          };
          this.summaryCache.set(file, { mtimeMs: stat.mtimeMs, summary });
          indexDirty = true;
          summaries.push(this.reconcileSummaryStatus(summary));
        } catch {
          // ignore malformed thread file
        }
      }
      for (const key of this.summaryCache.keys()) {
        if (!seen.has(key)) {
          this.summaryCache.delete(key);
          indexDirty = true;
        }
      }
      if (indexDirty) {
        await this.saveSummaryIndex();
      }
      summaries.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
      return summaries;
    }

    // Search path (q present): two-stage async search without calling listThreads() or sync fs.
    const allSummaries = await this.listThreadSummaries();
    const summaries: ThreadSummary[] = [];

    for (const s of allSummaries) {
      const titleMatches = s.title.toLowerCase().includes(q);
      let matchSnippet: string | undefined;
      let matchIdx = -1;

      const fullPath = path.join(this.threadsDir, `${s.id}.json`);
      try {
        const raw = await fs.promises.readFile(fullPath, "utf8");
        const t = JSON.parse(raw) as Thread;
        const msgs = Array.isArray(t.messages) ? t.messages : [];
        let bodyMatchContent: string | undefined;
        for (const m of msgs) {
          if (typeof m.content === "string") {
            const idx = m.content.toLowerCase().indexOf(q);
            if (idx !== -1) {
              bodyMatchContent = m.content;
              matchIdx = idx;
              break;
            }
          }
        }
        if (bodyMatchContent && matchIdx !== -1) {
          const start = Math.max(0, matchIdx - 32);
          const end = Math.min(bodyMatchContent.length, matchIdx + q.length + 48);
          const slice = bodyMatchContent.slice(start, end).replace(/\s+/g, " ").trim();
          matchSnippet = `${start > 0 ? "…" : ""}${slice}${end < bodyMatchContent.length ? "…" : ""}`;
        }
      } catch {
        if (!titleMatches && !s.lastMessagePreview.toLowerCase().includes(q)) {
          continue;
        }
      }

      if (!titleMatches && matchIdx === -1) {
        continue;
      }

      summaries.push({
        ...s,
        ...(matchSnippet ? { matchSnippet } : {}),
      });
    }

    return summaries;
  }

  async getThread(threadId: string): Promise<Thread | null> {
    let filePath = this.getFilePath(threadId);
    if (!fs.existsSync(filePath)) {
      const prefixedPath = this.getFilePath(`thread-${threadId}`);
      if (fs.existsSync(prefixedPath)) {
        filePath = prefixedPath;
      } else {
        return null;
      }
    }

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const thread = JSON.parse(raw) as Thread;
      this.reconcileThread(thread);
      return thread;
    } catch {
      return null;
    }
  }

  private supervisorDispatchTurn?: (threadId: string, prompt: string) => void;

  setSupervisorDispatchTurn(fn: (threadId: string, prompt: string) => void): void {
    this.supervisorDispatchTurn = fn;
  }

  private dispatchSupervisorTurn(threadId: string, prompt: string): void {
    if (this.supervisorDispatchTurn) {
      this.supervisorDispatchTurn(threadId, prompt);
      return;
    }
    const port = process.env.PORT || "3000";
    void fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        messages: [{ role: "user", content: prompt }],
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          let bodyText = "";
          try {
            bodyText = await res.text();
          } catch {
            bodyText = "";
          }
          const detail = bodyText ? ` — ${bodyText.slice(0, 500)}` : "";
          const errorMsg = `Supervisor auto-resume dispatch failed (HTTP ${res.status})${detail}`;
          console.error(`[ThreadStore] ${errorMsg} (threadId=${threadId})`);
          const thread = await this.getThread(threadId);
          if (thread) {
            thread.error = errorMsg;
            thread.needsAttention = true;
            thread.status = "failed";
            this.saveThread(thread);
          }
        }
      })
      .catch(async (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        const errorMsg = `Supervisor auto-resume dispatch error: ${reason}`;
        console.error(`[ThreadStore] ${errorMsg} (threadId=${threadId})`);
        const thread = await this.getThread(threadId);
        if (thread) {
          thread.error = errorMsg;
          thread.needsAttention = true;
          thread.status = "failed";
          this.saveThread(thread);
        }
      });
  }

  saveThread(thread: Thread): void {
    if (deletedThreadIds.has(thread.id)) {
      return;
    }
    if (!fs.existsSync(this.threadsDir)) {
      try {
        fs.mkdirSync(this.threadsDir, { recursive: true, mode: 0o770 });
      } catch {}
      try {
        fs.chmodSync(this.threadsDir, 0o770);
      } catch {}
    }
    thread.updatedAt = new Date().toISOString();
    // TOKEN ECONOMICS (a): the per-job rollup rides on the thread record so the
    // board item surfaces it without a separate UI surface. Recomputed on every
    // save from the per-turn rollups recorded on assistant messages.
    thread.tokenEconomics = computeThreadTokenEconomics(thread);
    const targetFile = this.getFilePath(thread.id);
    const tempFile = path.join(
      this.threadsDir,
      `.${thread.id}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
    );
    try {
      fs.writeFileSync(tempFile, JSON.stringify(thread, null, 2), {
        encoding: "utf8",
        mode: 0o660,
      });
      try {
        fs.chmodSync(tempFile, 0o660);
      } catch {}
      fs.renameSync(tempFile, targetFile);
      try {
        fs.chmodSync(targetFile, 0o660);
      } catch {}
    } catch {
      if (fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch {}
      }
      // Fallback to direct write if rename fails across partitions
      fs.writeFileSync(targetFile, JSON.stringify(thread, null, 2), {
        encoding: "utf8",
        mode: 0o660,
      });
      try {
        fs.chmodSync(targetFile, 0o660);
      } catch {}
    }
  }

  createThread(params: {
    id?: string;
    title?: string;
    model?: string;
    reasoningEffort?: "low" | "medium" | "xhigh";
    initialPrompt?: string;
    attachments?: ThreadAttachment[];
    taskId?: string;
    boardItemId?: string;
    error?: string;
    parkedReason?: string;
    scope?: TaskScope;
    isTest?: boolean;
    isSubagent?: boolean;
    isScheduled?: boolean;
    /** In-app supervisor: reason the turn was honestly ended after stalling. */
    stalledReason?: string;
    /** In-app supervisor: true when auto-resume cap is reached or no banked state exists. */
    needsAttention?: boolean;
    /** In-app supervisor: number of auto-resumes issued for this thread/job. */
    autoResumeCount?: number;
    /** In-app supervisor: source thread ID when this thread was created by auto-resume. */
    resumedFromThreadId?: string;
    /** In-app supervisor: fresh thread ID created when this stalled thread was auto-resumed. */
    resumedToThreadId?: string;
    hostAccess?: boolean;
    chunkBudget?: ChunkBudgetConfig | null;
  }): Thread {
    const threadId = params.id || `thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    deletedThreadIds.delete(threadId);
    const title = params.title || deriveThreadTitle(params.initialPrompt);
    const hostAccess =
      params.hostAccess !== undefined ? params.hostAccess : getHostSettings().hostAccessEnabled;
    const thread: Thread = {
      id: threadId,
      title,
      status: params.taskId ? "active" : "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: params.model || DEFAULT_PRIMARY_MODEL,
      reasoningEffort: params.reasoningEffort || "medium",
      hostAccess,
      taskId: params.taskId,
      ...(params.boardItemId !== undefined ? { boardItemId: params.boardItemId } : {}),
      scope: params.scope,
      isTest: params.isTest ?? false,
      ...(params.isSubagent !== undefined ? { isSubagent: params.isSubagent } : {}),
      ...(params.isScheduled !== undefined ? { isScheduled: params.isScheduled } : {}),
      ...(params.chunkBudget !== undefined ? { chunkBudget: params.chunkBudget } : {}),
      messages: params.initialPrompt
        ? [
            {
              id: `msg-${Date.now()}-u`,
              role: "user",
              content: params.initialPrompt,
              attachments: params.attachments,
              timestamp: new Date().toISOString(),
            },
          ]
        : [],
    };

    this.saveThread(thread);
    return thread;
  }

  addMessage(threadId: string, message: ThreadMessage): Thread | null {
    if (deletedThreadIds.has(threadId)) {
      return null;
    }
    const filePath = this.getFilePath(threadId);
    let thread: Thread | null = null;
    if (fs.existsSync(filePath)) {
      try {
        thread = JSON.parse(fs.readFileSync(filePath, "utf8")) as Thread;
      } catch {}
    }
    if (!thread) return null;

    thread.messages = thread.messages || [];
    const existingIdx = thread.messages.findIndex((m) => m.id === message.id);
    if (existingIdx >= 0) {
      const cleanMessage = Object.fromEntries(
        Object.entries(message).filter(([_, v]) => v !== undefined)
      ) as Partial<ThreadMessage>;
      thread.messages[existingIdx] = {
        ...thread.messages[existingIdx],
        ...cleanMessage,
      };
    } else if (
      message.role === "assistant" &&
      thread.messages.length > 0 &&
      thread.messages[thread.messages.length - 1].role === "assistant" &&
      !(thread.messages[thread.messages.length - 1].content || "").trim()
    ) {
      const cleanMessage = Object.fromEntries(
        Object.entries(message).filter(([_, v]) => v !== undefined)
      ) as Partial<ThreadMessage>;
      const tailIdx = thread.messages.length - 1;
      thread.messages[tailIdx] = {
        ...thread.messages[tailIdx],
        ...cleanMessage,
      };
    } else {
      thread.messages.push(message);
    }

    if (message.role === "user") {
      if (
        !thread.title ||
        thread.title.toLowerCase() === "new thread" ||
        thread.title.toLowerCase() === "untitled thread" ||
        thread.title.toLowerCase() === "new task" ||
        thread.title.toLowerCase() === "new session"
      ) {
        const content = message.content || "";
        if (content.trim()) {
          thread.title = deriveStoredThreadTitle(content);
        }
      }
    } else if (message.role === "assistant") {
      if (message.status === "streaming") {
        thread.status = "active";
      } else if (message.status === "incomplete" || message.status === "error") {
        thread.status = "stopped";
      } else {
        thread.status = "completed";
      }
    }

    this.saveThread(thread);
    return thread;
  }

  upsertMessage(threadId: string, message: ThreadMessage): Thread | null {
    return this.addMessage(threadId, message);
  }

  /**
   * TOKEN ECONOMICS (a): small read path for the board item. Returns the
   * per-job rollup (rounds, prompt-token integral, output tokens, compaction
   * count) aggregated from the thread's per-turn records.
   */
  getTokenEconomics(threadId: string): JobTokenRollup {
    const filePath = this.getFilePath(threadId);
    let thread: Thread | null = null;
    if (fs.existsSync(filePath)) {
      try {
        thread = JSON.parse(fs.readFileSync(filePath, "utf8")) as Thread;
      } catch {}
    }
    if (!thread) return { rounds: 0, promptTokens: 0, outputTokens: 0, compactions: 0 };
    return thread.tokenEconomics ?? computeThreadTokenEconomics(thread);
  }

  async clearThreadMessages(threadId: string): Promise<Thread | null> {
    const thread = await this.getThread(threadId);
    if (!thread) return null;
    thread.messages = [];
    thread.updatedAt = new Date().toISOString();
    this.saveThread(thread);
    return thread;
  }

  async deleteThread(threadId: string): Promise<boolean> {
    // 1. Abort any active streaming turn first & clear live presence
    abortActiveTurn(threadId);
    clearTurnActive(threadId);
    activeExecutionSet.delete(threadId);
    deletedThreadIds.add(threadId);

    const filePath = this.getFilePath(threadId);
    let thread: Thread | null = null;
    if (fs.existsSync(filePath)) {
      try {
        thread = JSON.parse(fs.readFileSync(filePath, "utf8")) as Thread;
      } catch {}
    }

    let taskId = thread?.taskId;
    if (!taskId && (threadId.startsWith("thread-task-") || threadId.startsWith("task-"))) {
      taskId = threadId.startsWith("thread-task-") ? threadId.replace(/^thread-/, "") : threadId;
    }

    const isGhostTaskThread = Boolean(
      taskId && (threadId === `thread-${taskId}` || threadId.startsWith("thread-task-"))
    );

    if (taskId) {
      activeExecutionSet.delete(taskId);
      if (isGhostTaskThread) {
        // (3) Checkpoint-synthesized ghost thread: remove checkpoint manifest so it never resurrects
        try {
          const checkpointFile = this.supervisor.getCheckpointFilePath(taskId);
          if (fs.existsSync(checkpointFile)) {
            fs.unlinkSync(checkpointFile);
          }
        } catch {}
      } else {
        // (4) REAL thread with taskId: keep today's behavior (cancel task, checkpoint retained)
        try {
          const task = await this.supervisor.resumeTaskFromCheckpoint(taskId);
          if (task) {
            task.status = "cancelled";
            task.updatedAt = new Date().toISOString();
            task.journal.push({
              timestamp: new Date().toISOString(),
              role: "supervisor",
              message: "Run cancelled upon thread deletion.",
            });
            this.supervisor.saveCheckpoint(task);
          }
        } catch {}
      }
    }

    let deletedAny = false;

    // (1) Remove thread record JSON
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        deletedAny = true;
      } catch {}
    }

    // (1) Remove thread's <threadId>/ subdirectory recursively
    const subDir = path.join(this.threadsDir, threadId);
    if (fs.existsSync(subDir)) {
      try {
        fs.rmSync(subDir, { recursive: true, force: true });
        deletedAny = true;
      } catch {}
    }

    // (1) Remove its <threadId>.steer.json sidecar if present
    const steerFile = path.join(this.threadsDir, `${threadId}.steer.json`);
    if (fs.existsSync(steerFile)) {
      try {
        fs.unlinkSync(steerFile);
        deletedAny = true;
      } catch {}
    }

    // (2) Remove leaked task/thread sidecar files (.handoff.json, -runlog.md, and -lg-checkpoint.json for non-task/ghost threads)
    const isRealTaskThread = Boolean(taskId && !isGhostTaskThread);
    const sidecarDirs = Array.from(
      new Set([
        this.threadsDir,
        path.dirname(this.supervisor.getCheckpointFilePath(taskId || threadId)),
      ])
    );
    const sidecarIds = Array.from(new Set([threadId, ...(taskId ? [taskId] : [])]));
    const sidecarSuffixes = isRealTaskThread
      ? [".handoff.json", "-runlog.md"]
      : [".handoff.json", "-runlog.md", "-lg-checkpoint.json"];

    for (const dir of sidecarDirs) {
      for (const id of sidecarIds) {
        for (const suffix of sidecarSuffixes) {
          const sidecarPath = path.join(dir, `${id}${suffix}`);
          if (fs.existsSync(sidecarPath)) {
            try {
              fs.unlinkSync(sidecarPath);
              deletedAny = true;
            } catch {}
          }
        }
      }
    }

    return deletedAny || isGhostTaskThread || Boolean(thread);
  }

  buildModelMessages(
    thread: Thread
  ): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const rawMessages = (thread.messages || []).filter(
      (m) => !(m.role === "assistant" && m.status === "streaming" && !m.content)
    );
    if (!thread.compaction || !thread.compaction.throughMessageId) {
      return rawMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
    }

    const { throughMessageId, summary } = thread.compaction;
    const boundaryIdx = rawMessages.findIndex((m) => m.id === throughMessageId);
    if (boundaryIdx < 0) {
      // If boundary message id is not found, fallback to all messages
      return rawMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
    }

    const after = rawMessages.slice(boundaryIdx + 1);
    const result: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

    // If there was a leading system message before or at boundary, keep it
    const leadingSystem = rawMessages.find((m) => m.role === "system");
    if (leadingSystem) {
      result.push({ role: "system", content: leadingSystem.content });
    }

    result.push({
      role: "assistant",
      content: summary,
    });

    // Fix D5 (F8e): preserve the leading user brief verbatim if no user message
    // survives in the post-boundary tail (e.g. mid-single-turn compaction).
    const leadingUser = rawMessages.find((m) => m.role === "user");
    const afterHasUser = after.some((m) => m.role === "user");
    if (leadingUser && !afterHasUser) {
      result.push({
        role: "user",
        content: leadingUser.content,
      });
    }

    for (const m of after) {
      result.push({
        role: m.role,
        content: m.content,
      });
    }

    return result;
  }

  applyCompactionBoundary(
    thread: Thread,
    summary: string,
    throughMessageId: string,
    tokensBefore: number,
    tokensAfter: number
  ): Thread {
    thread.compaction = {
      throughMessageId,
      summary,
      compactedAt: new Date().toISOString(),
      tokensBefore,
      tokensAfter,
    };
    this.saveThread(thread);
    return thread;
  }

  clearCompactionBoundary(thread: Thread): Thread {
    delete thread.compaction;
    this.saveThread(thread);
    return thread;
  }

  compactThreadIncremental(thread: Thread): {
    noop: boolean;
    reason?: string;
    tokensBefore: number;
    tokensAfter: number;
    summary?: string;
    throughMessageId?: string;
    thread: Thread;
  } {
    const currentModelView = this.buildModelMessages(thread);
    const tokensBefore = estimateTokens(currentModelView);
    const messages = thread.messages || [];

    if (messages.length <= 4) {
      return {
        noop: true,
        reason: "insufficient_messages",
        tokensBefore,
        tokensAfter: tokensBefore,
        thread,
      };
    }

    const hasSystem = messages[0]?.role === "system";
    const baseStartIdx = hasSystem ? 1 : 0;
    const prevBoundaryIdx = thread.compaction?.throughMessageId
      ? messages.findIndex((m) => m.id === thread.compaction!.throughMessageId)
      : -1;

    const uncompactedStartIdx =
      prevBoundaryIdx >= baseStartIdx ? prevBoundaryIdx + 1 : baseStartIdx;
    const endIdx = Math.max(baseStartIdx, messages.length - 4);

    if (endIdx <= uncompactedStartIdx) {
      return {
        noop: true,
        reason: "already_compacted",
        tokensBefore,
        tokensAfter: tokensBefore,
        summary: thread.compaction?.summary,
        throughMessageId: thread.compaction?.throughMessageId,
        thread,
      };
    }

    const newlyEligible = messages.slice(uncompactedStartIdx, endIdx);
    if (newlyEligible.length === 0) {
      return {
        noop: true,
        reason: "already_compacted",
        tokensBefore,
        tokensAfter: tokensBefore,
        summary: thread.compaction?.summary,
        throughMessageId: thread.compaction?.throughMessageId,
        thread,
      };
    }

    const throughMessage = newlyEligible[newlyEligible.length - 1];
    const priorSummaryAndNewMessages =
      thread.compaction?.summary && prevBoundaryIdx >= baseStartIdx
        ? [{ role: "assistant" as const, content: thread.compaction.summary }, ...newlyEligible]
        : newlyEligible;

    const summary = summarizeTurnHistory(priorSummaryAndNewMessages);

    const candidateModelMessages = [
      ...(hasSystem ? [{ role: "system" as const, content: messages[0].content }] : []),
      { role: "assistant" as const, content: summary },
      ...messages.slice(endIdx).map((m) => ({ role: m.role, content: m.content })),
    ];

    const candidateTokensAfter = estimateTokens(candidateModelMessages);

    if (candidateTokensAfter >= tokensBefore) {
      return {
        noop: true,
        reason: "already_optimal",
        tokensBefore,
        tokensAfter: tokensBefore,
        summary: thread.compaction?.summary,
        throughMessageId: thread.compaction?.throughMessageId,
        thread,
      };
    }

    this.applyCompactionBoundary(
      thread,
      summary,
      throughMessage.id,
      tokensBefore,
      candidateTokensAfter
    );

    return {
      noop: false,
      tokensBefore,
      tokensAfter: candidateTokensAfter,
      summary,
      throughMessageId: throughMessage.id,
      thread,
    };
  }

  async compactThreadIncrementalHybrid(
    thread: Thread,
    opts: {
      summarize: (req: SummarizeRequest) => Promise<SummarizeResult | string>;
      inactivityMs?: number;
      totalDeadlineMs?: number;
      /**
       * Fix D4 (F8d): optional in-memory message array carried by the live round
       * loop. Mid-single-turn threads have <= 4 persisted messages on disk while
       * carrying dozens of in-flight rounds in memory; running the hybrid rung
       * against liveMessages compacts mid-turn and updates the persisted record
       * from the same result.
       */
      liveMessages?: CompactionMessage[];
      maxContentTokens?: number;
      compactionThreshold?: number;
      measuredPromptTokens?: number;
      toolSchemaTokens?: number;
      contextWindowTokens?: number;
      outputReserveTokens?: number;
    }
  ): Promise<{
    noop: boolean;
    reason?: string;
    tokensBefore: number;
    tokensAfter: number;
    summary?: string;
    throughMessageId?: string;
    modelSummaryUsed: boolean;
    fallbackReason?: HybridFallbackReason;
    messages?: CompactionMessage[];
    thread: Thread;
  }> {
    const persistedMessages = thread.messages || [];

    // Fix D4 (F8d): when liveMessages is provided (mid-turn roundLoop path), run
    // the hybrid rung against the live in-memory array rather than no-oping on
    // the <=4 persisted on-disk messages of a single-turn job.
    if (opts.liveMessages && opts.liveMessages.length > 4) {
      const result = await runHybridCompaction(opts.liveMessages, {
        strategy: "hybrid",
        maxContentTokens: opts.maxContentTokens,
        compactionThreshold: opts.compactionThreshold,
        measuredPromptTokens: opts.measuredPromptTokens,
        toolSchemaTokens: opts.toolSchemaTokens,
        contextWindowTokens: opts.contextWindowTokens,
        outputReserveTokens: opts.outputReserveTokens,
        summarize: opts.summarize,
        inactivityMs: opts.inactivityMs,
        totalDeadlineMs: opts.totalDeadlineMs,
      });
      if (!result.compacted) {
        return {
          noop: true,
          reason: "below_threshold",
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          modelSummaryUsed: false,
          thread,
        };
      }

      const settledPersisted = persistedMessages.filter(
        (m) => !(m.role === "assistant" && m.status === "streaming" && !m.content)
      );
      let throughMessageId = "mid-turn";
      if (settledPersisted.length > 4) {
        const hasPersistedSystem = settledPersisted[0]?.role === "system";
        const persistedEndIdx = Math.max(hasPersistedSystem ? 1 : 0, settledPersisted.length - 4);
        throughMessageId =
          settledPersisted[Math.max(0, persistedEndIdx - 1)]?.id ??
          settledPersisted[0]?.id ??
          "mid-turn";
      } else if (settledPersisted.length > 0) {
        throughMessageId = settledPersisted[settledPersisted.length - 1].id;
      } else if (persistedMessages.length > 0) {
        throughMessageId = persistedMessages[0].id;
      }

      this.applyCompactionBoundary(
        thread,
        result.liveContent ?? "",
        throughMessageId,
        result.tokensBefore,
        result.tokensAfter
      );
      thread.compaction!.strategy = "hybrid";
      thread.compaction!.extractionDigest = result.extractionDigest;
      if (result.fallback) {
        thread.compaction!.fallbackLogged = true;
        thread.compaction!.fallbackReason = result.fallbackReason;
      }
      this.saveThread(thread);
      return {
        noop: false,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        summary: result.liveContent,
        throughMessageId,
        modelSummaryUsed: result.modelSummaryUsed,
        fallbackReason: result.fallbackReason,
        messages: result.messages,
        thread,
      };
    }

    const messages = persistedMessages;
    const tokensBefore = estimateTokens(this.buildModelMessages(thread));
    if (messages.length <= 4) {
      return {
        noop: true,
        reason: "insufficient_messages",
        tokensBefore,
        tokensAfter: tokensBefore,
        modelSummaryUsed: false,
        thread,
      };
    }
    const hasSystem = messages[0]?.role === "system";
    const baseStartIdx = hasSystem ? 1 : 0;
    const prevBoundaryIdx = thread.compaction?.throughMessageId
      ? messages.findIndex((m) => m.id === thread.compaction?.throughMessageId)
      : -1;
    const uncompactedStartIdx =
      prevBoundaryIdx >= baseStartIdx ? prevBoundaryIdx + 1 : baseStartIdx;
    const endIdx = Math.max(baseStartIdx, messages.length - 4);
    if (endIdx <= uncompactedStartIdx) {
      return {
        noop: true,
        reason: "already_compacted",
        tokensBefore,
        tokensAfter: tokensBefore,
        modelSummaryUsed: false,
        thread,
      };
    }
    const result = await runHybridCompaction(messages, {
      strategy: "hybrid",
      maxContentTokens: opts.maxContentTokens,
      compactionThreshold: opts.compactionThreshold,
      measuredPromptTokens: opts.measuredPromptTokens,
      toolSchemaTokens: opts.toolSchemaTokens,
      contextWindowTokens: opts.contextWindowTokens,
      outputReserveTokens: opts.outputReserveTokens,
      summarize: opts.summarize,
      inactivityMs: opts.inactivityMs,
      totalDeadlineMs: opts.totalDeadlineMs,
    });
    if (!result.compacted) {
      return {
        noop: true,
        reason: "already_compacted",
        tokensBefore,
        tokensAfter: tokensBefore,
        modelSummaryUsed: false,
        thread,
      };
    }
    const throughMessage = messages[endIdx - 1];
    this.applyCompactionBoundary(
      thread,
      result.liveContent ?? "",
      throughMessage.id,
      result.tokensBefore,
      result.tokensAfter
    );
    thread.compaction!.strategy = "hybrid";
    thread.compaction!.extractionDigest = result.extractionDigest;
    if (result.fallback) {
      thread.compaction!.fallbackLogged = true;
      thread.compaction!.fallbackReason = result.fallbackReason;
    }
    this.saveThread(thread);
    return {
      noop: false,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      summary: result.liveContent,
      throughMessageId: throughMessage.id,
      modelSummaryUsed: result.modelSummaryUsed,
      fallbackReason: result.fallbackReason,
      messages: result.messages,
      thread,
    };
  }

  /**
   * Turn-start conversation preparation.
   *
   * Overload contract: without a summarize callback the call stays synchronous
   * (extraction rung, byte-identical to prior behavior). With a summarize
   * callback the call returns a Promise driven by the hybrid rung.
   */
  prepareTurnConversationMessages(
    thread: Thread | null,
    clientMessages: Array<{
      id?: string;
      role: string;
      content: string;
      timestamp?: string;
    }>,
    maxBudgetTokens: number,
    opts: TurnStartCompactionOptions & {
      summarize: (req: SummarizeRequest) => Promise<SummarizeResult | string>;
    }
  ): Promise<TurnConversationPreparation>;
  prepareTurnConversationMessages(
    thread: Thread | null,
    clientMessages: Array<{
      id?: string;
      role: string;
      content: string;
      timestamp?: string;
    }>,
    maxBudgetTokens?: number,
    opts?: TurnStartCompactionOptions
  ): TurnConversationPreparation;
  prepareTurnConversationMessages(
    thread: Thread | null,
    clientMessages: Array<{
      id?: string;
      role: string;
      content: string;
      timestamp?: string;
    }>,
    maxBudgetTokens: number = CHAT_CONTEXT_BUDGET_TOKENS,
    opts?: TurnStartCompactionOptions
  ): TurnConversationPreparation | Promise<TurnConversationPreparation> {
    if (thread && thread.messages && thread.messages.length > 0) {
      const clientUserMessages = (clientMessages || []).filter((m) => m.role === "user");
      const lastClientUser = clientUserMessages[clientUserMessages.length - 1];

      if (lastClientUser && lastClientUser.content) {
        const threadUserMessages = thread.messages.filter((m) => m.role === "user");
        const lastThreadUser = threadUserMessages[threadUserMessages.length - 1];

        if (!lastThreadUser || lastThreadUser.content !== lastClientUser.content) {
          const newMsg: ThreadMessage = {
            id: lastClientUser.id || `msg-${Date.now()}-u`,
            role: "user",
            content: lastClientUser.content,
            timestamp: new Date().toISOString(),
          };
          thread.messages.push(newMsg);
          this.saveThread(thread);
        }
      }

      let modelView = this.buildModelMessages(thread);
      const triggerThreshold = Math.floor(maxBudgetTokens * COMPACTION_THRESHOLD_RATIO);

      if (estimateTokens(modelView) > triggerThreshold) {
        // TURN-START STRATEGY DISPATCH (compaction-hybrid turn-start fix): the
        // turn-start path must consult COMPACTION_STRATEGY instead of always
        // running the synchronous extraction rung. The hybrid rung previously
        // lived only in the mid-turn fit branch, which turn-start compaction
        // pre-empts, so a flag-on thread crossing the 85% trigger at turn start
        // got the extraction digest with strategy null.
        //
        // strategy=hybrid WITH a summarize callback routes to the hybrid rung:
        // extraction first, then exactly ONE guarded summarization pass when the
        // post-extraction model view still exceeds 65% of the budget (temperature
        // 0.2 pinned, generation capped 8192, 180s inactivity / 5-min total
        // deadline, identifier post-check). ANY failure, timeout, truncation, or
        // post-check rejection falls back to the extraction digest and is logged;
        // the extraction digest is always retained on the thread record as the
        // audit copy. strategy=extraction, hybrid without a callback, or no
        // options at all keep the synchronous extraction call byte-identical.
        const strategy = opts?.strategy ?? resolveCompactionStrategy();
        if (strategy === "hybrid" && opts?.summarize) {
          const summarize = opts.summarize;
          return this.compactThreadIncrementalHybrid(thread, {
            summarize,
            inactivityMs: opts.inactivityMs,
            totalDeadlineMs: opts.totalDeadlineMs,
          }).then((hybridResult) => {
            if (!hybridResult.noop) {
              return {
                messages: this.buildModelMessages(thread),
                compactedThisTurn: true,
                tokensBeforeCompaction: hybridResult.tokensBefore,
                tokensAfterCompaction: hybridResult.tokensAfter,
                modelSummaryUsed: hybridResult.modelSummaryUsed,
                fallbackReason: hybridResult.fallbackReason,
              };
            }
            return { messages: this.buildModelMessages(thread), compactedThisTurn: false };
          });
        }
        const compResult = this.compactThreadIncremental(thread);
        if (!compResult.noop) {
          modelView = this.buildModelMessages(thread);
          return {
            messages: modelView,
            compactedThisTurn: true,
            tokensBeforeCompaction: compResult.tokensBefore,
            tokensAfterCompaction: compResult.tokensAfter,
          };
        }
      }

      return {
        messages: modelView,
        compactedThisTurn: false,
      };
    }

    return {
      messages: [...(clientMessages || [])],
      compactedThisTurn: false,
    };
  }

  async cleanupTestSessions(): Promise<number> {
    let count = 0;
    try {
      if (!fs.existsSync(this.threadsDir)) return 0;
      const files = fs.readdirSync(this.threadsDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const raw = fs.readFileSync(path.join(this.threadsDir, file), "utf8");
            const thread = JSON.parse(raw) as Thread;
            if (
              thread.isTest ||
              thread.id.startsWith("test-") ||
              thread.id.includes("-test-") ||
              thread.id.includes("tmp-")
            ) {
              await this.deleteThread(thread.id);
              count++;
            }
          } catch {}
        }
      }
    } catch {}
    return count;
  }
}
