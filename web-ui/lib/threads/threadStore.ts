import fs from "fs";
import path from "path";
import { TaskManifest, TaskScope } from "../subagents/types";
import { OvernightSupervisor } from "../subagents/supervisor";
import { ExecutionTraceItem } from "@/components/ExecutionTrace";
import { estimateTokens, CHAT_CONTEXT_BUDGET_TOKENS } from "../contextBudget";
import { COMPACTION_THRESHOLD_RATIO } from "../modelLimits";
import { summarizeTurnHistory, runHybridCompaction, resolveCompactionStrategy } from "../conversationCompaction";
import type { CompactionStrategy, HybridFallbackReason, SummarizeRequest, SummarizeResult } from "../conversationCompaction";
import { TurnFileDiff } from "../chatDiffs";
import { computeThreadTokenEconomics, type JobTokenRollup } from "../tokenEconomics";
import type { ElisionMeta } from "../microElision";
import type { ReadDedupMeta } from "../readDedup";
import { getHostSettings } from "../hostSettings";

export const COMPACTION_TRIGGER_TOKENS = Math.floor(CHAT_CONTEXT_BUDGET_TOKENS * COMPACTION_THRESHOLD_RATIO);

/** Max characters for a derived thread-list title (UI-008). */
const THREAD_TITLE_MAX_CHARS = 40;

/**
 * UI-008: derive a readable thread-list title from a goal/prompt at
 * record-create time. Strips the driver/session style prefixes
 * ('Session: ', 'JOB — ' incl. hyphen/dash variants) case-insensitively,
 * collapses to the first line, and truncates at a word boundary so the
 * sidebar never shows a raw prefix or a mid-word cut. Plain goals pass
 * through unchanged apart from the word-boundary truncation.
 */
export function deriveStoredThreadTitle(raw: string | undefined): string {
  let text = (raw ?? "").trim();
  // Strip stacked style prefixes: 'Session:' / 'JOB' followed by an em/en dash,
  // hyphen, or colon separator. Only the exact prefix tokens are removed —
  // ordinary words that merely start with 'job'/'session' are left intact.
  const prefixPattern = /^(?:session|job)\s*[:\-–—]\s*/i;
  while (prefixPattern.test(text)) {
    text = text.replace(prefixPattern, "").trim();
  }
  // First line only — multi-line briefs keep the summary line.
  const firstLine = text.split(/\r?\n/)[0].trim();
  return firstLine || "New thread";
}

export function deriveThreadTitle(raw: string | undefined, maxChars: number = THREAD_TITLE_MAX_CHARS): string {
  const firstLine = deriveStoredThreadTitle(raw);
  if (firstLine === "New thread") return firstLine;
  if (firstLine.length <= maxChars) return firstLine;
  // Truncate at a word boundary: cut at the last whitespace before the cap.
  const window = firstLine.slice(0, maxChars);
  const lastBoundary = window.lastIndexOf(" ");
  const cut = lastBoundary > 0 ? window.slice(0, lastBoundary) : window;
  return cut.trim();
}

/** Result of turn-start conversation preparation (thread view + compaction report). */
export interface TurnConversationPreparation {
  messages: any[];
  compactedThisTurn: boolean;
  tokensBeforeCompaction?: number;
  tokensAfterCompaction?: number;
  /** True when the boundary summary placed in the model view is the MODEL DIGEST. */
  modelSummaryUsed?: boolean;
  /** Set when the hybrid pass failed and the extraction digest was used instead. */
  fallbackReason?: HybridFallbackReason;
}

/** Options for the turn-start compaction path (strategy-aware dispatch). */
export interface TurnStartCompactionOptions {
  /** Overrides COMPACTION_STRATEGY for this call; defaults to resolveCompactionStrategy(). */
  strategy?: CompactionStrategy;
  /** Summarization callback for the hybrid rung. Absent => extraction rung. */
  summarize?: (req: SummarizeRequest) => Promise<SummarizeResult | string>;
  /** Injectable deadlines (test seam); default to the pinned guardrails. */
  inactivityMs?: number;
  totalDeadlineMs?: number;
}

