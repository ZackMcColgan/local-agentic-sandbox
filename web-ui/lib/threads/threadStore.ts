import fs from "fs";
import path from "path";
import { TaskManifest, TaskScope } from "../subagents/types";
import { OvernightSupervisor } from "../subagents/supervisor";
import { ExecutionTraceItem } from "@/components/ExecutionTrace";
import { estimateTokens, CHAT_CONTEXT_BUDGET_TOKENS } from "../contextBudget";
import { summarizeTurnHistory } from "../conversationCompaction";
import { TurnFileDiff } from "../chatDiffs";

export const COMPACTION_TRIGGER_TOKENS = Math.floor(CHAT_CONTEXT_BUDGET_TOKENS * 0.85);

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
  timestamp: string;
  taskId?: string;
  isStopped?: boolean;
  compactedThisTurn?: boolean;
  tokensBeforeCompaction?: number;
  tokensAfterCompaction?: number;
  selectedModel?: string;
  status?: "completed" | "incomplete" | "error" | "streaming";
}

export interface ThreadCompactionBoundary {
  throughMessageId: string;
  summary: string;
  compactedAt: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface Thread {
  id: string;
  title: string;
  status: "active" | "running" | "paused" | "stopped" | "completed" | "failed" | "needs_input";
  createdAt: string;
  updatedAt: string;
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

// In-memory set of actively executing task/thread IDs in the current Node process
export const activeExecutionSet = new Set<string>();

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

const activeTurnRegistry = new Map<string, ActiveTurnInfo>();

export function markTurnActive(threadId: string): void {
  if (!activeTurnRegistry.has(threadId)) {
    activeTurnRegistry.set(threadId, {
      threadId,
      startedAt: new Date().toISOString(),
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

    // S2: Reconcile active status against live activeExecutionSet
    if (thread.status === "active") {
      const isLive =
        activeExecutionSet.has(thread.id) ||
        (thread.taskId ? activeExecutionSet.has(thread.taskId) : false);

      if (!isLive) {
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
    }

    // S4: Titles from content: retroactively title if "New thread", "New Thread", "Untitled Thread", or "New session"
    if (
      !thread.title ||
      thread.title.toLowerCase() === "new thread" ||
      thread.title.toLowerCase() === "untitled thread" ||
      thread.title.toLowerCase() === "new task" ||
      thread.title.toLowerCase() === "new session"
    ) {
      const firstUserMsg = thread.messages?.find((m) => m.role === "user");
      if (firstUserMsg && firstUserMsg.content && firstUserMsg.content.trim()) {
        const maxLen = thread.title?.toLowerCase() === "new session" ? 48 : 40;
        const derived = firstUserMsg.content.trim().slice(0, maxLen);
        if (derived && derived !== thread.title) {
          thread.title = derived;
          changed = true;
        }
      } else if (!thread.title) {
        thread.title = "New thread";
        changed = true;
      }
    }

    if (changed) {
      this.saveThread(thread);
    }

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
            title: task.goal.trim().slice(0, 40) || "New thread",
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

  async getThread(threadId: string): Promise<Thread | null> {
    const filePath = this.getFilePath(threadId);
    if (!fs.existsSync(filePath)) {
      // Check if threadId starts with or corresponds to a taskId
      const all = await this.listThreads();
      const match = all.find((t) => t.id === threadId || t.taskId === threadId || t.id === `thread-${threadId}`);
      if (match) return match;
      return null;
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
    if (!fs.existsSync(this.threadsDir)) {
      try {
        fs.mkdirSync(this.threadsDir, { recursive: true, mode: 0o770 });
      } catch {}
      try { fs.chmodSync(this.threadsDir, 0o770); } catch {}
    }
    thread.updatedAt = new Date().toISOString();
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
  }): Thread {
    const threadId = params.id || `thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const title = params.title || (params.initialPrompt && params.initialPrompt.trim() ? params.initialPrompt.trim().slice(0, 40) : "New thread");
    const thread: Thread = {
      id: threadId,
      title,
      status: params.taskId ? "active" : "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: params.model || "swift-15-27b-mtp",
      reasoningEffort: params.reasoningEffort || "medium",
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
          const maxLen = thread.title?.toLowerCase() === "new session" ? 48 : 40;
          thread.title = content.trim().slice(0, maxLen);
        }
      }
    } else if (message.role === "assistant") {
      if (thread.status !== "active") {
        thread.status = "completed";
      }
    }

    this.saveThread(thread);
    return thread;
  }

  upsertMessage(threadId: string, message: ThreadMessage): Thread | null {
    return this.addMessage(threadId, message);
  }

  async deleteThread(threadId: string): Promise<boolean> {
    const filePath = this.getFilePath(threadId);
    let thread: Thread | null = null;
    if (fs.existsSync(filePath)) {
      try {
        thread = JSON.parse(fs.readFileSync(filePath, "utf8")) as Thread;
      } catch {}
    }

    if (thread) {
      // S1: Live run stops first, then deletes
      activeExecutionSet.delete(thread.id);
      if (thread.taskId) {
        activeExecutionSet.delete(thread.taskId);
        try {
          const task = await this.supervisor.resumeTaskFromCheckpoint(thread.taskId);
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

    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        return true;
      } catch {}
    }
    return false;
  }

  buildModelMessages(thread: Thread): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const rawMessages = thread.messages || [];
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

  prepareTurnConversationMessages(
    thread: Thread | null,
    clientMessages: any[],
    maxBudgetTokens: number = CHAT_CONTEXT_BUDGET_TOKENS
  ): {
    messages: any[];
    compactedThisTurn: boolean;
    tokensBeforeCompaction?: number;
    tokensAfterCompaction?: number;
  } {
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
      const triggerThreshold = Math.floor(maxBudgetTokens * 0.85);

      if (estimateTokens(modelView) > triggerThreshold) {
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
