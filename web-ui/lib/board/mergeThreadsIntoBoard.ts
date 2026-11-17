import { deriveThreadTitle, resolveThreadsDir, ThreadStore } from "@/lib/threads/threadStore";
import { OvernightSupervisor } from "@/lib/subagents/supervisor";
import type { BoardItem, BoardStatus } from "./boardStore";

export function mapThreadStatusToBoardStatus(status: string | undefined): BoardStatus {
  if (status === "active" || status === "running" || status === "streaming") {
    return "working";
  }
  if (status === "completed") {
    return "done";
  }
  return "queued";
}

/**
 * Merges thread-backed items into the board item list on read without
 * persisting them into the board store. Resolves THREADS_DIR at call time.
 */
export async function mergeThreadsIntoBoard(boardItems: BoardItem[]): Promise<BoardItem[]> {
  const store = new ThreadStore(resolveThreadsDir());
  const threads = await store.listThreadSummaries();

  const existingIds = new Set(boardItems.map((item) => item.id));
  const existingLinks = new Set(
    boardItems.map((item) => item.threadLink).filter((link): link is string => Boolean(link)),
  );

  const merged = [...boardItems];
  const now = new Date().toISOString();
  for (const thread of threads) {
    const threadLink = `/?thread=${thread.id}`;
    if (existingIds.has(thread.id) || existingLinks.has(threadLink)) {
      continue;
    }
    merged.push({
      id: thread.id,
      key: thread.id,
      title: thread.title,
      brief: "",
      dependencies: [],
      status: mapThreadStatusToBoardStatus(thread.status),
      author: "Owner",
      source: "manual",
      threadLink,
      createdAt: thread.createdAt ?? now,
      updatedAt: thread.updatedAt ?? now,
    });
  }

  // Preserve ghost synthesis for checkpointed supervisor tasks without a thread file,
  // using supervisor task metadata only (no full thread-file parsing).
  try {
    const tasks = await new OvernightSupervisor().listAllTasks();
    for (const task of tasks) {
      const ghostId = `thread-${task.taskId}`;
      const hasMatchingThread = threads.some(
        (t) => t.id === task.taskId || t.id === ghostId || t.taskId === task.taskId,
      );
      if (hasMatchingThread) {
        continue;
      }
      const threadLink = `/?thread=${ghostId}`;
      if (existingIds.has(ghostId) || existingLinks.has(threadLink)) {
        continue;
      }
      const honestStatus =
        task.status === "paused"
          ? "paused"
          : task.status === "active"
            ? "stopped"
            : task.status === "completed"
              ? "completed"
              : "stopped";
      merged.push({
        id: ghostId,
        key: ghostId,
        title: deriveThreadTitle(task.goal),
        brief: "",
        dependencies: [],
        status: mapThreadStatusToBoardStatus(honestStatus),
        author: "Owner",
        source: "manual",
        threadLink,
        createdAt: task.startedAt || now,
        updatedAt: task.updatedAt || task.startedAt || now,
      });
    }
  } catch {}

  return merged;
}
