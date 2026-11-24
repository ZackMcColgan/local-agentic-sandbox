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

interface ScriptToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

function makeScriptedOllamaServer(
  script: Array<{ content: string; toolCalls?: ScriptToolCall[]; evalCount?: number }>
) {
  let completionCount = 0;
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url.includes("/api/ps")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (url.includes("/sse") || url.includes("/mcp") || url.includes("/browser")) {
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
        const msg: { role: string; content: string; tool_calls?: ScriptToolCall[] } = {
          role: "assistant",
          content: step.content,
        };
        if (step.toolCalls) msg.tool_calls = step.toolCalls;
        res.write(JSON.stringify({ message: msg }) + "\n");
        res.write(
          JSON.stringify({
            message: { role: "assistant", content: "" },
            done: true,
            ...(step.evalCount ? { eval_count: step.evalCount } : {}),
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

async function runTurn(
  script: Array<{ content: string; toolCalls?: ScriptToolCall[]; evalCount?: number }>
) {
  const tmpThreadsDir = path.resolve(
    process.cwd(),
    "tmp-test-synth-retry-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6)
  );
  fs.mkdirSync(tmpThreadsDir, { recursive: true });
  const prev = {
    THREADS_DIR: process.env.THREADS_DIR,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    LLAMACPP_BASE_URL: process.env.LLAMACPP_BASE_URL,
    MCP_SERVER_URL: process.env.MCP_SERVER_URL,
    BROWSER_MCP_URL: process.env.BROWSER_MCP_URL,
    LLM_ENGINE: process.env.LLM_ENGINE,
  };
  process.env.THREADS_DIR = tmpThreadsDir;
  process.env.LLM_ENGINE = "ollama";

  const { server, getCompletionCount } = makeScriptedOllamaServer(script);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
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
        messages: [
          {
            role: "user",
            content: "Inspect the repo patterns and report what you find.",
            id: "u-1",
          },
        ],
        model: "swift-15-27b-mtp",
        enableTools: true,
      }),
    });
    const res = await chatRouteModule.POST(req);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }

    const thread = await store.getThread(threadId);
    const asst = thread?.messages.find((m) => m.id === "a-1");
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
    function: { name: "workspace_get_tree", arguments: "{}" },
  };
  const script = [
    // Round 1: narration + tool call (MCP unreachable -> graceful trace recorded).
    { content: "Reading patterns first. ", toolCalls: [toolCall], evalCount: 40 },
    // Round 2 after tool result: empty completion, stop -> loop breaks.
    { content: "" },
    // Synthesis pass 1: empty again, stop -> the OLD code strands here.
    { content: "" },
    // Synthesis retry pass 2: real summary.
    { content: "FINAL SUMMARY: the fix landed.", evalCount: 128 },
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
    function: { name: "workspace_get_tree", arguments: "{}" },
  };
  const script = [
    { content: "Reading patterns first. ", toolCalls: [toolCall], evalCount: 40 },
    { content: "" },
    { content: "" },
    { content: "" }, // retry also empty
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

test("Synthesis deadline: stalled synthesis stream aborts at inactivity deadline and lands partial content", async () => {
  const toolCall = {
    id: "call-1",
    type: "function",
    function: { name: "workspace_get_tree", arguments: "{}" },
  };
  const prevInactivity = process.env.CHAT_ROUND_INACTIVITY_MS;
  const prevTotal = process.env.CHAT_ROUND_TOTAL_MS;
  process.env.CHAT_ROUND_INACTIVITY_MS = "300";
  process.env.CHAT_ROUND_TOTAL_MS = "5000";

  let completionCount = 0;
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url.includes("/api/ps")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (url.includes("/sse") || url.includes("/mcp") || url.includes("/browser")) {
      res.writeHead(404);
      res.end("no mcp");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.includes("/api/chat")) {
        completionCount++;
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (completionCount === 1) {
          res.write(
            JSON.stringify({
              message: { role: "assistant", content: "Checking. ", tool_calls: [toolCall] },
            }) + "\n"
          );
          res.write(
            JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n"
          );
          res.end();
        } else if (completionCount === 2) {
          res.write(
            JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n"
          );
          res.end();
        } else {
          // Synthesis pass: emit partial content then stall forever until aborted.
          res.write(
            JSON.stringify({ message: { role: "assistant", content: "Partial synth " } }) + "\n"
          );
          req.on("close", () => {
            if (!res.writableEnded) res.end();
          });
        }
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  });

  const tmpThreadsDir = path.resolve(process.cwd(), "tmp-test-synth-deadline-" + Date.now());
  fs.mkdirSync(tmpThreadsDir, { recursive: true });
  const prevEnv = {
    THREADS_DIR: process.env.THREADS_DIR,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    LLAMACPP_BASE_URL: process.env.LLAMACPP_BASE_URL,
    MCP_SERVER_URL: process.env.MCP_SERVER_URL,
    BROWSER_MCP_URL: process.env.BROWSER_MCP_URL,
    LLM_ENGINE: process.env.LLM_ENGINE,
  };

  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.LLM_ENGINE = "ollama";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.LLAMACPP_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.MCP_SERVER_URL = `http://127.0.0.1:${port}/mcp`;
    process.env.BROWSER_MCP_URL = `http://127.0.0.1:${port}/browser`;

    const { NextRequest } = await import("next/server");
    const chatRouteModule = await import("../app/api/chat/route");
    const { ThreadStore } = await import("../lib/threads/threadStore");

    const store = new ThreadStore(tmpThreadsDir);
    const threadId = `thread-synth-deadline-${Date.now()}`;
    store.createThread({ id: threadId, title: "Synthesis Deadline Test", hostAccess: false });

    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        userMessageId: "u-1",
        assistantMessageId: "a-1",
        messages: [{ role: "user", content: "Inspect.", id: "u-1" }],
        model: "swift-15-27b-mtp",
        enableTools: true,
      }),
    });

    const res = await Promise.race([
      chatRouteModule.POST(req),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("POST hung")), 4000)),
    ]);
    const reader = res.body!.getReader();
    while (true) {
      const { done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("Stream hung past synthesis deadline")), 4000)
        ),
      ]);
      if (done) break;
    }

    const thread = await store.getThread(threadId);
    const asst = thread?.messages.find((m) => m.id === "a-1");
    assert.ok(asst, "assistant message must exist");
    assert.ok(
      asst!.content.includes("Partial synth"),
      `partial content must be preserved, got: ${asst!.content}`
    );
  } finally {
    server.close();
    if (prevInactivity === undefined) delete process.env.CHAT_ROUND_INACTIVITY_MS;
    else process.env.CHAT_ROUND_INACTIVITY_MS = prevInactivity;
    if (prevTotal === undefined) delete process.env.CHAT_ROUND_TOTAL_MS;
    else process.env.CHAT_ROUND_TOTAL_MS = prevTotal;
    Object.entries(prevEnv).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  }
});

