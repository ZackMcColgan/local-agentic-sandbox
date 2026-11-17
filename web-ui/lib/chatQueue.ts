/**
 * CHAT-QUEUE: Client-side message queue during active turns.
 * Pure module with injected StorageLike for tests / localStorage in browser.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface QueueItem {
  id: string;
  text: string;
}

export type TurnEnding = "done" | "abort" | "error";

export function queueStorageKey(threadId: string): string {
  return `chat-queue:${threadId}`;
}

export class ChatQueue {
  private queue: QueueItem[] = [];

  constructor(
    private storage: StorageLike,
    private threadId: string,
    private idGenerator: () => string = () => `queue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  ) {
    this.load();
  }

  private load(): void {
    try {
      const raw = this.storage.getItem(queueStorageKey(this.threadId));
      if (!raw) {
        this.queue = [];
        return;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.queue = parsed.filter(
          (item) => item && typeof item.id === "string" && typeof item.text === "string"
        );
      } else {
        this.queue = [];
      }
    } catch {
      this.queue = [];
    }
  }

  private persist(): void {
    const key = queueStorageKey(this.threadId);
    if (this.queue.length === 0) {
      this.storage.removeItem(key);
    } else {
      this.storage.setItem(key, JSON.stringify(this.queue));
    }
  }

  enqueue(text: string): QueueItem | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const item: QueueItem = {
      id: this.idGenerator(),
      text: trimmed
    };
    this.queue.push(item);
    this.persist();
    return item;
  }

  items(): QueueItem[] {
    return [...this.queue];
  }

  shiftNext(): QueueItem | null {
    if (this.queue.length === 0) return null;
    const item = this.queue.shift() || null;
    this.persist();
    return item;
  }

  remove(id: string): boolean {
    const initLen = this.queue.length;
    this.queue = this.queue.filter((item) => item.id !== id);
    if (this.queue.length !== initLen) {
      this.persist();
      return true;
    }
    return false;
  }

  clearAll(): void {
    this.queue = [];
    this.persist();
  }
}

export function drainNextForTurnEnd(
  queue: ChatQueue,
  ending: TurnEnding
): QueueItem | null {
  if (ending !== "done") {
    return null;
  }
  return queue.shiftNext();
}

export function decideSendAction(options: {
  running: boolean;
  hasAttachments: boolean;
  text: string;
}): "send" | "enqueue" | "blocked-attachments" {
  const hasText = options.text.trim().length > 0;

  if (!options.running) {
    return "send";
  }

  if (options.hasAttachments) {
    return "blocked-attachments";
  }

  if (hasText) {
    return "enqueue";
  }

  return "blocked-attachments";
}
