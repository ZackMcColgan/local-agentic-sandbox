import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../app/api/chat/route";
import { ThreadStore, abortActiveTurn } from "../lib/threads/threadStore";
import { runSynthesisPass } from "../lib/chat/turnEngine";
import { ThrottledStreamSnapshot } from "../lib/streamSnapshot";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatStream } from "../components/ChatStream";

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

  it("R9: round-end thought SSE contains full round reasoning even when token 1 triggered a snapshot flush", async () => {
    const tokens = ["First ", "second ", "third ", "fourth ", "fifth"];
    const store = new ThreadStore(tmpThreadsDir);
    const threadId = `r9-round-end-thought-${Date.now()}`;
    store.createThread({ id: threadId, title: "round end thought" });
    const mock = await startMockLlmServer((_req, _body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (const t of tokens) {
        res.write(`${JSON.stringify({ message: { role: "assistant", thinking: t } })}\n`);
      }
      res.write(
        `${JSON.stringify({
          message: { role: "assistant", content: "Complete answer." },
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
        userMessageId: "u-r9-1",
        assistantMessageId: "a-r9-1",
        messages: [{ role: "user", content: "Think completely", id: "u-r9-1" }],
        model: "auto",
        enableTools: false,
      }),
    });
    const events = await readSseEvents(await POST(req));
    const thoughtEvents = events.filter((e) => e.type === "thought");

    assert.equal(
      thoughtEvents.length,
      1,
      `Expected exactly 1 round-end thought event, got ${thoughtEvents.length}`
    );
    const expectedFull = tokens.join("").trim();
    assert.equal(
      String(thoughtEvents[0].thought),
      expectedFull,
      `Round-end thought SSE must equal full round reasoning, got ${JSON.stringify(thoughtEvents[0].thought)}`
    );
    const segs = thoughtEvents[0].thinkingSegments as Array<{ round: number; text: string }>;
    assert.ok(Array.isArray(segs) && segs.length === 1);
    assert.equal(segs[0].text, expectedFull);
  });

  it("R9: mid-round abort preserves partial inFlightThinking in the persisted assistant message", async () => {
    const store = new ThreadStore(tmpThreadsDir);
    const threadId = `r9-abort-think-${Date.now()}`;
    store.createThread({ id: threadId, title: "abort partial thinking" });

    const openResponses: http.ServerResponse[] = [];
    const mock = await startMockLlmServer((_req, _body, res) => {
      openResponses.push(res);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(
        `${JSON.stringify({
          message: { role: "assistant", thinking: "Partial reasoning chunk 1 " },
        })}\n`
      );
      res.write(
        `${JSON.stringify({
          message: { role: "assistant", thinking: "and chunk 2 before abort" },
        })}\n`
      );
      // Leave stream open until turn is aborted
    });
    server = mock.server;
    process.env.LLM_BASE_URL = mock.baseUrl;

    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        userMessageId: "u-r9-abort",
        assistantMessageId: "a-r9-abort",
        messages: [{ role: "user", content: "Think then stop", id: "u-r9-abort" }],
        model: "auto",
        enableTools: false,
      }),
    });

    const response = await POST(req);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seenSecondThinking = false;
    let sseBuf = "";
    const deadline = Date.now() + 5000;
    while (!seenSecondThinking && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      if (sseBuf.includes("chunk 2 before abort")) {
        seenSecondThinking = true;
      }
    }
    assert.ok(seenSecondThinking, "Must receive both mid-round thinking deltas before abort");

    // Abort the active turn mid-round before the round ends
    assert.equal(abortActiveTurn(threadId), true, "Active turn must be registered and aborted");
    for (const res of openResponses) {
      if (!res.writableEnded) {
        res.end();
      }
    }
    // Drain SSE response so turn settles cleanly
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const saved = await store.getThread(threadId);
    const asst = saved?.messages.find((m) => m.id === "a-r9-abort");
    assert.ok(asst, "Aborted assistant message must be persisted");
    assert.equal(asst!.status, "incomplete");
    assert.ok(
      asst!.thought?.includes("Partial reasoning chunk 1 and chunk 2 before abort"),
      `Aborted persisted message must preserve partial in-flight thinking, got ${JSON.stringify(asst!.thought)}`
    );
  });

  it("P-F6: ThrottledStreamSnapshot.isDue gates sub-5s tokens so 0 cumulative joins or segment clones happen when throttled", async () => {
    const writes: Array<Record<string, unknown>> = [];
    let now = 1000;
    const snap = new ThrottledStreamSnapshot(
      {
        addMessage: (_tid, msg) => {
          writes.push(msg as unknown as Record<string, unknown>);
        },
      },
      "t-pf6",
      "m-pf6",
      5000,
      () => now
    );

    const snapWithIsDue = snap as ThrottledStreamSnapshot & {
      isDue?: (force?: boolean) => boolean;
    };
    assert.equal(
      typeof snapWithIsDue.isDue,
      "function",
      "ThrottledStreamSnapshot must expose isDue(force?: boolean)"
    );
    assert.equal(snapWithIsDue.isDue!(), true, "Initial snapshot before first write must be due");

    let segmentReadCount = 0;
    const initialOpts = {
      get thinkingSegments() {
        segmentReadCount++;
        return [{ round: 1, text: "seg 1" }];
      },
    };
    assert.equal(snap.maybeWrite("tok1", "thought 1", undefined, initialOpts), true);
    assert.equal(segmentReadCount, 1);
    assert.equal(snapWithIsDue.isDue!(), false, "Sub-5s follow-up must not be due");
    assert.equal(snapWithIsDue.isDue!(true), true, "Forced check must report due");

    // Inside the 5s window, maybeWrite must check interval BEFORE cloning/reading opts or trimming
    now += 100;
    let throttledSegmentReads = 0;
    const throttledOpts = {
      get thinkingSegments() {
        throttledSegmentReads++;
        return [{ round: 1, text: "seg 1 updated" }];
      },
      get roundPromptTokens() {
        throttledSegmentReads++;
        return [100];
      },
    };
    assert.equal(snap.maybeWrite("tok1 tok2", "thought 12", undefined, throttledOpts), false);
    assert.equal(
      throttledSegmentReads,
      0,
      "Throttled maybeWrite must perform 0 opts array clones before interval check"
    );

    // Verify runSynthesisPass skips cumulative thought joins when isSnapshotDue() is false
    let joinCalls = 0;
    const thoughtsProxy = ["prior"] as string[];
    const origJoin = thoughtsProxy.join.bind(thoughtsProxy);
    thoughtsProxy.join = ((sep?: string) => {
      joinCalls++;
      return origJoin(sep);
    }) as typeof thoughtsProxy.join;

    let synthSnapshotCalls = 0;
    const turnAc = new AbortController();
    await runSynthesisPass({
      llmBaseUrl: "http://127.0.0.1:11434",
      activeModel: "test-model",
      conversationMessages: [{ role: "user", content: "summarize" }],
      isArtifactRequest: false,
      turnAbortSignal: turnAc.signal,
      synthOptions: {},
      accumulatedThoughts: thoughtsProxy,
      getAccumulatedStreamedTokens: () => "",
      setAccumulatedStreamedTokens: () => {},
      onFinishReason: () => {},
      onPromptTokens: () => {},
      onOutputTokens: () => {},
      isSnapshotDue: () => snap.isDue(),
      maybeWriteSnapshot: (c: string, th: string | undefined) => {
        synthSnapshotCalls++;
        snap.maybeWrite(c, th);
      },
      sendEvent: async () => {},
      streamChat: async function* () {
        for (let i = 0; i < 5; i++) {
          now += 50;
          yield { message: { thinking: `t${i} ` } };
        }
        yield { message: { content: "Done." }, finish_reason: "stop" };
      },
      deadlines: { inactivityMs: 5000, totalMs: 10000 },
      log: () => {},
    });

    assert.equal(
      joinCalls,
      0,
      `Throttled synthesis tokens must perform 0 cumulative thought joins, got ${joinCalls}`
    );
    assert.equal(
      synthSnapshotCalls,
      0,
      `Throttled synthesis tokens must perform 0 maybeWriteSnapshot calls, got ${synthSnapshotCalls}`
    );
  });

  it("U-F3: ChatStream thinking -> token SSE transition preserves msg.thought", async () => {
    const prevActEnv = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const win = new GlobalWindow({ url: "http://localhost/" });
    (globalThis as Record<string, unknown>).window = win;
    (globalThis as Record<string, unknown>).document = win.document;
    (globalThis as Record<string, unknown>).localStorage = win.localStorage;
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    const encoder = new TextEncoder();
    let emitTokens: () => void = () => {};
    let closeStream: () => void = () => {};
    const sseStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "thinking", content: "Reasoning step A " })}\n\n`
          )
        );
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "thinking", content: "step B" })}\n\n`)
        );
        emitTokens = () => {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "token", content: "Visible reply." })}\n\n`
            )
          );
        };
        closeStream = () => {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "done",
                content: "Visible reply.",
                thought: "Reasoning step A step B",
              })}\n\n`
            )
          );
          controller.close();
        };
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/chat")) {
        return new Response(sseStream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    let trackedMessages: Array<{ id: string; role: string; content: string; thought?: string }> =
      [];
    const setMessages = (
      updater:
        | Array<{ id: string; role: string; content: string; thought?: string }>
        | ((
            prev: Array<{ id: string; role: string; content: string; thought?: string }>
          ) => Array<{ id: string; role: string; content: string; thought?: string }>)
    ) => {
      trackedMessages = typeof updater === "function" ? updater(trackedMessages) : updater;
    };

    try {
      await act(async () => {
        root.render(
          React.createElement(ChatStream, {
            onTracesUpdate: () => {},
            activeModel: "auto",
            reasoningEffort: "medium",
            threadId: "t-uf3",
            messages: trackedMessages as React.ComponentProps<typeof ChatStream>["messages"],
            setMessages: setMessages as unknown as React.ComponentProps<
              typeof ChatStream
            >["setMessages"],
          })
        );
      });

      const textarea = container.querySelector("textarea") as unknown as HTMLTextAreaElement;
      await act(async () => {
        const propsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"));
        (
          textarea as unknown as Record<
            string,
            { onChange: (e: { target: { value: string } }) => void }
          >
        )[propsKey!].onChange({ target: { value: "Explain this" } });
      });
      const sendBtn = container.querySelector(
        '[data-testid="send-button"]'
      ) as unknown as HTMLButtonElement;
      await act(async () => {
        sendBtn.click();
      });

      const waitDeadline = Date.now() + 2000;
      while (
        !trackedMessages.some(
          (m) => m.role === "assistant" && m.thought?.includes("Reasoning step A step B")
        ) &&
        Date.now() < waitDeadline
      ) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
      }
      assert.ok(
        trackedMessages.some(
          (m) => m.role === "assistant" && m.thought === "Reasoning step A step B"
        ),
        "Thinking events must populate msg.thought"
      );

      // Now emit the first text token (before done) and verify msg.thought is NOT wiped
      emitTokens?.();
      const tokenDeadline = Date.now() + 2000;
      while (
        !trackedMessages.some(
          (m) => m.role === "assistant" && m.content.includes("Visible reply.")
        ) &&
        Date.now() < tokenDeadline
      ) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
      }
      const midStreamAssistant = trackedMessages.find(
        (m) => m.role === "assistant" && m.content.includes("Visible reply.")
      );
      assert.ok(midStreamAssistant, "Token event must populate visible content");
      assert.equal(
        midStreamAssistant!.thought,
        "Reasoning step A step B",
        "U-F3: token event without <think> tags must preserve existing msg.thought"
      );
    } finally {
      closeStream?.();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      globalThis.fetch = originalFetch;
      act(() => {
        root.unmount();
      });
      if (prevActEnv === undefined) {
        delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
      } else {
        (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
      }
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).document;
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });
});
