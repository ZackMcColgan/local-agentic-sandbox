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
  title: "Live run",
  status: "active",
  milestones: [],
  journal: [],
  completedMilestones: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as TaskManifest;

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
    container = win.document.createElement("div");
    win.document.body.appendChild(container);
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
    const row = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.getAttribute("aria-label") || "").includes("Tool: search_web")
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

      // Drive the real composer control: textarea input event, then send-button click.
      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      assert.ok(textarea, "ChatStream must render a composer textarea");
      await act(async () => {
        textarea.value = "go";
        textarea.dispatchEvent(new (win as any).Event("input", { bubbles: true }));
      });
      const sendBtn = container.querySelector('[data-testid="send-button"]') as HTMLButtonElement;
      assert.ok(sendBtn, "ChatStream must render the send-button control");
      await act(async () => {
        sendBtn.click();
      });

      // Row rendered from the trace event received before the cut.
      const rowBefore = Array.from(container.querySelectorAll("button")).find(
        (b) => (b.getAttribute("aria-label") || "").includes("Tool: workspace_grep")
      );
      assert.ok(rowBefore, "Trace row must render from the event received before the cut");

      // Let the stream sever, then re-assert: the row must still be visible on the live screen.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      const rowAfter = Array.from(container.querySelectorAll("button")).find(
        (b) => (b.getAttribute("aria-label") || "").includes("Tool: workspace_grep")
      );
      assert.ok(rowAfter, "After the stream cut, the live client must keep the trace row it already rendered");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
