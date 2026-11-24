import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import {
  ThreadStore,
  activeExecutionSet,
  markTurnActive,
  clearTurnActive,
  getActiveTurn,
  touchActiveTurn,
  computeTurnLiveness,
  TURN_STALL_WINDOW_MS,
} from "../lib/threads/threadStore";
import { runChatTurn, type RunChatTurnDeps, type RunChatTurnState } from "../lib/chat/roundLoop";
import { createSseEventWriter } from "../lib/chat/turnEngine";
import { ThrottledStreamSnapshot } from "../lib/streamSnapshot";
import { TelemetryTracer } from "../lib/telemetry";
import type { QueuedJob } from "../lib/jobQueue";
import { ChatStream } from "../components/ChatStream";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("P-F1: zero-write heartbeat, throttled fast-round snapshots, and no redundant client done addMessage", () => {
  it("1. touchActiveTurn performs 0 fs.readFileSync and 0 fs.writeFileSync calls on thread JSON while keeping turn liveness alive", async () => {
    const dir = makeTempDir("hb-zero-io-");
    const threadId = "t-hb-zero-io";
    const store = new ThreadStore(dir);
    const thread = store.createThread({ id: threadId, title: "Heartbeat zero IO" });
    store.addMessage(threadId, {
      id: "msg-a",
      role: "assistant",
      content: "working...",
      status: "streaming",
      timestamp: new Date().toISOString(),
    });

    // Warm the summary index, then rewind updatedAt on disk past the stall window.
    await store.listThreadSummaries();
    const filePath = store.getFilePath(threadId);
    const staleIso = new Date(Date.now() - TURN_STALL_WINDOW_MS - 10_000).toISOString();
    const diskRecord = JSON.parse(fs.readFileSync(filePath, "utf8"));
    diskRecord.updatedAt = staleIso;
    fs.writeFileSync(filePath, JSON.stringify(diskRecord, null, 2), "utf8");
    const mtimeBefore = fs.statSync(filePath).mtimeMs;

    activeExecutionSet.add(threadId);
    markTurnActive(threadId);

    const origReadFileSync = fs.readFileSync;
    const origWriteFileSync = fs.writeFileSync;
    const readsOnThreadFile: string[] = [];
    const writesInThreadsDir: string[] = [];

    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
      p: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (typeof p === "string" && path.resolve(p) === path.resolve(filePath)) {
        readsOnThreadFile.push(p);
      }
      return (origReadFileSync as (...args: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync;

    (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((
      p: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (typeof p === "string" && path.resolve(p).startsWith(path.resolve(dir))) {
        writesInThreadsDir.push(p);
      }
      return (origWriteFileSync as (...args: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.writeFileSync;

    try {
      touchActiveTurn(threadId, dir);

      assert.equal(
        readsOnThreadFile.length,
        0,
        `touchActiveTurn must perform 0 fs.readFileSync calls on thread JSON (saw ${readsOnThreadFile.length})`
      );
      assert.equal(
        writesInThreadsDir.length,
        0,
        `touchActiveTurn must perform 0 fs.writeFileSync calls on thread JSON (saw ${writesInThreadsDir.length})`
      );

      const mtimeAfter = fs.statSync(filePath).mtimeMs;
      assert.equal(
        mtimeAfter,
        mtimeBefore,
        "touchActiveTurn must not mutate thread JSON mtimeMs (must not invalidate .summaries-index.json)"
      );

      const presence = getActiveTurn(threadId);
      assert.ok(presence, "activeTurnRegistry entry must exist");
      assert.equal(
        typeof presence.lastActivityAtMs,
        "number",
        "touchActiveTurn must record lastActivityAtMs in activeTurnRegistry"
      );

      assert.equal(
        computeTurnLiveness({ ...thread, updatedAt: staleIso }, Date.now()),
        "alive",
        "computeTurnLiveness must reflect heartbeat and report alive despite stale disk updatedAt"
      );

      const loaded = await store.getThread(threadId);
      assert.ok(loaded, "thread must load");
      assert.equal(
        loaded.liveness,
        "alive",
        "getThread must report liveness=alive after heartbeat"
      );
      assert.ok(
        Date.parse(loaded.updatedAt) > Date.parse(staleIso),
        "getThread must expose refreshed updatedAt in memory without rewriting disk JSON"
      );

      const swept = await store.sweepStalledThreads(Date.now());
      assert.equal(swept, 0, "sweepStalledThreads must not mark a heartbeated turn as stalled");
    } finally {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = origReadFileSync;
      (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
        origWriteFileSync;
      clearTurnActive(threadId);
      activeExecutionSet.delete(threadId);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2. 10-round fast mocked runChatTurn performs 0 full-thread writes from touchActiveTurn and throttles <5s round boundaries", async () => {
    const dir = makeTempDir("hb-10round-");
    const origThreadsDir = process.env.THREADS_DIR;
    const origMcpUrl = process.env.MCP_SERVER_URL;
    const origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
    process.env.THREADS_DIR = dir;
    process.env.MCP_SERVER_URL = "http://127.0.0.1:59991/mcp/sse";
    process.env.BROWSER_MCP_URL = "http://127.0.0.1:59992/browser/sse";

    const store = new ThreadStore(dir);
    const threadId = `t-10round-${Date.now()}`;
    const thread = store.createThread({ id: threadId, title: "10-round throttle test" });
    const filePath = store.getFilePath(threadId);
    const totalRounds = 10;

    let llmRound = 0;
    const fakeClient = {
      callTool: async (req: { name: string; arguments: Record<string, unknown> }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ content: `1 | ${String(req.arguments.path || "a.ts")}` }),
          },
        ],
      }),
      close: async () => {},
    } as unknown as Client;

    const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
      ["workspace_read_file", { client: fakeClient, tier: "sandbox" }],
    ]);

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const reqAbort = new AbortController();
    const sseWriter = createSseEventWriter({
      stream,
      signal: reqAbort.signal,
      activeThreadId: thread.id,
    });
    sseWriter.startReadableDrain();

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

    const streamSnapshot = new ThrottledStreamSnapshot(store, thread.id, "msg-10r");
    const deps: RunChatTurnDeps = {
      reqSignal: reqAbort.signal,
      messages: [{ role: "user", content: "Inspect files across 10 fast rounds." }],
      userPrompt: "Inspect files across 10 fast rounds.",
      priorUserPrompt: "",
      assistantMessageId: "msg-10r",
      clientSessionId: "sess-10r",
      systemPrompt: "You are a helpful assistant.",
      effortDirective: "",
      imagePayloads: [],
      docContexts: [],
      mode: "auto",
      requestedModel: "test-model",
      initialEffectiveReasoningEffort: "low",
      invalidRequestedModel: null,
      triageComplexityResult: null,
      getLlmBaseUrl: () => "http://127.0.0.1:59999",
      resolveJobRepoRoot: () => dir,
      streamLlmChat: async function* () {
        llmRound += 1;
        if (llmRound < totalRounds) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  id: `call_r_${llmRound}`,
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: `file-${llmRound}.ts` }),
                  },
                },
              ],
            },
            finish_reason: "stop",
          };
        } else {
          yield {
            message: { content: "All 10 rounds complete." },
            finish_reason: "stop",
          };
        }
      },
      advertisedTools: new Set(["workspace_read_file"]),
      activeThreadId: thread.id,
      threadsDir: dir,
      threadStore: store,
      initialThreadData: thread,
      initialThreadHostAccess: false,
      streamSnapshot,
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
    };

    const fakeJob: QueuedJob = {
      id: "job-10r",
      threadId: thread.id,
      prompt: "Inspect files across 10 fast rounds.",
      position: 0,
      status: "running",
    };

    const origSaveThread = store.saveThread.bind(store);
    let saveThreadCalls = 0;
    store.saveThread = (t) => {
      saveThreadCalls += 1;
      origSaveThread(t);
    };

    const origWriteFileSync = fs.writeFileSync;
    let directThreadFileWrites = 0;
    (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((
      p: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (typeof p === "string" && path.resolve(p) === path.resolve(filePath)) {
        directThreadFileWrites += 1;
      }
      return (origWriteFileSync as (...args: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.writeFileSync;

    try {
      activeExecutionSet.add(threadId);
      markTurnActive(threadId);
      await runChatTurn(deps, fakeJob, null);

      assert.equal(llmRound, totalRounds, "expected 10 LLM rounds to execute");
      assert.ok(
        directThreadFileWrites <= 1,
        `expected 0 direct thread JSON writes from touchActiveTurn (at most 1 from markTurnExecuting), saw ${directThreadFileWrites}`
      );
      assert.ok(
        saveThreadCalls <= 2,
        `expected <= 2 saveThread calls across 10 fast <5s rounds (initial snapshot + final settlement), saw ${saveThreadCalls}`
      );

      const finalThread = await store.getThread(threadId);
      const asst = finalThread?.messages.find((m) => m.id === "msg-10r");
      assert.ok(asst, "final assistant message must be persisted");
      assert.equal(asst.status, "completed");
      assert.equal(asst.traces?.length, totalRounds - 1, "all 9 round traces must be persisted");
    } finally {
      (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
        origWriteFileSync;
      store.saveThread = origSaveThread;
      clearTurnActive(threadId);
      activeExecutionSet.delete(threadId);
      if (origThreadsDir === undefined) delete process.env.THREADS_DIR;
      else process.env.THREADS_DIR = origThreadsDir;
      if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
      else process.env.MCP_SERVER_URL = origMcpUrl;
      if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
      else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("3. ChatStream SSE done does not POST redundant action: 'addMessage'", () => {
    let win: GlobalWindow;
    let container: HTMLDivElement;
    let root: Root | null = null;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
      win = new GlobalWindow({ url: "http://localhost:3000" });
      globalThis.window = win as unknown as Window & typeof globalThis;
      globalThis.document = win.document as unknown as Document;
      globalThis.localStorage = win.localStorage as unknown as Storage;
      Object.defineProperty(globalThis, "navigator", {
        value: win.navigator,
        configurable: true,
      });

      const div = win.document.createElement("div");
      win.document.body.appendChild(div);
      container = div as unknown as HTMLDivElement;
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      if (root) {
        try {
          root.unmount();
        } catch {}
        root = null;
      }
      if (container && container.parentNode) {
        container.parentNode.removeChild(container);
      }
      globalThis.fetch = originalFetch;
    });

    it("omits assistant addMessage POST on SSE done while keeping client message state updated", async () => {
      const threadId = "test-thread-done-dedup";
      const threadPostPayloads: Array<{ action?: string; message?: { role?: string } }> = [];

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr === "/api/chat") {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "token", content: "Server persisted reply." })}\n\n`
                )
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "done",
                    status: "completed",
                    content: "Server persisted reply.",
                    outputTokens: 4,
                  })}\n\n`
                )
              );
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }

        if (urlStr.includes(`/api/threads/${threadId}`) && init?.method === "POST") {
          try {
            threadPostPayloads.push(JSON.parse(String(init.body || "{}")));
          } catch {}
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        return new Response(JSON.stringify({ ok: true, thread: null }), { status: 200 });
      }) as typeof globalThis.fetch;

      function ChatHarness() {
        const [msgs, setMsgs] = React.useState<
          NonNullable<React.ComponentProps<typeof ChatStream>["messages"]>
        >([]);
        return React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "test-model",
          reasoningEffort: "low",
          threadId,
          messages: msgs,
          setMessages: setMsgs,
        });
      }

      root = createRoot(container);
      await act(async () => {
        root!.render(React.createElement(ChatHarness));
      });

      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      assert.ok(textarea, "Textarea input must exist");

      await act(async () => {
        const textareaPropsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"));
        const textareaProps = textareaPropsKey
          ? (
              textarea as unknown as Record<
                string,
                { onChange?: (e: { target: { value: string } }) => void } | undefined
              >
            )[textareaPropsKey]
          : undefined;
        if (textareaProps?.onChange) {
          textareaProps.onChange({ target: { value: "Hello" } });
        } else {
          textarea.value = "Hello";
          const WinEvent = (win as unknown as { Event: typeof Event }).Event;
          textarea.dispatchEvent(new WinEvent("input", { bubbles: true }));
        }
      });

      const sendForm = container.querySelector("form");
      assert.ok(sendForm, "Send form must exist");

      await act(async () => {
        const formPropsKey = Object.keys(sendForm).find((k) => k.startsWith("__reactProps"));
        const formProps = formPropsKey
          ? (
              sendForm as unknown as Record<
                string,
                { onSubmit?: (e: { preventDefault: () => void }) => void } | undefined
              >
            )[formPropsKey]
          : undefined;
        if (formProps?.onSubmit) {
          formProps.onSubmit({ preventDefault: () => {} });
        } else {
          const WinEvent = (win as unknown as { Event: typeof Event }).Event;
          sendForm.dispatchEvent(new WinEvent("submit", { bubbles: true, cancelable: true }));
        }
        for (let i = 0; i < 20; i++) {
          if (container.textContent?.includes("Server persisted reply.")) break;
          await new Promise((r) => setTimeout(r, 25));
        }
      });

      assert.ok(
        container.textContent?.includes("Server persisted reply."),
        "Client UI state must still render the final assistant reply from SSE done"
      );

      const assistantAddMessages = threadPostPayloads.filter(
        (p) => p.action === "addMessage" && p.message?.role === "assistant"
      );
      assert.equal(
        assistantAddMessages.length,
        0,
        `ChatStream must NOT POST redundant assistant action:'addMessage' on SSE done (saw ${assistantAddMessages.length})`
      );
    });
  });
});