test("Synthesis cap: runaway synthesis stream stops at MAX_STREAMED_CONTENT_CHARS", async () => {
  const { MAX_STREAMED_CONTENT_CHARS, TURN_SIZE_LIMIT_MARKER } =
    await import("../lib/contextBudget");
  const toolCall = {
    id: "call-1",
    type: "function",
    function: { name: "workspace_get_tree", arguments: "{}" },
  };
  const hugeChunk = "x".repeat(Math.ceil(MAX_STREAMED_CONTENT_CHARS / 2) + 5000);
  const script = [
    { content: "Checking. ", toolCalls: [toolCall], evalCount: 10 },
    { content: "" },
    // Synthesis emits 3 huge chunks (> MAX_STREAMED_CONTENT_CHARS).
    { content: hugeChunk + hugeChunk + hugeChunk, evalCount: 100 },
  ];

  const { raw } = await runTurn(script);
  assert.ok(
    raw.includes(TURN_SIZE_LIMIT_MARKER.trim().slice(0, 30)),
    "runaway synthesis must hit MAX_STREAMED_CONTENT_CHARS and emit size limit marker"
  );
});

test("Synthesis token recording: prompt_eval_count in synthesis pass is recorded in turn promptTokens", async () => {
  const toolCall = {
    id: "call-1",
    type: "function",
    function: { name: "workspace_get_tree", arguments: "{}" },
  };
  let completionCount = 0;
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url.includes("/api/ps")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (url.includes("/sse") || url.includes("/mcp") || url.includes("/browser")) {
      res.writeHead(404);
      res.end("no mcp");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.includes("/api/chat")) {
        completionCount++;
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (completionCount === 1) {
          res.write(
            JSON.stringify({
              message: { role: "assistant", content: "Checking. ", tool_calls: [toolCall] },
            }) + "\n"
          );
          res.write(
            JSON.stringify({
              message: { role: "assistant", content: "" },
              done: true,
              prompt_eval_count: 100,
              eval_count: 10,
            }) + "\n"
          );
        } else if (completionCount === 2) {
          res.write(
            JSON.stringify({
              message: { role: "assistant", content: "" },
              done: true,
              prompt_eval_count: 200,
              eval_count: 5,
            }) + "\n"
          );
        } else {
          res.write(
            JSON.stringify({ message: { role: "assistant", content: "Final synthesis." } }) + "\n"
          );
          res.write(
            JSON.stringify({
              message: { role: "assistant", content: "" },
              done: true,
              prompt_eval_count: 333,
              eval_count: 20,
            }) + "\n"
          );
        }
        res.end();
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  });

  const tmpThreadsDir = path.resolve(process.cwd(), "tmp-test-synth-tokens-" + Date.now());
  fs.mkdirSync(tmpThreadsDir, { recursive: true });
  const prevEnv = {
    THREADS_DIR: process.env.THREADS_DIR,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    LLAMACPP_BASE_URL: process.env.LLAMACPP_BASE_URL,
    MCP_SERVER_URL: process.env.MCP_SERVER_URL,
    BROWSER_MCP_URL: process.env.BROWSER_MCP_URL,
    LLM_ENGINE: process.env.LLM_ENGINE,
  };
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.LLM_ENGINE = "ollama";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.LLAMACPP_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.MCP_SERVER_URL = `http://127.0.0.1:${port}/mcp`;
    process.env.BROWSER_MCP_URL = `http://127.0.0.1:${port}/browser`;

    const { NextRequest } = await import("next/server");
    const chatRouteModule = await import("../app/api/chat/route");
    const { ThreadStore } = await import("../lib/threads/threadStore");

    const store = new ThreadStore(tmpThreadsDir);
    const threadId = `thread-synth-tokens-${Date.now()}`;
    store.createThread({ id: threadId, title: "Synthesis Tokens Test", hostAccess: false });

    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        userMessageId: "u-1",
        assistantMessageId: "a-1",
        messages: [{ role: "user", content: "Inspect.", id: "u-1" }],
        model: "swift-15-27b-mtp",
        enableTools: true,
      }),
    });
    const res = await chatRouteModule.POST(req);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    // 100 + 200 + 333 = 633 prompt tokens across [100, 200, 333]
    assert.ok(
      raw.includes(`"roundPromptTokens":[100,200,333]`),
      `synthesis prompt_eval_count (333) must be included in roundPromptTokens, got raw: ${raw.slice(-500)}`
    );
  } finally {
    server.close();
    Object.entries(prevEnv).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  }
});

