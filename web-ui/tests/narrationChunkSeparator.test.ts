import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../app/api/chat/route";
import { ThreadStore } from "../lib/threads/threadStore";
import { appendNarrationChunk } from "../lib/liveActivity";

describe("UI-010: narration chunk separators", () => {
  let tmpThreadsDir: string;
  let origThreadsDir: string | undefined;
  let origLlmBaseUrl: string | undefined;
  let origLlmProvider: string | undefined;
  let origMcpUrl: string | undefined;
  let origBrowserMcpUrl: string | undefined;
  let server: http.Server | null = null;

  beforeEach(() => {
    tmpThreadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "narration-sep-"));
    origThreadsDir = process.env.THREADS_DIR;
    origLlmBaseUrl = process.env.LLM_BASE_URL;
    origLlmProvider = process.env.LLM_ENGINE;
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

  it("inserts a paragraph break (\\n\\n) between separate status chunks that end with punctuation and start with uppercase", () => {
    let acc = "";
    acc = appendNarrationChunk(acc, "Updated runlog.");
    acc = appendNarrationChunk(acc, "Both runs green.");
    acc = appendNarrationChunk(acc, "Banking commit.");
    assert.equal(acc, "Updated runlog.\n\nBoth runs green.\n\nBanking commit.");
  });

  it("leaves single-chunk messages unchanged", () => {
    assert.equal(appendNarrationChunk("", "Single chunk."), "Single chunk.");
  });

  it("does not split mid-word BPE tokens or normal spaced tokens", () => {
    let acc = "";
    acc = appendNarrationChunk(acc, "hel");
    acc = appendNarrationChunk(acc, "lo");
    acc = appendNarrationChunk(acc, " world");
    assert.equal(acc, "hello world");
  });

  it("does not double-insert newlines when chunk or existing already has one", () => {
    assert.equal(appendNarrationChunk("Line 1.\n", "Line 2."), "Line 1.\nLine 2.");
    assert.equal(appendNarrationChunk("Line 1.", "\nLine 2."), "Line 1.\nLine 2.");
  });

  it("chat/route.ts uses appendNarrationChunk for streamed token assembly", async () => {
    let round = 0;
    server = http.createServer((_req, res) => {
      round += 1;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (round === 1) {
        res.write(
          `${JSON.stringify({
            message: {
              role: "assistant",
              content: "Updated runlog.",
              tool_calls: [{ function: { name: "workspace_get_tree", arguments: {} } }],
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 10,
            eval_count: 4,
          })}\n`
        );
      } else {
        res.write(
          `${JSON.stringify({
            message: { role: "assistant", content: "Both runs green." },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 15,
            eval_count: 4,
          })}\n`
        );
      }
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };
    process.env.LLM_BASE_URL = `http://127.0.0.1:${addr.port}`;

    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "narration-sep-thread",
        messages: [{ role: "user", content: "status?" }],
      }),
    });

    const res = await POST(req);
    await res.text();
    const store = new ThreadStore(tmpThreadsDir);
    const thread = await store.getThread("narration-sep-thread");
    const assistant = thread?.messages.find((m) => m.role === "assistant");
    assert.equal(assistant?.content.trim(), "Both runs green.");
    assert.ok(
      assistant?.roundNarrations?.some((n) => n.text.includes("Updated runlog.")),
      `Expected round 1 narration in roundNarrations, got: ${JSON.stringify(assistant?.roundNarrations)}`
    );
  });
});
