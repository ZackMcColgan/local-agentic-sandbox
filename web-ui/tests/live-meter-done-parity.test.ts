import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../app/api/chat/route";

const webUiRoot = path.resolve(__dirname, "..");

describe("B4: Live meter parity on SSE done", () => {
  let tmpThreadsDir: string;
  let origThreadsDir: string | undefined;
  let origLlmBaseUrl: string | undefined;
  let origLlmProvider: string | undefined;
  let origMcpUrl: string | undefined;
  let origBrowserMcpUrl: string | undefined;
  let server: http.Server | null = null;

  beforeEach(() => {
    tmpThreadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-meter-done-"));
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

  it("chat/route.ts includes roundPromptTokens and outputTokens in the SSE done payload", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(
        `${JSON.stringify({
          message: { role: "assistant", content: "ok" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 123,
          eval_count: 9,
        })}\n`
      );
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };
    process.env.LLM_BASE_URL = `http://127.0.0.1:${addr.port}`;

    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "live-meter-done-thread",
        messages: [{ role: "user", content: "ping" }],
      }),
    });

    const res = await POST(req);
    const text = await res.text();
    let donePayload: Record<string, unknown> | null = null;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.type === "done") {
        donePayload = parsed;
      }
    }

    assert.ok(donePayload, 'Expected SSE { type: "done", ... } event from POST /api/chat');
    assert.deepEqual(
      donePayload.roundPromptTokens,
      [123],
      "SSE done payload must include roundPromptTokens"
    );
    assert.equal(donePayload.outputTokens, 9, "SSE done payload must include outputTokens");
  });

  it("ChatStream.tsx applies roundPromptTokens and outputTokens from SSE done to the tail assistant message", () => {
    const chatSrc = fs.readFileSync(path.join(webUiRoot, "components", "ChatStream.tsx"), "utf8");
    assert.ok(
      chatSrc.includes("Array.isArray(event.roundPromptTokens)"),
      "ChatStream.tsx done handler must apply event.roundPromptTokens to the tail assistant message"
    );
  });
});
