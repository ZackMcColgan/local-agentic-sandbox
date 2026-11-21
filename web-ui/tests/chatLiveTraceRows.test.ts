// UI-003 / UI-011b: live tool-call trace rows during a turn.
//
// Harness note (adapted from the brief): this repo's test runner is
// `node:test` + `tsx` + happy-dom + react-dom/client createRoot/act — there is
// no jest or @testing-library/react in web-ui/package.json. The brief's
// assertions are preserved verbatim; only the driving/render API is adapted to
// the real harness (see unifiedUi.test.ts for the same pattern). ChatStream has
// no `isLoading` prop (generation state is internal), so that prop is dropped;
// the send control is the composer's `data-testid="send-button"` (ChatStream.tsx:3458).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ChatStream } from "../components/ChatStream";
import { LiveRunBlock } from "../components/LiveRunBlock";
import { TaskManifest } from "../lib/subagents/types";
import type { ExecutionTraceItem } from "../components/ExecutionTrace";

// ExecutionTraceItem.timestamp is a string (components/ExecutionTrace.tsx:12),
// not a number — the brief's Date.now() is adapted to an ISO string.
const trace = (tool: string): ExecutionTraceItem => ({
  tool,
  args: { path: "src/foo.ts" },
  result: "ok",
  durationMs: 12,
  timestamp: new Date().toISOString(),
});

