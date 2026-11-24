import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act, Profiler, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatStream, type ChatMessage } from "../components/ChatStream";
import { ChatMessageItem } from "../components/chat/messageRender";
import { ActivityTimeline } from "../components/ActivityTimeline";
import { StintCard } from "../components/StintCard";
import { CanvasProvider } from "../components/CanvasContext";
import { deriveStintMetrics } from "../lib/stintDerivation";
import { mergeStreamedTokens } from "../lib/chatStatus";
import type { ExecutionTraceItem } from "../components/ExecutionTrace";

function makeTraces(count: number, prefix: string): ExecutionTraceItem[] {
  const out: ExecutionTraceItem[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      tool: "run_check",
      args: { target: `${prefix}-${i}.ts` },
      result: { stdout: `${prefix} ok ${i}`, exitCode: 0 },
      durationMs: 12 + i,
      timestamp: `2026-11-24T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    });
  }
  return out;
}

function buildTwentyMessageFixture(): {
  messages: ChatMessage[];
  readCounters: number[];
} {
  const messages: ChatMessage[] = [];
  const readCounters: number[] = [];

  for (let turn = 0; turn < 10; turn++) {
    messages.push({
      id: `user-${turn}`,
      role: "user",
      content: `Prompt for turn ${turn}`,
      timestamp: "2026-11-24T00:00:00.000Z",
    });

    const idx = readCounters.length;
    readCounters.push(0);
    const assistantMsg: ChatMessage = {
      id: `assistant-${turn}`,
      role: "assistant",
      content: `Completed response for turn ${turn}.`,
      thought: `Reasoning for turn ${turn}`,
      traces: makeTraces(15, `t${turn}`),
      roundPromptTokens: [1000 + turn * 100],
      roundGenerationMs: [500],
      outputTokens: 120,
      durationMs: 1200,
      status: "completed",
    };

    let storedThinkingMs: number | undefined = 450 + turn;
    Object.defineProperty(assistantMsg, "thinkingDurationMs", {
      enumerable: true,
      configurable: true,
      get() {
        readCounters[idx]++;
        return storedThinkingMs;
      },
      set(val: number | undefined) {
        storedThinkingMs = val;
      },
    });

    messages.push(assistantMsg);
  }

  return { messages, readCounters };
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for: ${description}`);
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

describe("U-F4 render memoization, rAF batching, shallow stint derivation, and bounded merge", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    win = new GlobalWindow();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;
    globalThis.localStorage = win.localStorage as unknown as Storage;
    container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(
      container as unknown as Parameters<typeof win.document.body.appendChild>[0]
    );
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("wraps ChatMessageItem, ActivityTimeline, and StintCard in React.memo", () => {
    assert.equal(
      (ChatMessageItem as unknown as { $$typeof?: symbol }).$$typeof,
      Symbol.for("react.memo"),
      "ChatMessageItem must be wrapped in React.memo"
    );
    assert.equal(
      (ActivityTimeline as unknown as { $$typeof?: symbol }).$$typeof,
      Symbol.for("react.memo"),
      "ActivityTimeline must be wrapped in React.memo"
    );
    assert.equal(
      (StintCard as unknown as { $$typeof?: symbol }).$$typeof,
      Symbol.for("react.memo"),
      "StintCard must be wrapped in React.memo"
    );
  });

  it("settled ChatMessageItem rows render once while tail message streams updates (20-message / 150-trace Profiler fixture)", async () => {
    const { messages: baseMessages, readCounters } = buildTwentyMessageFixture();
    // 19 settled messages + 1 streaming tail message = 20 messages, 135+15 = 150 traces
    const tailMsg: ChatMessage = {
      ...baseMessages[19],
      id: "assistant-tail",
      content: "Initial",
      status: "streaming",
    };
    const initialList = [...baseMessages.slice(0, 19), tailMsg];

    const userRenderCounts = new Map<string, number>();
    for (const m of initialList.slice(0, 19)) {
      if (m.role === "user") {
        userRenderCounts.set(m.id, 0);
        Object.defineProperty(m, "attachments", {
          enumerable: true,
          configurable: true,
          get() {
            userRenderCounts.set(m.id, (userRenderCounts.get(m.id) || 0) + 1);
            return undefined;
          },
        });
      }
    }

    const tailRenderCounts: number[] = [];
    const noop = () => {};
    const emptyTraces: ExecutionTraceItem[] = [];

    let updateTail!: (next: Partial<ChatMessage>) => void;

    function FixtureHarness() {
      const [msgs, setMsgs] = useState<ChatMessage[]>(initialList);
      updateTail = (next: Partial<ChatMessage>) => {
        setMsgs((prev) =>
          prev.map((m, i) => (i === prev.length - 1 ? { ...m, ...next } : m))
        );
      };

      return React.createElement(
        CanvasProvider,
        null,
        msgs.map((m, idx) => {
          const item = React.createElement(ChatMessageItem, {
            key: m.id,
            message: m,
            idx,
            copiedMessageId: null,
            lastLinkedTaskMsgIndex: -1,
            lastAssistantIndex: msgs.length - 1,
            liveTurnTraces: emptyTraces,
            isLoading: true,
            isStoppingTask: false,
            activeAssistantMsgId: "assistant-tail",
            completedTurnMsgId: null,
            hasResolvedDetachedTurn: false,
            activeModel: "default-model",
            onPreviewImage: noop,
            onCopyToClipboard: noop,
            onRetry: noop,
            onRunControlAction: noop,
            onOpenCanvasDiff: noop,
          });
          if (m.id === "assistant-tail") {
            return React.createElement(
              Profiler,
              {
                key: m.id,
                id: m.id,
                onRender: () => {
                  tailRenderCounts.push(1);
                },
              },
              item
            );
          }
          return item;
        })
      );
    }

    await act(async () => {
      root.render(React.createElement(FixtureHarness));
    });

    for (let i = 0; i < 19; i++) {
      const msg = initialList[i];
      if (msg.role === "user") {
        assert.equal(
          userRenderCounts.get(msg.id),
          1,
          `Settled user message ${msg.id} should render once initially`
        );
      }
    }
    for (let a = 0; a < 9; a++) {
      assert.equal(
        readCounters[a],
        1,
        `Settled assistant message assistant-${a} should render once initially`
      );
    }

    for (let step = 1; step <= 6; step++) {
      await act(async () => {
        updateTail({
          content: `Initial chunk ${step}`,
          thought: `Thinking step ${step}`,
        });
      });
    }

    for (let i = 0; i < 19; i++) {
      const msg = initialList[i];
      if (msg.role === "user") {
        assert.equal(
          userRenderCounts.get(msg.id),
          1,
          `Settled user message ${msg.id} must remain at render count 1 while tail streams`
        );
      }
    }
    for (let a = 0; a < 9; a++) {
      assert.equal(
        readCounters[a],
        1,
        `Settled assistant message assistant-${a} must remain at render count 1 while tail streams`
      );
    }
    assert.equal(
      tailRenderCounts.length,
      7,
      "Tail streaming message should render 1 initial + 6 updates"
    );
  });

  it("ChatStream with 20 settled messages (150 traces) does not re-render settled rows during SSE thinking/token/trace streaming", async () => {
    const { messages: initialMessages, readCounters } = buildTwentyMessageFixture();
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.includes("/api/chat")) {
        return { ok: true, status: 200, body: stream } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [], thread: null }),
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    function ChatStreamHost() {
      const [msgs, setMsgs] = useState<ChatMessage[]>(initialMessages);
      return React.createElement(ChatStream, {
        messages: msgs,
        setMessages: setMsgs,
        onTracesUpdate: () => {},
        activeModel: "default-model",
        reasoningEffort: "medium",
        threadId: "thread-memo-test",
        activeTask: null,
      });
    }

    try {
      await act(async () => {
        root.render(React.createElement(ChatStreamHost));
      });

      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      assert.ok(textarea, "Composer textarea must exist");
      await act(async () => {
        const propsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"));
        assert.ok(propsKey, "Composer textarea must have React props");
        const taProps = (
          textarea as unknown as Record<
            string,
            {
              onChange: (e: { target: { value: string } }) => void;
              onKeyDown: (e: {
                key: string;
                shiftKey: boolean;
                preventDefault: () => void;
              }) => void;
            }
          >
        )[propsKey];
        taProps.onChange({ target: { value: "Stream tail response" } });
      });

      await act(async () => {
        const propsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"));
        assert.ok(propsKey);
        const taProps = (
          textarea as unknown as Record<
            string,
            {
              onKeyDown: (e: {
                key: string;
                shiftKey: boolean;
                preventDefault: () => void;
              }) => void;
            }
          >
        )[propsKey];
        taProps.onKeyDown({ key: "Enter", shiftKey: false, preventDefault: () => {} });
      });

      // Emit meta event so the stream loop has entered active streaming state
      await act(async () => {
        streamController.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "meta", model: "default-model" })}\n\n`)
        );
        await new Promise((r) => setTimeout(r, 25));
      });

      const baselineReads = [...readCounters];

      // Stream multiple thinking, token, and trace updates to the tail assistant message
      await act(async () => {
        for (let i = 0; i < 5; i++) {
          streamController.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "thinking", content: `step ${i} ` })}\n\n`)
          );
        }
        streamController.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "trace",
              trace: {
                tool: "run_check",
                args: { target: "live.ts" },
                result: "ok",
                durationMs: 10,
                timestamp: "2026-11-24T00:01:00.000Z",
              },
            })}\n\n`
          )
        );
        for (let i = 0; i < 8; i++) {
          streamController.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "token", content: `word${i} ` })}\n\n`)
          );
        }
        await new Promise((r) => setTimeout(r, 60));
      });

      await waitForCondition(
        () => (container.textContent || "").includes("word7"),
        "streamed tail tokens to appear in DOM"
      );

      for (let i = 0; i < baselineReads.length; i++) {
        assert.equal(
          readCounters[i],
          baselineReads[i],
          `Settled assistant message #${i} must not re-render during tail SSE streaming (before=${baselineReads[i]}, after=${readCounters[i]})`
        );
      }

      await act(async () => {
        streamController.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "done",
              content: "word0 word1 word2 word3 word4 word5 word6 word7",
            })}\n\n`
          )
        );
        streamController.close();
        await new Promise((r) => setTimeout(r, 40));
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("batches SSE thinking/token commits to requestAnimationFrame, flushes before done, and cancels on unmount", async () => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    let nextRafId = 1;
    const pendingRafs = new Map<number, FrameRequestCallback>();
    const cancelledRafIds: number[] = [];

    const origGlobalRaf = globalThis.requestAnimationFrame;
    const origGlobalCancelRaf = globalThis.cancelAnimationFrame;
    const origWinRaf = win.requestAnimationFrame;
    const origWinCancelRaf = win.cancelAnimationFrame;

    const mockRaf = (cb: FrameRequestCallback): number => {
      const id = nextRafId++;
      pendingRafs.set(id, cb);
      return id;
    };
    const mockCancelRaf = (id: number): void => {
      cancelledRafIds.push(id);
      pendingRafs.delete(id);
    };

    globalThis.requestAnimationFrame = mockRaf;
    globalThis.cancelAnimationFrame = mockCancelRaf;
    win.requestAnimationFrame = mockRaf as unknown as typeof win.requestAnimationFrame;
    win.cancelAnimationFrame = mockCancelRaf as unknown as typeof win.cancelAnimationFrame;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.includes("/api/chat")) {
        return { ok: true, status: 200, body: stream } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [], thread: null }),
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    let hostRenderCommits = 0;

    function BatchTestHost() {
      const [msgs, setMsgs] = useState<ChatMessage[]>([]);
      hostRenderCommits++;
      return React.createElement(ChatStream, {
        messages: msgs,
        setMessages: setMsgs,
        onTracesUpdate: () => {},
        activeModel: "default-model",
        reasoningEffort: "medium",
        threadId: "thread-raf-test",
        activeTask: null,
      });
    }

    try {
      await act(async () => {
        root.render(React.createElement(BatchTestHost));
      });

      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      await act(async () => {
        const propsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"));
        assert.ok(propsKey);
        (
          textarea as unknown as Record<
            string,
            { onChange: (e: { target: { value: string } }) => void }
          >
        )[propsKey].onChange({ target: { value: "Test batching" } });
      });

      await act(async () => {
        const propsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"));
        assert.ok(propsKey);
        (
          textarea as unknown as Record<
            string,
            {
              onKeyDown: (e: {
                key: string;
                shiftKey: boolean;
                preventDefault: () => void;
              }) => void;
            }
          >
        )[propsKey].onKeyDown({ key: "Enter", shiftKey: false, preventDefault: () => {} });
      });

      await act(async () => {
        streamController.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "meta", model: "default-model" })}\n\n`)
        );
        await new Promise((r) => setTimeout(r, 20));
      });

      const commitsBeforeBurst = hostRenderCommits;

      // Enqueue 8 token chunks in one burst without firing rAF yet
      await act(async () => {
        let payload = "";
        for (let i = 0; i < 8; i++) {
          payload += `data: ${JSON.stringify({ type: "token", content: `tok${i} ` })}\n\n`;
        }
        streamController.enqueue(encoder.encode(payload));
        await new Promise((r) => setTimeout(r, 15));
      });

      assert.equal(
        pendingRafs.size,
        1,
        "Burst of token chunks must schedule exactly 1 requestAnimationFrame callback"
      );
      assert.equal(
        hostRenderCommits,
        commitsBeforeBurst,
        "No React message state commit should occur before rAF fires"
      );

      // Fire the single scheduled rAF
      await act(async () => {
        const entries = Array.from(pendingRafs.entries());
        pendingRafs.clear();
        for (const [, cb] of entries) cb(performance.now());
      });

      assert.ok(
        (container.textContent || "").includes("tok7"),
        "Firing the single rAF must commit all 8 buffered tokens"
      );
      assert.equal(
        hostRenderCommits,
        commitsBeforeBurst + 1,
        "All 8 buffered tokens must commit in a single React render"
      );

      // Enqueue another token without firing rAF, then unmount to verify rAF cancellation
      await act(async () => {
        streamController.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "token", content: "unmounted-tok" })}\n\n`)
        );
        await new Promise((r) => setTimeout(r, 15));
      });
      assert.equal(pendingRafs.size, 1, "Pending rAF should exist before unmount");
      const [pendingId] = Array.from(pendingRafs.keys());

      await act(async () => {
        root.unmount();
      });

      assert.ok(
        cancelledRafIds.includes(pendingId),
        "Unmounting ChatStream must cancel any pending SSE animation frame"
      );
      try {
        streamController.close();
      } catch {}
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.requestAnimationFrame = origGlobalRaf;
      globalThis.cancelAnimationFrame = origGlobalCancelRaf;
      win.requestAnimationFrame = origWinRaf;
      win.cancelAnimationFrame = origWinCancelRaf;
      // Recreate root for afterEach unmount
      root = createRoot(container);
    }
  });

  it("ActivityTimeline memoizes buildActivityTimeline and deriveStintMetrics performs 0 JSON.stringify calls", async () => {
    let stringifyCalls = 0;
    const origStringify = JSON.stringify;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      stringifyCalls++;
      return origStringify(...args);
    }) as typeof JSON.stringify;

    try {
      const metrics = deriveStintMetrics({
        durationMs: 4200,
        outputTokens: 300,
        roundPromptTokens: [1200, 1400],
        roundGenerationMs: [1000, 1200],
        traces: [
          {
            tool: "run_check",
            args: { cmd: "test" },
            result: {
              isError: false,
              success: true,
              ok: true,
              exitCode: 0,
              status: "passed",
              stdout: "14 tests passed, 0 failed",
            },
            durationMs: 400,
          },
          {
            tool: "run_check",
            args: { cmd: "meta" },
            result: {
              exit_code: 1,
              error: "non-zero exit",
              nested: { deep: [1, 2, 3] },
            },
            durationMs: 200,
          },
          {
            tool: "run_check",
            args: { cmd: "raw" },
            result: "ok plain string",
            durationMs: 50,
          },
        ],
      });

      assert.ok(metrics);
      assert.deepEqual(metrics.tests, { passed: 14, failed: 0 });
      assert.equal(
        stringifyCalls,
        0,
        "deriveStintMetrics must perform 0 JSON.stringify calls on trace results"
      );
    } finally {
      JSON.stringify = origStringify;
    }

    // Verify ActivityTimeline memoizes buildActivityTimeline across non-timeline prop changes
    let durationReadCount = 0;
    const tracedItem: ExecutionTraceItem = {
      tool: "run_check",
      args: { target: "memo.ts" },
      result: "ok",
      durationMs: 25,
      timestamp: "2026-11-24T00:00:00.000Z",
    };
    Object.defineProperty(tracedItem, "durationMs", {
      enumerable: true,
      configurable: true,
      get() {
        durationReadCount++;
        return 25;
      },
    });
    const traces = [tracedItem];

    await act(async () => {
      root.render(
        React.createElement(ActivityTimeline, {
          traces,
          isStreaming: true,
          hasContent: false,
        })
      );
    });
    const readsAfterFirstRender = durationReadCount;
    assert.ok(readsAfterFirstRender >= 1);

    await act(async () => {
      root.render(
        React.createElement(ActivityTimeline, {
          traces,
          isStreaming: true,
          hasContent: true,
        })
      );
    });
    assert.equal(
      durationReadCount,
      readsAfterFirstRender,
      "Changing only hasContent must not re-run buildActivityTimeline inside ActivityTimeline"
    );
  });

  it("mergeStreamedTokens bounds overlap scan to 4 KB and finishes < 50ms on 64 KB strings", () => {
    const chunkA = "A".repeat(63 * 1024);
    const overlap2k = Array.from({ length: 2048 }, (_, i) =>
      String.fromCharCode(97 + (i % 26))
    ).join("");
    const chunkB = "B".repeat(62 * 1024);

    const acc = chunkA + overlap2k;
    const evt = overlap2k + chunkB;

    const t0 = performance.now();
    const merged = mergeStreamedTokens(acc, evt);
    const elapsed2k = performance.now() - t0;

    assert.ok(
      elapsed2k < 50,
      `mergeStreamedTokens with 2 KB overlap on 64 KB strings took ${elapsed2k.toFixed(2)}ms (must be < 50ms)`
    );
    assert.equal(merged, chunkA + overlap2k + chunkB);

    // Exact 4 KB overlap boundary
    const overlap4k = Array.from({ length: 4096 }, (_, i) =>
      String.fromCharCode(65 + (i % 26))
    ).join("");
    const acc4k = "X".repeat(60 * 1024) + overlap4k;
    const evt4k = overlap4k + "Y".repeat(60 * 1024);

    const t1 = performance.now();
    const merged4k = mergeStreamedTokens(acc4k, evt4k);
    const elapsed4k = performance.now() - t1;

    assert.ok(
      elapsed4k < 50,
      `mergeStreamedTokens with 4 KB overlap on 64 KB strings took ${elapsed4k.toFixed(2)}ms (must be < 50ms)`
    );
    assert.equal(merged4k, "X".repeat(60 * 1024) + overlap4k + "Y".repeat(60 * 1024));

    // Worst-case 0 overlap on two 64 KB strings must also complete < 50ms
    const noOverlapA = Array.from({ length: 65536 }, (_, i) =>
      String.fromCharCode(97 + (i % 23))
    ).join("");
    const noOverlapB = Array.from({ length: 65536 }, (_, i) =>
      String.fromCharCode(65 + (i % 23))
    ).join("");

    const t2 = performance.now();
    const mergedNone = mergeStreamedTokens(noOverlapA, noOverlapB);
    const elapsedNone = performance.now() - t2;

    assert.ok(
      elapsedNone < 50,
      `mergeStreamedTokens with 0 overlap on 64 KB strings took ${elapsedNone.toFixed(2)}ms (must be < 50ms)`
    );
    assert.equal(mergedNone, `${noOverlapA}\n\n${noOverlapB}`);

    // Pathological repetitive 64 KB string that triggers O(N^2) without the 4 KB bound
    const repeatAcc = "x" + "a".repeat(61440) + "y" + "a".repeat(4096);
    const repeatEvt = "a".repeat(4096) + "z" + "a".repeat(61441);
    const t3 = performance.now();
    const mergedRepeat = mergeStreamedTokens(repeatAcc, repeatEvt);
    const elapsedRepeat = performance.now() - t3;

    assert.ok(
      elapsedRepeat < 50,
      `mergeStreamedTokens on repetitive 64 KB strings took ${elapsedRepeat.toFixed(2)}ms (must be < 50ms)`
    );
    assert.equal(mergedRepeat, repeatAcc + "z" + "a".repeat(61441));
  });
});
