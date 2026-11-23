import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../app/api/chat/route";
import { ThreadStore, abortActiveTurn } from "../lib/threads/threadStore";
import { LlamaCppProvider } from "../lib/llm/provider";

interface SseEvent {
  type?: string;
  [key: string]: unknown;
}

async function readSseEvents(response: Response): Promise<SseEvent[]> {
  const text = await response.text();
  const events: SseEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      events.push(JSON.parse(raw) as SseEvent);
    } catch {}
  }
  return events;
}

function startMockLlmServer(
  handler: (
    req: http.IncomingMessage,
    body: Record<string, unknown>,
    res: http.ServerResponse
  ) => void
): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        } catch {}
        handler(req, parsed, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function createMockSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("Batch C — Counting truth (F10, F11, F12)", () => {
  let tmpThreadsDir: string;
  let origThreadsDir: string | undefined;
  let origLlmBaseUrl: string | undefined;
  let origLlmEngine: string | undefined;
  let origLlamaCppBaseUrl: string | undefined;
  let origMcpUrl: string | undefined;
  let origBrowserMcpUrl: string | undefined;
  let server: http.Server | null = null;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tmpThreadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "counting-truth-"));
    origThreadsDir = process.env.THREADS_DIR;
    origLlmBaseUrl = process.env.LLM_BASE_URL;
    origLlmEngine = process.env.LLM_ENGINE;
    origLlamaCppBaseUrl = process.env.LLAMACPP_BASE_URL;
    origMcpUrl = process.env.MCP_SERVER_URL;
    origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.LLM_ENGINE = "ollama";
    delete process.env.LLAMACPP_BASE_URL;
    process.env.MCP_SERVER_URL = "http://127.0.0.1:59997/mcp/sse";
    process.env.BROWSER_MCP_URL = "http://127.0.0.1:59996/browser/sse";
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    if (origThreadsDir === undefined) delete process.env.THREADS_DIR;
    else process.env.THREADS_DIR = origThreadsDir;
    if (origLlmBaseUrl === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = origLlmBaseUrl;
    if (origLlmEngine === undefined) delete process.env.LLM_ENGINE;
    else process.env.LLM_ENGINE = origLlmEngine;
    if (origLlamaCppBaseUrl === undefined) delete process.env.LLAMACPP_BASE_URL;
    else process.env.LLAMACPP_BASE_URL = origLlamaCppBaseUrl;
    if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
    else process.env.MCP_SERVER_URL = origMcpUrl;
    if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
    else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  });

  describe("Fix C1 (F10): cumulative output tokens across all write paths & pre-EOF usage chunks", () => {
    it("persists outputTokens equal to the SUM of a 3-round turn on normal settle", async () => {
      let dispatch = 0;
      const mock = await startMockLlmServer((_req, _body, res) => {
        dispatch += 1;
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (dispatch === 1) {
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: "",
                thinking: "Round 1 reasoning",
                tool_calls: [{ function: { name: "workspace_get_tree", arguments: {} } }],
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 1000,
              eval_count: 200,
            })}\n`
          );
        } else if (dispatch === 2) {
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: "",
                thinking: "Round 2 reasoning",
                tool_calls: [{ function: { name: "git_status", arguments: {} } }],
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 1500,
              eval_count: 300,
            })}\n`
          );
        } else {
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: "Final three-round answer.",
                thinking: "Round 3 reasoning",
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 2000,
              eval_count: 717,
            })}\n`
          );
        }
        res.end();
      });
      server = mock.server;
      process.env.LLM_BASE_URL = mock.baseUrl;

      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-c1-normal",
          messages: [{ role: "user", content: "Run 3 rounds" }],
        }),
      });

      const res = await POST(req);
      const events = await readSseEvents(res);
      const done = events.find((e) => e.type === "done");
      assert.ok(done, "turn must emit done event");
      assert.equal(dispatch, 3, "must dispatch exactly 3 rounds");
      assert.equal(done.outputTokens, 1217, "done event must carry cumulative output tokens");

      const store = new ThreadStore(tmpThreadsDir);
      const thread = await store.getThread("thread-c1-normal");
      const assistant = thread?.messages.find((m) => m.role === "assistant");
      assert.ok(assistant, "assistant message must be persisted");
      assert.equal(assistant.outputTokens, 1217, "assistant.outputTokens must be 200+300+717");
      assert.equal(
        assistant.tokenEconomics?.outputTokens,
        1217,
        "tokenEconomics.outputTokens must be 200+300+717"
      );
      assert.equal(
        thread?.tokenEconomics?.outputTokens,
        1217,
        "thread rollup outputTokens must be 200+300+717"
      );
      assert.equal(assistant.tokenEconomics?.rounds, 3, "3-dispatch turn must record rounds == 3");
      assert.deepEqual(assistant.roundPromptTokens, [1000, 1500, 2000]);
      assert.equal(assistant.roundGenerationMs?.length, 3);
      assert.deepEqual(
        assistant.thinkingSegments?.map((s) => s.round),
        [1, 2, 3],
        "thinkingSegments rounds must be 1-based and aligned with dispatched rounds"
      );
    });

    it("persists cumulative outputTokens on the abort path after 3 rounds emit completion tokens", async () => {
      let dispatch = 0;
      const threadId = "thread-c1-abort";
      let releaseRound3: (() => void) | null = null;
      const round3ChunkSent = new Promise<void>((resolve) => {
        releaseRound3 = resolve;
      });

      const mock = await startMockLlmServer((_req, _body, res) => {
        dispatch += 1;
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (dispatch === 1) {
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ function: { name: "workspace_get_tree", arguments: {} } }],
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 800,
              eval_count: 200,
            })}\n`
          );
          res.end();
        } else if (dispatch === 2) {
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ function: { name: "git_status", arguments: {} } }],
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 1100,
              eval_count: 300,
            })}\n`
          );
          res.end();
        } else {
          // Round 3 emits partial content + usage chunk, then stays open until aborted.
          res.write(
            `${JSON.stringify({
              message: { role: "assistant", content: "Working on final step..." },
              done: false,
              prompt_eval_count: 1400,
              eval_count: 150,
            })}\n`
          );
          releaseRound3?.();
          // Keep response open until client aborts the fetch
          res.on("close", () => {
            try {
              res.end();
            } catch {}
          });
        }
      });
      server = mock.server;
      process.env.LLM_BASE_URL = mock.baseUrl;

      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          messages: [{ role: "user", content: "Abort mid round 3" }],
        }),
      });

      const res = await POST(req);
      // Consume the SSE stream concurrently so writer backpressure never triggers
      const eventsPromise = readSseEvents(res);
      // Wait for round 3's chunk to be sent and processed, then abort the turn.
      await round3ChunkSent;
      await new Promise((r) => setTimeout(r, 40));
      abortActiveTurn(threadId);
      await eventsPromise;

      const store = new ThreadStore(tmpThreadsDir);
      const thread = await store.getThread(threadId);
      const assistant = thread?.messages.find((m) => m.role === "assistant");
      assert.ok(assistant, "aborted assistant message must be persisted");
      assert.equal(assistant.status, "incomplete");
      assert.equal(
        assistant.outputTokens,
        650,
        "abort-persisted outputTokens must equal cumulative sum (200 + 300 + 150)"
      );
    });

    it("does not zero the cumulative output accumulator when a middle round omits usage", async () => {
      let dispatch = 0;
      const mock = await startMockLlmServer((_req, _body, res) => {
        dispatch += 1;
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (dispatch === 1) {
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ function: { name: "workspace_get_tree", arguments: {} } }],
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 500,
              eval_count: 250,
            })}\n`
          );
        } else if (dispatch === 2) {
          // Chunk-less usage round: no eval_count field
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ function: { name: "git_status", arguments: {} } }],
              },
              done: true,
              done_reason: "stop",
            })}\n`
          );
        } else {
          res.write(
            `${JSON.stringify({
              message: { role: "assistant", content: "Done after gap." },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 900,
              eval_count: 400,
            })}\n`
          );
        }
        res.end();
      });
      server = mock.server;
      process.env.LLM_BASE_URL = mock.baseUrl;

      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-c1-gap",
          messages: [{ role: "user", content: "Gap round" }],
        }),
      });

      const res = await POST(req);
      await readSseEvents(res);

      const store = new ThreadStore(tmpThreadsDir);
      const thread = await store.getThread("thread-c1-gap");
      const assistant = thread?.messages.find((m) => m.role === "assistant");
      assert.equal(assistant?.outputTokens, 650, "250 + 0 + 400 must be preserved");
    });

    it("LlamaCppProvider.streamChat yields usage from pre-EOF standalone choices:[] chunk and content+finish chunk", async () => {
      const provider = new LlamaCppProvider("strata");

      // Case 1: standalone pre-EOF chunk with choices: [] and usage
      globalThis.fetch = async () =>
        createMockSseResponse([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":1500,"completion_tokens":222}}\n\n',
          "data: [DONE]\n\n",
        ]);

      const chunks1: Array<{ outputTokens?: number; promptTokens?: number }> = [];
      for await (const chunk of provider.streamChat("http://127.0.0.1:9", {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks1.push(chunk);
      }
      const usageChunk1 = chunks1.find((c) => typeof c.outputTokens === "number");
      assert.ok(usageChunk1, "standalone choices:[] usage chunk must be yielded");
      assert.equal(usageChunk1.outputTokens, 222);
      assert.equal(usageChunk1.promptTokens, 1500);

      // Case 2: content + finish_reason + usage in one chunk carries BOTH promptTokens and outputTokens
      globalThis.fetch = async () =>
        createMockSseResponse([
          'data: {"choices":[{"delta":{"content":"All in one"},"finish_reason":"stop"}],"usage":{"prompt_tokens":987,"completion_tokens":65}}\n\n',
          "data: [DONE]\n\n",
        ]);

      const chunks2: Array<{ outputTokens?: number; promptTokens?: number }> = [];
      for await (const chunk of provider.streamChat("http://127.0.0.1:9", {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks2.push(chunk);
      }
      const usageChunk2 = chunks2.find((c) => typeof c.outputTokens === "number");
      assert.ok(usageChunk2, "content+finish chunk must yield usage");
      assert.equal(usageChunk2.outputTokens, 65);
      assert.equal(usageChunk2.promptTokens, 987);
    });
  });

  describe("Fix C2 (F11): dispatched rounds counting & synthesis pass array alignment", () => {
    it("records rounds == 1 for a 1-round direct answer with aligned per-round arrays", async () => {
      const mock = await startMockLlmServer((_req, _body, res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(
          `${JSON.stringify({
            message: { role: "assistant", content: "Direct answer." },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 321,
            eval_count: 42,
          })}\n`
        );
        res.end();
      });
      server = mock.server;
      process.env.LLM_BASE_URL = mock.baseUrl;

      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-c2-direct",
          messages: [{ role: "user", content: "Say hello" }],
        }),
      });

      const res = await POST(req);
      await readSseEvents(res);

      const store = new ThreadStore(tmpThreadsDir);
      const thread = await store.getThread("thread-c2-direct");
      const assistant = thread?.messages.find((m) => m.role === "assistant");
      assert.ok(assistant, "assistant message must be persisted");
      assert.equal(
        assistant.tokenEconomics?.rounds,
        1,
        "1-round direct answer must record rounds == 1"
      );
      assert.equal(assistant.roundPromptTokens?.length, 1);
      assert.equal(assistant.roundGenerationMs?.length, 1);
      assert.equal(assistant.outputTokens, 42);
    });

    it("keeps rounds and per-round arrays aligned across a synthesis pass and accumulates synthesis output tokens", async () => {
      const threadId = "thread-c2-synth";
      const store = new ThreadStore(tmpThreadsDir);
      let dispatch = 0;

      const mock = await startMockLlmServer((_req, _body, res) => {
        dispatch += 1;
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (dispatch === 1) {
          // Inject a late steer while round 1 is executing so post-tool synthesis runs as round 2.
          store.appendSteer(threadId, "Now summarize concisely.");
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: "Initial answer before steer.",
                thinking: "Round 1 thought",
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 600,
              eval_count: 110,
            })}\n`
          );
        } else {
          // Synthesis pass (dispatch 2)
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: "Concise synthesized summary.",
                thinking: "Synthesis pass thought",
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 950,
              eval_count: 85,
            })}\n`
          );
        }
        res.end();
      });
      server = mock.server;
      process.env.LLM_BASE_URL = mock.baseUrl;

      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          messages: [{ role: "user", content: "Explain briefly" }],
        }),
      });

      const res = await POST(req);
      const events = await readSseEvents(res);
      const done = events.find((e) => e.type === "done");
      assert.ok(done, "turn must emit done event");
      assert.equal(dispatch, 2, "must dispatch main round + synthesis pass");

      const thread = await store.getThread(threadId);
      const assistant = thread?.messages.find((m) => m.role === "assistant");
      assert.ok(assistant, "assistant message must be persisted");

      assert.equal(
        assistant.tokenEconomics?.rounds,
        2,
        "rounds must include the synthesis pass (1 + 1 = 2)"
      );
      assert.equal(
        assistant.roundPromptTokens?.length,
        2,
        "roundPromptTokens.length must equal rounds after synthesis"
      );
      assert.equal(
        assistant.roundGenerationMs?.length,
        2,
        "roundGenerationMs.length must equal rounds after synthesis"
      );
      assert.deepEqual(assistant.roundPromptTokens, [600, 950]);
      assert.deepEqual(
        assistant.thinkingSegments?.map((s) => s.round),
        [1, 2],
        "thinkingSegments must stay index-consistent across synthesis passes"
      );
      assert.equal(
        assistant.outputTokens,
        195,
        "cumulative outputTokens must include synthesis pass (110 + 85)"
      );
      assert.equal(assistant.tokenEconomics?.outputTokens, 195);
      assert.equal(done.outputTokens, 195);
    });
  });

  describe("Fix C3 (F12): turn clock starts at chat-route entry", () => {
    it("persists route-entry turnStartMs <= first provider request timestamp and route-to-settle durationMs", async () => {
      let firstProviderRequestMs: number | null = null;
      const mock = await startMockLlmServer((_req, _body, res) => {
        if (firstProviderRequestMs === null) {
          firstProviderRequestMs = Date.now();
        }
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
          res.write(
            `${JSON.stringify({
              message: { role: "assistant", content: "Timed response." },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 100,
              eval_count: 25,
            })}\n`
          );
          res.end();
        }, 25);
      });
      server = mock.server;
      process.env.LLM_BASE_URL = mock.baseUrl;

      const beforeRouteMs = Date.now();
      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-c3-clock",
          messages: [{ role: "user", content: "Measure turn start" }],
        }),
      });

      const res = await POST(req);
      const events = await readSseEvents(res);
      const afterSettleMs = Date.now();
      const done = events.find((e) => e.type === "done");
      assert.ok(done, "turn must emit done event");
      assert.ok(firstProviderRequestMs !== null, "provider must have received a request");

      const store = new ThreadStore(tmpThreadsDir);
      const thread = await store.getThread("thread-c3-clock");
      const assistant = thread?.messages.find((m) => m.role === "assistant");
      assert.ok(assistant, "assistant message must be persisted");

      assert.equal(typeof assistant.turnStartMs, "number", "turnStartMs must be persisted");
      assert.ok(
        assistant.turnStartMs! >= beforeRouteMs,
        `turnStartMs (${assistant.turnStartMs}) must be >= route call time (${beforeRouteMs})`
      );
      assert.ok(
        assistant.turnStartMs! <= firstProviderRequestMs!,
        `turnStartMs (${assistant.turnStartMs}) must be <= first provider request (${firstProviderRequestMs})`
      );
      assert.equal(
        done.turnStartMs,
        assistant.turnStartMs,
        "SSE done turnStartMs must match persisted record"
      );

      assert.equal(typeof assistant.durationMs, "number", "durationMs must be persisted");
      assert.ok(
        assistant.durationMs! >= 20,
        `durationMs (${assistant.durationMs}) must cover route-entry to settle`
      );
      assert.ok(
        assistant.durationMs! <= afterSettleMs - beforeRouteMs + 50,
        "durationMs must be bounded by actual wall time"
      );
      assert.equal(
        done.durationMs,
        assistant.durationMs,
        "SSE done durationMs must match persisted record"
      );
    });
  });
});