export interface ThreadAttachment {
  name: string;
  type: string;
  size: number;
  previewUrl?: string;
  base64?: string;
  isImage?: boolean;
}

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thought?: string;
  traces?: ExecutionTraceItem[];
  attachments?: ThreadAttachment[];
  diffs?: TurnFileDiff[];
  modelUsed?: string;
  durationMs?: number;
  thinkingDurationMs?: number;
  timestamp: string;
  taskId?: string;
  isStopped?: boolean;
  compactedThisTurn?: boolean;
  tokensBeforeCompaction?: number;
  tokensAfterCompaction?: number;
  compactionActions?: string[];
  selectedModel?: string;
  status?: "completed" | "incomplete" | "error" | "streaming";
  finish_reason?: string;
  outputTokens?: number;
  /** TOKEN ECONOMICS (a): prompt tokens recorded per model round in this turn. */
  roundPromptTokens?: number[];
  /** TOKEN ECONOMICS (c): micro-elision audit — every stub applied during the
   * turn (tool, target, original size, round). The full results remain in
   * `traces`, so a stubbed result stays recoverable from the thread record. */
  microElisions?: ElisionMeta[];
  /** TOKEN ECONOMICS (d): read-dedup audit — every unchanged re-read stubbed
   * during the turn (path, content hash, the earlier read's round/trace, and
   * the re-read's round). The full content of the first read remains in
   * `traces`, so a stubbed read stays recoverable from the thread record. */
  readDedups?: ReadDedupMeta[];
  /** TOKEN ECONOMICS (a): per-job rollup for this turn (rounds, prompt integral, output, compactions). */
  tokenEconomics?: JobTokenRollup;
}

/**
 * TURN-LIVENESS: derived heartbeat state for a thread record.
 * - "alive": turn is live and its record was touched within TURN_STALL_WINDOW_MS.
 * - "stalled": turn is live but no activity landed past the stale window.
 * - "settled": turn is not live (completed / stopped / failed / paused).
 */
export type ThreadLiveness = "alive" | "stalled" | "settled";

/** How long a live turn may go without a record touch before it reads as stalled. */
export const TURN_STALL_WINDOW_MS = 600000;

/**
 * qa-6 / UI-001 + UI-002: hard cap on zombie live signals. A turn-presence
 * entry (or execution-set entry) whose thread record has gone untouched
 * past this cap belongs to a turn that died without clearing its live
 * signals — reconcile reaps it instead of trusting it forever. A genuinely
 * live turn heartbeats its record (touchActiveTurn + per-round snapshots),
 * so its record never approaches this cap while it works.
 */
export const ZOMBIE_TURN_AGE_CAP_MS = 6 * 60 * 60 * 1000;

/** True when the thread record has not been touched for longer than windowMs. */
export function isRecordStaleBeyond(thread: Thread, now: number, windowMs: number): boolean {
  const touchedAt = Date.parse(thread.updatedAt || thread.createdAt || "");
  if (!Number.isFinite(touchedAt)) return false;
  return now - touchedAt > windowMs;
}

/**
 * A presence entry is a zombie when it is older than the hard cap AND the
 * thread record has been stale past the ordinary stall window. Both
 * conditions are required: an ancient presence with a fresh record is a
 * live long turn; a young presence with a stale record may just be a
 * quiet round.
 */
export function isZombiePresence(
  presence: { startedAt: string } | null | undefined,
  thread: Thread,
  now: number = Date.now()
): boolean {
  if (!presence) return false;
  const startedAt = Date.parse(presence.startedAt || "");
  if (!Number.isFinite(startedAt)) return false;
  if (now - startedAt <= ZOMBIE_TURN_AGE_CAP_MS) return false;
  return isRecordStaleBeyond(thread, now, TURN_STALL_WINDOW_MS);
}

