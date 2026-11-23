import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../app/api/chat/route";
import { ThreadStore } from "../lib/threads/threadStore";
import { runSynthesisPass } from "../lib/chat/turnEngine";

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

describe("PERF-P3 — thought stream is delta-only per token, cumulative thought at round boundaries", () => {
  let tmpThreadsDir: string;
  let origThreadsDir: string | undefined;
  let origLlmBaseUrl: string | undefined;
  let origLlmProvider: string | undefined;
  let origMcpUrl: string | undefined;
  let origBrowserMcpUrl: string | undefined;
  let server: http.Server | null = null;

  beforeEach(() => {
    tmpThreadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-p3-thought-"));
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
    else process.env.LLM_PROVIDER = origLlmProvider;
    if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
    else process.env.MCP_SERVER_URL = origMcpUrl;
    if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
    else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  });

  it("N thinking tokens produce N thinking delta events and at most one thought event per round whose payload equals the full round thought", async () => {
    const tokens = ["Alpha ", "beta ", "gamma ", "delta ", "epsilon"];
    const store = new ThreadStore(tmpThreadsDir);
    const threadId = `perf-p3-single-${Date.now()}`;
    store.createThread({ id: threadId, title: "delta only" });
    const mock = await startMockLlmServer((_req, _body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (const t of tokens) {
        res.write(`${JSON.stringify({ message: { role: "assistant", thinking: t } })}\n`);
      }
      res.write(
        `${JSON.stringify({
          message: { role: "assistant", content: "Final answer." },
          done: true,
          done_reason: "stop",
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
        threadId,
        userMessageId: "u-p3",
        assistantMessageId: "a-p3",
        messages: [{ role: "user", content: "Think hard", id: "u-p3" }],
        model: "swift-15-27b-mtp",
        enableTools: false,
      }),
    });
    const events = await readSseEvents(await POST(req));

    const thinkingEvents = events.filter((e) => e.type === "thinking");
    const thoughtEvents = events.filter((e) => e.type === "thought");

    assert.equal(
      thinkingEvents.length,
      tokens.length,
      `Expected ${tokens.length} thinking delta events, got ${thinkingEvents.length}`
    );
    for (const ev of thinkingEvents) {
      assert.equal(typeof ev.content, "string", "thinking event must carry a delta content");
      assert.ok(
        tokens.some((t) => t === ev.content),
        `thinking delta must be a single token, got ${JSON.stringify(ev.content)}`
      );
    }
    assert.ok(
      thoughtEvents.length <= 1,
      `At most one thought event per round, got ${thoughtEvents.length}`
    );
    if (thoughtEvents.length === 1) {
      const fullRoundThought = tokens.join("").trim();
      const payload = String(thoughtEvents[0].thought);
      assert.ok(
        payload.length > 0 && fullRoundThought.startsWith(payload.trim()),
        `Thought payload must be the cumulative thought-so-far (prefix of full round thought), got ${JSON.stringify(payload)}`
      );
    }
  });

  it("multi-round turn emits at most one thought event per round and the last thought is cumulative across rounds", async () => {
    let roundCount = 0;
    const store = new ThreadStore(tmpThreadsDir);
    const threadId = `perf-p3-multi-${Date.now()}`;
    store.createThread({ id: threadId, title: "multi round" });
    const mock = await startMockLlmServer((_req, _body, res) => {
      roundCount += 1;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (roundCount === 1) {
        res.write(
          `${JSON.stringify({
            message: { role: "assistant", thinking: "Round 1 reasoning part A " },
          })}\n`
        );
        res.write(
          `${JSON.stringify({
            message: { role: "assistant", thinking: "part B" },
          })}\n`
        );
        res.write(
          `${JSON.stringify({
            message: {
              role: "assistant",
              content: "Calling a tool.",
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "workspace_read_file", arguments: '{"path":"f.txt"}' },
                },
              ],
            },
            done: true,
            done_reason: "stop",
          })}\n`
        );
        res.end();
      } else {
        res.write(
          `${JSON.stringify({
            message: { role: "assistant", thinking: "Round 2 reasoning" },
          })}\n`
        );
        res.write(
          `${JSON.stringify({
            message: { role: "assistant", content: "Final answer after tool." },
            done: true,
            done_reason: "stop",
          })}\n`
        );
        res.end();
      }
    });
    server = mock.server;
    process.env.LLM_BASE_URL = mock.baseUrl;

    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        userMessageId: "u-p3m",
        assistantMessageId: "a-p3m",
        messages: [{ role: "user", content: "Multi round work", id: "u-p3m" }],
        model: "swift-15-27b-mtp",
        enableTools: true,
      }),
    });
    const events = await readSseEvents(await POST(req));

    const thinkingEvents = events.filter((e) => e.type === "thinking");
    const thoughtEvents = events.filter((e) => e.type === "thought");

    assert.ok(
      thinkingEvents.length >= 3,
      `Delta thinking events must cover every thinking token, got ${thinkingEvents.length}`
    );
    assert.ok(thoughtEvents.length >= 1, "Round-boundary thought events must still be emitted");
    assert.ok(
      thoughtEvents.length <= 2,
      `At most one thought event per round (2 rounds), got ${thoughtEvents.length}`
    );
    const last = thoughtEvents[thoughtEvents.length - 1];
    assert.ok(
      String(last.thought).includes("Round 1 reasoning part A part B"),
      `Last thought must carry round 1 reasoning, got ${JSON.stringify(last.thought)}`
    );
    assert.ok(
      String(last.thought).includes("Round 2 reasoning"),
      `Last thought must carry round 2 reasoning, got ${JSON.stringify(last.thought)}`
    );
  });

  it("runSynthesisPass emits thinking deltas only and never a cumulative thought event", async () => {
    const events: Record<string, unknown>[] = [];
    let streamed = "";
    const turnAc = new AbortController();
    const result = await runSynthesisPass({
      llmBaseUrl: "http://127.0.0.1:11434",
      activeModel: "test-model",
      conversationMessages: [{ role: "user", content: "summarize" }],
      isArtifactRequest: false,
      turnAbortSignal: turnAc.signal,
      synthOptions: {},
      accumulatedThoughts: ["prior round thought"],
      getAccumulatedStreamedTokens: () => streamed,
      setAccumulatedStreamedTokens: (next) => {
        streamed = next;
      },
      onFinishReason: () => {},
      onPromptTokens: () => {},
      onOutputTokens: () => {},
      maybeWriteSnapshot: () => {},
      sendEvent: async (ev) => {
        events.push(ev);
      },
      streamChat: async function* () {
        yield { message: { thinking: "one " } };
        yield { message: { thinking: "two " } };
        yield { message: { thinking: "three" } };
        yield { message: { content: "Summary." }, finish_reason: "stop" };
      },
      deadlines: { inactivityMs: 5000, totalMs: 10000 },
      log: () => {},
    });
    assert.equal(result.thinking, "one two three");
    assert.equal(result.content, "Summary.");
    assert.equal(
      events.filter((e) => e.type === "thinking").length,
      3,
      "Every thinking token must produce exactly one thinking delta event"
    );
    assert.equal(
      events.filter((e) => e.type === "thought").length,
      0,
      "Synthesis pass must not re-send the cumulative thought per token"
    );
  });
});
