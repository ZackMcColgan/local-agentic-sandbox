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
}

function resolveThreadsDir(): string {
  if (process.env.THREADS_DIR) {
    return process.env.THREADS_DIR;
  }
  const workspacePath = path.resolve(process.cwd(), "../workspace/.agent/threads");
  if (fs.existsSync(path.resolve(process.cwd(), "../workspace"))) {
    return workspacePath;
  }
  return path.resolve(process.cwd(), ".agent/threads");
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
   * Loads all threads from disk and reconciles status honestly against the
   * running process state.
   */
  async listThreads(): Promise<Thread[]> {
    if (!fs.existsSync(this.threadsDir)) {
      try {
        fs.mkdirSync(this.threadsDir, { recursive: true });
      } catch {}
    }

    const threads: Thread[] = [];
    try {
      const files = fs.readdirSync(this.threadsDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const raw = fs.readFileSync(path.join(this.threadsDir, file), "utf8");
            const thread = JSON.parse(raw) as Thread;
            if (thread && thread.id) {
              // Reconcile status honestly:
              // If marked active, but not actively executing in this Node process,
              // it means the server restarted or crashed — mark as stopped honestly.
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
