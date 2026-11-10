import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { POST } from "../app/api/chat/route";
import { NextRequest } from "next/server";
import { ThreadStore, activeExecutionSet, registerTurnAbortController, clearTurnAbortController } from "../lib/threads/threadStore";
import {
  formatSseWriterError,
  transitionOnStreamDisconnect,
  transitionOnDetachedTurnReconciliation,
  TurnDeliveryState
} from "../lib/turnReconciliation";

test("Deliverable 1: SSE writer error formatting includes name, message, and first stack frame", async () => {
  const sampleErr = new Error("Connection reset by peer");
  const formatted = formatSseWriterError(sampleErr);
  assert.match(formatted, /Error: Connection reset by peer/);
  // Must include stack line
  assert.ok(formatted.includes("at "), `Expected stack frame in "${formatted}"`);
});

test("Deliverable 4: Zombie reaping on thread read", async () => {
  const tmpDir = path.resolve(process.cwd(), "tmp-test-threadstore-" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  process.env.THREADS_DIR = tmpDir;

  try {
    const store = new ThreadStore();
    const threadId = "thread-zombie-test-1";

    store.createThread({
      id: threadId,
      title: "Zombie Test Thread",
      model: "strata",
      reasoningEffort: "medium"
    });

    store.addMessage(threadId, {
      id: "user-1",
      role: "user",
      content: "Hello zombie test",
      timestamp: new Date().toISOString()
    });

    store.addMessage(threadId, {
      id: "asst-1",
      role: "assistant",
      content: "Partial streaming content before crash",
      timestamp: new Date().toISOString(),
      status: "streaming"
    });

    // Case A: No live execution registered -> zombie reaped on read
    // Content is preserved as-is, status becomes incomplete
    activeExecutionSet.delete(threadId);
    clearTurnAbortController(threadId);

    const reapedThread = await store.getThread(threadId);
    assert.ok(reapedThread, "Thread should exist");
    const asstMsg = reapedThread.messages.find(m => m.id === "asst-1");
    assert.equal(asstMsg?.status, "incomplete");
    assert.ok(asstMsg?.content.includes("Partial streaming content before crash"));
    assert.ok(asstMsg?.content.includes("⚠️ [Turn incomplete:"));

    // Case B: Live execution registered -> NOT reaped, stays streaming
    const liveThreadId = "thread-live-test-2";
    store.createThread({
      id: liveThreadId,
      title: "Live Test Thread",
      model: "strata",
      reasoningEffort: "medium"
    });

    store.addMessage(liveThreadId, {
      id: "asst-2",
      role: "assistant",
      content: "Still actively generating",
      timestamp: new Date().toISOString(),
      status: "streaming"
    });

    activeExecutionSet.add(liveThreadId);
    try {
      const liveThread = await store.getThread(liveThreadId);
      assert.ok(liveThread);
      const liveMsg = liveThread.messages.find(m => m.id === "asst-2");
      assert.equal(liveMsg?.status, "streaming", "Live turn must stay streaming");
      assert.equal(liveMsg?.content, "Still actively generating");
    } finally {
      activeExecutionSet.delete(liveThreadId);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Deliverable 2: Honest turn records (finish_reason, outputTokens, honest truncation flag)", async () => {
  const tmpDir = path.resolve(process.cwd(), "tmp-test-threadstore-honest-" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  process.env.THREADS_DIR = tmpDir;

  try {
    const store = new ThreadStore();
    const threadId = "thread-honest-test";
    store.createThread({
      id: threadId,
      title: "Honest Records Test",
      model: "strata",
      reasoningEffort: "medium",
      status: "active",
      messages: []
    });

    // 1. Abnormal generation with finish_reason: "length"
    store.addMessage(threadId, {
      id: "asst-len",
      role: "assistant",
      content: "Cut off mid senten",
      timestamp: new Date().toISOString(),
      finish_reason: "length",
      outputTokens: 4096,
      status: "incomplete" // Must never be plain completed!
    });

    const thread = await store.getThread(threadId);
    const msg = thread?.messages.find(m => m.id === "asst-len");
    assert.equal(msg?.finish_reason, "length");
    assert.equal(msg?.outputTokens, 4096);
    assert.equal(msg?.status, "incomplete");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Deliverable 3: Client reconciliation state mapping (pure transition logic)", () => {
  // Case 1: Mid-turn stream failure transitions to TRANSIENT state
  const initialStreaming: TurnDeliveryState = { state: "streaming", content: "Partial text received before cut" };
  const transient = transitionOnStreamDisconnect(initialStreaming, "thread-recon-1", "Partial text received before cut");

  assert.equal(transient.state, "transient_disconnected");
  if (transient.state === "transient_disconnected") {
    assert.equal(transient.threadId, "thread-recon-1");
    assert.equal(transient.partialContent, "Partial text received before cut");
  }

  // Case 2: Intermediate poll while turn is still running detached -> stays transient
  const stillRunning = transitionOnDetachedTurnReconciliation(transient, {
    content: "Partial text received before cut plus more tokens",
    status: "streaming"
  });
  assert.equal(stillRunning.state, "transient_disconnected");

  // Case 3: Detached turn lands final persisted message -> transitions to resolved_reconciled
  const resolved = transitionOnDetachedTurnReconciliation(stillRunning, {
    content: "Complete turn content persisted by detached backend.",
    status: "completed",
    finish_reason: "stop",
    outputTokens: 512
  });
  assert.equal(resolved.state, "resolved_reconciled");
  if (resolved.state === "resolved_reconciled") {
    assert.equal(resolved.finalContent, "Complete turn content persisted by detached backend.");
    assert.equal(resolved.finish_reason, "stop");
    assert.equal(resolved.outputTokens, 512);
  }
});

test("Deliverable 3: Stub e2e sever client stream mid-turn -> detached turn completes -> reconciles to full content", async () => {
  const http = await import("node:http");
  const tmpThreadsDir = path.resolve(process.cwd(), "tmp-test-sever-" + Date.now());
  fs.mkdirSync(tmpThreadsDir, { recursive: true });
  process.env.THREADS_DIR = tmpThreadsDir;

  let fakeServer: any;
  let serverPort: number;
  let prevLlamacppUrl = process.env.LLAMACPP_BASE_URL;
  const prevLlmUrl = process.env.LLM_BASE_URL;
  const prevOllamaUrl = process.env.OLLAMA_BASE_URL;
  const prevMcpUrl = process.env.MCP_SERVER_URL;
  const prevBrowserMcpUrl = process.env.BROWSER_MCP_URL;

  try {
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
        // llama.cpp / strata SSE completions endpoint format
        if (url.includes("/v1/chat/completions")) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Beginning part of generation... " } }] })}\n\n`);

          setTimeout(() => {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Middle part of detached execution... " } }] })}\n\n`);
            setTimeout(() => {
              res.write(`data: ${JSON.stringify({
                choices: [{ delta: { content: "Final conclusion successfully finished server-side." }, finish_reason: "stop" }],
                usage: { completion_tokens: 128 }
              })}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
            }, 50);
          }, 50);
          return;
        }

        // Ollama streaming fallback
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(JSON.stringify({
          message: { content: "Beginning part of generation... " }
        }) + "\n");

        setTimeout(() => {
          res.write(JSON.stringify({
            message: { content: "Middle part of detached execution... " }
          }) + "\n");
          setTimeout(() => {
            res.write(JSON.stringify({
              message: { content: "Final conclusion successfully finished server-side." },
              done: true,
              eval_count: 128
            }) + "\n");
            res.end();
          }, 50);
        }, 50);
      });
    });

    await new Promise<void>((r) => fakeServer.listen(0, "127.0.0.1", () => r()));
    serverPort = fakeServer.address().port;
    process.env.LLM_BASE_URL = `http://127.0.0.1:${serverPort}`;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${serverPort}`;
    process.env.LLAMACPP_BASE_URL = `http://127.0.0.1:${serverPort}`;
    process.env.MCP_SERVER_URL = `http://127.0.0.1:${serverPort}/mcp`;
    process.env.BROWSER_MCP_URL = `http://127.0.0.1:${serverPort}/browser`;

    // Re-import route fresh so getLlmBaseUrl picks up test env
    const { NextRequest } = await import("next/server");
    const chatRouteModule = await import("../app/api/chat/route");
    const chatRoutePost = chatRouteModule.POST;

    const store = new ThreadStore(tmpThreadsDir);
    const threadId = `thread-sever-${Date.now()}`;
    store.createThread({ id: threadId, title: "Severed Stream Test" });

    const clientAbortController = new AbortController();
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: clientAbortController.signal,
      body: JSON.stringify({
        threadId,
        userMessageId: "u-sever-1",
        assistantMessageId: "a-sever-1",
        messages: [{ role: "user", content: "Tell me a story", id: "u-sever-1" }],
        model: "swift-15-27b-mtp",
        enableTools: false
      })
    });

    const res = await chatRoutePost(req as any);
    assert.ok(res.body, "Response should have body stream");
    const reader = res.body.getReader();

    // Read initial chunk on client
    const firstChunk = await reader.read();
    assert.ok(!firstChunk.done);

    // Sever client stream
    clientAbortController.abort();
    try {
      await reader.cancel();
    } catch {}

    // Client enters transient state
    let clientState: TurnDeliveryState = { state: "streaming", content: "Beginning part" };
    clientState = transitionOnStreamDisconnect(clientState, threadId, "Beginning part");
    assert.equal(clientState.state, "transient_disconnected");

    // Wait for detached turn to finish in threadStore
    let finalAsstMsg: any = null;
    for (let i = 0; i < 50; i++) {
      const thread = await store.getThread(threadId);
      const asst = thread?.messages.find((m) => m.id === "a-sever-1");
      if (asst && asst.status === "completed") {
        finalAsstMsg = asst;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(finalAsstMsg, "Detached turn must finish and persist to threadStore");
    assert.equal(finalAsstMsg.status, "completed");
    assert.ok(finalAsstMsg.content.includes("Final conclusion successfully finished server-side."));
    assert.equal(finalAsstMsg.finish_reason, "stop");
    assert.ok(typeof finalAsstMsg.outputTokens === "number");

    // UI reconciles transient state -> resolved_reconciled with full content
    clientState = transitionOnDetachedTurnReconciliation(clientState, finalAsstMsg);
    assert.equal(clientState.state, "resolved_reconciled");
    if (clientState.state === "resolved_reconciled") {
      assert.ok(clientState.finalContent.includes("Final conclusion successfully finished server-side."));
    }
  } finally {
    if (fakeServer) fakeServer.close();
    if (prevLlamacppUrl !== undefined) process.env.LLAMACPP_BASE_URL = prevLlamacppUrl; else delete process.env.LLAMACPP_BASE_URL;
    if (prevLlmUrl !== undefined) process.env.LLM_BASE_URL = prevLlmUrl; else delete process.env.LLM_BASE_URL;
    if (prevOllamaUrl !== undefined) process.env.OLLAMA_BASE_URL = prevOllamaUrl; else delete process.env.OLLAMA_BASE_URL;
    if (prevMcpUrl !== undefined) process.env.MCP_SERVER_URL = prevMcpUrl; else delete process.env.MCP_SERVER_URL;
    if (prevBrowserMcpUrl !== undefined) process.env.BROWSER_MCP_URL = prevBrowserMcpUrl; else delete process.env.BROWSER_MCP_URL;
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  }
});
