import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ThinkingPanel } from "../components/ThinkingPanel";
import { sanitizeMessagesForStorage } from "../lib/chatHistory";

describe("UI-028b: ThinkingPanel completed-turn duration and past-tense label", () => {
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
    win.close();
  });

  it("renders 'Thought for 12s' when isStreaming is false and durationMs is 12000", () => {
    act(() => {
      root.render(
        React.createElement(ThinkingPanel, {
          rawThought: "Step 1: inspect the file.",
          isStreaming: false,
          durationMs: 12000,
        })
      );
    });

    const text = container.textContent ?? "";
    assert.match(text, /Thought for 12s/);
    assert.doesNotMatch(text, /\bThinking\b/);
  });

  it("renders past-tense 'Thought' (never 'Thinking') when isStreaming is false and durationMs is undefined", () => {
    act(() => {
      root.render(
        React.createElement(ThinkingPanel, {
          rawThought: "Step 1: inspect the file.",
          isStreaming: false,
          durationMs: undefined,
        })
      );
    });

    const text = container.textContent ?? "";
    assert.match(text, /Thought/);
    assert.doesNotMatch(text, /\bThinking\b/);
  });

  it("UI-042: expanding a '1 step' ThinkingPanel never renders an empty list when rawThought is non-empty", () => {
    act(() => {
      root.render(
        React.createElement(ThinkingPanel, {
          rawThought: '<tool_call>{"name":"ls"}</tool_call>',
          isStreaming: false,
          durationMs: 2000,
        })
      );
    });

    const toggleBtn = container.querySelector("button[aria-expanded]");
    assert.ok(toggleBtn, "Toggle button should exist");
    act(() => {
      toggleBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as any);
    });

    const text = container.textContent ?? "";
    assert.match(text, /1 step/);
    const listItems = container.querySelectorAll("[data-testid^='phase-card-']");
    assert.ok(
      listItems.length >= 1,
      `Expected at least 1 rendered step item, got ${listItems.length}`
    );
    assert.match(listItems[0].textContent ?? "", /Formulated response\./);
  });

  it("UI-049: at phone width (390px) header title never truncates and phase pill yields on small screens", () => {
    win.innerWidth = 390;
    act(() => {
      root.render(
        React.createElement(ThinkingPanel, {
          rawThought: "Step 1: inspect.",
          isStreaming: true,
          streamStatus: "Thinking",
          durationMs: 12000,
        })
      );
    });

    const titleEl = container.querySelector("[data-testid='thinking-panel-title']");
    assert.ok(titleEl, "Header title element should have data-testid='thinking-panel-title'");
    assert.equal(titleEl!.textContent, "Thinking");
    assert.ok(
      !titleEl!.className.includes("truncate"),
      `Header title must not have 'truncate' class, got: ${titleEl!.className}`
    );
    assert.ok(
      titleEl!.className.includes("shrink-0"),
      `Header title must have 'shrink-0' so it is not squeezed on 390px, got: ${titleEl!.className}`
    );

    const badge = container.querySelector("[data-testid='streaming-badge']");
    assert.ok(badge, "Step badge should be rendered");

    const phaseSlot = container.querySelector("[data-testid='turn-status-slot']");
    if (phaseSlot) {
      const labelSpan = phaseSlot.querySelector("span");
      assert.ok(labelSpan, "Phase pill label span should exist");
      assert.ok(
        labelSpan!.className.includes("hidden") && labelSpan!.className.includes("sm:inline"),
        `Phase pill label must yield on small screens (hidden sm:inline), got: ${labelSpan!.className}`
      );
    }
  });

  it("UI-041: persists phaseTimings through sanitizeMessagesForStorage and renders breakdown in expanded ThinkingPanel", () => {
    const phaseTimings = {
      contextPrepMs: 1000,
      thinkingMs: 4000,
      toolsMs: 5000,
      writingMs: 2000,
    };
    const sanitized = sanitizeMessagesForStorage([
      {
        id: "m-1",
        role: "assistant",
        content: "Done.",
        thought: "Checked files.",
        durationMs: 12000,
        thinkingDurationMs: 12000,
        phaseTimings,
      } as any,
    ]);
    assert.deepEqual((sanitized[0] as any).phaseTimings, phaseTimings);
    assert.equal((sanitized[0] as any).thinkingDurationMs, 12000);

    act(() => {
      root.render(
        React.createElement(ThinkingPanel, {
          rawThought: "Checked files.",
          isStreaming: false,
          durationMs: 12000,
          phaseTimings,
        } as any)
      );
    });

    const toggleBtn = container.querySelector("button[aria-expanded]");
    assert.ok(toggleBtn, "Toggle button should exist");
    act(() => {
      toggleBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as any);
    });

    const breakdown = container.querySelector("[data-testid='phase-timings-breakdown']");
    assert.ok(breakdown, "Expanded ThinkingPanel should render phase-timings-breakdown");
    const text = breakdown!.textContent ?? "";
    assert.match(text, /Context prep/i);
    assert.match(text, /Thinking/i);
    assert.match(text, /Tools/i);
    assert.match(text, /Writing/i);
  });

  it("FP2: ThreadStore round-trips phaseTimings and thinkingDurationMs intact", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { ThreadStore } = await import("../lib/threads/threadStore");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp2-phase-timings-"));
    try {
      const store = new ThreadStore(tmpDir);
      const thread = await store.createThread({ title: "FP2 test", model: "test-model" });
      const phaseTimings = {
        contextPrepMs: 120,
        thinkingMs: 850,
        toolsMs: 430,
        writingMs: 600,
      };
      const durationMs = 2000;
      await store.addMessage(thread.id, {
        id: "msg-fp2-1",
        role: "assistant",
        content: "Done",
        timestamp: new Date().toISOString(),
        durationMs,
        thinkingDurationMs: 850,
        phaseTimings,
      });

      const loaded = await store.getThread(thread.id);
      assert.ok(loaded, "Expected thread to be loaded");
      const msg = loaded.messages.find((m) => m.id === "msg-fp2-1");
      assert.ok(msg, "Expected assistant message to be persisted");
      assert.equal(msg.thinkingDurationMs, 850);
      assert.deepEqual(msg.phaseTimings, phaseTimings);
      const sum =
        (msg.phaseTimings?.contextPrepMs ?? 0) +
        (msg.phaseTimings?.thinkingMs ?? 0) +
        (msg.phaseTimings?.toolsMs ?? 0) +
        (msg.phaseTimings?.writingMs ?? 0);
      assert.ok(
        Math.abs(sum - durationMs) <= 100,
        `Expected phase sum ${sum} near durationMs ${durationMs}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
