import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  ChatQueue,
  decideSendAction,
  drainNextForTurnEnd,
  queueStorageKey,
  type StorageLike,
  type TurnEnding
} from "../lib/chatQueue";

/** In-memory StorageLike fake — same contract localStorage satisfies. */
function makeFakeStorage(): StorageLike & { dump(): Map<string, string> } {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    dump: () => store
  };
}

describe("CHAT-QUEUE — message queue for the sandbox (behavioral)", () => {
  let storage: ReturnType<typeof makeFakeStorage>;
  let seq: number;
  const nextId = () => `item-${seq++}`;

  beforeEach(() => {
    storage = makeFakeStorage();
    seq = 0;
  });

  describe("enqueue / items", () => {
    it("enqueue appends an item and persists it under the thread key", () => {
      const q = new ChatQueue(storage, "thread-a", nextId);
      const item = q.enqueue("first follow-up");
      assert.equal(item.text, "first follow-up");
      assert.ok(item.id, "items must carry an id");
      assert.deepEqual(q.items(), [item]);
      assert.ok(storage.getItem(queueStorageKey("thread-a")), "enqueue must write to storage");
    });

    it("enqueue ignores blank text", () => {
      const q = new ChatQueue(storage, "thread-a", nextId);
      assert.equal(q.enqueue("   "), null);
      assert.equal(q.items().length, 0);
    });

    it("FIFO order is preserved across multiple enqueues", () => {
      const q = new ChatQueue(storage, "thread-a", nextId);
      q.enqueue("one");
      q.enqueue("two");
      q.enqueue("three");
      assert.deepEqual(q.items().map((i) => i.text), ["one", "two", "three"]);
    });

    it("queues are isolated per thread id", () => {
      const a = new ChatQueue(storage, "thread-a", nextId);
      const b = new ChatQueue(storage, "thread-b", nextId);
      a.enqueue("for a");
      b.enqueue("for b");
      assert.deepEqual(a.items().map((i) => i.text), ["for a"]);
      assert.deepEqual(b.items().map((i) => i.text), ["for b"]);
    });
  });

  describe("shiftNext / drain semantics", () => {
    it("shiftNext returns exactly one item in FIFO order and removes it", () => {
      const q = new ChatQueue(storage, "thread-a", nextId);
      q.enqueue("one");
      q.enqueue("two");
      const drained = q.shiftNext();
      assert.equal(drained?.text, "one");
      assert.deepEqual(q.items().map((i) => i.text), ["two"]);
      assert.deepEqual(JSON.parse(storage.getItem(queueStorageKey("thread-a"))!), [{ id: "item-1", text: "two" }]);
    });

    it("shiftNext on an empty queue returns null and mutates nothing", () => {
      const q = new ChatQueue(storage, "thread-a", nextId);
      assert.equal(q.shiftNext(), null);
      assert.equal(q.items().length, 0);
    });

    it("drain-on-done sends exactly one item and removes it", () => {
      const q = new ChatQueue(storage, "thread-a", nextId);
      q.enqueue("follow-up 1");
      q.enqueue("follow-up 2");
      const sent = drainNextForTurnEnd(q, "done");
      assert.equal(sent?.text, "follow-up 1", "DONE must drain exactly one item");
      assert.deepEqual(q.items().map((i) => i.text), ["follow-up 2"], "only one item drains per turn end");
    });

    it("no drain on abort or error endings — the queue pauses", () => {
      const q = new ChatQueue(storage, "thread-a", nextId);
      q.enqueue("pending");
      assert.equal(drainNextForTurnEnd(q, "abort"), null, "abort must not auto-fire the queue");
      assert.equal(drainNextForTurnEnd(q, "error"), null, "error must not auto-fire the queue");
      assert.deepEqual(q.items().map((i) => i.text), ["pending"], "queue survives abort/error intact");
      assert.equal(drainNextForTurnEnd(q, "done")?.text, "pending", "queue resumes on the next DONE");
    });
  });

  describe("remove / clearAll", () => {
    it("remove(id) drops only that item", () => {
      const q = new ChatQueue(storage, "thread-a", nextId);
      const a = q.enqueue("keep");
      const b = q.enqueue("drop");
      assert.equal(q.remove(b!.id), true);
      assert.deepEqual(q.items().map((i) => i.id), [a!.id]);
      assert.equal(q.remove("nonexistent"), false);
    });

    it("clearAll empties the queue and clears the storage key", () => {
      const q = new ChatQueue(storage, "thread-a", nextId);
      q.enqueue("one");
      q.enqueue("two");
      q.clearAll();
      assert.equal(q.items().length, 0);
      assert.equal(storage.getItem(queueStorageKey("thread-a")), null, "clearAll must remove the storage key");
    });
  });

  describe("restore from storage by thread id", () => {
    it("a fresh ChatQueue for the same thread id restores the persisted items", () => {
      const first = new ChatQueue(storage, "thread-a", nextId);
      first.enqueue("survives reload 1");
      first.enqueue("survives reload 2");

      const reopened = new ChatQueue(storage, "thread-a", nextId);
      assert.deepEqual(reopened.items().map((i) => i.text), ["survives reload 1", "survives reload 2"]);

      const otherThread = new ChatQueue(storage, "thread-b", nextId);
      assert.equal(otherThread.items().length, 0, "another thread must see an empty queue");
    });

    it("corrupt storage payload degrades to an empty queue instead of throwing", () => {
      storage.setItem(queueStorageKey("thread-a"), "not-json{{{");
      const q = new ChatQueue(storage, "thread-a", nextId);
      assert.equal(q.items().length, 0);
      assert.equal(q.shiftNext(), null);
    });
  });

  describe("decideSendAction gating", () => {
    it("idle with text sends immediately", () => {
      assert.equal(decideSendAction({ running: false, hasAttachments: false, text: "hello" }), "send");
    });

    it("running with text enqueues instead of sending", () => {
      assert.equal(decideSendAction({ running: true, hasAttachments: false, text: "queued follow-up" }), "enqueue");
    });

    it("running with attachments is blocked with the attachments hint", () => {
      assert.equal(decideSendAction({ running: true, hasAttachments: true, text: "look at this file" }), "blocked-attachments");
    });

    it("running with nothing to enqueue stays blocked", () => {
      assert.equal(decideSendAction({ running: true, hasAttachments: false, text: "   " }), "blocked-attachments");
    });

    it("idle with attachments only still sends", () => {
      assert.equal(decideSendAction({ running: false, hasAttachments: true, text: "" }), "send");
    });
  });
});
