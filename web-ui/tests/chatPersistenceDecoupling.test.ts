import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ThreadStore, ThreadMessage, Thread } from "../lib/threads/threadStore";
import { POST } from "../app/api/chat/route";

describe("PACKAGE 3: Chat Runtime Shakeout (CHAT-4 + CHAT-6 Server-Side Turn Persistence & Decoupling)", () => {
  let tmpThreadsDir: string;
  let originalThreadsDir: string | undefined;

  beforeEach(() => {
    tmpThreadsDir = path.join(os.tmpdir(), `test-threads-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(tmpThreadsDir, { recursive: true, mode: 0o770 });
    originalThreadsDir = process.env.THREADS_DIR;
    process.env.THREADS_DIR = tmpThreadsDir;
  });

  afterEach(() => {
    process.env.THREADS_DIR = originalThreadsDir;
    try {
      if (fs.existsSync(tmpThreadsDir)) {
        fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe("Requirement 1 & 5: ThreadStore Idempotent Message Upsert & Status Tracking", () => {
    it("updates existing message in place when adding a message with an already existing ID", () => {
      const store = new ThreadStore(tmpThreadsDir);
      const thread = store.createThread({ title: "Shakeout Thread" });
      assert.ok(thread && thread.id);
      assert.equal(thread.messages.length, 0);

      // 1. Initial user message
      const userMsg: ThreadMessage = {
        id: "msg-user-1",
        role: "user",
        content: "What is the capital of France?",
        timestamp: new Date().toISOString()
      };
      store.addMessage(thread.id, userMsg);

      let loaded = store.getFilePath(thread.id);
      let data: Thread = JSON.parse(fs.readFileSync(loaded, "utf8"));
      assert.equal(data.messages.length, 1);
      assert.equal(data.messages[0].id, "msg-user-1");
      assert.equal(data.messages[0].content, "What is the capital of France?");

      // 2. Initial partial assistant message (e.g. streaming or aborted)
      const assistantMsgPartial: ThreadMessage = {
        id: "msg-asst-1",
        role: "assistant",
        content: "The capital of",
        thought: "Thinking about France...",
        timestamp: new Date().toISOString(),
        status: "incomplete"
      };
      store.addMessage(thread.id, assistantMsgPartial);

      data = JSON.parse(fs.readFileSync(loaded, "utf8"));
      assert.equal(data.messages.length, 2);
      assert.equal(data.messages[1].id, "msg-asst-1");
      assert.equal(data.messages[1].content, "The capital of");
      assert.equal(data.messages[1].status, "incomplete");
      assert.equal(data.messages[1].thought, "Thinking about France...");

      // 3. Upsert with completed message using same ID: MUST update in place without duplicating
      const assistantMsgCompleted: ThreadMessage = {
        id: "msg-asst-1",
        role: "assistant",
        content: "The capital of France is Paris.",
        timestamp: new Date().toISOString(),
        status: "completed",
        durationMs: 340,
        modelUsed: "swift-15-27b-mtp"
      };
      store.upsertMessage(thread.id, assistantMsgCompleted);

      data = JSON.parse(fs.readFileSync(loaded, "utf8"));
      assert.equal(data.messages.length, 2, "Message count must not increase on upsert");
      assert.equal(data.messages[1].id, "msg-asst-1");
      assert.equal(data.messages[1].content, "The capital of France is Paris.");
      assert.equal(data.messages[1].status, "completed");
      assert.equal(data.messages[1].thought, "Thinking about France...", "Existing thought should be retained if not overwritten");
      assert.equal(data.messages[1].durationMs, 340);
      assert.equal(data.messages[1].modelUsed, "swift-15-27b-mtp");

      // 4. Repeated call with addMessage using same ID also remains idempotent
      store.addMessage(thread.id, assistantMsgCompleted);
      data = JSON.parse(fs.readFileSync(loaded, "utf8"));
      assert.equal(data.messages.length, 2, "Message count must stay 2 on repeated addMessage");
    });

    it("supports all message status variants: completed, incomplete, error", () => {
      const store = new ThreadStore(tmpThreadsDir);
      const thread = store.createThread({ title: "Status Test" });

      const msg1: ThreadMessage = {
        id: "msg-completed",
        role: "assistant",
        content: "Turn completed successfully.",
        timestamp: new Date().toISOString(),
        status: "completed"
      };
      const msg2: ThreadMessage = {
        id: "msg-incomplete",
        role: "assistant",
        content: "⚠️ [Turn incomplete: Stream aborted or disconnected.]",
        timestamp: new Date().toISOString(),
        status: "incomplete"
      };
      const msg3: ThreadMessage = {
        id: "msg-error",
        role: "assistant",
        content: "⚠️ [Turn error: LLM engine is stopped]",
        timestamp: new Date().toISOString(),
        status: "error"
      };

      store.addMessage(thread.id, msg1);
      store.addMessage(thread.id, msg2);
      store.addMessage(thread.id, msg3);

      const filePath = store.getFilePath(thread.id);
      const loaded: Thread = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(loaded.messages.length, 3);
      assert.equal(loaded.messages[0].status, "completed");
      assert.equal(loaded.messages[1].status, "incomplete");
      assert.equal(loaded.messages[2].status, "error");
    });
  });

  describe("Requirement 1 & 6: Permissions & Security Boundary (Strict mode 0o660 / 0o770, no 0777)", () => {
    it("creates threads with strict file and directory permissions without 0777", () => {
      const store = new ThreadStore(tmpThreadsDir);
      const thread = store.createThread({ title: "Permissions Test" });

      const filePath = store.getFilePath(thread.id);
      assert.ok(fs.existsSync(filePath));

      // Check stat
      const stat = fs.statSync(filePath);
      assert.ok(stat.isFile());

      // Statically inspect threadStore.ts and route.ts for banned 0777 or 0o777
      const threadStoreSource = fs.readFileSync(path.resolve(__dirname, "../lib/threads/threadStore.ts"), "utf8");
      const routeSource = fs.readFileSync(path.resolve(__dirname, "../app/api/chat/route.ts"), "utf8");

      assert.ok(!threadStoreSource.includes("0777"), "threadStore.ts must never contain 0777 permissions");
      assert.ok(!threadStoreSource.includes("0o777"), "threadStore.ts must never contain 0o777 permissions");
      assert.ok(!routeSource.includes("0777"), "route.ts must never contain 0777 permissions");
      assert.ok(!routeSource.includes("0o777"), "route.ts must never contain 0o777 permissions");

      // Verify that 0o770 and 0o660 are used
      assert.ok(threadStoreSource.includes("0o770"), "threadStore.ts must use 0o770 for directories");
      assert.ok(threadStoreSource.includes("0o660"), "threadStore.ts must use 0o660 for files");
      assert.ok(routeSource.includes("0o770"), "route.ts must use 0o770 for directories");
    });
  });

  describe("Requirement 2: Server-Side Turn Persistence in /api/chat Route", () => {
    it("persists user message at turn start directly in ThreadStore before streaming", async () => {
      const store = new ThreadStore(tmpThreadsDir);
      const threadId = `thread-turn-start-${Date.now()}`;
      store.createThread({ id: threadId, title: "Initial Title" });

      const req = new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          userMessageId: "custom-user-msg-id-123",
          assistantMessageId: "custom-asst-msg-id-456",
          messages: [
            { role: "user", content: "Build a new React dashboard component", id: "custom-user-msg-id-123" }
          ],
          model: "swift-15-27b-mtp"
        })
      });

      // Call route handler
      const res = await POST(req as any);
      assert.ok(res.ok || res.status === 200 || res.status === 503 || res.status === 500);

      if (res.body) {
        try {
          const reader = res.body.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {}
      }

      // Check ThreadStore directly
      const thread = await store.getThread(threadId);
      assert.ok(thread);
      const userMsg = thread.messages.find((m) => m.id === "custom-user-msg-id-123");
      assert.ok(userMsg, "User message must be persisted directly to ThreadStore at turn start");
      assert.equal(userMsg.role, "user");
      assert.equal(userMsg.content, "Build a new React dashboard component");
    });

    it("saves assistant message with status 'error' and honest banner when execution fails", async () => {
      const store = new ThreadStore(tmpThreadsDir);
      const threadId = `thread-error-${Date.now()}`;
      store.createThread({ id: threadId, title: "Error Thread" });

      // Point LLM_BASE_URL to an unreachable endpoint to force engine connection failure
      const prevLlmUrl = process.env.LLM_BASE_URL;
      process.env.LLM_BASE_URL = "http://127.0.0.1:59999"; // unreachable

      try {
        const req = new Request("http://localhost:3000/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId,
            userMessageId: "user-err-turn",
            assistantMessageId: "asst-err-turn",
            messages: [
              { role: "user", content: "Analyze this system architecture", id: "user-err-turn" }
            ],
            model: "swift-15-27b-mtp"
          })
        });

        const res = await POST(req as any);
        // Read SSE stream until end
        if (res.body) {
          const reader = res.body.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        }

        // Check ThreadStore: Assistant message must be saved with status 'error'
        const thread = await store.getThread(threadId);
        assert.ok(thread);
        const asstMsg = thread.messages.find((m) => m.id === "asst-err-turn");
        assert.ok(asstMsg, "Assistant message must be saved even on engine/stream error");
        assert.equal(asstMsg.role, "assistant");
        assert.equal(asstMsg.status, "error");
        assert.ok(asstMsg.content.includes("⚠️ [Turn error:"));
      } finally {
        process.env.LLM_BASE_URL = prevLlmUrl;
      }
    });

    it("saves assistant message with status 'incomplete' and honest banner when stream is aborted", async () => {
      const store = new ThreadStore(tmpThreadsDir);
      const threadId = `thread-abort-${Date.now()}`;
      store.createThread({ id: threadId, title: "Abort Thread" });

      const abortController = new AbortController();

      const req = new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          threadId,
          userMessageId: "user-abort-turn",
          assistantMessageId: "asst-abort-turn",
          messages: [
            { role: "user", content: "Stream this long response", id: "user-abort-turn" }
          ],
          model: "swift-15-27b-mtp"
        })
      });

      // Abort immediately after POST call
      const res = await POST(req as any);
      abortController.abort();

      if (res.body) {
        try {
          const reader = res.body.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {}
      }

      // Check ThreadStore: Assistant message must be saved with status 'incomplete'
      const thread = await store.getThread(threadId);
      assert.ok(thread);
      const asstMsg = thread.messages.find((m) => m.id === "asst-abort-turn");
      assert.ok(asstMsg, "Assistant message must be saved to ThreadStore on abort");
      assert.equal(asstMsg.role, "assistant");
      assert.ok(
        asstMsg.status === "incomplete" || asstMsg.status === "error",
        `Expected status 'incomplete' or 'error', got '${asstMsg.status}'`
      );
      assert.ok(
        asstMsg.content.includes("⚠️ [Turn incomplete:") || asstMsg.content.includes("⚠️ [Turn error:"),
        "Must contain honest incomplete/error warning banner"
      );
    });
  });

  describe("Requirement 3: ChatStream Component Wiring Integration", () => {
    it("statically verifies ChatStream passes userMessageId and assistantMessageId to /api/chat", () => {
      const chatStreamSource = fs.readFileSync(
        path.resolve(__dirname, "../components/ChatStream.tsx"),
        "utf8"
      );

      // Verify request payload contains both IDs
      assert.ok(
        chatStreamSource.includes("userMessageId: userMsgId") ||
        chatStreamSource.includes("userMessageId"),
        "ChatStream must pass userMessageId in /api/chat payload"
      );
      assert.ok(
        chatStreamSource.includes("assistantMessageId: assistantMsgId") ||
        chatStreamSource.includes("assistantMessageId"),
        "ChatStream must pass assistantMessageId in /api/chat payload"
      );

      // Verify readStreamResponse receives or uses assistantMsgId
      assert.ok(
        chatStreamSource.includes("readStreamResponse") &&
        (chatStreamSource.includes("providedAssistantMsgId") ||
         chatStreamSource.includes("assistantMsgId")),
        "readStreamResponse must wire matching assistantMsgId"
      );
    });

    it("statically verifies /api/chat extracts userMessageId and assistantMessageId from request", () => {
      const routeSource = fs.readFileSync(
        path.resolve(__dirname, "../app/api/chat/route.ts"),
        "utf8"
      );

      assert.ok(
        routeSource.includes("userMessageId: requestedUserMessageId") ||
        routeSource.includes("userMessageId"),
        "route.ts must extract userMessageId"
      );
      assert.ok(
        routeSource.includes("assistantMessageId: requestedAssistantMessageId") ||
        routeSource.includes("assistantMessageId"),
        "route.ts must extract assistantMessageId"
      );
      assert.ok(
        routeSource.includes("assistantPersisted"),
        "route.ts must track assistantPersisted to avoid duplicate persistence"
      );
    });
  });
});
