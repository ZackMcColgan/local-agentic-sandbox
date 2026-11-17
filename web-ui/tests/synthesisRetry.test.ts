import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

/**
 * SYNTHESIS-RETRY: an empty post-tool synthesis must never strand the turn.
 * Mechanism (forensics, thread-1794329641005-qw9f idx 12): the post-tool
 * synthesis pass (route.ts ~1554-1607) streamed finish_reason=stop with zero
 * visible content; synthContent stayed empty, cleanedContent stayed empty,
 * and route.ts:1627-1632 emitted the bare "concluded without synthesis text"
 * stamp with status=incomplete — silent stranding despite landed tool work.
 *
 * Expected recovery: the synthesis pass retries ONCE within the same turn;
 * the retried summary persists; status=completed; a retry status event is
 * emitted. If BOTH passes come back empty, the turn ends honestly: work
 * persisted, status incomplete, and the stamp says the summary failed and the
 * thread is resumable (not a bare silent ⚠️).
 */

function makeScriptedOllamaServer(script: Array<{ content: string; toolCalls?: any[]; evalCount?: number }>) {
  let completionCount = 0;
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url.includes("/api/ps")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (url.includes("/sse")) {
      // MCP endpoints unreachable: route falls back to graceful advertised-tool traces.
      res.writeHead(404);
      res.end("no mcp");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.includes("/api/chat")) {
        completionCount++;
        const step = script[Math.min(completionCount - 1, script.length - 1)];
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        const msg: any = { role: "assistant", content: step.content };
        if (step.toolCalls) msg.tool_calls = step.toolCalls;
        res.write(JSON.stringify({ message: msg }) + "\n");
        res.write(
          JSON.stringify({
            message: { role: "assistant", content: "" },
            done: true,
            ...(step.evalCount ? { eval_count: step.evalCount } : {})
          }) + "\n"
        );
        res.end();
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  });
  return { server, getCompletionCount: () => completionCount };
}

async function runTurn(script: Array<{ content: string; toolCalls?: any[]; evalCount?: number }>) {
  const tmpThreadsDir = path.resolve(process.cwd(), "tmp-test-synth-retry-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(tmpThreadsDir, { recursive: true });
  const prev = {
    THREADS_DIR: process.env.THREADS_DIR,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    LLAMACPP_BASE_URL: process.env.LLAMACPP_BASE_URL,
    MCP_SERVER_URL: process.env.MCP_SERVER_URL,
    BROWSER_MCP_URL: process.env.BROWSER_MCP_URL,
    LLM_ENGINE: process.env.LLM_ENGINE
  };
  process.env.THREADS_DIR = tmpThreadsDir;
  process.env.LLM_ENGINE = "ollama";

  const { server, getCompletionCount } = makeScriptedOllamaServer(script);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.LLAMACPP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MCP_SERVER_URL = `http://127.0.0.1:${port}/mcp`;
  process.env.BROWSER_MCP_URL = `http://127.0.0.1:${port}/browser`;

  try {
    const { NextRequest } = await import("next/server");
    const chatRouteModule = await import("../app/api/chat/route");
    const { ThreadStore } = await import("../lib/threads/threadStore");

    const store = new ThreadStore(tmpThreadsDir);
    const threadId = `thread-synth-retry-${Date.now()}`;
    store.createThread({ id: threadId, title: "Synthesis Retry Test", hostAccess: false });

    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        userMessageId: "u-1",
        assistantMessageId: "a-1",
        messages: [{ role: "user", content: "Inspect the repo patterns and report what you find.", id: "u-1" }],
        model: "swift-15-27b-mtp",
        enableTools: true
      })
    });
    const res = await chatRouteModule.POST(req as any);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }

    const thread = await store.getThread(threadId);
    const asst = thread?.messages.find((m: any) => m.id === "a-1");
    return { asst, raw, completionCount: getCompletionCount() };
  } finally {
    server.close();
    Object.entries(prev).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  }
}

test("Empty post-tool synthesis retries once and lands a real summary", async () => {
  const toolCall = {
    id: "call-1",
    type: "function",
    function: { name: "workspace_get_tree", arguments: "{}" }
  };
  const script = [
    // Round 1: narration + tool call (MCP unreachable -> graceful trace recorded).
    { content: "Reading patterns first. ", toolCalls: [toolCall], evalCount: 40 },
    // Round 2 after tool result: empty completion, stop -> loop breaks.
    { content: "" },
    // Synthesis pass 1: empty again, stop -> the OLD code strands here.
    { content: "" },
    // Synthesis retry pass 2: real summary.
    { content: "FINAL SUMMARY: the fix landed.", evalCount: 128 }
  ];

  const { asst, raw, completionCount } = await runTurn(script);

  assert.ok(asst, "assistant message must exist");
  assert.ok(
    completionCount >= 4,
    `synthesis must be retried once within the turn (expected >= 4 completions, got ${completionCount})`
  );
  assert.ok(
    asst!.content.includes("FINAL SUMMARY: the fix landed."),
    `final content must carry the retried summary, got: ${asst!.content}`
  );
  assert.ok(
    !asst!.content.includes("concluded without synthesis text"),
    `must not strand on the empty-synthesis stamp, got: ${asst!.content}`
  );
  assert.equal(asst!.status, "completed");
  assert.ok(raw.includes("retrying once"), "retry status event must be emitted");
});

test("Double-empty synthesis ends honestly: work persisted, resumable stamp, incomplete status", async () => {
  const toolCall = {
    id: "call-1",
    type: "function",
    function: { name: "workspace_get_tree", arguments: "{}" }
  };
  const script = [
    { content: "Reading patterns first. ", toolCalls: [toolCall], evalCount: 40 },
    { content: "" },
    { content: "" },
    { content: "" } // retry also empty
  ];

  const { asst, raw, completionCount } = await runTurn(script);

  assert.ok(asst, "assistant message must exist");
  assert.ok(
    completionCount >= 4,
    `retry must fire even when pass 1 is empty (expected >= 4 completions, got ${completionCount})`
  );
  assert.equal(asst!.status, "incomplete");
  assert.ok(asst!.content.includes("⚠️ [Turn incomplete:"), "honest incomplete stamp required");
  assert.ok(
    /Work persisted above; the summary failed\./.test(asst!.content),
    `stamp must state work persisted + summary failed, got: ${asst!.content}`
  );
  assert.ok(
    /resumable|resume this thread/i.test(asst!.content),
    `stamp must state the thread is resumable, got: ${asst!.content}`
  );
  assert.ok(raw.includes("retrying once"), "retry status event must be emitted");
});
