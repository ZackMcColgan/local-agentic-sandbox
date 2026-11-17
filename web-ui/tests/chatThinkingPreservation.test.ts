import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { ThreadStore, activeExecutionSet } from "../lib/threads/threadStore";
import { ThrottledStreamSnapshot, STREAM_SNAPSHOT_INTERVAL_MS } from "../lib/streamSnapshot";
import { POST as CHAT_POST } from "../app/api/chat/route";
import { NextRequest } from "next/server";

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat13-14-test-"));
  return { store: new ThreadStore(dir), dir };
}

describe("CHAT-13 & CHAT-14 — Thinking panel survival across steering and refresh", () => {
  // 1(a) Snapshot writer: given thought-only progress (no content yet), a snapshot write lands
  // and the stored streaming message carries thinking so far; later snapshots grow it cumulatively.
  it("1(a) Snapshot writer captures thought-only progress, updates cumulatively, and never shrinks", () => {
    const { store, dir } = makeStore();
    const thread = store.createThread({ id: "t-thought-snap", title: "thought snap test" });
    let fakeNow = 1000;
    const snap = new ThrottledStreamSnapshot(store, thread.id, "msg-asst-1", STREAM_SNAPSHOT_INTERVAL_MS, () => fakeNow);

    // Thought-only call: content is empty string, but thought is present
    const write1 = snap.maybeWrite("", "Analyzing user request...");
    assert.equal(write1, true, "Snapshot write must land when thought is provided even if content is empty");

    const saved1 = store.getFilePath(thread.id);
    const parsed1 = JSON.parse(fs.readFileSync(saved1, "utf8"));
    const msg1 = parsed1.messages.find((m: any) => m.id === "msg-asst-1");
    assert.ok(msg1, "Streaming message must be written to disk");
    assert.equal(msg1.status, "streaming");
    assert.equal(msg1.thought, "Analyzing user request...");
    assert.equal(msg1.content, "");

    // Later snapshot inside throttle window returns false
    fakeNow += 500;
    const write2 = snap.maybeWrite("", "Analyzing user request... still thinking");
    assert.equal(write2, false, "Throttled write must be skipped within 1s interval");

    // Past interval: grows cumulatively
    fakeNow += 600;
    const write3 = snap.maybeWrite("Here is the start of answer", "Analyzing user request... still thinking\nDone thinking.");
    assert.equal(write3, true, "Snapshot past interval must land");

    const parsed2 = JSON.parse(fs.readFileSync(saved1, "utf8"));
    const msg2 = parsed2.messages.find((m: any) => m.id === "msg-asst-1");
    assert.equal(msg2.thought, "Analyzing user request... still thinking\nDone thinking.");
    assert.equal(msg2.content, "Here is the start of answer");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 1(b) Rejoin / Refresh mid-thinking: start turn against fake model emitting thinking,
  // disconnect client while only thinking has streamed, GET thread and assert assistant message has thought.
  it("1(b) Refresh/Rejoin mid-thinking: streaming assistant message carries thought before any content arrives", async () => {
    const { store, dir } = makeStore();
    const originalThreadsDir = process.env.THREADS_DIR;
    process.env.THREADS_DIR = dir;

    let serverPort: number;
    let holdThinkingStream = true;
    let releaseThinking!: () => void;
    const thinkingReleased = new Promise<void>((r) => { releaseThinking = r; });

    const fakeServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { role: "assistant", thinking: "Step 1: Deep mathematical analysis..." } }) + "\n");
      // Hold stream in thinking phase
      const interval = setInterval(() => {
        if (!holdThinkingStream) {
          clearInterval(interval);
          res.write(JSON.stringify({ message: { role: "assistant", content: "Result is 42." }, done: true }) + "\n");
          res.end();
        } else {
          res.write(JSON.stringify({ message: { role: "assistant", thinking: " Still reasoning..." } }) + "\n");
        }
      }, 100);
    });

    await new Promise<void>((r) => fakeServer.listen(0, "127.0.0.1", () => r()));
    serverPort = (fakeServer.address() as any).port;
    const prevLlmUrl = process.env.LLM_BASE_URL;
    process.env.LLM_BASE_URL = `http://127.0.0.1:${serverPort}`;

    const threadId = `thread-rejoin-think-${Date.now()}`;
    store.createThread({ id: threadId, title: "Rejoin thinking test" });

    const clientAbort = new AbortController();
    const chatReq = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: clientAbort.signal,
      body: JSON.stringify({
        threadId,
        userMessageId: "u-think",
        assistantMessageId: "a-think",
        messages: [{ role: "user", content: "Compute answer", id: "u-think" }],
        model: "swift-15-27b-mtp",
        enableTools: false
      })
    });

    try {
      const chatRes = await CHAT_POST(chatReq);
      const reader = chatRes.body!.getReader();
      const decoder = new TextDecoder();
      let gotThoughtEvent = false;

      // Read until we see a thought event
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.includes('"type":"thought"')) {
          gotThoughtEvent = true;
          break;
        }
      }
      assert.ok(gotThoughtEvent, "Must receive thought event from stream");

      // Wait 1.1s for throttled stream snapshot to land on disk
      await new Promise((r) => setTimeout(r, 1200));

      // Simulate client refresh / disconnect
      clientAbort.abort();

      // Read thread from disk (as a watcher / refreshed page would)
      const readerStore = new ThreadStore(dir);
      const polledThread = await readerStore.getThread(threadId);
      assert.ok(polledThread, "Thread must exist on refresh");
      const asstMsg = polledThread.messages.find((m) => m.id === "a-think");
      assert.ok(asstMsg, "Assistant streaming message must exist");
      assert.equal(asstMsg.status, "streaming", "Message must be streaming");
      assert.ok(asstMsg.thought, "Streaming assistant message MUST carry thought field before content arrives");
      assert.ok(asstMsg.thought.includes("Deep mathematical analysis"), "Thought must contain the streamed thinking text");
    } finally {
      holdThinkingStream = false;
      releaseThinking();
      fakeServer.close();
      process.env.LLM_BASE_URL = prevLlmUrl;
      process.env.THREADS_DIR = originalThreadsDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 1(c) CHAT-13a: Simulated stream — round-1 thought events -> steer event -> round-2 thought events.
  // The SSE event contract for 'thought' must carry cumulative thinking so far.
  it("1(c) Chat route emits cumulative thought events across multi-round and interrupt-steer turns", async () => {
    const { store, dir } = makeStore();
    const originalThreadsDir = process.env.THREADS_DIR;
    process.env.THREADS_DIR = dir;

    let roundCount = 0;
    const fakeServer = http.createServer((req, res) => {
      roundCount++;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (roundCount === 1) {
        // Round 1 thinking
        res.write(JSON.stringify({ message: { role: "assistant", thinking: "Round 1 initial reasoning." } }) + "\n");
        // Steer arrives, trigger tool call or interrupt
        store.appendSteer(threadId, "Please redirect");
        res.write(JSON.stringify({
          message: {
            content: "Planning tool call...",
            tool_calls: [{ id: "c1", type: "function", function: { name: "workspace_read_file", arguments: '{"path":"f.txt"}' } }]
          },
          done: true
        }) + "\n");
        res.end();
      } else {
        // Round 2 thinking
        res.write(JSON.stringify({ message: { role: "assistant", thinking: "Round 2 adjusted reasoning." } }) + "\n");
        res.write(JSON.stringify({ message: { role: "assistant", content: "Final answer after steer." }, done: true }) + "\n");
        res.end();
      }
    });

    await new Promise<void>((r) => fakeServer.listen(0, "127.0.0.1", () => r()));
    const serverPort = (fakeServer.address() as any).port;
    const prevLlmUrl = process.env.LLM_BASE_URL;
    process.env.LLM_BASE_URL = `http://127.0.0.1:${serverPort}`;

    const threadId = `thread-cumulative-think-${Date.now()}`;
    store.createThread({ id: threadId, title: "Cumulative think test" });

    const chatReq = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        userMessageId: "u-cumul",
        assistantMessageId: "a-cumul",
        messages: [{ role: "user", content: "Start multi round work", id: "u-cumul" }],
        model: "swift-15-27b-mtp",
        enableTools: true
      })
    });

    try {
      const chatRes = await CHAT_POST(chatReq);
      const reader = chatRes.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const thoughtEvents: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const p of parts) {
          if (p.startsWith("data:")) {
            try {
              const evt = JSON.parse(p.slice(5));
              if (evt.type === "thought") {
                thoughtEvents.push(evt.thought);
              }
            } catch {}
          }
        }
      }

      assert.ok(thoughtEvents.length >= 2, "Must receive thought events from both rounds");
      const lastThought = thoughtEvents[thoughtEvents.length - 1];
      assert.ok(
        lastThought.includes("Round 1 initial reasoning"),
        `Round 2 thought event must contain Round 1 reasoning (cumulative), but got: ${JSON.stringify(lastThought)}`
      );
      assert.ok(
        lastThought.includes("Round 2 adjusted reasoning"),
        `Round 2 thought event must contain Round 2 reasoning, but got: ${JSON.stringify(lastThought)}`
      );
    } finally {
      fakeServer.close();
      process.env.LLM_BASE_URL = prevLlmUrl;
      process.env.THREADS_DIR = originalThreadsDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 1(d) CHAT-13b & Watcher render verification: check ChatStream.tsx static logic
  // The reasoning panel must not be restricted to (isLoading && idx === deduplicatedMessages.length - 1)
  // because that disappears when steer bubble is appended or when watcher rehydrates on refresh.
  it("1(d) ChatStream reasoning panel renders for streaming assistant message regardless of last position or watcher state", () => {
    const chatStreamSrc = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
    // Ensure the old fragile condition is NOT present
    const oldFragilePattern = /idx === deduplicatedMessages\.length - 1/g;
    const matches = chatStreamSrc.match(oldFragilePattern);
    assert.equal(
      matches,
      null,
      "ChatStream.tsx must not key thinking panel visibility to (idx === deduplicatedMessages.length - 1)"
    );
  });
});
