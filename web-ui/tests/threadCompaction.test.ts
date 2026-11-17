import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { ThreadStore, Thread } from "../lib/threads/threadStore";
import { POST } from "../app/api/threads/[id]/compact/route";

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

  // F4.3: prepareTurnConversationMessages & stored boundary + 85% auto-compaction
  it("F4.3: prepareTurnConversationMessages respects stored boundary and auto-compacts at 85% budget", async () => {
    const f43TmpDir = path.resolve("./.tmp-test-f43-" + Date.now());
    try {
      const store = new ThreadStore(f43TmpDir);

      // 1. Thread with 10 messages and an existing compaction boundary through message 4 (m4)
      const thread1: Thread = {
        id: "thread-f43-boundary",
        title: "Boundary Thread",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: "swift-15-27b-mtp",
        reasoningEffort: "medium",
        messages: [
          { id: "m1", role: "user", content: "Query 1", timestamp: "now" },
          { id: "m2", role: "assistant", content: "Response 1", timestamp: "now" },
          { id: "m3", role: "user", content: "Query 2", timestamp: "now" },
          { id: "m4", role: "assistant", content: "Response 2", timestamp: "now" },
          { id: "m5", role: "user", content: "Query 3", timestamp: "now" },
          { id: "m6", role: "assistant", content: "Response 3", timestamp: "now" },
          { id: "m7", role: "user", content: "Query 4", timestamp: "now" },
          { id: "m8", role: "assistant", content: "Response 4", timestamp: "now" },
          { id: "m9", role: "user", content: "Query 5", timestamp: "now" },
          { id: "m10", role: "assistant", content: "Response 5", timestamp: "now" }
        ],
        compaction: {
          throughMessageId: "m4",
          summary: "[PRIOR COMPACTED SUMMARY THROUGH M4]",
          compactedAt: new Date().toISOString(),
          tokensBefore: 1200,
          tokensAfter: 350
        }
      };
      store.saveThread(thread1);

      const clientMessages1 = [
        ...thread1.messages,
        { role: "user", content: "New turn prompt from client" }
      ];

      const prep1 = store.prepareTurnConversationMessages(thread1, clientMessages1, 100000);
      assert.equal(prep1.compactedThisTurn, false);
      // Should NOT contain raw m1..m4; should start with summary, then m5..m10, then new user prompt
      const rolesAndContents = prep1.messages.map((m: any) => ({ role: m.role, content: m.content }));
      assert.ok(
        !rolesAndContents.some((m) => m.content === "Query 1" || m.content === "Query 2"),
        "Raw messages 1..4 before boundary must not be in model view"
      );
      assert.equal(rolesAndContents[0].role, "assistant");
      assert.equal(rolesAndContents[0].content, "[PRIOR COMPACTED SUMMARY THROUGH M4]");
      assert.equal(rolesAndContents[rolesAndContents.length - 1].content, "New turn prompt from client");

      // 2. Thread whose uncompacted messages exceed 85,000 estimated tokens (>85% of 100,000)
      // 360,000 chars is ~90,000 tokens (> 85,000)
      const largeContent = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6500);
      const thread2: Thread = {
        id: "thread-f43-autocompact",
        title: "Huge Thread",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: "swift-15-27b-mtp",
        reasoningEffort: "medium",
        messages: [
          { id: "h1", role: "user", content: "Early question: " + largeContent, timestamp: "now" },
          { id: "h2", role: "assistant", content: "Early answer: " + largeContent, timestamp: "now" },
          { id: "h3", role: "user", content: "Middle question: " + largeContent, timestamp: "now" },
          { id: "h4", role: "assistant", content: "Middle answer", timestamp: "now" },
          { id: "h5", role: "user", content: "Recent question 1", timestamp: "now" },
          { id: "h6", role: "assistant", content: "Recent answer 1", timestamp: "now" },
          { id: "h7", role: "user", content: "Recent question 2", timestamp: "now" },
          { id: "h8", role: "assistant", content: "Recent answer 2", timestamp: "now" }
        ]
      };
      store.saveThread(thread2);

      const clientMessages2 = [
        ...thread2.messages,
        { role: "user", content: "What is our current status?" }
      ];

      const prep2 = store.prepareTurnConversationMessages(thread2, clientMessages2, 100000);
      assert.equal(prep2.compactedThisTurn, true, "Must flag compactedThisTurn when exceeding 85% budget");
      assert.ok(prep2.tokensBeforeCompaction! > 85000, "tokensBeforeCompaction must exceed 85000");
      assert.ok(
        prep2.tokensAfterCompaction! < prep2.tokensBeforeCompaction!,
        "tokensAfterCompaction must be strictly less than tokensBeforeCompaction"
      );

      // Verify persisted to disk
      const savedThread2 = await store.getThread(thread2.id);
      assert.ok(savedThread2?.compaction, "Compaction boundary must be persisted to disk");
      assert.ok(savedThread2?.compaction?.throughMessageId);
      assert.ok(savedThread2!.compaction!.tokensAfter < savedThread2!.compaction!.tokensBefore);
    } finally {
      try {
        fs.rmSync(f43TmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // F4.4: Idempotent / non-increasing manual compaction via POST /api/threads/[id]/compact and compactThreadIncremental
  it("F4.4: manual compaction is idempotent, non-increasing, folds incremental turns, and allows restore", async () => {
    const f44TmpDir = path.resolve("./.tmp-test-f44-" + Date.now());
    try {
      process.env.THREADS_DIR = f44TmpDir;
      const store = new ThreadStore(f44TmpDir);

      const filler = "Detailed analysis of system performance and memory architecture. ".repeat(60);
      const thread: Thread = {
        id: "thread-f44-idempotent",
        title: "Manual Compact Thread",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: "swift-15-27b-mtp",
        reasoningEffort: "medium",
        messages: [
          { id: "m1", role: "user", content: "Turn 1 request: " + filler, timestamp: "now" },
          { id: "m2", role: "assistant", content: "Turn 1 answer: " + filler, timestamp: "now" },
          { id: "m3", role: "user", content: "Turn 2 request: " + filler, timestamp: "now" },
          { id: "m4", role: "assistant", content: "Turn 2 answer: " + filler, timestamp: "now" },
          { id: "m5", role: "user", content: "Turn 3 request: " + filler, timestamp: "now" },
          { id: "m6", role: "assistant", content: "Turn 3 answer: " + filler, timestamp: "now" },
          { id: "m7", role: "user", content: "Turn 4 request: " + filler, timestamp: "now" },
          { id: "m8", role: "assistant", content: "Turn 4 answer: " + filler, timestamp: "now" }
        ]
      };
      store.saveThread(thread);

      // Step 1: First compaction via route handler
      const req1 = new Request(`http://localhost/api/threads/${thread.id}/compact`, { method: "POST" });
      const res1 = await POST(req1, { params: Promise.resolve({ id: thread.id }) });
      const data1 = await res1.json();

      assert.equal(data1.noop, false, "First compaction should execute (noop=false)");
      assert.ok(data1.tokensAfter < data1.tokensBefore, "tokensAfter must be smaller than tokensBefore");
      const firstTokensAfter = data1.tokensAfter;
      assert.equal(data1.throughMessageId, "m4", "Preserves last 4 messages (m5..m8), compacts through m4");

      // Step 2: Second compaction immediately after (with no new messages added)
      const req2 = new Request(`http://localhost/api/threads/${thread.id}/compact`, { method: "POST" });
      const res2 = await POST(req2, { params: Promise.resolve({ id: thread.id }) });
      const data2 = await res2.json();

      assert.equal(data2.noop, true, "Immediate second compaction must be no-op");
      assert.equal(data2.tokensBefore, firstTokensAfter, "tokensBefore must equal the model view tokens, not raw messages");
      assert.ok(data2.tokensAfter <= data2.tokensBefore, "tokensAfter must never increase tokens");

      // Step 3: Add 2 new messages (1 turn) and compact a third time
      const updatedThread = (await store.getThread(thread.id))!;
      store.addMessage(thread.id, {
        id: "m9",
        role: "user",
        content: "Turn 5 request: " + filler,
        timestamp: "now"
      });
      store.addMessage(thread.id, {
        id: "m10",
        role: "assistant",
        content: "Turn 5 answer: " + filler,
        timestamp: "now"
      });

      const refreshedThread = (await store.getThread(thread.id))!;
      const comp3 = store.compactThreadIncremental(refreshedThread);
      assert.equal(comp3.noop, false, "Compacting after new turn should execute");
      assert.equal(comp3.throughMessageId, "m6", "New boundary should advance to m6 (preserving m7..m10)");
      assert.ok(comp3.tokensAfter <= comp3.tokensBefore, "tokensAfter must be <= tokensBefore");
      assert.ok(comp3.summary?.includes("Turn 1 request") || comp3.summary?.includes("Turn 2 request") || comp3.summary?.includes("Prior User Goals"), "Summary folds earlier and newly eligible messages");

      // Step 4: Restore boundary and verify raw messages return
      store.clearCompactionBoundary(refreshedThread);
      const fullModelMessages = store.buildModelMessages(refreshedThread);
      assert.equal(fullModelMessages.length, 10, "Clearing boundary restores all 10 raw messages");
      assert.equal(fullModelMessages[0].content, refreshedThread.messages[0].content);
    } finally {
      try {
        fs.rmSync(f44TmpDir, { recursive: true, force: true });
      } catch {}
    }
  });
});
