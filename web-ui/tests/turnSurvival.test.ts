import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { createSseEventWriter, createRoundDeadline } from "../lib/chat/turnEngine";
import { runChatTurn, type RunChatTurnDeps, type RunChatTurnState } from "../lib/chat/roundLoop";
import { LlamaCppProvider } from "../lib/llm/provider";
import { executeHostTool } from "../lib/hostMode";
import { getBridgeManifest, PROTOCOL_VERSION } from "../../host-bridge/manifest";
import {
  ThreadStore,
  activeExecutionSet,
  getActiveTurn,
  abortActiveTurn,
} from "../lib/threads/threadStore";
import { computeTurnLiveness, TURN_STALL_WINDOW_MS } from "../lib/threads/liveness";
import { detectStalledTurn } from "../lib/threads/inAppSupervisor";
import { ThrottledStreamSnapshot } from "../lib/streamSnapshot";
import { TelemetryTracer } from "../lib/telemetry";
import { MAX_STREAMED_CONTENT_CHARS, TURN_SIZE_LIMIT_MARKER } from "../lib/contextBudget";
import { getSharedSlotScheduler, SlotPriority } from "../lib/slotScheduler";
import { createProductionIssueAndWait } from "../lib/board/productionDrain";
import { readStreamTail } from "../lib/board/streamTail";
import { POST as chatPost } from "../app/api/chat/route";
import type { QueuedJob } from "../lib/jobQueue";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function makeDirectTurnDeps(overrides: {
  tmpDir: string;
  userPrompt?: string;
  toolClientMap: RunChatTurnDeps["toolClientMap"];
  streamLlmChat: RunChatTurnDeps["streamLlmChat"];
  hostAccess?: boolean;
  isProhibitedTask?: boolean;
  heartbeatIntervalMs?: number;
  onEvent?: (evt: Record<string, unknown>) => void;
}) {
  const threadStore = new ThreadStore(overrides.tmpDir);
  const threadId = `survival-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const thread = threadStore.createThread({
    id: threadId,
    title: "turn survival test",
    hostAccess: Boolean(overrides.hostAccess),
    ...(overrides.isProhibitedTask ? { taskId: "task-prohibited" } : {}),
  });
  const assistantMessageId = `msg-${threadId}`;
  threadStore.addMessage(threadId, {
    id: assistantMessageId,
    role: "assistant",
    content: "",
    status: "streaming",
    timestamp: new Date().toISOString(),
  });

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const reqAbort = new AbortController();
  const baseWriter = createSseEventWriter({
    stream,
    signal: reqAbort.signal,
    activeThreadId: thread.id,
    heartbeatIntervalMs: 60_000,
    log: () => {},
  });
  baseWriter.startReadableDrain();

  const events: Array<Record<string, unknown>> = [];
  const sseWriter = {
    ...baseWriter,
    sendEvent: async (data: Record<string, unknown>) => {
      events.push(data);
      overrides.onEvent?.(data);
      await baseWriter.sendEvent(data);
    },
  };

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

  const turnAbortController = new AbortController();
  const streamSnapshot = new ThrottledStreamSnapshot(threadStore, thread.id, assistantMessageId);
  const tracer = new TelemetryTracer();
  const prompt = overrides.userPrompt ?? "Inspect repository files.";

  const deps: RunChatTurnDeps = {
    reqSignal: reqAbort.signal,
    messages: [{ role: "user", content: prompt }],
    userPrompt: prompt,
    priorUserPrompt: "",
    assistantMessageId,
    clientSessionId: "sess-survival",
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
    resolveJobRepoRoot: () => overrides.tmpDir,
    streamLlmChat: overrides.streamLlmChat,
    advertisedTools: new Set(["search_web", "fetch_webpage_markdown", "workspace_write_file"]),
    activeThreadId: thread.id,
    threadsDir: overrides.tmpDir,
    threadStore,
    initialThreadData: thread,
    initialThreadHostAccess: Boolean(overrides.hostAccess),
    streamSnapshot,
    sseWriter,
    turnAbortController,
    persistAssistantOnAbort: () => {},
    onRunTurnStarted: () => {},
    onRunTurnFinally: () => {},
    isExplicitStopped: () => false,
    turnState,
    activeSessions: [],
    toolClientMap: overrides.toolClientMap,
    tracer,
    rootSpan: null,
    ...(overrides.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: overrides.heartbeatIntervalMs }
      : {}),
  };

  const fakeJob: QueuedJob = {
    id: `job-${threadId}`,
    threadId: thread.id,
    prompt,
    position: 0,
    status: "running",
  };

  return { deps, turnState, events, fakeJob, threadStore, threadId: thread.id, assistantMessageId };
}

describe("Batch B — Turn Survival (F5, F4, F9, F13)", () => {
  describe("Fix B1 (F5) — Slow in-process stream consumer must not kill a live turn", () => {
    it("in-process sseWriter timeout drops write side without aborting stream.readable", async () => {
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const ac = new AbortController();
      const sse = createSseEventWriter({
        stream,
        signal: ac.signal,
        activeThreadId: "thread-inproc-slow",
        writerTimeoutMs: 40,
        heartbeatIntervalMs: 60_000,
        inProcessConsumer: true,
        log: () => {},
      });

      // Consumer locks readable (as readResponseStreamTail does) but stalls past writerTimeoutMs.
      const reader = stream.readable.getReader();

      // Write hits backpressure and times out at 40ms; must NOT abort readable.
      await sse.sendEvent({ type: "status", status: "working" });
      await sse.sendEvent({ type: "token", content: "dropped while consumer stalled" });

      // Turn finishes and closes writer while reader is still stalled.
      sse.stopHeartbeat();
      await sse.closeWriterWithTimeout(40);

      // Slow consumer wakes up later and drains the stream — must see clean EOF, never throw.
      await sleep(30);
      let chunks = 0;
      while (true) {
        const { done } = await reader.read();
        if (done) break;
        chunks++;
      }
      assert.ok(chunks >= 1, "buffered chunk before drop should still drain cleanly");
      ac.signal.removeEventListener("abort", sse.cleanupClientSignal);
    });

    it("browser HTTP sseWriter preserves abort-on-writer-timeout behavior", async () => {
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const ac = new AbortController();
      const sse = createSseEventWriter({
        stream,
        signal: ac.signal,
        activeThreadId: "thread-http-slow",
        writerTimeoutMs: 40,
        heartbeatIntervalMs: 60_000,
        log: () => {},
      });

      const reader = stream.readable.getReader();
      await sse.sendEvent({ type: "status", status: "working" });

      await assert.rejects(
        async () => {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        },
        /writer timeout/i,
        "HTTP browser SSE path must preserve writer-timeout abort behavior"
      );
      sse.stopHeartbeat();
      ac.signal.removeEventListener("abort", sse.cleanupClientSignal);
    });

    it("Acceptance 1(a): drain-consumed turn whose writer stalls >2s settles by its own outcome", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b1-drain-stall-"));
      const origThreadsDir = process.env.THREADS_DIR;
      const origLlmBaseUrl = process.env.LLM_BASE_URL;
      const origLlmEngine = process.env.LLM_ENGINE;
      const origMcpUrl = process.env.MCP_SERVER_URL;
      const origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
      process.env.THREADS_DIR = tmpDir;
      process.env.LLM_ENGINE = "ollama";
      process.env.MCP_SERVER_URL = "http://127.0.0.1:59991/mcp/sse";
      process.env.BROWSER_MCP_URL = "http://127.0.0.1:59992/browser/sse";

      const mock = await startMockLlmServer((_req, _body, res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        // Stream across 2.5s so an un-read stream stalls past the 2s writer timeout.
        res.write(
          `${JSON.stringify({ message: { role: "assistant", content: "Working on task... " }, done: false })}\n`
        );
        setTimeout(() => {
          res.write(
            `${JSON.stringify({
              message: { role: "assistant", content: "Opened PR #901 successfully." },
              done: true,
              done_reason: "stop",
            })}\n`
          );
          res.end();
        }, 2400);
      });
      process.env.LLM_BASE_URL = mock.baseUrl;

      try {
        const threadStore = new ThreadStore(tmpDir);
        const issueAndWait = createProductionIssueAndWait({
          threadStore,
          hostCheckoutPath: tmpDir,
          executeHostTool: async () => ({ ok: true, exitCode: 0, stdout: "develop\n" }),
          dispatchChatTurn: async ({ threadId, brief }) => {
            const chatReq = new NextRequest("http://localhost/api/chat", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-internal-consumer": "in-process",
                "x-dispatch-source": "board-drain",
              },
              body: JSON.stringify({
                threadId,
                messages: [{ role: "user", content: brief }],
              }),
            });
            const response = await chatPost(chatReq);
            // Simulate a slow in-process consumer stalling >2s before reading the stream.
            await sleep(2200);
            const { tail: rawStream, totalBytes: streamTotalBytes } = await readStreamTail(
              response.body
            );
            return { ok: response.ok, status: response.status, rawStream, streamTotalBytes };
          },
        });

        const outcome = await issueAndWait({
          item: {
            id: "item-b1-slow",
            key: "#901",
            title: "Slow consumer survival test",
            brief: "Complete the job and report PR #901.",
            status: "queued",
            dependencies: [],
            author: "Owner",
            source: "manual",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          brief: "Complete the job and report PR #901.",
        });

        assert.equal(
          outcome.status,
          "completed",
          `Slow in-process consumer must not fail a live turn, got: ${JSON.stringify(outcome)}`
        );
        if (outcome.status === "completed") {
          assert.equal(outcome.prNumber, 901);
        }
      } finally {
        mock.server.closeAllConnections?.();
        await new Promise<void>((r) => mock.server.close(() => r()));
        if (origThreadsDir === undefined) delete process.env.THREADS_DIR;
        else process.env.THREADS_DIR = origThreadsDir;
        if (origLlmBaseUrl === undefined) delete process.env.LLM_BASE_URL;
        else process.env.LLM_BASE_URL = origLlmBaseUrl;
        if (origLlmEngine === undefined) delete process.env.LLM_ENGINE;
        else process.env.LLM_ENGINE = origLlmEngine;
        if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
        else process.env.MCP_SERVER_URL = origMcpUrl;
        if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
        else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("Fix B2 (F4) — Heartbeats cover every long span", () => {
    it("LlamaCppProvider.streamChat emits progress during delta.tool_calls so inactivity deadline stays alive", async () => {
      const origFetch = globalThis.fetch;
      const encoder = new TextEncoder();

      // Stream a tool call across 5 chunks spaced 45ms apart (225ms total) with a 90ms inactivity deadline.
      // Without progress yields, the 90ms inactivity deadline aborts at ~90ms before EOF.
      const sseFrames = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_big","type":"function","function":{"name":"host_write_file","arguments":"{\\"path\\":\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"a.ts\\",\\"content\\":\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"export const x = 1;"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\nexport const y = 2;"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ];

      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const frame of sseFrames) {
              if (init?.signal?.aborted) {
                controller.error(new DOMException("Aborted", "AbortError"));
                return;
              }
              controller.enqueue(encoder.encode(frame));
              await sleep(45);
            }
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as typeof globalThis.fetch;

      try {
        const provider = new LlamaCppProvider();
        const ac = new AbortController();
        const deadline = createRoundDeadline(ac, { inactivityMs: 110, totalMs: 5000 });
        let progressYieldsBeforeDone = 0;
        let finalToolCalls: unknown[] = [];

        try {
          for await (const chunk of provider.streamChat("http://127.0.0.1:8080", {
            messages: [{ role: "user", content: "Write file" }],
            signal: ac.signal,
          })) {
            deadline.arm();
            if (!chunk.done && chunk.toolCallProgress) {
              progressYieldsBeforeDone++;
            }
            if (chunk.message?.tool_calls) {
              finalToolCalls = chunk.message.tool_calls;
            }
          }
        } finally {
          deadline.clear();
        }

        assert.equal(
          deadline.getTimedOut(),
          null,
          "inactivity deadline must NOT fire during active delta.tool_calls streaming"
        );
        assert.ok(
          progressYieldsBeforeDone >= 3,
          `expected progress chunks before EOF, got ${progressYieldsBeforeDone}`
        );
        assert.equal(finalToolCalls.length, 1);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("Acceptance 1(b): a turn executing a 605s-class host command heartbeats continuously and is never stall-stamped mid-command", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-host-heartbeat-"));
      const origThreadsDir = process.env.THREADS_DIR;
      const origHostUrl = process.env.HOST_RUNNER_URL;
      const origMcpUrl = process.env.MCP_SERVER_URL;
      const origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
      process.env.THREADS_DIR = tmpDir;
      process.env.MCP_SERVER_URL = "http://127.0.0.1:59991/mcp/sse";
      process.env.BROWSER_MCP_URL = "http://127.0.0.1:59992/browser/sse";

      // Mock host-bridge server that holds a host_run_powershell request for 900ms
      // (simulating a long 605s-class command under a scaled 450ms stall window).
      const manifest = getBridgeManifest();
      let commandInFlight = false;
      let commandHoldMs = 300;
      const hostServer = http.createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              protocolVersion: PROTOCOL_VERSION,
              bridgeSourceSha256: manifest.bridgeSourceSha256,
            })
          );
          return;
        }
        if (req.url === "/execute") {
          commandInFlight = true;
          setTimeout(() => {
            commandInFlight = false;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, exitCode: 0, stdout: "command finished" }));
          }, commandHoldMs);
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((r) => hostServer.listen(0, "127.0.0.1", () => r()));
      const hostPort = (hostServer.address() as { port: number }).port;
      process.env.HOST_RUNNER_URL = `http://127.0.0.1:${hostPort}`;

      try {
        // 1. Direct executeHostTool heartbeat verification (keeps 605s ceiling intact)
        const hostHeartbeats: number[] = [];
        const res = await executeHostTool(
          "host_run_powershell",
          { command: "npm run test:gate", timeoutSeconds: 600 },
          undefined,
          undefined,
          undefined,
          {
            heartbeatIntervalMs: 50,
            onHeartbeat: (elapsedMs: number) => hostHeartbeats.push(elapsedMs),
          }
        );
        assert.equal(res.ok, true);
        assert.ok(
          hostHeartbeats.length >= 3,
          `expected >=3 host command heartbeats during long command, got ${hostHeartbeats.length}`
        );

        // 2. Full runChatTurn execution: scaled stall window = 450ms, command takes 950ms,
        //    in-turn heartbeat = 50ms (9x margin inside window, 2x+ longer than window).
        commandHoldMs = 950;
        let llmRound = 0;
        const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
          ["host_run_powershell", { client: null, tier: "host" }],
        ]);
        const { deps, fakeJob, threadStore, threadId } = makeDirectTurnDeps({
          tmpDir,
          userPrompt: "Run the full test gate.",
          toolClientMap,
          hostAccess: true,
          heartbeatIntervalMs: 50,
          streamLlmChat: async function* () {
            llmRound++;
            if (llmRound === 1) {
              yield {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_ps_1",
                      type: "function",
                      function: {
                        name: "host_run_powershell",
                        arguments: JSON.stringify({
                          command: "npm run test:gate",
                          timeoutSeconds: 600,
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "stop",
              };
            } else {
              yield {
                message: { content: "All tests passed." },
                finish_reason: "stop",
              };
            }
          },
        });

        activeExecutionSet.add(threadId);
        const turnPromise = runChatTurn(deps, fakeJob, null);

        // Wait until the host command is actually in flight, then sample repeatedly across
        // its 950ms duration (> 450ms scaled stall window) and verify it is NEVER stalled.
        const waitStart = Date.now();
        while (!commandInFlight && Date.now() - waitStart < 5000) {
          await sleep(20);
        }
        assert.equal(commandInFlight, true, "host command must enter in-flight state");

        const seenUpdatedAts = new Set<string>();
        const scaledStallWindowMs = 450;
        let sawStalled = false;
        while (commandInFlight) {
          await sleep(80);
          const rawFile = threadStore.getFilePath(threadId);
          if (fs.existsSync(rawFile)) {
            const diskThread = JSON.parse(fs.readFileSync(rawFile, "utf8"));
            if (diskThread.status === "active") {
              seenUpdatedAts.add(diskThread.updatedAt);
              const det = detectStalledTurn(diskThread, Date.now(), scaledStallWindowMs);
              if (det.stalled) sawStalled = true;
            }
          }
        }

        await turnPromise;
        assert.equal(
          sawStalled,
          false,
          "turn running a long host command must NEVER be stall-stamped mid-command"
        );
        assert.ok(
          seenUpdatedAts.size >= 2,
          `expected updatedAt to advance via heartbeats mid-command, saw ${seenUpdatedAts.size} distinct timestamps`
        );
      } finally {
        hostServer.closeAllConnections?.();
        await new Promise<void>((r) => hostServer.close(() => r()));
        if (origThreadsDir === undefined) delete process.env.THREADS_DIR;
        else process.env.THREADS_DIR = origThreadsDir;
        if (origHostUrl === undefined) delete process.env.HOST_RUNNER_URL;
        else process.env.HOST_RUNNER_URL = origHostUrl;
        if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
        else process.env.MCP_SERVER_URL = origMcpUrl;
        if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
        else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("queued/pre-round-0 time does not age against the stall window", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-queued-stall-"));
      try {
        const store = new ThreadStore(tmpDir);
        const queuedThread = store.createThread({
          id: "thread-queued-wait",
          title: "Queued thread waiting behind marathon job",
        });
        store.addMessage(queuedThread.id, {
          id: "msg-q",
          role: "assistant",
          content: "",
          status: "streaming",
          timestamp: new Date().toISOString(),
        });

        // Simulate thread queued for execution 20 minutes ago (2x TURN_STALL_WINDOW_MS)
        const filePath = store.getFilePath(queuedThread.id);
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
        raw.queuedForExecution = true;
        raw.updatedAt = new Date(Date.now() - TURN_STALL_WINDOW_MS * 2).toISOString();
        fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));

        // 1. detectStalledTurn must NOT flag a queued thread
        const det = detectStalledTurn(raw, Date.now());
        assert.equal(det.stalled, false, "queued thread must not age against the stall window");

        // 2. computeTurnLiveness must report alive, not stalled
        assert.equal(
          computeTurnLiveness(raw, Date.now(), true),
          "alive",
          "queued thread must report alive while awaiting slot"
        );

        // 3. sweepStalledThreads must NOT stamp the queued thread stopped
        activeExecutionSet.add(queuedThread.id);
        try {
          const acted = await store.sweepStalledThreads(Date.now());
          assert.equal(acted, 0, "sweepStalledThreads must skip queued pre-execution threads");
          const after = JSON.parse(fs.readFileSync(filePath, "utf8"));
          assert.equal(after.status, "active", "queued thread must remain active");
        } finally {
          activeExecutionSet.delete(queuedThread.id);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("Fix B3 (F9) — No silent early exits", () => {
    it("Acceptance 1(c): a coding brief whose first round is a single web search continues to a second round", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b3-coding-websearch-"));
      const origMcpUrl = process.env.MCP_SERVER_URL;
      const origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
      process.env.MCP_SERVER_URL = "http://127.0.0.1:59991/mcp/sse";
      process.env.BROWSER_MCP_URL = "http://127.0.0.1:59992/browser/sse";

      try {
        const fakeBrowserClient = {
          callTool: async () => ({
            content: [{ type: "text", text: "MDN docs: AbortSignal.any() combines signals." }],
          }),
          close: async () => {},
        } as unknown as Client;
        const fakeSandboxClient = {
          callTool: async () => ({
            content: [{ type: "text", text: JSON.stringify({ status: "SUCCESS" }) }],
          }),
          close: async () => {},
        } as unknown as Client;

        const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
          ["search_web", { client: fakeBrowserClient, tier: "browser" }],
          ["workspace_write_file", { client: fakeSandboxClient, tier: "sandbox" }],
        ]);

        let llmRound = 0;
        const { deps, turnState, fakeJob, threadStore, threadId, assistantMessageId } =
          makeDirectTurnDeps({
            tmpDir,
            // Coding brief that triggers hasArtifactCreationIntent ("build ... module ... file")
            userPrompt: "Build a new TypeScript helper module file for retry backoff with tests.",
            toolClientMap,
            streamLlmChat: async function* () {
              llmRound++;
              if (llmRound === 1) {
                // Round 1: lone web search to check API docs
                yield {
                  message: {
                    content: "Checking AbortSignal docs first.",
                    tool_calls: [
                      {
                        id: "call_search_1",
                        type: "function",
                        function: {
                          name: "search_web",
                          arguments: JSON.stringify({ query: "MDN AbortSignal.any Node 20" }),
                        },
                      },
                    ],
                  },
                  finish_reason: "stop",
                };
              } else if (llmRound === 2) {
                // Round 2: actually write the requested module file
                yield {
                  message: {
                    content: "Writing the helper module.",
                    tool_calls: [
                      {
                        id: "call_write_1",
                        type: "function",
                        function: {
                          name: "workspace_write_file",
                          arguments: JSON.stringify({
                            path: "src/retry.ts",
                            content: "export const retry = () => true;\n",
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: "stop",
                };
              } else {
                yield {
                  message: { content: "Implemented src/retry.ts and verified." },
                  finish_reason: "stop",
                };
              }
            },
          });

        await runChatTurn(deps, fakeJob, null);

        assert.ok(
          llmRound >= 2,
          `coding brief must continue to round 2 after lone web search (only ran ${llmRound} round(s))`
        );
        assert.ok(
          turnState.traces.some((t) => t.tool === "workspace_write_file"),
          "round 2 workspace_write_file must execute after round 1 web search"
        );
        const settled = await threadStore.getThread(threadId);
        const asst = settled?.messages.find((m) => m.id === assistantMessageId);
        assert.equal(asst?.status, "completed");
      } finally {
        if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
        else process.env.MCP_SERVER_URL = origMcpUrl;
        if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
        else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("per-round narration cap does not starve multi-round turns whose cumulative narration exceeds 64K", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b3-per-round-cap-"));
      const origMcpUrl = process.env.MCP_SERVER_URL;
      const origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
      process.env.MCP_SERVER_URL = "http://127.0.0.1:59991/mcp/sse";
      process.env.BROWSER_MCP_URL = "http://127.0.0.1:59992/browser/sse";

      try {
        const fakeSandboxClient = {
          callTool: async () => ({
            content: [{ type: "text", text: "ok" }],
          }),
          close: async () => {},
        } as unknown as Client;

        const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
          ["workspace_get_tree", { client: fakeSandboxClient, tier: "sandbox" }],
        ]);

        // 3 rounds x 30,000 chars = 90,000 cumulative (> 64,000), but each round is 30,000 (< 64,000)
        const perRoundText = "a".repeat(30_000);
        let llmRound = 0;

        const { deps, fakeJob, threadStore, threadId, assistantMessageId } = makeDirectTurnDeps({
          tmpDir,
          userPrompt: "Inspect the codebase across multiple steps.",
          toolClientMap,
          streamLlmChat: async function* () {
            llmRound++;
            if (llmRound <= 2) {
              yield {
                message: {
                  content: perRoundText,
                  tool_calls: [
                    {
                      id: `call_tree_${llmRound}`,
                      type: "function",
                      function: { name: "workspace_get_tree", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "stop",
              };
            } else {
              yield {
                message: { content: `${perRoundText}\nFinal conclusion.` },
                finish_reason: "stop",
              };
            }
          },
        });

        await runChatTurn(deps, fakeJob, null);

        assert.equal(llmRound, 3, "all 3 rounds must execute without hitting cumulative cap");
        const settled = await threadStore.getThread(threadId);
        const asst = settled?.messages.find((m) => m.id === assistantMessageId);
        assert.equal(
          asst?.status,
          "completed",
          `multi-round turn must complete cleanly, got status=${asst?.status}`
        );
        assert.ok(
          !asst?.content.includes(TURN_SIZE_LIMIT_MARKER),
          "healthy multi-round turn must not be stamped with TURN_SIZE_LIMIT_MARKER"
        );
        assert.ok(asst?.content.includes("Final conclusion."));
      } finally {
        if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
        else process.env.MCP_SERVER_URL = origMcpUrl;
        if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
        else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("single runaway round exceeding MAX_STREAMED_CONTENT_CHARS still trips per-round cap", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b3-runaway-round-cap-"));
      const origMcpUrl = process.env.MCP_SERVER_URL;
      const origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
      process.env.MCP_SERVER_URL = "http://127.0.0.1:59991/mcp/sse";
      process.env.BROWSER_MCP_URL = "http://127.0.0.1:59992/browser/sse";

      try {
        const halfPlus = "b".repeat(Math.ceil(MAX_STREAMED_CONTENT_CHARS / 2) + 5000);
        const { deps, fakeJob, threadStore, threadId, assistantMessageId } = makeDirectTurnDeps({
          tmpDir,
          userPrompt: "Say hello.",
          toolClientMap: new Map(),
          streamLlmChat: async function* () {
            yield { message: { content: halfPlus } };
            yield { message: { content: halfPlus }, finish_reason: "stop" };
          },
        });

        await runChatTurn(deps, fakeJob, null);

        const settled = await threadStore.getThread(threadId);
        const asst = settled?.messages.find((m) => m.id === assistantMessageId);
        assert.equal(asst?.status, "incomplete");
        assert.ok(asst?.content.includes(TURN_SIZE_LIMIT_MARKER));
      } finally {
        if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
        else process.env.MCP_SERVER_URL = origMcpUrl;
        if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
        else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("transient host-probe failure surfaces as a tool-level error instead of killing the turn with unregistered-tool throw", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b3-host-probe-fail-"));
      const origHostUrl = process.env.HOST_RUNNER_URL;
      const origMcpUrl = process.env.MCP_SERVER_URL;
      const origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
      // Unreachable host runner simulates a transient host-probe failure at turn start.
      process.env.HOST_RUNNER_URL = "http://127.0.0.1:59995";
      process.env.MCP_SERVER_URL = "http://127.0.0.1:59991/mcp/sse";
      process.env.BROWSER_MCP_URL = "http://127.0.0.1:59992/browser/sse";

      try {
        let llmRound = 0;
        let round2ToolErrorMsg = "";
        const { deps, fakeJob, threadStore, threadId, assistantMessageId } = makeDirectTurnDeps({
          tmpDir,
          userPrompt: "Check git status on host.",
          toolClientMap: new Map(),
          hostAccess: true,
          streamLlmChat: async function* (_url, payload) {
            llmRound++;
            if (llmRound === 1) {
              yield {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_host_1",
                      type: "function",
                      function: {
                        name: "host_run_powershell",
                        arguments: JSON.stringify({ command: "git status" }),
                      },
                    },
                  ],
                },
                finish_reason: "stop",
              };
            } else {
              const toolMsgs = (
                payload.messages as Array<{ role?: string; name?: string; content?: string }>
              ).filter((m) => m.role === "tool" && m.name === "host_run_powershell");
              round2ToolErrorMsg = String(toolMsgs[0]?.content || "");
              yield {
                message: {
                  content: "Host runner was temporarily unavailable; reporting honestly.",
                },
                finish_reason: "stop",
              };
            }
          },
        });

        await runChatTurn(deps, fakeJob, null);

        assert.equal(llmRound, 2, "model must receive a round 2 to react to the tool-level error");
        assert.ok(
          round2ToolErrorMsg.length > 0 && /unavailable|offline|host/i.test(round2ToolErrorMsg),
          `expected structured host-unavailable tool error, got: ${round2ToolErrorMsg}`
        );
        const settled = await threadStore.getThread(threadId);
        const asst = settled?.messages.find((m) => m.id === assistantMessageId);
        assert.equal(
          asst?.status,
          "completed",
          `turn must not die with status=error on transient host-probe failure, got ${asst?.status}: ${asst?.content}`
        );
      } finally {
        if (origHostUrl === undefined) delete process.env.HOST_RUNNER_URL;
        else process.env.HOST_RUNNER_URL = origHostUrl;
        if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
        else process.env.MCP_SERVER_URL = origMcpUrl;
        if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
        else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("Fix B4 (F13) — Board job priority separation & pre-start abort cleanup", () => {
    it("Acceptance 1(d): board-dispatched turn acquires job priority (P1) while interactive turn keeps owner priority (P0)", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b4-priority-"));
      const origThreadsDir = process.env.THREADS_DIR;
      const origLlmBaseUrl = process.env.LLM_BASE_URL;
      const origLlmEngine = process.env.LLM_ENGINE;
      const origMcpUrl = process.env.MCP_SERVER_URL;
      const origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
      process.env.THREADS_DIR = tmpDir;
      process.env.LLM_ENGINE = "ollama";
      process.env.MCP_SERVER_URL = "http://127.0.0.1:59991/mcp/sse";
      process.env.BROWSER_MCP_URL = "http://127.0.0.1:59992/browser/sse";

      const observedPriorities: Array<{ label: string; priority: SlotPriority | undefined }> = [];
      const mock = await startMockLlmServer((_req, _body, res) => {
        const snap = getSharedSlotScheduler().getSnapshot();
        observedPriorities.push({
          label: snap.active?.label || "",
          priority: snap.active?.priority,
        });
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(
          `${JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true })}\n`
        );
        res.end();
      });
      process.env.LLM_BASE_URL = mock.baseUrl;

      try {
        // 1. Real defaultDispatchChatTurn via createProductionIssueAndWait -> must acquire P1_BUILDER
        const threadStore = new ThreadStore(tmpDir);
        const issueAndWait = createProductionIssueAndWait({
          threadStore,
          hostCheckoutPath: tmpDir,
          executeHostTool: async () => ({ ok: true, exitCode: 0, stdout: "develop\n" }),
        });
        const drainOutcome = await issueAndWait({
          item: {
            id: "item-b4-priority",
            key: "#904",
            title: "Board priority test",
            brief: "Run board job",
            status: "queued",
            dependencies: [],
            author: "Owner",
            source: "manual",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          brief: "Run board job",
        });
        assert.equal(drainOutcome.status, "completed");
        const boardThreadId = drainOutcome.status === "completed" ? drainOutcome.threadId : "";

        // 2. Interactive owner turn -> must acquire SlotPriority.P0_OWNER
        const ownerReq = new NextRequest("http://localhost/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            threadId: "thread-b4-owner",
            messages: [{ role: "user", content: "Interactive owner prompt" }],
          }),
        });
        const ownerRes = await chatPost(ownerReq);
        await readStreamTail(ownerRes.body);

        const boardObs = observedPriorities.find((o) => o.label.includes(boardThreadId));
        const ownerObs = observedPriorities.find((o) => o.label.includes("thread-b4-owner"));
        assert.ok(boardObs, "board turn must acquire a scheduler slot");
        assert.ok(ownerObs, "owner turn must acquire a scheduler slot");
        assert.equal(
          boardObs!.priority,
          SlotPriority.P1_BUILDER,
          `board-dispatched turn must acquire P1_BUILDER (${SlotPriority.P1_BUILDER}), got ${boardObs!.priority}`
        );
        assert.equal(
          ownerObs!.priority,
          SlotPriority.P0_OWNER,
          `interactive turn must keep P0_OWNER (${SlotPriority.P0_OWNER}), got ${ownerObs!.priority}`
        );
      } finally {
        mock.server.closeAllConnections?.();
        await new Promise<void>((r) => mock.server.close(() => r()));
        if (origThreadsDir === undefined) delete process.env.THREADS_DIR;
        else process.env.THREADS_DIR = origThreadsDir;
        if (origLlmBaseUrl === undefined) delete process.env.LLM_BASE_URL;
        else process.env.LLM_BASE_URL = origLlmBaseUrl;
        if (origLlmEngine === undefined) delete process.env.LLM_ENGINE;
        else process.env.LLM_ENGINE = origLlmEngine;
        if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
        else process.env.MCP_SERVER_URL = origMcpUrl;
        if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
        else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("Acceptance 1(d): pre-start abort leaves activeExecutionSet and activeTurnRegistry empty", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b4-prestart-abort-"));
      const origThreadsDir = process.env.THREADS_DIR;
      const origLlmBaseUrl = process.env.LLM_BASE_URL;
      const origLlmEngine = process.env.LLM_ENGINE;
      const origMcpUrl = process.env.MCP_SERVER_URL;
      const origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
      process.env.THREADS_DIR = tmpDir;
      process.env.LLM_ENGINE = "ollama";
      process.env.MCP_SERVER_URL = "http://127.0.0.1:59991/mcp/sse";
      process.env.BROWSER_MCP_URL = "http://127.0.0.1:59992/browser/sse";

      let releaseHolder!: () => void;
      const holderGate = new Promise<void>((r) => {
        releaseHolder = r;
      });
      let holderReachedLlm!: () => void;
      const holderStarted = new Promise<void>((r) => {
        holderReachedLlm = r;
      });

      const mock = await startMockLlmServer((_req, _body, res) => {
        holderReachedLlm();
        holderGate.then(() => {
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
          res.write(
            `${JSON.stringify({ message: { role: "assistant", content: "holder done" }, done: true })}\n`
          );
          res.end();
        });
      });
      process.env.LLM_BASE_URL = mock.baseUrl;

      const holderThreadId = `thread-b4-holder-${Date.now()}`;
      const queuedThreadId = `thread-b4-aborted-${Date.now()}`;

      try {
        // 1. Start holder turn so the queue/slot is occupied
        const res1 = await chatPost(
          new NextRequest("http://localhost/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              threadId: holderThreadId,
              messages: [{ role: "user", content: "Hold slot" }],
            }),
          })
        );
        const drain1 = readStreamTail(res1.body);
        await holderStarted;

        // 2. Submit second turn which queues behind holder
        const res2 = await chatPost(
          new NextRequest("http://localhost/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              threadId: queuedThreadId,
              messages: [{ role: "user", content: "Aborted before start" }],
            }),
          })
        );
        const drain2 = readStreamTail(res2.body);

        // 3. Abort the queued turn BEFORE holder releases the queue/slot
        assert.equal(
          abortActiveTurn(queuedThreadId),
          true,
          "abortActiveTurn must find queued turn"
        );

        // 4. Release holder and wait for both streams to settle
        releaseHolder();
        await Promise.all([drain1, drain2]);
        // Allow microtasks / onSettled callbacks to flush
        await sleep(50);

        assert.equal(
          activeExecutionSet.has(queuedThreadId),
          false,
          "activeExecutionSet must NOT retain pre-start aborted thread"
        );
        assert.equal(
          getActiveTurn(queuedThreadId),
          null,
          "activeTurnRegistry must NOT retain pre-start aborted thread"
        );
        assert.equal(
          activeExecutionSet.has(holderThreadId),
          false,
          "holder thread must also be cleared"
        );
        assert.equal(getActiveTurn(holderThreadId), null, "holder presence must also be cleared");
      } finally {
        releaseHolder?.();
        activeExecutionSet.delete(holderThreadId);
        activeExecutionSet.delete(queuedThreadId);
        await new Promise<void>((r) => mock.server.close(() => r()));
        if (origThreadsDir === undefined) delete process.env.THREADS_DIR;
        else process.env.THREADS_DIR = origThreadsDir;
        if (origLlmBaseUrl === undefined) delete process.env.LLM_BASE_URL;
        else process.env.LLM_BASE_URL = origLlmBaseUrl;
        if (origLlmEngine === undefined) delete process.env.LLM_ENGINE;
        else process.env.LLM_ENGINE = origLlmEngine;
        if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
        else process.env.MCP_SERVER_URL = origMcpUrl;
        if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
        else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
