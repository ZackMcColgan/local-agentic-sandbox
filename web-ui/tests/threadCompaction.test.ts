import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { ThreadStore, Thread } from "../lib/threads/threadStore";

describe("Thread Compaction Boundary & Restore Suite", () => {
  const tmpDir = path.resolve("./.tmp-test-thread-compaction-" + Date.now());

  it("applies compaction boundary without mutating message history and builds model messages correctly", () => {
    const store = new ThreadStore(tmpDir);

    const thread: Thread = {
      id: "thread-test-compaction",
      title: "Test Thread",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: "swift-15-27b-mtp",
      reasoningEffort: "medium",
      messages: [
        { id: "m0", role: "system", content: "System prompt instructions.", timestamp: "now" },
        { id: "m1", role: "user", content: "Query 1", timestamp: "now" },
        { id: "m2", role: "assistant", content: "Response 1", timestamp: "now" },
        { id: "m3", role: "user", content: "Query 2", timestamp: "now" },
        { id: "m4", role: "assistant", content: "Response 2", timestamp: "now" },
        { id: "m5", role: "user", content: "Query 3", timestamp: "now" },
        { id: "m6", role: "assistant", content: "Response 3", timestamp: "now" }
      ]
    };

    store.saveThread(thread);

    // Apply compaction through m2
    store.applyCompactionBoundary(
      thread,
      "[COMPACTED DIGEST OF TURNS 1]",
      "m2",
      1500,
      400
    );

    // Verify raw messages untouched
    assert.equal(thread.messages.length, 7);
    assert.equal(thread.compaction?.throughMessageId, "m2");
    assert.equal(thread.compaction?.summary, "[COMPACTED DIGEST OF TURNS 1]");

    // Verify buildModelMessages replaces history through m2 with summary
    const modelMessages = store.buildModelMessages(thread);
    // Expected: system (m0) + summary + m3 + m4 + m5 + m6 = 6 messages
    assert.equal(modelMessages.length, 6);
    assert.equal(modelMessages[0].role, "system");
    assert.equal(modelMessages[0].content, "System prompt instructions.");
    assert.equal(modelMessages[1].role, "assistant");
    assert.equal(modelMessages[1].content, "[COMPACTED DIGEST OF TURNS 1]");
    assert.equal(modelMessages[2].content, "Query 2");
    assert.equal(modelMessages[5].content, "Response 3");

    // Clear compaction boundary (restore)
    store.clearCompactionBoundary(thread);
    assert.equal(thread.compaction, undefined);

    const restoredMessages = store.buildModelMessages(thread);
    assert.equal(restoredMessages.length, 7);
    assert.equal(restoredMessages[1].content, "Query 1");

    // Cleanup tmpDir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });
});
