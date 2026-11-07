import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ThreadStore, ThreadMessage, Thread } from "../lib/threads/threadStore";
import { POST } from "../app/api/chat/route";
import { NextRequest } from "next/server";

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

      const prevLlmUrl = process.env.LLM_BASE_URL;
      process.env.LLM_BASE_URL = "http://127.0.0.1:59998"; // fast ECONNREFUSED

      try {
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
      } finally {
        if (prevLlmUrl !== undefined) process.env.LLM_BASE_URL = prevLlmUrl; else delete process.env.LLM_BASE_URL;
      }
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
        if (prevLlmUrl !== undefined) process.env.LLM_BASE_URL = prevLlmUrl; else delete process.env.LLM_BASE_URL;
      }
    });

    it("saves assistant message with status 'incomplete' and honest banner when stream is aborted", async () => {
      const store = new ThreadStore(tmpThreadsDir);
      const threadId = `thread-abort-${Date.now()}`;
      store.createThread({ id: threadId, title: "Abort Thread" });

      const http = await import("node:http");
      let activeRes: any = null;
      const abortMockServer = http.createServer((sReq, sRes) => {
        const url = sReq.url || "";
        if (url.includes("/api/ps")) {
          sRes.writeHead(200, { "Content-Type": "application/json" });
          sRes.end(JSON.stringify({ models: [] }));
          return;
        }
        if (url.includes("/api/generate")) {
          sRes.writeHead(200, { "Content-Type": "application/json" });
          sRes.end(JSON.stringify({ response: "", done: true }));
          return;
        }
        sRes.writeHead(200, { "Content-Type": "application/x-ndjson" });
        sRes.write(JSON.stringify({
          message: {
            content: "Partial streaming content before abort..."
          }
        }) + "\n");
        activeRes = sRes;
      });
      await new Promise<void>((r) => abortMockServer.listen(0, "127.0.0.1", () => r()));
      const mockPort = (abortMockServer.address() as any).port;
      const prevLlmUrl = process.env.LLM_BASE_URL;
      const prevOllamaUrl = process.env.OLLAMA_BASE_URL;
      process.env.LLM_BASE_URL = `http://127.0.0.1:${mockPort}`;
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${mockPort}`;

      try {
        const req = new NextRequest("http://localhost:3000/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId,
            userMessageId: "user-abort-turn",
            assistantMessageId: "asst-abort-turn",
            messages: [
              { role: "user", content: "Stream this long response", id: "user-abort-turn" }
            ],
            model: "swift-15-27b-mtp",
            enableTools: false
          })
        });

        const res = await POST(req as any);
        // Drain response body in background so writer never blocks
        const drainPromise = (async () => {
          if (!res.body) return;
          const reader = res.body.getReader();
          try {
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
          } catch {}
        })();

        // Wait until first token or server connection established
        for (let i = 0; i < 120; i++) {
          if (activeRes) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((r) => setTimeout(r, 50));

        // Explicit stop via thread API
        const { POST: THREAD_POST } = await import("../app/api/threads/[id]/route");
        const stopReq = new Request(`http://localhost:3000/api/threads/${threadId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" })
        });
        await THREAD_POST(stopReq as any, { params: Promise.resolve({ id: threadId }) });
        if (activeRes) {
          try { activeRes.end(); } catch {}
        }
        await drainPromise;

        // Check ThreadStore: Assistant message must be saved with status 'incomplete'
        for (let i = 0; i < 30; i++) {
          const thread = await store.getThread(threadId);
          const asst = thread?.messages.find((m) => m.id === "asst-abort-turn");
          if (asst && asst.status === "incomplete") break;
          await new Promise((r) => setTimeout(r, 100));
        }

        const thread = await store.getThread(threadId);
        assert.ok(thread);
        const asstMsg = thread.messages.find((m) => m.id === "asst-abort-turn");
        assert.ok(asstMsg, "Assistant message must be saved to ThreadStore on abort");
        assert.equal(asstMsg.role, "assistant");
        assert.equal(asstMsg.status, "incomplete");
        assert.ok(
          asstMsg.content.includes("⚠️ [Turn incomplete:"),
          "Must contain honest incomplete warning banner"
        );
      } finally {
        abortMockServer.close();
        if (prevLlmUrl !== undefined) process.env.LLM_BASE_URL = prevLlmUrl; else delete process.env.LLM_BASE_URL;
        if (prevOllamaUrl !== undefined) process.env.OLLAMA_BASE_URL = prevOllamaUrl; else delete process.env.OLLAMA_BASE_URL;
      }
    });
  });

  describe("Requirement 4: Turn-Lifetime Decoupling (Client Disconnect vs Explicit Stop & No Holes)", () => {
    let fakeServer: any;
    let serverPort: number;
    let prevLlmUrl: string | undefined;
    let prevOllamaUrl: string | undefined;
    let roundHandler: (parsed: any, res: any, req: any) => void;

    before(async () => {
      const http = await import("node:http");
      fakeServer = http.createServer((req, res) => {
        const url = req.url || "";
        if (url.includes("/api/ps")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ models: [] }));
          return;
        }
        if (url.includes("/api/generate")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ response: "", done: true }));
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let parsed: any = {};
          try { parsed = JSON.parse(body); } catch {}
          roundHandler(parsed, res, req);
        });
      });
      await new Promise<void>((r) => fakeServer.listen(0, "127.0.0.1", () => r()));
      serverPort = fakeServer.address().port;
      prevLlmUrl = process.env.LLM_BASE_URL;
      prevOllamaUrl = process.env.OLLAMA_BASE_URL;
      process.env.LLM_BASE_URL = `http://127.0.0.1:${serverPort}`;
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${serverPort}`;
    });

    after(() => {
      fakeServer.close();
      if (prevLlmUrl !== undefined) process.env.LLM_BASE_URL = prevLlmUrl; else delete process.env.LLM_BASE_URL;
      if (prevOllamaUrl !== undefined) process.env.OLLAMA_BASE_URL = prevOllamaUrl; else delete process.env.OLLAMA_BASE_URL;
    });

    it("1. Client disconnect mid-turn allows turn to complete detached server-side with FULL answer and consumes steer", async () => {
      process.env.LLM_BASE_URL = `http://127.0.0.1:${serverPort}`;
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${serverPort}`;
      const store = new ThreadStore(tmpThreadsDir);
      const threadId = `thread-decouple-${Date.now()}`;
      store.createThread({ id: threadId, title: "Decoupled Thread" });

      // Steer text queued before disconnect
      store.appendSteer(threadId, "Add tomorrow too");

      let roundCount = 0;
      let recordedPrompts: any[] = [];

      roundHandler = (parsed, res) => {
        recordedPrompts.push(parsed);
        roundCount++;
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (roundCount === 1) {
          // Send thinking and first tool call
          res.write(JSON.stringify({
            message: {
              thinking: "Investigating weather...",
              content: "Checking forecast...",
              tool_calls: [{
                id: "tc-1",
                type: "function",
                function: { name: "workspace_read_file", arguments: '{"path":"weather.txt"}' }
              }]
            }
          }) + "\n");
        } else {
          // Final synthesized answer
          res.write(JSON.stringify({
            message: {
              content: "Here is the complete forecast for today and tomorrow in Spanish Fort."
            }
          }) + "\n");
        }
        res.write(JSON.stringify({ message: {}, done: true }) + "\n");
        res.end();
      };

      const abortController = new AbortController();
      const req = new NextRequest("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          threadId,
          userMessageId: "u-decouple-1",
          assistantMessageId: "a-decouple-1",
          messages: [{ role: "user", content: "What is the weather?", id: "u-decouple-1" }],
          model: "swift-15-27b-mtp",
          enableTools: true
        })
      });

      const res = await POST(req as any);
      // Abort the client request SSE stream immediately after initial stream setup
      abortController.abort();

      // Wait for background detached turn execution to complete (including MCP fallback + 2 LLM rounds)
      for (let i = 0; i < 80; i++) {
        const thread = await store.getThread(threadId);
        const asst = thread?.messages.find((m) => m.id === "a-decouple-1");
        if (asst && asst.status === "completed") {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      // Wait for Test 1's finally block (MCP client close) to finish before starting Test 2
      for (let i = 0; i < 30; i++) {
        if (!(await import("../lib/threads/threadStore")).getActiveTurn(threadId)) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const finalThread = await store.getThread(threadId);
      assert.ok(finalThread);
      const asst = finalThread.messages.find((m) => m.id === "a-decouple-1");
      assert.ok(asst, "Assistant message must exist in thread");
      assert.equal(asst.status, "completed");
      assert.ok(asst.content.includes("complete forecast for today and tomorrow"));
      assert.equal(asst.content.includes("⚠️ [Turn incomplete:"), false, "Must not contain incomplete warning banner");

      // Steer should be persisted in transcript
      const steerMsg = finalThread.messages.find((m) => m.content.includes("Add tomorrow too"));
      assert.ok(steerMsg, "Steer must have been consumed and persisted to transcript");
    });

    it("2. Explicit Stop mid-turn halts turn and persists partial content with incomplete banner", async () => {
      process.env.LLM_BASE_URL = `http://127.0.0.1:${serverPort}`;
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${serverPort}`;
      const prevEngine = process.env.LLM_ENGINE;
      delete process.env.LLM_ENGINE;
      const store = new ThreadStore(tmpThreadsDir);
      const threadId = `thread-stop-${Date.now()}`;
      store.createThread({ id: threadId, title: "Stop Thread" });

      let activeRes: any = null;
      let stopTriggeredPromiseResolve: (() => void) | null = null;
      const stopTriggeredPromise = new Promise<void>((r) => {
        stopTriggeredPromiseResolve = r;
      });

      roundHandler = (_parsed, res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(JSON.stringify({
          message: {
            content: "Starting long process..."
          }
        }) + "\n");
        activeRes = res;
        if (stopTriggeredPromiseResolve) stopTriggeredPromiseResolve();
      };

      try {
        const req = new NextRequest("http://localhost:3000/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId,
            userMessageId: "u-stop-1",
            assistantMessageId: "a-stop-1",
            messages: [{ role: "user", content: "Do a long task", id: "u-stop-1" }],
            model: "swift-15-27b-mtp",
            enableTools: false
          })
        });

        const res = await POST(req as any);
        // Read until we receive the first token event ("Starting long process...")
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let receivedFirstToken = false;
        const readLoop = (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              if (text.includes("Starting long process")) {
                receivedFirstToken = true;
              }
            }
          } catch {}
        })();

        await Promise.race([
          stopTriggeredPromise,
          new Promise((r) => setTimeout(r, 12000))
        ]);
        for (let i = 0; i < 40; i++) {
          if (receivedFirstToken) break;
          await new Promise((r) => setTimeout(r, 50));
        }

        // Issue explicit STOP via POST /api/threads/[id]
        const { POST: THREAD_POST } = await import("../app/api/threads/[id]/route");
        const stopReq = new Request(`http://localhost:3000/api/threads/${threadId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" })
        });
        await THREAD_POST(stopReq as any, { params: Promise.resolve({ id: threadId }) });
        if (activeRes) {
          try { activeRes.end(); } catch {}
        }
        await readLoop;

        const finalThread = await store.getThread(threadId);
        assert.ok(finalThread);
        const asst = finalThread.messages.find((m) => m.id === "a-stop-1");
        assert.ok(asst);
        assert.equal(asst.status, "incomplete", `Expected incomplete, got ${asst.status} with content: ${JSON.stringify(asst.content)}`);
        assert.ok(asst.content.includes("⚠️ [Turn incomplete:"));
        assert.ok(asst.content.includes("Starting long process..."), "Partial streamed tokens must be preserved on Stop");
      } finally {
        if (prevEngine !== undefined) process.env.LLM_ENGINE = prevEngine; else delete process.env.LLM_ENGINE;
      }
    });

    it("3. Reload / GET /api/threads/[id] immediately after turn start sees in-progress assistant message (zero holes)", async () => {
      process.env.LLM_BASE_URL = `http://127.0.0.1:${serverPort}`;
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${serverPort}`;
      const store = new ThreadStore(tmpThreadsDir);
      const threadId = `thread-hole-check-${Date.now()}`;
      store.createThread({ id: threadId, title: "Hole Check Thread" });

      roundHandler = (_parsed, res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(JSON.stringify({ message: { content: "Story finished." }, done: true }) + "\n");
        res.end();
      };

      const abortController = new AbortController();
      // Start turn
      const req = new NextRequest("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          threadId,
          userMessageId: "u-hole-1",
          assistantMessageId: "a-hole-1",
          messages: [{ role: "user", content: "Tell me a story", id: "u-hole-1" }],
          model: "swift-15-27b-mtp"
        })
      });

      await POST(req as any);
      // Simulate client disconnect right after turn start
      abortController.abort();

      // Immediately call GET /api/threads/[id] while turn is running
      const { GET: THREAD_GET } = await import("../app/api/threads/[id]/route");
      const getRes = await THREAD_GET(new Request(`http://localhost:3000/api/threads/${threadId}`) as any, {
        params: Promise.resolve({ id: threadId })
      });
      const data = await getRes.json();
      assert.ok(data.thread);
      assert.equal(data.activeTurn?.status, "streaming");

      const asst = data.thread.messages.find((m: any) => m.id === "a-hole-1");
      assert.ok(asst, "Assistant message must be present immediately on thread reload (NO HOLE)");
      assert.equal(asst.status, "streaming");

      // Wait for background turn to finish so it doesn't leak into subsequent tests
      for (let i = 0; i < 60; i++) {
        const t = await store.getThread(threadId);
        const a = t?.messages.find((m) => m.id === "a-hole-1");
        if (a && a.status === "completed") break;
        await new Promise((r) => setTimeout(r, 100));
      }
    });

    it("4. [CHAT-10] Server restart mid-turn reconciles orphaned 'streaming' assistant message to 'incomplete' and keeps thread.status 'active' during streaming", async () => {
      const store = new ThreadStore(tmpThreadsDir);
      const threadId = `thread-restart-d4-${Date.now()}`;
      store.createThread({ id: threadId, title: "Restart Recovery Thread" });

      // Complete a first turn so thread.status becomes "completed"
      store.addMessage(threadId, {
        id: "u-turn-1",
        role: "user",
        content: "First turn",
        timestamp: new Date().toISOString()
      });
      store.addMessage(threadId, {
        id: "a-turn-1",
        role: "assistant",
        content: "First answer",
        status: "completed",
        timestamp: new Date().toISOString()
      });

      // Now simulate Turn 2 starting and writing a streaming snapshot (as ThrottledStreamSnapshot does)
      store.addMessage(threadId, {
        id: "u-turn-2",
        role: "user",
        content: "Second turn before pod restart",
        timestamp: new Date().toISOString()
      });
      const duringStream = store.addMessage(threadId, {
        id: "a-turn-2",
        role: "assistant",
        content: "Partial output before server restart...",
        status: "streaming",
        timestamp: new Date().toISOString()
      });
      assert.ok(duringStream);
      assert.equal(duringStream.status, "active", "thread.status must remain 'active' when a 'streaming' assistant message is added");

      // Now simulate server restart: activeExecutionSet and activeTurnRegistry do NOT contain threadId
      // When getThread is called after restart, reconcileThread must mark the orphaned streaming message as incomplete
      const reconciled = await store.getThread(threadId);
      assert.ok(reconciled);
      assert.equal(reconciled.status, "stopped", "Orphaned active thread must reconcile to 'stopped'");
      const asst2 = reconciled.messages.find((m) => m.id === "a-turn-2");
      assert.ok(asst2);
      assert.equal(asst2.status, "incomplete", "Orphaned streaming message must reconcile to 'incomplete' (not stay 'streaming' forever)");
      assert.equal(asst2.isStopped, true);
      assert.ok(
        asst2.content.includes("⚠️ [Turn incomplete:"),
        "Reconciled streaming message must include honest incomplete marker"
      );
      assert.ok(
        asst2.content.includes("Partial output before server restart..."),
        "Partial streamed content before restart must be preserved"
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