test("Synthesis markup guard: tool-call markup in synthesis triggers one retry; second markup ends with honest marker", async () => {
  const toolCall = {
    id: "call-1",
    type: "function",
    function: { name: "workspace_get_tree", arguments: "{}" },
  };
  const markupText = `<function=workspace_read_file><parameter=path>foo.ts</parameter></function>`;
  const script = [
    { content: "Checking. ", toolCalls: [toolCall], evalCount: 10 },
    { content: "" },
    // Synthesis pass 1: emits tool-call markup as text
    { content: markupText, evalCount: 20 },
    // Synthesis retry pass 2: emits tool-call markup again
    { content: markupText, evalCount: 20 },
  ];

  const { asst, raw, completionCount } = await runTurn(script);
  assert.ok(asst, "assistant message must exist");
  assert.ok(
    completionCount >= 4,
    `markup in synthesis must trigger retry (got ${completionCount})`
  );
  assert.ok(
    raw.includes("retrying once") || raw.includes("tool calls were not executable"),
    "must emit retry status or honest markup end marker"
  );
  assert.ok(
    asst!.content.includes("tool calls were not executable"),
    `second markup failure must end with honest marker, got: ${asst!.content}`
  );
});

test("R9: runSynthesisPass re-arms passDeadline on toolCallProgress chunks", async () => {
  const { runSynthesisPass } = await import("../lib/chat/turnEngine");
  const turnAc = new AbortController();
  const result = await runSynthesisPass({
    llmBaseUrl: "http://127.0.0.1:11434",
    activeModel: "test-model",
    conversationMessages: [{ role: "user", content: "summarize" }],
    isArtifactRequest: false,
    turnAbortSignal: turnAc.signal,
    synthOptions: {},
    accumulatedThoughts: [],
    getAccumulatedStreamedTokens: () => "",
    setAccumulatedStreamedTokens: () => {},
    onFinishReason: () => {},
    onPromptTokens: () => {},
    onOutputTokens: () => {},
    maybeWriteSnapshot: () => {},
    sendEvent: async () => {},
    streamChat: async function* (_url, payload) {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 45));
        if (payload.signal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        yield { toolCallProgress: { name: "workspace_read_file", argumentChars: (i + 1) * 12 } };
      }
      if (payload.signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      yield { message: { content: "Recovered prose after progress." }, finish_reason: "stop" };
    },
    deadlines: { inactivityMs: 90, totalMs: 1000 },
    log: () => {},
  });
  assert.equal(
    result.content,
    "Recovered prose after progress.",
    "toolCallProgress must re-arm passDeadline so synthesis does not abort at inactivityMs"
  );
});

