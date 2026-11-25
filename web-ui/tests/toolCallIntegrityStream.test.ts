import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../app/api/chat/route";
import { ThreadStore } from "../lib/threads/threadStore";
import { TURN_TOOL_MARKUP_MARKER } from "../lib/toolCallIntegrity";
import { runChatTurn, type RunChatTurnDeps, type RunChatTurnState } from "../lib/chat/roundLoop";
import { createSseEventWriter } from "../lib/chat/turnEngine";
import { ThrottledStreamSnapshot } from "../lib/streamSnapshot";
import { TelemetryTracer } from "../lib/telemetry";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { QueuedJob } from "../lib/jobQueue";

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

/**
 * Mock LLM server that replays a scripted sequence of assistant rounds.
 * Each round is one POST; the nth POST gets the nth scripted reply.
 */
function startScriptedLlmServer(
  replies: Array<{
    content: string;
    toolCalls?: Array<{ function: { name: string; arguments: unknown } }>;
  }>
): Promise<{
  server: http.Server;
  baseUrl: string;
  requestBodies: Array<Record<string, unknown>>;
}> {
  const requestBodies: Array<Record<string, unknown>> = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        } catch {}
        requestBodies.push(parsed);
        const index = requestBodies.length - 1;
        const reply = replies[Math.min(index, replies.length - 1)];
        const message: Record<string, unknown> = {
          role: "assistant",
          content: reply.content,
        };
        if (reply.toolCalls) message.tool_calls = reply.toolCalls;
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(`${JSON.stringify({ message, done: false })}\n`);
        res.write(
          `${JSON.stringify({
            message: { role: "assistant", content: "" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 40,
            eval_count: 8,
          })}\n`
        );
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}`, requestBodies });
    });
  });
}

describe("tool-call integrity: stubbed-stream round-loop behavior", () => {
  let tmpThreadsDir: string;
  let origThreadsDir: string | undefined;
  let origLlmBaseUrl: string | undefined;
  let origLlmProvider: string | undefined;
  let origMcpUrl: string | undefined;
  let origBrowserMcpUrl: string | undefined;
  let server: http.Server | null = null;

  beforeEach(() => {
    tmpThreadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "integrity-stream-"));
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

  async function runTurn(threadId: string, userContent: string) {
    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    const res = await POST(req);
    const events = await readSseEvents(res);
    const store = new ThreadStore(tmpThreadsDir);
    const thread = await store.getThread(threadId);
    return { events, thread };
  }

  it("markup-as-text round triggers exactly one repair re-prompt, then the honest marker on a second offense", async () => {
    const markup =
      '<tool_call><|im_start|>function_calls><invoke name="host_grep"><parameter=arguments>{"pattern":"roundLoop"}</parameter></invoke>';
    const mock = await startScriptedLlmServer([
      { content: `Let me search. ${markup}` },
      { content: markup },
      {
        content: "SHOULD NEVER BE REACHED — a second consecutive markup failure must end the turn.",
      },
    ]);
    server = mock.server;
    process.env.LLM_BASE_URL = mock.baseUrl;

    const { events, thread } = await runTurn(
      "thread-markup-repair",
      "Search the codebase for roundLoop."
    );

    // Exactly two LLM rounds: offense 1 -> repair re-prompt; offense 2 -> end turn.
    assert.equal(mock.requestBodies.length, 2, "must re-prompt once and end on the second offense");

    // The repair directive must be present in the second request's messages.
    const secondMessages = mock.requestBodies[1].messages as Array<{
      role: string;
      content?: string;
    }>;
    const repairSeen = secondMessages.some(
      (m) => typeof m.content === "string" && m.content.includes("[SYSTEM CORRECTION]")
    );
    assert.ok(repairSeen, "second round must carry the corrective repair directive");

    // The honest marker must be streamed and persisted; turn stamped incomplete.
    const streamedText = events
      .filter((e) => e.type === "token")
      .map((e) => String(e.content ?? ""))
      .join("");
    assert.ok(streamedText.includes(TURN_TOOL_MARKUP_MARKER), "marker must be streamed live");

    const assistant = thread?.messages.find((m) => m.role === "assistant");
    assert.ok(assistant, "assistant message must be persisted");
    assert.ok(
      assistant.content.includes(TURN_TOOL_MARKUP_MARKER),
      "marker must be in persisted content"
    );
    assert.equal(assistant.status, "incomplete", "markup-failed turn must be stamped incomplete");
  });

  it("a normal tool round is untouched by the markup fence", async () => {
    const mock = await startScriptedLlmServer([
      {
        content: "",
        toolCalls: [{ function: { name: "workspace_get_tree", arguments: {} } }],
      },
      { content: "Tree inspected. All good." },
    ]);
    server = mock.server;
    process.env.LLM_BASE_URL = mock.baseUrl;

    const { events, thread } = await runTurn("thread-normal-round", "Inspect the workspace tree.");

    assert.equal(
      mock.requestBodies.length,
      2,
      "tool round then final answer — no repair re-prompt"
    );
    const secondMessages = mock.requestBodies[1].messages as Array<{
      role: string;
      content?: string;
    }>;
    assert.ok(
      !secondMessages.some(
        (m) => typeof m.content === "string" && m.content.includes("[SYSTEM CORRECTION]")
      ),
      "normal tool round must never receive the repair directive"
    );
    const done = events.find((e) => e.type === "done");
    assert.ok(done, "turn must emit done event");
    const assistant = thread?.messages.find((m) => m.role === "assistant");
    assert.ok(assistant, "assistant message must be persisted");
    assert.ok(assistant.content.includes("All good."));
    assert.ok(!assistant.content.includes(TURN_TOOL_MARKUP_MARKER));
  });

  it("a turn claiming tool work with zero traces is stamped completed-unverified", async () => {
    const mock = await startScriptedLlmServer([
      {
        content: "I ran `npm run test:gate` and committed the fix. Everything is green.",
      },
    ]);
    server = mock.server;
    process.env.LLM_BASE_URL = mock.baseUrl;

    const { thread } = await runTurn("thread-zero-trace", "Summarize the fix you made.");

    const assistant = thread?.messages.find((m) => m.role === "assistant");
    assert.ok(assistant, "assistant message must be persisted");
    const stamped = assistant as typeof assistant & {
      completionStamp?: string;
      verificationGaps?: Array<{ kind: string }>;
    };
    assert.equal(
      stamped.completionStamp,
      "completed-unverified",
      "zero-trace claim must be stamped unverified"
    );
    assert.ok(
      stamped.verificationGaps?.some((g) => g.kind === "zero_traces"),
      "gap must be recorded"
    );
  });

  it("a turn with real traces is never stamped unverified", async () => {
    // Direct runChatTurn harness with a fake tool client so the tool round
    // records genuine traces (the route-level degraded path emits SSE trace
    // events but does not push into the persisted traces array).
    const fakeClient = {
      callTool: async () => ({
        content: [{ type: "text", text: JSON.stringify({ tree: "lib/ tests/" }) }],
      }),
      close: async () => {},
    } as unknown as Client;
    const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
      ["workspace_get_tree", { client: fakeClient, tier: "sandbox" }],
    ]);

    const threadStore = new ThreadStore(tmpThreadsDir);
    const threadId = `traces-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const thread = threadStore.createThread({ id: threadId, title: "traces test" });

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const reqAbort = new AbortController();
    const baseWriter = createSseEventWriter({
      stream,
      signal: reqAbort.signal,
      activeThreadId: thread.id,
    });
    baseWriter.startReadableDrain();

    const turnState: RunChatTurnState = {
      activeModel: "test-model",
      accumulatedStreamedTokens: "",
      assistantPersisted: false,
      lastFinishReason: undefined,
      turnOutputTokens: undefined,
      turnCreatedFiles: [],
      turnPreImages: new Map(),
      turnHostDiffs: [],
      traces: [],
      turnMicroElisions: [],
      turnReadDedups: [],
      accumulatedThoughts: [],
    };

    let llmRound = 0;
    const deps: RunChatTurnDeps = {
      reqSignal: reqAbort.signal,
      messages: [{ role: "user", content: "Inspect the workspace." }],
      userPrompt: "Inspect the workspace.",
      priorUserPrompt: "",
      assistantMessageId: "msg-traces",
      clientSessionId: "sess-traces",
      systemPrompt: "You are a test agent.",
      effortDirective: "",
      imagePayloads: [],
      docContexts: [],
      mode: "auto",
      requestedModel: "test-model",
      initialEffectiveReasoningEffort: "low",
      invalidRequestedModel: null,
      triageComplexityResult: null,
      getLlmBaseUrl: () => "http://127.0.0.1:59999",
      resolveJobRepoRoot: () => tmpThreadsDir,
      streamLlmChat: async function* () {
        llmRound++;
        if (llmRound === 1) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_tree_1",
                  type: "function",
                  function: { name: "workspace_get_tree", arguments: "{}" },
                },
              ],
            },
            finish_reason: "stop",
          };
        } else {
          yield {
            message: {
              content: "I ran the tree inspection and confirmed the layout.",
            },
            finish_reason: "stop",
          };
        }
      },
      advertisedTools: new Set(toolClientMap.keys()),
      activeThreadId: thread.id,
      threadsDir: tmpThreadsDir,
      threadStore,
      initialThreadData: thread,
      initialThreadHostAccess: false,
      streamSnapshot: new ThrottledStreamSnapshot(threadStore, thread.id, "msg-traces"),
      sseWriter: baseWriter,
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
    };

    const fakeJob: QueuedJob = {
      id: "job-traces",
      threadId: thread.id,
      prompt: "Inspect the workspace.",
      position: 0,
      status: "running",
    };

    await runChatTurn(deps, fakeJob, null);

    assert.ok(
      turnState.traces.length > 0,
      "real traces must be recorded by the executed tool round"
    );
    const assistant = (await threadStore.getThread(thread.id))?.messages.find(
      (m) => m.role === "assistant"
    );
    assert.ok(assistant, "assistant message must be persisted");
    assert.ok(assistant.traces && assistant.traces.length > 0, "traces must be persisted");
    assert.notEqual(
      (assistant as typeof assistant & { completionStamp?: string }).completionStamp,
      "completed-unverified",
      "traced turn must never be unverified"
    );
  });
});
