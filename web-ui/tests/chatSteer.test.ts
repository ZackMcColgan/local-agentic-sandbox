import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { ThreadStore } from "../lib/threads/threadStore";
import { POST as STEER_POST } from "../app/api/threads/[id]/steer/route";
import { NextRequest } from "next/server";

describe("CHAT-STEER — mid-turn steering mailbox (behavioral)", () => {
  let tmpDir: string;
  let store: ThreadStore;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `test-steer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    store = new ThreadStore(tmpDir);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe("ThreadStore steer mailbox methods", () => {
    it("appendSteer appends to disk mailbox and returns pendingCount", () => {
      const count1 = store.appendSteer("thread-1", "First direction");
      assert.equal(count1, 1);
      const count2 = store.appendSteer("thread-1", "Second direction");
      assert.equal(count2, 2);

      const pending = store.getPendingSteers("thread-1");
      assert.deepEqual(pending, ["First direction", "Second direction"]);
    });

    it("consumeSteers consumes exactly-once and removes mailbox", () => {
      store.appendSteer("thread-1", "Direction A");
      store.appendSteer("thread-1", "Direction B");

      const consumed = store.consumeSteers("thread-1");
      assert.deepEqual(consumed, ["Direction A", "Direction B"]);

      const secondConsume = store.consumeSteers("thread-1");
      assert.deepEqual(secondConsume, [], "second consume must be empty (exactly-once)");
      assert.equal(store.getPendingSteers("thread-1").length, 0);
    });

    it("pending steers survive until consumed", () => {
      store.appendSteer("thread-1", "Direction 1");
      const freshStore = new ThreadStore(tmpDir);
      assert.deepEqual(freshStore.getPendingSteers("thread-1"), ["Direction 1"]);
    });

    it("clearSteers empties the mailbox on thread end", () => {
      store.appendSteer("thread-1", "To be cleared");
      store.clearSteers("thread-1");
      assert.deepEqual(store.getPendingSteers("thread-1"), []);
    });
  });

  describe("POST /api/threads/[id]/steer endpoint", () => {
    it("appends steer and returns pendingCount", async () => {
      process.env.THREADS_DIR = tmpDir;
      store.createThread({ id: "t-endpoint", title: "Steer Endpoint Test Thread" });
      const req = new NextRequest("http://localhost/api/threads/t-endpoint/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Please focus on tests" })
      });

      const res = await STEER_POST(req, { params: Promise.resolve({ id: "t-endpoint" }) });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.pendingCount, 1);

      assert.deepEqual(store.getPendingSteers("t-endpoint"), ["Please focus on tests"]);
    });

    it("[CHAT-11] rejects steer to nonexistent thread with 404 and does not write orphan sidecar", async () => {
      process.env.THREADS_DIR = tmpDir;
      const req = new NextRequest("http://localhost/api/threads/nonexistent-thread-999999/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Orphan steer attempt" })
      });

      const res = await STEER_POST(req, { params: Promise.resolve({ id: "nonexistent-thread-999999" }) });
      assert.equal(res.status, 404);
      const json = await res.json();
      assert.ok(json.error);
      assert.deepEqual(store.getPendingSteers("nonexistent-thread-999999"), []);
    });

    it("rejects empty text with 400", async () => {
      const req = new NextRequest("http://localhost/api/threads/t-empty/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "   " })
      });

      const res = await STEER_POST(req, { params: Promise.resolve({ id: "t-empty" }) });
      assert.equal(res.status, 400);
    });
  });

  describe("Loop-level steer consumption & stream event integration", () => {
    let fakeServer: http.Server;
    let serverPort: number;
    let prevLlmUrl: string | undefined;
    let roundHandler: (parsed: any, res: http.ServerResponse) => void;

    before(async () => {
      fakeServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let parsed: any = {};
          try { parsed = JSON.parse(body); } catch {}
          roundHandler(parsed, res);
        });
      });
      await new Promise<void>((r) => fakeServer.listen(0, "127.0.0.1", () => r()));
      serverPort = (fakeServer.address() as any).port;
      prevLlmUrl = process.env.LLM_BASE_URL;
      process.env.LLM_BASE_URL = `http://127.0.0.1:${serverPort}`;
    });

    after(() => {
      fakeServer.close();
      process.env.LLM_BASE_URL = prevLlmUrl;
    });

    it("consumes steer mid-turn, injects into conversationMessages, and emits steer event", async () => {
      const threadId = `t-steer-loop-${Date.now()}`;
      process.env.THREADS_DIR = tmpDir;

      let roundCount = 0;
      let recordedRequests: any[] = [];
      roundHandler = (parsed, res) => {
        recordedRequests.push(parsed);
        roundCount++;
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (roundCount === 1) {
          store.appendSteer(threadId, "skip A - do B");
          res.write(JSON.stringify({
            message: {
              content: "Executing first step...",
              tool_calls: [{
                id: "tc-1",
                type: "function",
                function: { name: "workspace_read_file", arguments: '{"path":"dummy.txt"}' }
              }]
            }
          }) + "\n");
        } else {
          res.write(JSON.stringify({
            message: {
              content: "Done with B."
            }
          }) + "\n");
        }
        res.write(JSON.stringify({ message: {}, done: true }) + "\n");
        res.end();
      };

      const { POST: CHAT_POST } = await import("../app/api/chat/route");
      const chatReq = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          userMessageId: "u-steer",
          assistantMessageId: "a-steer",
          messages: [{ role: "user", content: "Start work", id: "u-steer" }],
          model: "swift-15-27b-mtp",
          enableTools: true
        })
      });

      const chatRes = await CHAT_POST(chatReq);
      const reader = chatRes.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const events: any[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const p of parts) {
          if (p.startsWith("data:")) {
            try {
              events.push(JSON.parse(p.slice(5)));
            } catch {}
          }
        }
      }

      // 1. Emitted steer event
      const steerEvent = events.find((e) => e.type === "steer");
      assert.ok(steerEvent, "Must emit steer event");
      assert.deepEqual(steerEvent.texts, ["skip A - do B"]);

      // 2. Steer appeared in persisted thread transcript
      const thread = await store.getThread(threadId);
      assert.ok(thread);
      const persistedSteer = thread.messages.find((m) => m.content.includes("[Steer from user, mid-turn] skip A - do B"));
      assert.ok(persistedSteer, "Steer must be persisted into thread transcript in position");
      assert.equal(persistedSteer.role, "user");

      // 3. Steer appeared in subsequent model request
      assert.ok(recordedRequests.length >= 2, "Must have made at least 2 LLM requests");
      const round2Messages = recordedRequests[1].messages || [];
      const steerInPrompt = round2Messages.find((m: any) => m.content && m.content.includes("[Steer from user, mid-turn] skip A - do B"));
      assert.ok(steerInPrompt, "Steer must appear in subsequent round messages");

      // 4. Mailbox is empty
      assert.equal(store.getPendingSteers(threadId).length, 0);
    });

    it("late-steer test: steers appended before synthesis round force synthesis, consume steer, and appear in model request", async () => {
      const threadId = `t-steer-late-${Date.now()}`;
      process.env.THREADS_DIR = tmpDir;

      let roundCount = 0;
      let recordedRequests: any[] = [];
      roundHandler = (parsed, res) => {
        recordedRequests.push(parsed);
        roundCount++;
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (roundCount === 1) {
          // Model answered the initial question with 0 tools
          store.appendSteer(threadId, "Create a svg of it");
          res.write(JSON.stringify({
            message: {
              content: "The weather in Spanish Fort is sunny."
            }
          }) + "\n");
        } else if (roundCount === 2) {
          // Second round should be synthesis incorporating the steer!
          res.write(JSON.stringify({
            message: {
              content: "Here is the SVG of the sunny weather: <svg></svg>"
            }
          }) + "\n");
        }
        res.write(JSON.stringify({ message: {}, done: true }) + "\n");
        res.end();
      };

      const { POST: CHAT_POST } = await import("../app/api/chat/route");
      const chatReq = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          userMessageId: "u-late",
          assistantMessageId: "a-late",
          messages: [{ role: "user", content: "What's the weather today?", id: "u-late" }],
          model: "swift-15-27b-mtp",
          enableTools: false
        })
      });

      const chatRes = await CHAT_POST(chatReq);
      const reader = chatRes.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const events: any[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const p of parts) {
          if (p.startsWith("data:")) {
            try {
              events.push(JSON.parse(p.slice(5)));
            } catch {}
          }
        }
      }

      // 1. Emitted steer event
      const steerEvent = events.find((e) => e.type === "steer");
      assert.ok(steerEvent, "Must emit steer event when steer is consumed");
      assert.deepEqual(steerEvent.texts, ["Create a svg of it"]);

      // 2. Steer appeared in subsequent model synthesis request
      assert.ok(recordedRequests.length >= 2, "Must have dispatched synthesis request to model");
      const synthMessages = recordedRequests[1].messages || [];
      const steerInPrompt = synthMessages.find((m: any) => m.content && m.content.includes("[Steer from user, mid-turn] Create a svg of it"));
      assert.ok(steerInPrompt, "Steer must appear in synthesis model request");

      // 3. Steer appeared in persisted transcript
      const thread = await store.getThread(threadId);
      assert.ok(thread);
      const persistedSteer = thread.messages.find((m) => m.content.includes("[Steer from user, mid-turn] Create a svg of it"));
      assert.ok(persistedSteer, "Steer must be persisted into thread transcript as consumed");

      // 4. Mailbox is empty
      assert.equal(store.getPendingSteers(threadId).length, 0);
    });

    it("unconsumed steer invariant: if steer arrives when no further model call is possible, it is NOT persisted in transcript and returned in pendingSteers", async () => {
      // Invariant: If a steer is in pendingSteers when done fires, it must NOT be in thread transcript as consumed.
      const threadId = `t-steer-unconsumed-${Date.now()}`;
      process.env.THREADS_DIR = tmpDir;

      // Manually simulate a steer sitting in unconsumedSteers at turn completion
      store.appendSteer(threadId, "late arrival");
      const unconsumed = store.consumeSteers(threadId);
      assert.deepEqual(unconsumed, ["late arrival"]);

      // Verify thread messages do NOT contain the unconsumed steer
      const thread = await store.getThread(threadId);
      const foundInTranscript = (thread?.messages || []).some((m) => m.content.includes("late arrival"));
      assert.equal(foundInTranscript, false, "Unconsumed steer must not be in transcript");
    });

    it("INTERRUPT-STEER: POST /api/threads/[id]/steer with interrupt=true aborts in-flight round stream without stopping turn and immediately applies steer", async () => {
      const threadId = `t-steer-interrupt-${Date.now()}`;
      process.env.THREADS_DIR = tmpDir;

      let roundCount = 0;
      let recordedRequests: any[] = [];
      let round1FirstTokenReceivedResolve!: () => void;
      const round1FirstTokenReceived = new Promise<void>((r) => {
        round1FirstTokenReceivedResolve = r;
      });

      roundHandler = (parsed, res) => {
        recordedRequests.push(parsed);
        roundCount++;
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (roundCount === 1) {
          // Write initial partial token and then hold the HTTP stream open (simulating a long 60s generation)
          res.write(
            JSON.stringify({
              message: {
                thinking: "Starting long analysis...",
                content: "Initial partial response before interrupt."
              }
            }) + "\n"
          );
          // Do NOT call res.end() here — wait for roundAbortController to abort the request!
          res.on("close", () => {
            try {
              res.end();
            } catch {}
          });
        } else {
          res.write(
            JSON.stringify({
              message: {
                content: "Redirected response incorporating immediate interrupt steer!"
              }
            }) + "\n"
          );
          res.write(JSON.stringify({ message: {}, done: true }) + "\n");
          res.end();
        }
      };

      const { POST: CHAT_POST } = await import("../app/api/chat/route");
      const chatReq = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          userMessageId: "u-int",
          assistantMessageId: "a-int",
          messages: [{ role: "user", content: "Write a very long essay", id: "u-int" }],
          model: "swift-15-27b-mtp",
          enableTools: false
        })
      });

      const chatRes = await CHAT_POST(chatReq);
      const reader = chatRes.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const events: any[] = [];

      // Start reading SSE stream concurrently
      const streamDonePromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value);
          const parts = buf.split("\n\n");
          buf = parts.pop() || "";
          for (const p of parts) {
            if (p.startsWith("data:")) {
              try {
                const evt = JSON.parse(p.slice(5));
                events.push(evt);
                if (evt.type === "token" && String(evt.content || "").includes("Initial partial response")) {
                  round1FirstTokenReceivedResolve();
                }
              } catch {}
            }
          }
        }
      })();

      // Wait until round 1 stream has emitted the first partial token and is stalled waiting for more
      await round1FirstTokenReceived;

      // Send interrupt steer via POST /api/threads/[id]/steer with interrupt: true
      const steerReq = new NextRequest(`http://localhost/api/threads/${threadId}/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Switch to concise bullet points now", interrupt: true })
      });
      const steerRes = await STEER_POST(steerReq, { params: Promise.resolve({ id: threadId }) });
      assert.equal(steerRes.status, 200);
      const steerJson = await steerRes.json();
      assert.equal(steerJson.success, true);
      assert.equal(steerJson.interrupted, true, "Must report interrupted=true when active round stream was aborted");

      await streamDonePromise;

      // 1. Must have emitted steer event and completed turn cleanly (not aborted/incomplete!)
      const steerEvent = events.find((e) => e.type === "steer");
      assert.ok(steerEvent, "Must emit steer event after interrupting round 1");
      assert.deepEqual(steerEvent.texts, ["Switch to concise bullet points now"]);

      const doneEvent = events.find((e) => e.type === "done");
      assert.ok(doneEvent, "Turn must complete with done event (not abort)");

      // 2. Round 2 request must contain both the partial round 1 assistant text and the steer
      assert.equal(recordedRequests.length, 2, "Must have made 2 LLM requests (interrupted round 1 + steered round 2)");
      const round2Messages = recordedRequests[1].messages || [];
      const partialAssistantInRound2 = round2Messages.find(
        (m: any) => m.role === "assistant" && m.content.includes("Initial partial response before interrupt.")
      );
      assert.ok(partialAssistantInRound2, "Partial content from interrupted round 1 must be preserved in round 2 context");
      const steerInRound2 = round2Messages.find(
        (m: any) => m.role === "user" && m.content.includes("[Steer from user, mid-turn] Switch to concise bullet points now")
      );
      assert.ok(steerInRound2, "Interrupt steer must be injected into round 2 messages");

      // 3. Thread must be persisted as completed (NOT incomplete/stopped) with final steered answer
      const thread = await store.getThread(threadId);
      assert.ok(thread);
      assert.equal(thread.status, "completed");
      const assistantMsg = thread.messages.find((m) => m.id === "a-int");
      assert.ok(assistantMsg);
      assert.equal(assistantMsg.status, "completed");
      assert.ok(assistantMsg.content.includes("Redirected response incorporating immediate interrupt steer!"));
    });
  });
});