const activeTask: TaskManifest = {
  taskId: "task-live-1",
  goal: "Live run",
  toolchain: "node:22",
  branchName: "feat/live-run",
  status: "active",
  currentMilestoneIndex: 0,
  milestones: [],
  checkpoints: [],
  ambiguityFlags: [],
  journal: [],
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const baseProps = {
  onTracesUpdate: () => {},
  activeModel: "test-model",
  reasoningEffort: "medium" as const,
  threadId: "t1",
};

describe("UI-003 / UI-011b: live trace rows during a turn", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    win = new GlobalWindow();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = win as any;
    globalThis.document = win.document as any;
    globalThis.localStorage = win.localStorage as any;
    container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(container as any);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).localStorage;
  });

  const toolRows = (): HTMLButtonElement[] =>
    Array.from(container.querySelectorAll("button")).filter((b) =>
      (b.getAttribute("aria-label") || "").startsWith("Tool:")
    );

  it("LiveRunBlock renders tool rows while the task is active", async () => {
    await act(async () => {
      root.render(
        React.createElement(LiveRunBlock, {
          task: activeTask,
          liveTraces: [trace("workspace_read_file"), trace("workspace_run_command")],
        })
      );
    });
    const rows = toolRows();
    assert.equal(rows.length, 2, "LiveRunBlock must render one row per live trace");
    assert.ok(
      (rows[0].getAttribute("aria-label") || "").includes("workspace_read_file"),
      "First row aria-label must name the tool"
    );
  });

  it("ChatStream shows trace rows in the live block while a task run is active", async () => {
    await act(async () => {
      root.render(
        React.createElement(ChatStream, {
          ...baseProps,
          messages: [
            { id: "u1", role: "user", content: "go", timestamp: new Date().toISOString() },
          ] as any,
          setMessages: () => {},
          activeTask,
          liveTraces: [trace("search_web")],
        })
      );
    });
    const row = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.getAttribute("aria-label") || "").includes("Tool: search_web")
    );
    assert.ok(row, "ChatStream must surface live trace rows in the live block");
  });

  // PR #63 lesson: assert the LIVE CLIENT end-state under a severed stream,
  // not the persisted record. Rows received before the cut must stay on screen.
  it("severed stream: live client keeps the trace rows it already rendered", async () => {
    let emitted = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        if (emitted === 0) {
          controller.enqueue(
            encoder.encode(
              `data: {"type":"trace","trace":{"tool":"workspace_grep","args":{},"result":"hit","durationMs":5,"timestamp":"${new Date().toISOString()}"}}\n\n`
            )
          );
          emitted++;
        } else {
          // Sever the stream mid-turn (engine slot drop / transient disconnect).
          controller.error(new Error("stream severed"));
        }
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : String(input?.url ?? "");
      if (url.includes("/api/chat")) {
        return { ok: true, status: 200, body: stream } as any;
      }
      // Any other background fetch (thread status/reconcile polls): benign JSON.
      return { ok: true, status: 200, json: async () => ({ messages: [], thread: null }) } as any;
    }) as typeof globalThis.fetch;

    try {
      await act(async () => {
        root.render(
          React.createElement(ChatStream, {
            ...baseProps,
            messages: [
              { id: "u1", role: "user", content: "go", timestamp: new Date().toISOString() },
            ] as any,
            setMessages: () => {},
            activeTask: null,
          })
        );
      });

      // Drive the real composer control via React props (repo-established
      // driver pattern, see tests/uiStateAndDedup.test.ts): happy-dom events
      // do not reach React's synthetic listeners, so invoke onChange/onClick.
      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      assert.ok(textarea, "ChatStream must render a composer textarea");
      await act(async () => {
        const propsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"));
        assert.ok(propsKey, "Composer textarea must have React props");
        (textarea as any)[propsKey].onChange({ target: { value: "go" } });
      });
      const sendBtn = container.querySelector('[data-testid="send-button"]') as HTMLButtonElement;
      assert.ok(sendBtn, "ChatStream must render the send-button control");
      await act(async () => {
        const propsKey = Object.keys(sendBtn).find((k) => k.startsWith("__reactProps"));
        if (propsKey && (sendBtn as any)[propsKey]?.onClick) {
          (sendBtn as any)[propsKey].onClick({ preventDefault: () => {} });
        } else {
          sendBtn.click();
        }
      });

      // Row rendered from the trace event received before the cut.
      const rowBefore = Array.from(container.querySelectorAll("button")).find((b) =>
        (b.getAttribute("aria-label") || "").includes("Tool: workspace_grep")
      );
      assert.ok(rowBefore, "Trace row must render from the event received before the cut");

      // Let the stream sever, then re-assert: the row must still be visible on the live screen.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      const rowAfter = Array.from(container.querySelectorAll("button")).find((b) =>
        (b.getAttribute("aria-label") || "").includes("Tool: workspace_grep")
      );
      assert.ok(
        rowAfter,
        "After the stream cut, the live client must keep the trace row it already rendered"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("severed stream: live client converges liveness out of running when stream cuts", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        controller.enqueue(
          encoder.encode(
            `data: {"type":"trace","trace":{"tool":"workspace_grep","args":{},"result":"hit","durationMs":5,"timestamp":"${new Date().toISOString()}"}}\n\n`
          )
        );
        controller.error(new Error("stream severed"));
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : String(input?.url ?? "");
      if (url.includes("/api/chat")) {
        return { ok: true, status: 200, body: stream } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          messages: [],
          thread: { id: "t-live-1", status: "stopped", liveness: "settled" },
        }),
      } as any;
    }) as typeof globalThis.fetch;

    try {
      await act(async () => {
        root.render(
          React.createElement(ChatStream, {
            ...baseProps,
            messages: [
              { id: "u1", role: "user", content: "go", timestamp: new Date().toISOString() },
            ] as any,
            setMessages: () => {},
            activeTask: null,
          })
        );
      });

      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      await act(async () => {
        const propsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"));
        if (propsKey) {
          (textarea as any)[propsKey].onChange({ target: { value: "go" } });
        }
      });
      const sendBtn = container.querySelector('[data-testid="send-button"]') as HTMLButtonElement;
      await act(async () => {
        const propsKey = Object.keys(sendBtn).find((k) => k.startsWith("__reactProps"));
        if (propsKey && (sendBtn as any)[propsKey]?.onClick) {
          (sendBtn as any)[propsKey].onClick({ preventDefault: () => {} });
        } else {
          sendBtn.click();
        }
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });

      // After stream sever, the live client must not stay stuck in a running/streaming state.
      const stopBtn = container.querySelector('[data-testid="stop-button"]');
      assert.equal(
        stopBtn,
        null,
        "Live client must not remain in running/stop-button state after stream sever"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("trace duplication and live-trace scoping", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    win = new GlobalWindow();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = win as any;
    globalThis.document = win.document as any;
    globalThis.localStorage = win.localStorage as any;
    container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(container as any);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).localStorage;
  });

  it("(b) parked LiveRunBlock renders 0 live rows when given another run's traces", async () => {
    const parkedTask: TaskManifest = {
      ...activeTask,
      taskId: "task-parked-1",
      status: "paused",
    };
    await act(async () => {
      root.render(
        React.createElement(LiveRunBlock, {
          task: parkedTask,
          liveTraces: [trace("search_web"), trace("workspace_read_file")],
        })
      );
    });
    const liveRows = container.querySelectorAll('[data-testid="live-trace-rows"] button');
    assert.equal(liveRows.length, 0, "Parked LiveRunBlock must render 0 live trace rows");
  });

  it("(a) 3 trace events on a turn render exactly 3 rows in order with no duplicates", async () => {
    // Simulate ChatStream's onTracesUpdate contract: ChatStream passes the full
    // accumulated list on every trace event.
    const { default: Home } = await import("../app/page");
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();

    const makeSseStream = () =>
      new ReadableStream({
        start(controller) {
          const events = [
            { type: "trace", trace: trace("search_web") },
            { type: "trace", trace: trace("workspace_read_file") },
            { type: "trace", trace: trace("workspace_run_command") },
            { type: "done" },
          ];
          for (const ev of events) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
          }
          controller.close();
        },
      });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/chat")) {
        return new Response(makeSseStream(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.endsWith("/api/threads") || url.includes("/api/threads?")) {
        return new Response(
          JSON.stringify({
            threads: [{ id: "t1", title: "Thread 1", updatedAt: new Date().toISOString() }],
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/threads/t1")) {
        return new Response(JSON.stringify({ thread: { id: "t1", messages: [] }, task: null }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    try {
      await act(async () => {
        root.render(React.createElement(Home));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      if (textarea) {
        await act(async () => {
          const propsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"));
          if (propsKey) {
            (textarea as any)[propsKey].onChange({ target: { value: "run 3 tools" } });
          }
        });
        const sendBtn = container.querySelector('[data-testid="send-button"]') as HTMLButtonElement;
        await act(async () => {
          const propsKey = Object.keys(sendBtn).find((k) => k.startsWith("__reactProps"));
          if (propsKey && (sendBtn as any)[propsKey]?.onClick) {
            (sendBtn as any)[propsKey].onClick({ preventDefault: () => {} });
          } else {
            sendBtn.click();
          }
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 80));
        });
      }

      // Navigate to telemetry/trace panel or check ExecutionTrace rows
      // In page.tsx, traces are passed to <ExecutionTrace traces={traces} />.
      // We can also check that the live-trace-rows or trace rows have 3 items, not 6.
      const toolButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
        (b.getAttribute("aria-label") || "").startsWith("Tool:")
      );
      assert.equal(toolButtons.length, 3, `Expected 3 trace rows, got ${toolButtons.length}`);
      assert.ok((toolButtons[0].getAttribute("aria-label") || "").includes("search_web"));
      assert.ok((toolButtons[1].getAttribute("aria-label") || "").includes("workspace_read_file"));
      assert.ok(
        (toolButtons[2].getAttribute("aria-label") || "").includes("workspace_run_command")
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("(c) switching threads clears the previous thread's traces from the panel", async () => {
    const { default: Home } = await import("../app/page");
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/chat")) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "trace", trace: trace("search_web") })}\n\n`
              )
            );
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.endsWith("/api/threads") || url.includes("/api/threads?")) {
        return new Response(
          JSON.stringify({
            threads: [
              { id: "t1", title: "Thread 1", updatedAt: new Date().toISOString() },
              { id: "t2", title: "Thread 2", updatedAt: new Date().toISOString() },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/threads/t1")) {
        return new Response(JSON.stringify({ thread: { id: "t1", messages: [] }, task: null }), {
          status: 200,
        });
      }
      if (url.includes("/api/threads/t2")) {
        return new Response(JSON.stringify({ thread: { id: "t2", messages: [] }, task: null }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    try {
      await act(async () => {
        root.render(React.createElement(Home));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      if (textarea) {
        await act(async () => {
          const propsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"));
          if (propsKey) {
            (textarea as any)[propsKey].onChange({ target: { value: "hi" } });
          }
        });
        const sendBtn = container.querySelector('[data-testid="send-button"]') as HTMLButtonElement;
        await act(async () => {
          const propsKey = Object.keys(sendBtn).find((k) => k.startsWith("__reactProps"));
          if (propsKey && (sendBtn as any)[propsKey]?.onClick) {
            (sendBtn as any)[propsKey].onClick({ preventDefault: () => {} });
          } else {
            sendBtn.click();
          }
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 80));
        });
      }

      // Switch to Thread 2 (or New Chat if sidebar thread list is collapsed)
      const switchBtn = Array.from(container.querySelectorAll("button, [role='button'], div")).find(
        (el) => (el.textContent || "").trim() === "Thread 2"
      ) as HTMLElement | undefined;
      assert.ok(switchBtn, "Thread switch button must exist");
      await act(async () => {
        switchBtn.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      // Open ExecutionTrace / Telemetry view or check no stale traces remain
      const toolButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
        (b.getAttribute("aria-label") || "").startsWith("Tool:")
      );
      assert.equal(toolButtons.length, 0, "Switching threads must clear previous thread's traces");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
