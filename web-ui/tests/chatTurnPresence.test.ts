import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

/**
 * CHAT-PRESENCE lifecycle tests (INV-B B2, behavioral only).
 * Env is set BEFORE routes are imported (provider caches engine config at module
 * load), so routes are dynamically imported after env — one shared fake engine with
 * a switchable scenario, so every test hits the same cached provider config.
 */
type Scenario =
  | { kind: "thinking-then-content"; thinkChunkMs: number; content: string }
  | { kind: "thinking-only-then-empty-done"; thinkChunkMs: number }
  | { kind: "engine-error"; delayMs: number };

let scenario: Scenario = { kind: "thinking-then-content", thinkChunkMs: 350, content: "All done." };

const tmpBase = path.join(os.tmpdir(), `presence-${Date.now()}`);
fs.mkdirSync(tmpBase, { recursive: true });
process.env.THREADS_DIR = tmpBase;

async function main() {
const engine = await new Promise<{ url: string; close: () => void }>((resolve) => {
  const server = http.createServer(async (req, res) => {
    let acc = "";
    req.on("data", (c) => (acc += c));
    await new Promise((r) => req.on("end", r));
    let parsedBody: any = {};
    try { parsedBody = JSON.parse(acc); } catch {}
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Protocol-aware fake engine: Ollama-native /api/chat NDJSON for the Ollama
    // path; OpenAI-compatible SSE for the llama.cpp/Strata /v1 path. Same scripted
    // scenario for both so tests drive every client in the route.
    const isOpenAI = typeof req.url === "string" && req.url.startsWith("/v1");
    const writeContent = (text: string) => {
      if (isOpenAI) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      else res.write(`${JSON.stringify({ message: { content: text } })}\n`);
    };
    const writeThinking = (text: string) => {
      if (isOpenAI) res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] })}\n\n`);
      else res.write(`${JSON.stringify({ message: { thinking: text } })}\n`);
    };
    const writeDone = () => {
      if (isOpenAI) res.write("data: [DONE]\n\n");
      else res.write(`${JSON.stringify({ message: {}, done: true })}\n`);
    };

    const isTriage = typeof parsedBody.messages?.[0]?.content === "string"
      && parsedBody.messages[0].content.includes("complexity");
    if (isTriage) {
      res.writeHead(200, { "Content-Type": isOpenAI ? "text/event-stream" : "application/x-ndjson" });
      writeContent('{"complexity":"SIMPLE_EXECUTION","reasoning":"simple probe"}');
      writeDone();
      res.end();
      return;
    }

    if (scenario.kind === "engine-error") {
      await sleep(scenario.delayMs);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("fake engine exploded");
      return;
    }

    res.writeHead(200, { "Content-Type": isOpenAI ? "text/event-stream" : "application/x-ndjson" });
    // Reasoning-only phase: thinking channel, no content yet (the pre-token blind window).
    for (const t of ["planning ", "step one ", "step two ", "almost there"]) {
      writeThinking(t);
      await sleep(scenario.thinkChunkMs);
    }
    if (scenario.kind === "thinking-then-content") {
      writeContent(scenario.content);
    }
    writeDone();
    res.end();
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as any).port;
    resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
  });
});
process.env.LLM_BASE_URL = engine.url;
process.env.LLAMACPP_BASE_URL = engine.url;

const { POST: CHAT_POST } = await import("../app/api/chat/route");
const { GET: THREAD_GET } = await import("../app/api/threads/[id]/route");
const { activeExecutionSet, markTurnActive, getActiveTurn, clearTurnActive } = await import("../lib/threads/threadStore");

async function drain(res: Response) {
  if (!res.body) return;
  const reader = res.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

async function getThreadResponse(threadId: string): Promise<any> {
  const res = await THREAD_GET(new Request(`http://localhost/api/threads/${threadId}`), {
    params: Promise.resolve({ id: threadId })
  } as any);
  return res.json();
}

function chatRequest(threadId: string, assistantId: string, content: string): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId,
      userMessageId: `${threadId}-user`,
      assistantMessageId: assistantId,
      messages: [{ role: "user", content, id: `${threadId}-user` }],
      model: "auto",
      mode: "chat",
      enableTools: false
    })
  });
}

function uniqueThread(prefix: string): { threadId: string; assistantId: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return { threadId: `${prefix}-${stamp}`, assistantId: `assistant-${stamp}` };
}

