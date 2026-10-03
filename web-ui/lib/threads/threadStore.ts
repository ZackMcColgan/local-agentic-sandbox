import fs from "fs";
import path from "path";
import { TaskManifest } from "../subagents/types";
import { OvernightSupervisor } from "../subagents/supervisor";
import { ExecutionTraceItem } from "@/components/ExecutionTrace";

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
  modelUsed?: string;
  durationMs?: number;
  timestamp: string;
  taskId?: string;
  isStopped?: boolean;
}

export interface Thread {
  id: string;
  title: string;
  status: "active" | "stopped" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  model: string;
  reasoningEffort: "low" | "medium" | "xhigh";
  messages: ThreadMessage[];
  taskId?: string;
  workerInfo?: string;
  timeLabel?: string;
}

function resolveThreadsDir(): string {
  let resolvedDir = process.env.THREADS_DIR;
  if (!resolvedDir) {
    const candidates = [
      fs.existsSync(path.resolve(process.cwd(), "../workspace"))
        ? path.resolve(process.cwd(), "../workspace/.agent/threads")
        : null,
      path.resolve(process.cwd(), ".agent/threads"),
      path.resolve("/tmp/.agent/threads")
    ].filter(Boolean) as string[];

    for (const dir of candidates) {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
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

export class ThreadStore {
  private threadsDir: string;
  private supervisor: OvernightSupervisor;

  constructor(threadsDir?: string, supervisor?: OvernightSupervisor) {
    this.threadsDir = threadsDir || resolveThreadsDir();
    this.supervisor = supervisor || new OvernightSupervisor();
    if (!fs.existsSync(this.threadsDir)) {
      try {
        fs.mkdirSync(this.threadsDir, { recursive: true });
      } catch {}
    }
  }

  getFilePath(threadId: string): string {
    return path.join(this.threadsDir, `${threadId}.json`);
  }

  /**
   * Seeds the approved Mockup 1 & 3 initial threads if no threads exist yet.
   */
  async ensureSeeded(): Promise<void> {
    if (!fs.existsSync(this.threadsDir)) {
      try {
        fs.mkdirSync(this.threadsDir, { recursive: true });
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
      model: "qwen3.8:27b-q3_k_m",
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
      model: "qwen3.8:27b-q3_k_m",
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
      model: "qwen3.8:27b-q3_k_m",
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
              if (thread.status === "active" && !activeExecutionSet.has(thread.id) && (!thread.taskId || !activeExecutionSet.has(thread.taskId))) {
                thread.status = "stopped";
                if (thread.messages && thread.messages.length > 0) {
                  const lastMsg = thread.messages[thread.messages.length - 1];
                  if (lastMsg.role === "assistant" && !lastMsg.content.includes("Stopped")) {
                    lastMsg.isStopped = true;
                  }
                }
                this.saveThread(thread);
              }
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
            : (task.status === "active" ? "stopped" : (task.status === "completed" ? "completed" : "stopped"));

          const newThread: Thread = {
            id: `thread-${task.taskId}`,
            title: task.goal.slice(0, 48),
            status: honestStatus,
            createdAt: task.startedAt || new Date().toISOString(),
            updatedAt: task.updatedAt || task.startedAt || new Date().toISOString(),
            model: "qwen3.8:27b-q3_k_m",
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
      if (thread.status === "active" && !activeExecutionSet.has(thread.id) && (!thread.taskId || !activeExecutionSet.has(thread.taskId))) {
        thread.status = "stopped";
        this.saveThread(thread);
      }
      return thread;
    } catch {
      return null;
    }
  }

  saveThread(thread: Thread): void {
    if (!fs.existsSync(this.threadsDir)) {
      try {
        fs.mkdirSync(this.threadsDir, { recursive: true });
      } catch {}
    }
    thread.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.getFilePath(thread.id), JSON.stringify(thread, null, 2), "utf8");
  }

  createThread(params: {
    title?: string;
    model?: string;
    reasoningEffort?: "low" | "medium" | "xhigh";
    initialPrompt?: string;
    attachments?: ThreadAttachment[];
    taskId?: string;
  }): Thread {
    const threadId = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const title = params.title || (params.initialPrompt ? params.initialPrompt.slice(0, 40) : "New Thread");
    const thread: Thread = {
      id: threadId,
      title,
      status: params.taskId ? "active" : "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: params.model || "qwen3.8:27b-q3_k_m",
      reasoningEffort: params.reasoningEffort || "medium",
      taskId: params.taskId,
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

  deleteThread(threadId: string): boolean {
    const filePath = this.getFilePath(threadId);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        return true;
      } catch {}
    }
    return false;
  }
}