/**
 * Derives liveness from the record's last-activity timestamp (updatedAt) against the
 * live-execution state. A live-but-stale turn is NEVER reconciled to completed here;
 * reconciliation stays owned by reconcileThread.
 */
export function computeTurnLiveness(thread: Thread, now: number = Date.now()): ThreadLiveness {
  const isLive =
    thread.status === "active" ||
    thread.status === "running" ||
    activeExecutionSet.has(thread.id) ||
    Boolean(getActiveTurn(thread.id));
  if (!isLive) return "settled";
  const touchedAt = Date.parse(thread.updatedAt || thread.createdAt || "");
  if (!Number.isFinite(touchedAt)) return "stalled";
  return now - touchedAt <= TURN_STALL_WINDOW_MS ? "alive" : "stalled";
}

/**
 * TURN-LIVENESS heartbeat: refreshes the thread record's updatedAt without touching
 * messages or status, so a working round reads ALIVE even between snapshot writes.
 */
export function touchActiveTurn(threadId: string): void {
  try {
    const filePath = path.join(resolveThreadsDir(), `${threadId}.json`);
    if (!fs.existsSync(filePath)) return;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Thread;
    if (!raw || raw.id !== threadId) return;
    raw.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), { encoding: "utf8", mode: 0o660 });
  } catch {}
}

export interface ThreadCompactionBoundary {
  strategy?: CompactionStrategy;
  extractionDigest?: string;
  fallbackLogged?: boolean;
  fallbackReason?: HybridFallbackReason;
  throughMessageId: string;
  summary: string;
  compactedAt: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface ThreadSummary {
  id: string;
  title: string;
  status: Thread["status"];
  createdAt: string;
  updatedAt: string;
  model?: string;
  reasoningEffort?: Thread["reasoningEffort"];
  taskId?: string;
  messageCount: number;
  lastMessagePreview: string;
  hasDiffs: boolean;
  matchSnippet?: string;
}

export interface Thread {
  id: string;
  title: string;
  status: "active" | "running" | "paused" | "stopped" | "completed" | "failed" | "needs_input";
  createdAt: string;
  updatedAt: string;
  liveness?: ThreadLiveness;
  model: string;
  reasoningEffort: "low" | "medium" | "xhigh";
  messages: ThreadMessage[];
  compaction?: ThreadCompactionBoundary;
  hostAccess?: boolean;
  taskId?: string;
  scope?: TaskScope;
  workerInfo?: string;
  timeLabel?: string;
  isTest?: boolean;
  isSubagent?: boolean;
  isScheduled?: boolean;
  /**
   * TOKEN ECONOMICS (a): per-job rollup aggregated across the thread's turns
   * (rounds, prompt-token integral, output tokens, compaction count). Surfaced
   * with the board item; no separate UI surface in this pass.
   */
  tokenEconomics?: JobTokenRollup;
}

export function resolveThreadsDir(): string {
  let resolvedDir = process.env.THREADS_DIR;
  if (!resolvedDir) {
    const candidates = [
      process.env.WORKSPACE_DIR
        ? path.resolve(process.env.WORKSPACE_DIR, ".agent/threads")
        : null,
      fs.existsSync("/workspace")
        ? path.resolve("/workspace/.agent/threads")
        : null,
      fs.existsSync(path.resolve(process.cwd(), "../workspace"))
        ? path.resolve(process.cwd(), "../workspace/.agent/threads")
        : null,
      path.resolve(process.cwd(), ".agent/threads"),
      path.resolve("/tmp/.agent/threads")
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
const g = globalThis as any;
export const activeExecutionSet: Set<string> =
  g.__sandboxActiveExecutionSet || (g.__sandboxActiveExecutionSet = new Set<string>());

/**
 * CHAT-PRESENCE: turn-presence marker. Visible in GET responses from the moment a
 * turn starts — before any token or streaming snapshot exists — so cross-device
 * watchers see "a turn is running" immediately. Cleared on done/error/abort/stop.
 */
export interface ActiveTurnInfo {
  threadId: string;
  startedAt: string;
  status: "streaming";
}

const activeTurnRegistry: Map<string, ActiveTurnInfo> =
  g.__sandboxActiveTurnRegistry || (g.__sandboxActiveTurnRegistry = new Map<string, ActiveTurnInfo>());
const activeTurnAbortControllers: Map<string, AbortController> =
  g.__sandboxActiveTurnAbortControllers || (g.__sandboxActiveTurnAbortControllers = new Map<string, AbortController>());
const activeRoundAbortControllers: Map<string, AbortController> =
  g.__sandboxActiveRoundAbortControllers || (g.__sandboxActiveRoundAbortControllers = new Map<string, AbortController>());
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
      status: "streaming"
    });
  }
}