test("R9: synthesis pass 2 appends a plain-prose correction directive instead of retrying identical messages", async () => {
  const toolCall = {
    id: "call-1",
    type: "function",
    function: { name: "workspace_get_tree", arguments: "{}" },
  };
  const capturedBodies: Array<{ messages?: Array<{ role?: string; content?: string }> }> = [];
  let completionCount = 0;
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url.includes("/api/ps")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (url.includes("/sse")) {
      res.writeHead(404);
      res.end("no mcp");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.includes("/api/chat")) {
        completionCount++;
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (completionCount === 1) {
          res.write(
            JSON.stringify({
              message: { role: "assistant", content: "Checking. ", tool_calls: [toolCall] },
            }) + "\n"
          );
          res.write(
            JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n"
          );
        } else if (completionCount === 2) {
          res.write(
            JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n"
          );
        } else if (completionCount === 3) {
          // Synthesis pass 1: empty
          res.write(
            JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n"
          );
        } else {
          // Synthesis pass 2: plain prose
          res.write(
            JSON.stringify({
              message: { role: "assistant", content: "Plain prose final summary." },
              done: true,
            }) + "\n"
          );
        }
        res.end();
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  });

  const tmpThreadsDir = path.resolve(process.cwd(), "tmp-test-synth-directive-" + Date.now());
  fs.mkdirSync(tmpThreadsDir, { recursive: true });
  const prevEnv = {
    THREADS_DIR: process.env.THREADS_DIR,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    LLAMACPP_BASE_URL: process.env.LLAMACPP_BASE_URL,
    MCP_SERVER_URL: process.env.MCP_SERVER_URL,
    BROWSER_MCP_URL: process.env.BROWSER_MCP_URL,
    LLM_ENGINE: process.env.LLM_ENGINE,
  };
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.LLM_ENGINE = "ollama";
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.LLAMACPP_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.MCP_SERVER_URL = `http://127.0.0.1:${port}/mcp`;
    process.env.BROWSER_MCP_URL = `http://127.0.0.1:${port}/browser`;

    const { NextRequest } = await import("next/server");
    const chatRouteModule = await import("../app/api/chat/route");
    const { ThreadStore } = await import("../lib/threads/threadStore");
    const store = new ThreadStore(tmpThreadsDir);
    const threadId = `thread-synth-dir-${Date.now()}`;
    store.createThread({ id: threadId, title: "Synthesis Directive Test", hostAccess: false });

    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        userMessageId: "u-1",
        assistantMessageId: "a-1",
        messages: [{ role: "user", content: "Inspect.", id: "u-1" }],
        model: "auto",
        enableTools: true,
      }),
    });
    const res = await chatRouteModule.POST(req);
    await res.text();

    assert.equal(capturedBodies.length, 4);
    const pass1Msgs = capturedBodies[2].messages || [];
    const pass2Msgs = capturedBodies[3].messages || [];
    assert.ok(
      pass2Msgs.length > pass1Msgs.length,
      `Pass 2 must append a correction directive instead of retrying identical messages (pass1=${pass1Msgs.length}, pass2=${pass2Msgs.length})`
    );
    const lastPass2 = pass2Msgs[pass2Msgs.length - 1];
    assert.equal(lastPass2.role, "user");
    assert.match(String(lastPass2.content), /plain.?prose|do not call any tools/i);
  } finally {
    server.close();
    Object.entries(prevEnv).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  }
});

