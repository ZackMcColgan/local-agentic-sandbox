import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../app/api/chat/route";
import { ThreadStore } from "../lib/threads/threadStore";

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

describe("chat route round-loop characterization", () => {
  let tmpThreadsDir: string;
  let origThreadsDir: string | undefined;
  let origLlmBaseUrl: string | undefined;
  let origLlmProvider: string | undefined;
  let origMcpUrl: string | undefined;
  let origBrowserMcpUrl: string | undefined;
  let server: http.Server | null = null;

  beforeEach(() => {
    tmpThreadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-roundloop-"));
    origThreadsDir = process.env.THREADS_DIR;
    origLlmBaseUrl = process.env.LLM_BASE_URL;
    origLlmProvider = process.env.LLM_PROVIDER;
    origMcpUrl = process.env.MCP_SERVER_URL;
    origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.LLM_ENGINE = "ollama";
    process.env.MCP_SERVER_URL = "http://127.0.0.1:59997/mcp/sse";
    process.env.BROWSER_MCP_URL = "http://127.0.0.1:59996/browser/sse";
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    if (origThreadsDir === undefined) delete process.env.THREADS_DIR;
    else process.env.THREADS_DIR = origThreadsDir;
    if (origLlmBaseUrl === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = origLlmBaseUrl;
    if (origLlmProvider === undefined) delete process.env.LLM_ENGINE;
    else process.env.LLM_ENGINE = origLlmProvider;
    if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
    else process.env.MCP_SERVER_URL = origMcpUrl;
    if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
    else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  });

  it("delegates queued turns through serializeTurn to the turn runner and persists assistant messages", async () => {
    let callCount = 0;
    const mock = await startMockLlmServer((_req, _body, res) => {
      callCount += 1;
      const reply = `Reply #${callCount}`;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(
        `${JSON.stringify({ message: { role: "assistant", content: reply }, done: false })}\n`
      );
      res.write(
        `${JSON.stringify({
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 42,
          eval_count: 7,
        })}\n`
      );
      res.end();
    });
    server = mock.server;
    process.env.LLM_BASE_URL = mock.baseUrl;

    const req1 = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "thread-queue-1",
        messages: [{ role: "user", content: "First turn" }],
      }),
    });
    const req2 = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "thread-queue-2",
        messages: [{ role: "user", content: "Second turn" }],
      }),
    });

    const [res1, res2] = await Promise.all([POST(req1), POST(req2)]);
    const [events1, events2] = await Promise.all([readSseEvents(res1), readSseEvents(res2)]);

    const done1 = events1.find((e) => e.type === "done");
    const done2 = events2.find((e) => e.type === "done");
    assert.ok(done1, "first turn must emit done event");
    assert.ok(done2, "second turn must emit done event");
    assert.deepEqual(done1.roundPromptTokens, [42]);
    assert.equal(done1.outputTokens, 7);

    const store = new ThreadStore(tmpThreadsDir);
    const t1 = await store.getThread("thread-queue-1");
    const t2 = await store.getThread("thread-queue-2");
    assert.ok(t1?.messages.some((m) => m.role === "assistant" && m.content.includes("Reply #1")));
    assert.ok(t2?.messages.some((m) => m.role === "assistant" && m.content.includes("Reply #2")));
  });

  it("handles advertised tool call with graceful degradation and completes on next round", async () => {
    let round = 0;
    const mock = await startMockLlmServer((_req, _body, res) => {
      round += 1;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (round === 1) {
        res.write(
          `${JSON.stringify({
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: "workspace_get_tree", arguments: {} } }],
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 55,
            eval_count: 12,
          })}\n`
        );
      } else {
        res.write(
          `${JSON.stringify({
            message: { role: "assistant", content: "Handled gracefully." },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 80,
            eval_count: 5,
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
        threadId: "thread-tool-degrade",
        messages: [{ role: "user", content: "Inspect workspace" }],
      }),
    });

    const res = await POST(req);
    const events = await readSseEvents(res);
    const done = events.find((e) => e.type === "done");
    assert.ok(done, "turn must emit done event");
    assert.equal(round, 2, "must execute tool round then final round");

    const store = new ThreadStore(tmpThreadsDir);
    const thread = await store.getThread("thread-tool-degrade");
    const assistant = thread?.messages.find((m) => m.role === "assistant");
    assert.ok(assistant, "assistant message must be persisted");
    assert.ok(assistant.content.includes("Handled gracefully."));
    assert.deepEqual(done.roundPromptTokens, [55, 80]);
  });

  it("emits SSE error and persists error assistant message for invalid requested model", async () => {
    process.env.LLM_BASE_URL = "http://127.0.0.1:59999";
    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "thread-invalid-model",
        model: "nonexistent-model-xyz",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    const res = await POST(req);
    const events = await readSseEvents(res);
    const errEvent = events.find((e) => e.type === "error");
    assert.ok(errEvent, "must emit SSE error event for invalid model");
    assert.match(String(errEvent.error), /nonexistent-model-xyz/);

    const store = new ThreadStore(tmpThreadsDir);
    const thread = await store.getThread("thread-invalid-model");
    const assistant = thread?.messages.find((m) => m.role === "assistant");
    assert.equal(assistant?.status, "error");
  });
});