export function getActiveTurn(threadId: string): ActiveTurnInfo | null {
  return activeTurnRegistry.get(threadId) ?? null;
}

export function clearTurnActive(threadId: string): void {
  activeTurnRegistry.delete(threadId);
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
    try { fs.chmodSync(path.dirname(this.threadsDir), 0o770); } catch {}
    try { fs.chmodSync(this.threadsDir, 0o770); } catch {}
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
      fs.writeFileSync(steerFile, JSON.stringify(pending, null, 2), { encoding: "utf8", mode: 0o660 });
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
      try { fs.chmodSync(this.threadsDir, 0o770); } catch {}
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
          diffSummary: "Tokens refactored to M3 design tokens"
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
          diffSummary: "Updated components with Material You styling"
        },
        {
          id: "m3",
          title: "Validate component theming & accessibility",
          description: "Run visual inspection and accessibility checks",
          acceptanceCriteria: [{ id: "ac3", assertion: "Contrast and layout pass accessibility" }],
          status: "pending",
          builderIterations: 0,
          criticRounds: 0
        }
      ],
      journal: [
        {
          timestamp: new Date(now - 1000 * 60 * 15).toISOString(),
          role: "builder",
          message: "Analyzing config dependencies... ✨"
        },
        {
          timestamp: new Date(now - 1000 * 60 * 10).toISOString(),
          role: "builder",
          message: "Validating theme tokens... ✨"
        },
        {
          timestamp: new Date(now - 1000 * 60 * 2).toISOString(),
          role: "builder",
          message: "Reconciling M3 color scheme... ✨"
        }
      ],
      checkpoints: [],
      ambiguityFlags: []
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
          content: "Let's rebuild the settings experience using Material 3. Keep it clean, add the migration checklist and a way to stop the run.",
          timestamp: "Today · 10:42 AM"
        }
      ]
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
          timestamp: "Today · 8:42 AM"
        },
        {
          id: "msg-c2",
          role: "assistant",
          thought: "Checking critic diff acceptance criteria and synthetic marker checks in workerPool.ts...",
          content: "The critic checks the diff against each acceptance criterion, then verifies no synthetic markers exist. If the model is unreachable it abstains instead of approving.",
          timestamp: "Today · 8:43 AM",
          traces: [
            {
              tool: "file",
              args: { path: "workerPool.ts:342" },
              result: "Diff verified against acceptance criteria; no synthetic markers found",
              durationMs: 45,
              timestamp: new Date(now - 1000 * 60 * 60 * 2).toISOString()
            }
          ]
        }
      ]
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
          timestamp: "Yesterday"
        },
        {
          id: "msg-q2",
          role: "assistant",
          content: "Evaluation run stopped after 14 iterations.",
          isStopped: true,
          timestamp: "Yesterday"
        }
      ]
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
    const presenceZombie = isZombiePresence(presence, thread, now);
    if (presenceZombie) {
      clearTurnActive(thread.id);
    }
    let executionLive =
      activeExecutionSet.has(thread.id) ||
      (thread.taskId ? activeExecutionSet.has(thread.taskId) : false);
    if (executionLive && isRecordStaleBeyond(thread, now, ZOMBIE_TURN_AGE_CAP_MS)) {
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
      changed = true;
      if (thread.messages && thread.messages.length > 0) {
        const lastMsg = thread.messages[thread.messages.length - 1];
        if (lastMsg.role === "assistant" && !lastMsg.content.includes("Stopped") && !lastMsg.content.includes("Paused")) {
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
            : (task.status === "paused"
                ? "paused"
                : (task.status === "active" ? "stopped" : (task.status === "completed" ? "completed" : "stopped")));

          const newThread: Thread = {
            id: `thread-${task.taskId}`,
            title: deriveThreadTitle(task.goal),
            status: honestStatus,
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
                timestamp: task.startedAt || new Date().toISOString()
              },
              {
                id: `msg-${Date.now()}-assistant`,
                role: "assistant",
                content: honestStatus === "completed" ? "Task completed successfully." : (honestStatus === "stopped" ? "Task stopped." : "Task in progress."),
                timestamp: task.updatedAt || new Date().toISOString(),
                taskId: task.taskId,
                isStopped: honestStatus === "stopped"
              }
            ]
          };
          threads.push(newThread);
          this.saveThread(newThread);
        }
      }
    } catch {}

    // Sort descending by updatedAt
    return threads.sort(
      (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
    );
  }

  async listThreadSummaries(query?: string): Promise<ThreadSummary[]> {
    const threads = await this.listThreads();
    const q = query?.trim().toLowerCase() || "";
    const summaries: ThreadSummary[] = [];

    for (const t of threads) {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
      const rawPreview = (lastMsg?.content || "").replace(/\s+/g, " ").trim();
      const lastMessagePreview = rawPreview.length > 140 ? rawPreview.slice(0, 140) + "…" : rawPreview;
      const hasDiffs = msgs.some((m) => Array.isArray(m.diffs) && m.diffs.length > 0);
      const firstUserMsg = msgs.find((m) => m.role === "user" && m.content?.trim());
      const title =
        t.title && t.title !== "New session"
          ? t.title
          : firstUserMsg
            ? deriveThreadTitle(firstUserMsg.content)
            : t.title || "New session";

      let matchSnippet: string | undefined;
      if (q) {
        const titleMatches = title.toLowerCase().includes(q);
        let bodyMatchContent: string | undefined;
        let matchIdx = -1;
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
        if (!titleMatches && matchIdx === -1) {
          continue;
        }
        if (bodyMatchContent && matchIdx !== -1) {
          const start = Math.max(0, matchIdx - 32);
          const end = Math.min(bodyMatchContent.length, matchIdx + q.length + 48);
          const slice = bodyMatchContent.slice(start, end).replace(/\s+/g, " ").trim();
          matchSnippet = `${start > 0 ? "…" : ""}${slice}${end < bodyMatchContent.length ? "…" : ""}`;
        }
      }

      summaries.push({
        id: t.id,
        title,
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        model: t.model,
        reasoningEffort: t.reasoningEffort,
        taskId: t.taskId,
        messageCount: msgs.length,
        lastMessagePreview,
        hasDiffs,
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

  saveThread(thread: Thread): void {
    if (deletedThreadIds.has(thread.id)) {
      return;
    }
    if (!fs.existsSync(this.threadsDir)) {
      try {
        fs.mkdirSync(this.threadsDir, { recursive: true, mode: 0o770 });
      } catch {}
      try { fs.chmodSync(this.threadsDir, 0o770); } catch {}
    }
    thread.updatedAt = new Date().toISOString();
    // TOKEN ECONOMICS (a): the per-job rollup rides on the thread record so the
    // board item surfaces it without a separate UI surface. Recomputed on every
    // save from the per-turn rollups recorded on assistant messages.
    thread.tokenEconomics = computeThreadTokenEconomics(thread);
    const targetFile = this.getFilePath(thread.id);
    const tempFile = path.join(this.threadsDir, `.${thread.id}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`);
    try {
      fs.writeFileSync(tempFile, JSON.stringify(thread, null, 2), { encoding: "utf8", mode: 0o660 });
      try { fs.chmodSync(tempFile, 0o660); } catch {}
      fs.renameSync(tempFile, targetFile);
      try { fs.chmodSync(targetFile, 0o660); } catch {}
    } catch (err) {
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch {}
      }
      // Fallback to direct write if rename fails across partitions
      fs.writeFileSync(targetFile, JSON.stringify(thread, null, 2), { encoding: "utf8", mode: 0o660 });
      try { fs.chmodSync(targetFile, 0o660); } catch {}
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
    scope?: TaskScope;
    isTest?: boolean;
  isSubagent?: boolean;
  isScheduled?: boolean;
    hostAccess?: boolean;
  }): Thread {
    const threadId = params.id || `thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    deletedThreadIds.delete(threadId);
    const title = params.title || deriveThreadTitle(params.initialPrompt);
    const hostAccess = params.hostAccess !== undefined ? params.hostAccess : getHostSettings().hostAccessEnabled;
    const thread: Thread = {
      id: threadId,
      title,
      status: params.taskId ? "active" : "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: params.model || "swift-15-27b-mtp",
      reasoningEffort: params.reasoningEffort || "medium",
      hostAccess,
      taskId: params.taskId,
      scope: params.scope,
      isTest: params.isTest ?? false,
      messages: params.initialPrompt
        ? [
            {
              id: `msg-${Date.now()}-u`,
              role: "user",
              content: params.initialPrompt,
              attachments: params.attachments,
              timestamp: new Date().toISOString()
            }
          ]
        : []
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
        ...cleanMessage
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
              message: "Run cancelled upon thread deletion."
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

    return deletedAny || isGhostTaskThread || Boolean(thread);
  }

  buildModelMessages(thread: Thread): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const rawMessages = (thread.messages || []).filter(
      (m) => !(m.role === "assistant" && m.status === "streaming" && !m.content)
    );
    if (!thread.compaction || !thread.compaction.throughMessageId) {
      return rawMessages.map((m) => ({
        role: m.role,
        content: m.content
      }));
    }

    const { throughMessageId, summary } = thread.compaction;
    const boundaryIdx = rawMessages.findIndex((m) => m.id === throughMessageId);
    if (boundaryIdx < 0) {
      // If boundary message id is not found, fallback to all messages
      return rawMessages.map((m) => ({
        role: m.role,
        content: m.content
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
      content: summary
    });

    for (const m of after) {
      result.push({
        role: m.role,
        content: m.content
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
      tokensAfter
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
        thread
      };
    }

    const hasSystem = messages[0]?.role === "system";
    const baseStartIdx = hasSystem ? 1 : 0;
    const prevBoundaryIdx = thread.compaction?.throughMessageId
      ? messages.findIndex((m) => m.id === thread.compaction!.throughMessageId)
      : -1;

    const uncompactedStartIdx = prevBoundaryIdx >= baseStartIdx ? prevBoundaryIdx + 1 : baseStartIdx;
    const endIdx = Math.max(baseStartIdx, messages.length - 4);

    if (endIdx <= uncompactedStartIdx) {
      return {
        noop: true,
        reason: "already_compacted",
        tokensBefore,
        tokensAfter: tokensBefore,
        summary: thread.compaction?.summary,
        throughMessageId: thread.compaction?.throughMessageId,
        thread
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
        thread
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
      ...messages.slice(endIdx).map((m) => ({ role: m.role, content: m.content }))
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
        thread
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
      thread
    };
  }

  async compactThreadIncrementalHybrid(
    thread: Thread,
    opts: { summarize: (req: SummarizeRequest) => Promise<SummarizeResult | string>; inactivityMs?: number; totalDeadlineMs?: number }
  ): Promise<{
    noop: boolean;
    reason?: string;
    tokensBefore: number;
    tokensAfter: number;
    summary?: string;
    throughMessageId?: string;
    modelSummaryUsed: boolean;
    fallbackReason?: HybridFallbackReason;
    thread: Thread;
  }> {
    const messages = thread.messages || [];
    const tokensBefore = estimateTokens(this.buildModelMessages(thread));
    if (messages.length <= 4) {
      return { noop: true, reason: "insufficient_messages", tokensBefore, tokensAfter: tokensBefore, modelSummaryUsed: false, thread };
    }
    const hasSystem = messages[0]?.role === "system";
    const baseStartIdx = hasSystem ? 1 : 0;
    const prevBoundaryIdx = thread.compaction?.throughMessageId
      ? messages.findIndex((m) => m.id === thread.compaction?.throughMessageId)
      : -1;
    const uncompactedStartIdx = prevBoundaryIdx >= baseStartIdx ? prevBoundaryIdx + 1 : baseStartIdx;
    const endIdx = Math.max(baseStartIdx, messages.length - 4);
    if (endIdx <= uncompactedStartIdx) {
      return { noop: true, reason: "already_compacted", tokensBefore, tokensAfter: tokensBefore, modelSummaryUsed: false, thread };
    }
    const result = await runHybridCompaction(messages, {
      strategy: "hybrid",
      summarize: opts.summarize,
      inactivityMs: opts.inactivityMs,
      totalDeadlineMs: opts.totalDeadlineMs,
    });
    if (!result.compacted) {
      return { noop: true, reason: "already_compacted", tokensBefore, tokensAfter: tokensBefore, modelSummaryUsed: false, thread };
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
    clientMessages: any[],
    maxBudgetTokens: number,
    opts: TurnStartCompactionOptions & { summarize: (req: SummarizeRequest) => Promise<SummarizeResult | string> }
  ): Promise<TurnConversationPreparation>;
  prepareTurnConversationMessages(
    thread: Thread | null,
    clientMessages: any[],
    maxBudgetTokens?: number,
    opts?: TurnStartCompactionOptions
  ): TurnConversationPreparation;
  prepareTurnConversationMessages(
    thread: Thread | null,
    clientMessages: any[],
    maxBudgetTokens: number = CHAT_CONTEXT_BUDGET_TOKENS,
    opts?: TurnStartCompactionOptions
  ): TurnConversationPreparation | Promise<TurnConversationPreparation> {
    if (thread && thread.messages && thread.messages.length > 0) {
      const clientUserMessages = (clientMessages || []).filter((m: any) => m.role === "user");
      const lastClientUser = clientUserMessages[clientUserMessages.length - 1];

      if (lastClientUser && lastClientUser.content) {
        const threadUserMessages = thread.messages.filter((m) => m.role === "user");
        const lastThreadUser = threadUserMessages[threadUserMessages.length - 1];

        if (!lastThreadUser || lastThreadUser.content !== lastClientUser.content) {
          const newMsg: ThreadMessage = {
            id: lastClientUser.id || `msg-${Date.now()}-u`,
            role: "user",
            content: lastClientUser.content,
            timestamp: new Date().toISOString()
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
            totalDeadlineMs: opts.totalDeadlineMs
          }).then((hybridResult) => {
            if (!hybridResult.noop) {
              return {
                messages: this.buildModelMessages(thread),
                compactedThisTurn: true,
                tokensBeforeCompaction: hybridResult.tokensBefore,
                tokensAfterCompaction: hybridResult.tokensAfter,
                modelSummaryUsed: hybridResult.modelSummaryUsed,
                fallbackReason: hybridResult.fallbackReason
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
            tokensAfterCompaction: compResult.tokensAfter
          };
        }
      }

      return {
        messages: modelView,
        compactedThisTurn: false
      };
    }

    return {
      messages: [...(clientMessages || [])],
      compactedThisTurn: false
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