describe("CHAT-PRESENCE — turn-presence marker lifecycle (behavioral)", () => {
  afterEach(() => {
    scenario = { kind: "thinking-then-content", thinkChunkMs: 350, content: "All done." };
  });

  it("module contract: marker visible pre-token, cleared on clear", () => {
    markTurnActive("t-presence-1");
    const info = getActiveTurn("t-presence-1");
    assert.ok(info, "presence must be visible immediately after mark");
    assert.equal(info.status, "streaming");
    assert.ok(!Number.isNaN(Date.parse(info.startedAt)), "startedAt must be a real timestamp");
    clearTurnActive("t-presence-1");
    assert.equal(getActiveTurn("t-presence-1"), null, "clear must remove presence");
  });

  it("presence is visible to a watcher BEFORE the first content token exists", async () => {
    scenario = { kind: "thinking-then-content", thinkChunkMs: 350, content: "All done." };
    const { threadId, assistantId } = uniqueThread("presence-live");
    const res = await CHAT_POST(chatRequest(threadId, assistantId, "Probe presence window") as any);
    // The route generator only runs while the body is consumed — pump it concurrently.
    const consume = (async () => { await drain(res); })();

    let sawPresenceBeforeContent = false;
    let sawContent = false;
    // The route's MCP tool-listing preamble retries ~5s before the engine is hit.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const data = await getThreadResponse(threadId);
      const assistantMsg = (data.thread?.messages || []).find((m: any) => m.role === "assistant");
      const hasContent = assistantMsg && (assistantMsg.content || "").trim().length > 0;
      if (data.activeTurn && !hasContent) sawPresenceBeforeContent = true;
      if (hasContent) { sawContent = true; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    await consume;
    assert.ok(sawPresenceBeforeContent, "watcher must see activeTurn marker while no assistant content exists yet");
    assert.ok(sawContent, "content must eventually appear in the thread record");

    const after = await getThreadResponse(threadId);
    assert.equal(after.activeTurn, null, "presence must be cleared when the turn ends (done)");
    const asst = (after.thread.messages || []).find((m: any) => m.role === "assistant");
    assert.equal(asst.id, assistantId, "terminal persistence must upsert the same message id");
    assert.ok(asst.content.includes("All done."), "final content must persist");
  });

  it("presence survives a thinking-only turn that never emits content and clears at end", async () => {
    scenario = { kind: "thinking-only-then-empty-done", thinkChunkMs: 350 };
    const { threadId, assistantId } = uniqueThread("presence-empty");
    const res = await CHAT_POST(chatRequest(threadId, assistantId, "Probe empty synthesis") as any);
    const during = await getThreadResponse(threadId);
    assert.ok(during.activeTurn, "presence must be visible even when the model never emits content");
    assert.equal(during.activeTurn.status, "streaming");
    await drain(res);
    const after = await getThreadResponse(threadId);
    assert.equal(after.activeTurn, null, "presence must clear on an empty-synthesis ending too");
  });

  it("presence clears on engine error", async () => {
    scenario = { kind: "engine-error", delayMs: 1200 };
    const { threadId, assistantId } = uniqueThread("presence-err");
    const res = await CHAT_POST(chatRequest(threadId, assistantId, "Probe error path") as any);
    const during = await getThreadResponse(threadId);
    assert.ok(during.activeTurn, "presence must be visible during the engine-error window");
    await drain(res);
    const after = await getThreadResponse(threadId);
    assert.equal(after.activeTurn, null, "presence must clear on error ending");
  });

  it("presence clears when the client disconnects mid-turn", async () => {
    scenario = { kind: "thinking-then-content", thinkChunkMs: 600, content: "late" };
    const { threadId, assistantId } = uniqueThread("presence-abort");
    const res = await CHAT_POST(chatRequest(threadId, assistantId, "Probe abort path") as any);
    const during = await getThreadResponse(threadId);
    assert.ok(during.activeTurn, "presence visible during the turn");
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    const deadline = Date.now() + 8000;
    let cleared = false;
    while (Date.now() < deadline) {
      const data = await getThreadResponse(threadId);
      if (!data.activeTurn && !activeExecutionSet.has(threadId)) { cleared = true; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(cleared, "presence and execution registration must clear on disconnect");
  });

  it("watcher merge still reconciles: presence + streaming snapshot coexist, then converge", async () => {
    scenario = { kind: "thinking-then-content", thinkChunkMs: 400, content: "streamed answer" };
    const { threadId, assistantId } = uniqueThread("presence-merge");
    const res = await CHAT_POST(chatRequest(threadId, assistantId, "Probe merge coexist") as any);
    const consume = (async () => { await drain(res); })();
    let sawStreamingSnapshot: any = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const data = await getThreadResponse(threadId);
      const asst = (data.thread?.messages || []).find((m: any) => m.role === "assistant");
      if (data.activeTurn && asst && asst.status === "streaming") {
        assert.equal(asst.id, assistantId, "snapshot must carry the turn's assistant message id");
        assert.ok(data.activeTurn.startedAt, "presence must coexist with a streaming snapshot");
        sawStreamingSnapshot = asst;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(sawStreamingSnapshot, "watcher must see a streaming snapshot while presence is active");
    await drain(res);
    const after = await getThreadResponse(threadId);
    assert.equal(after.activeTurn, null, "presence clears at done");
    const finals = (after.thread.messages || []).filter((m: any) => m.role === "assistant");
    assert.equal(finals.length, 1, "snapshot + terminal must converge into one message (merge-by-id holds)");
  });

  it("GET answers the presence marker even before the thread file exists", async () => {
    const { threadId } = uniqueThread("presence-nofile");
    markTurnActive(threadId); // simulates turn-start before persistence lands
    const data = await getThreadResponse(threadId);
    assert.ok(data.activeTurn, "fresh watcher must see presence for a thread with no file yet");
    assert.equal(data.thread, null);
    clearTurnActive(threadId);
  });
});

engine.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
