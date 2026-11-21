import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { ExecutionTraceItem } from "../components/ExecutionTrace";
import { useLiveTraces, type UseLiveTracesResult } from "../lib/hooks/useLiveTraces";

const makeTrace = (tool: string): ExecutionTraceItem => ({
  tool,
  args: { path: "src/example.ts" },
  result: "ok",
  durationMs: 10,
  timestamp: "2026-11-21T12:00:00.000Z",
});

describe("useLiveTraces hook", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    win = new GlobalWindow();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;
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
  });

  it("accumulates traces via updateTraces and clears via clearTraces", async () => {
    let latest: UseLiveTracesResult | null = null;

    function Harness({ threadId }: { threadId: string | null }) {
      latest = useLiveTraces(threadId);
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness, { threadId: "t1" }));
    });
    assert.deepEqual(latest!.traces, []);

    const t1 = makeTrace("search_web");
    const t2 = makeTrace("workspace_read_file");
    await act(async () => {
      latest!.updateTraces([t1]);
    });
    assert.equal(latest!.traces.length, 1);
    assert.equal(latest!.traces[0].tool, "search_web");

    await act(async () => {
      latest!.updateTraces([t1, t2]);
    });
    assert.equal(latest!.traces.length, 2);
    assert.deepEqual(
      latest!.traces.map((t) => t.tool),
      ["search_web", "workspace_read_file"]
    );

    await act(async () => {
      latest!.clearTraces();
    });
    assert.deepEqual(latest!.traces, []);
  });

  it("clears previous thread traces when selectedThreadId switches or becomes null", async () => {
    let latest: UseLiveTracesResult | null = null;

    function Harness({ threadId }: { threadId: string | null }) {
      latest = useLiveTraces(threadId);
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness, { threadId: "t1" }));
    });
    await act(async () => {
      latest!.updateTraces([makeTrace("search_web"), makeTrace("workspace_grep")]);
    });
    assert.equal(latest!.traces.length, 2);

    // Switching to another thread clears traces
    await act(async () => {
      root.render(React.createElement(Harness, { threadId: "t2" }));
    });
    assert.deepEqual(latest!.traces, []);

    // Re-populate on t2, then clear selectedThreadId to null
    await act(async () => {
      latest!.updateTraces([makeTrace("workspace_run_command")]);
    });
    assert.equal(latest!.traces.length, 1);

    await act(async () => {
      root.render(React.createElement(Harness, { threadId: null }));
    });
    assert.deepEqual(latest!.traces, []);
  });

  it("preserves traces when shouldSkipClear returns true for the new threadId", async () => {
    let latest: UseLiveTracesResult | null = null;
    let skipId: string | null = "t-auto";

    function Harness({ threadId }: { threadId: string | null }) {
      latest = useLiveTraces(threadId, {
        shouldSkipClear: (id) => id === skipId,
      });
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness, { threadId: null }));
    });
    await act(async () => {
      latest!.updateTraces([makeTrace("search_web")]);
    });
    assert.equal(latest!.traces.length, 1);

    // Transition to the auto-created thread should preserve traces
    await act(async () => {
      root.render(React.createElement(Harness, { threadId: "t-auto" }));
    });
    assert.equal(latest!.traces.length, 1);
    assert.equal(latest!.traces[0].tool, "search_web");

    // Switching to another thread afterwards clears traces
    skipId = null;
    await act(async () => {
      root.render(React.createElement(Harness, { threadId: "t-other" }));
    });
    assert.deepEqual(latest!.traces, []);
  });
});
