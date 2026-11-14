import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ThinkingPanel } from "../components/ThinkingPanel";

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
    container = win.document.createElement("div");
    win.document.body.appendChild(container);
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
});