test("R9: isFinalRound blocks tool execution even when engine ignores tool_choice none", async () => {
  const { runChatTurn } = await import("../lib/chat/roundLoop");
  const { createSseEventWriter } = await import("../lib/chat/turnEngine");
  const { ThreadStore } = await import("../lib/threads/threadStore");
  const { ThrottledStreamSnapshot } = await import("../lib/streamSnapshot");
  const { TelemetryTracer } = await import("../lib/telemetry");
  const os = await import("node:os");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r9-final-round-"));
  try {
    const threadStore = new ThreadStore(tmpDir);
    const thread = threadStore.createThread({ id: "t-final-round", title: "final round guard" });
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const reqAbort = new AbortController();
    const sseWriter = createSseEventWriter({
      stream,
      signal: reqAbort.signal,
      activeThreadId: thread.id,
    });
    sseWriter.startReadableDrain();

    let executedToolCalls = 0;
    const mockClient = {
      callTool: async () => {
        executedToolCalls++;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const toolClientMap = new Map([
      [
        "workspace_read_file",
        {
          client: mockClient as unknown as NonNullable<
            import("../lib/chat/roundLoop").RunChatTurnDeps["toolClientMap"] extends Map<
              string,
              { client: infer C }
            >
              ? C
              : never
          >,
          tier: "workspace" as const,
        },
      ],
    ]);

    let llmCall = 0;
    let secondCallToolChoice: unknown = undefined;
    const turnState = {
      activeModel: "test-model",
      accumulatedStreamedTokens: "",
      assistantPersisted: false,
      lastFinishReason: undefined,
      turnOutputTokens: undefined,
      turnCreatedFiles: [],
      turnPreImages: new Map<string, string>(),
      turnHostDiffs: [],
      traces: [],
      turnMicroElisions: [],
      turnReadDedups: [],
      accumulatedThoughts: [],
    };

    const deps = {
      reqSignal: reqAbort.signal,
      messages: [{ role: "user", content: "Read a file and answer." }],
      userPrompt: "Read a file and answer.",
      priorUserPrompt: "",
      assistantMessageId: "a-final",
      clientSessionId: "s-final",
      systemPrompt: "System.",
      effortDirective: "",
      imagePayloads: [],
      docContexts: [],
      mode: "auto" as const,
      requestedModel: "test-model",
      initialEffectiveReasoningEffort: "low" as const,
      invalidRequestedModel: null,
      triageComplexityResult: null,
      getLlmBaseUrl: () => "http://127.0.0.1:59999",
      resolveJobRepoRoot: () => tmpDir,
      streamLlmChat: async function* (_url: string, payload: { tool_choice?: unknown }) {
        llmCall++;
        if (llmCall === 1) {
          yield {
            message: {
              role: "assistant",
              content: "Reading first.",
              tool_calls: [
                {
                  id: "tc-0",
                  type: "function",
                  function: { name: "workspace_read_file", arguments: '{"path":"a.txt"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          };
        } else if (llmCall === 2) {
          secondCallToolChoice = payload.tool_choice;
          // Engine ignores tool_choice: "none" and emits another tool call!
          yield {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "tc-1",
                  type: "function",
                  function: { name: "workspace_read_file", arguments: '{"path":"evil.txt"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          };
        } else {
          yield {
            message: { role: "assistant", content: "Synthesized without running final tool." },
            finish_reason: "stop",
          };
        }
      },
      advertisedTools: new Set(["workspace_read_file"]),
      activeThreadId: thread.id,
      threadsDir: tmpDir,
      threadStore,
      initialThreadData: thread,
      initialThreadHostAccess: false,
      streamSnapshot: new ThrottledStreamSnapshot(threadStore, thread.id, "a-final"),
      sseWriter,
      turnAbortController: new AbortController(),
      persistAssistantOnAbort: () => {},
      onRunTurnStarted: () => {},
      onRunTurnFinally: () => {},
      isExplicitStopped: () => false,
      turnState,
      activeSessions: [],
      toolClientMap,
      tracer: new TelemetryTracer(),
      rootSpan: null,
      roundBackstop: 2,
    };

    await runChatTurn(
      deps as unknown as Parameters<typeof runChatTurn>[0],
      {
        id: "job-final",
        threadId: thread.id,
        prompt: "Read a file and answer.",
        position: 0,
        status: "running",
      },
      null
    );

    assert.equal(secondCallToolChoice, "none", "Final round must send tool_choice: none");
    assert.equal(
      executedToolCalls,
      1,
      `Final round must block tool execution (expected 1 execution from round 0, got ${executedToolCalls})`
    );
    assert.equal(turnState.traces.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
