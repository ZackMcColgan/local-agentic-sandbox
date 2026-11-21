import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { NextRequest } from "next/server";
import { ThreadStore } from "../lib/threads/threadStore";
import { POST } from "../app/api/chat/route";

function startMockOllamaServer(
  handler: (callIndex: number, body: Record<string, unknown>, res: http.ServerResponse) => void
): Promise<{ server: http.Server; url: string }> {
  let callIndex = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen2.5-coder:32b" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const idx = callIndex++;
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      handler(idx, body, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("FIX-5: UI-010 joinNarrationChunks wiring + B-1 multi-round prose preservation", () => {
  let tmpThreadsDir: string;
  let originalThreadsDir: string | undefined;
  let originalLlmUrl: string | undefined;
  let originalOllamaUrl: string | undefined;
  let originalLlmProvider: string | undefined;
  let mockServer: http.Server | null = null;

  beforeEach(() => {
    tmpThreadsDir = path.join(
      os.tmpdir(),
      `fix5-threads-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    );
    fs.mkdirSync(tmpThreadsDir, { recursive: true });
    originalThreadsDir = process.env.THREADS_DIR;
    originalLlmUrl = process.env.LLM_BASE_URL;
    originalOllamaUrl = process.env.OLLAMA_BASE_URL;
    originalLlmProvider = process.env.LLM_PROVIDER;
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.LLM_PROVIDER = "ollama";
  });

  afterEach(async () => {
    if (mockServer) {
      await new Promise<void>((r) => mockServer!.close(() => r()));
      mockServer = null;
    }
    if (originalThreadsDir === undefined) delete process.env.THREADS_DIR;
    else process.env.THREADS_DIR = originalThreadsDir;
    if (originalLlmUrl === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = originalLlmUrl;
    if (originalOllamaUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalOllamaUrl;
    if (originalLlmProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalLlmProvider;
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  });

  it("UI-010: multi-chunk length-continuation narration is joined with separator in persisted record", async () => {
    const { server, url } = await startMockOllamaServer((callIndex, _body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (callIndex === 0) {
        res.write(
          JSON.stringify({
            model: "qwen2.5-coder:32b",
            message: { role: "assistant", content: "First chunk" },
            done: true,
            done_reason: "length",
            finish_reason: "length",
          }) + "\n"
        );
      } else {
        res.write(
          JSON.stringify({
            model: "qwen2.5-coder:32b",
            message: { role: "assistant", content: "second chunk" },
            done: true,
            done_reason: "stop",
          }) + "\n"
        );
      }
      res.end();
    });
    mockServer = server;
    process.env.LLM_BASE_URL = url;
    process.env.OLLAMA_BASE_URL = url;

    const store = new ThreadStore(tmpThreadsDir);
    const thread = await store.createThread({ title: "UI-010 test" });

    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: thread.id,
        messages: [{ role: "user", content: "Write two chunks" }],
      }),
    });

    const resp = await POST(req);
    assert.equal(resp.status, 200);
    await resp.text();

    const updated = await store.getThread(thread.id);
    assert.ok(updated, "thread should exist");
    const assistantMsgs = updated.messages.filter((m) => m.role === "assistant");
    assert.ok(assistantMsgs.length >= 1, "at least one assistant message should be persisted");
    const lastContent = assistantMsgs[assistantMsgs.length - 1].content;
    assert.ok(
      lastContent.includes("First chunk second chunk"),
      `Expected persisted content to join chunks with space separator, got: ${JSON.stringify(lastContent)}`
    );
  });

  it("B-1: round 1 prose survives in persisted message when round 2 produces a tool call", async () => {
    const { server, url } = await startMockOllamaServer((callIndex, _body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (callIndex === 0) {
        res.write(
          JSON.stringify({
            model: "qwen2.5-coder:32b",
            message: {
              role: "assistant",
              content: "Round 1 prose before tool.",
              tool_calls: [
                { id: "tc_1", function: { name: "search_web", arguments: { query: "test 1" } } },
              ],
            },
            done: true,
            done_reason: "stop",
          }) + "\n"
        );
      } else if (callIndex === 1) {
        res.write(
          JSON.stringify({
            model: "qwen2.5-coder:32b",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "tc_2", function: { name: "search_web", arguments: { query: "test 2" } } },
              ],
            },
            done: true,
            done_reason: "stop",
          }) + "\n"
        );
      } else {
        res.write(
          JSON.stringify({
            model: "qwen2.5-coder:32b",
            message: { role: "assistant", content: "Round 3 final answer." },
            done: true,
            done_reason: "stop",
          }) + "\n"
        );
      }
      res.end();
    });
    mockServer = server;
    process.env.LLM_BASE_URL = url;
    process.env.OLLAMA_BASE_URL = url;

    const store = new ThreadStore(tmpThreadsDir);
    const thread = await store.createThread({ title: "B-1 test" });

    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: thread.id,
        messages: [{ role: "user", content: "Check the time twice" }],
      }),
    });

    const resp = await POST(req);
    assert.equal(resp.status, 200);
    await resp.text();

    const updated = await store.getThread(thread.id);
    assert.ok(updated, "thread should exist");
    const assistantMsgs = updated.messages.filter((m) => m.role === "assistant");
    assert.ok(assistantMsgs.length >= 1, "at least one assistant message should be persisted");
    const lastContent = assistantMsgs[assistantMsgs.length - 1].content;
    assert.ok(
      lastContent.includes("Round 1 prose before tool."),
      `Expected round 1 prose to survive in persisted message, got: ${JSON.stringify(lastContent)}`
    );
  });
});
