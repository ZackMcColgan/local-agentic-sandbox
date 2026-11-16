import { resolveThreadsDir, ThreadStore } from "@/lib/threads/threadStore";
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
  const threads = await store.listThreads();
  if (threads.length === 0) {
    return boardItems;
  }

  const existingIds = new Set(boardItems.map((item) => item.id));
  const existingLinks = new Set(
    boardItems.map((item) => item.threadLink).filter((link): link is string => Boolean(link)),
  );

  const merged = [...boardItems];
  for (const thread of threads) {
    const threadLink = `/?thread=${thread.id}`;
    if (existingIds.has(thread.id) || existingLinks.has(threadLink)) {
      continue;
    }
    const now = new Date().toISOString();
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

  return merged;
}
