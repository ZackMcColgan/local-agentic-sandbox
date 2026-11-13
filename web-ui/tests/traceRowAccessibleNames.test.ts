// UI-011a: completed-thread trace rows must carry an accessible name.
//
// The sweep (docs/ui-qa-findings-2026-11-10.md, ledger UI-011a) measured zero
// [aria-label*='Tool'] elements: trace buttons carried only font-mono text.
// PR #81 (qa-3) covered the ChatStream proof rows (ChatStream.tsx:2479) and the
// live strips (ChatStream.tsx:2992, LiveRunBlock.tsx:538). This test pins the
// remaining completed-thread trace list: the ExecutionTrace accordion rows
// (web-ui/components/ExecutionTrace.tsx, rendered at app/page.tsx:1265), and
// regression-guards the ChatStream completed-message proof rows.
//
// Harness: node:test + tsx + happy-dom + react-dom/client createRoot/act
// (same pattern as tests/chatLiveTraceRows.test.ts).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ExecutionTrace, ExecutionTraceItem } from "../components/ExecutionTrace";
import { ChatStream } from "../components/ChatStream";

const trace = (tool: string): ExecutionTraceItem => ({
  tool,
  args: { path: "src/foo.ts" },
  result: "ok",
  durationMs: 12,
  timestamp: new Date().toISOString(),
});

describe("UI-011a: trace rows carry accessible names", () => {
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

  it("ExecutionTrace rows name the tool via aria-label", async () => {
    await act(async () => {
      root.render(
        React.createElement(ExecutionTrace, {
          traces: [trace("workspace_read_file"), trace("workspace_run_command")],
        })
      );
    });
    const rows = toolRows();
    assert.equal(rows.length, 2, "ExecutionTrace must render one labelled row per trace");
    assert.ok(
      (rows[0].getAttribute("aria-label") || "").includes("workspace_read_file"),
      "First row aria-label must name the tool"
    );
    assert.ok(
      (rows[1].getAttribute("aria-label") || "").includes("workspace_run_command"),
      "Second row aria-label must name the tool"
    );
  });

  it("ChatStream completed-message proof rows keep their accessible names", async () => {
    await act(async () => {
      root.render(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "test-model",
          reasoningEffort: "medium" as const,
          threadId: "t1",
          messages: [
            {
              id: "a1",
              role: "assistant",
              content: "done",
              timestamp: new Date().toISOString(),
              traces: [trace("workspace_grep")],
            },
          ] as any,
          setMessages: () => {},
          activeTask: null,
        })
      );
    });
    const row = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.getAttribute("aria-label") || "").includes("Tool: workspace_grep")
    );
    assert.ok(row, "Completed-message proof rows must carry Tool: <name> aria-labels");
  });
});
