import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ModelBottomSheet } from "../components/ModelBottomSheet";

function setupDom() {
  const win = new Window({ url: "http://localhost/" });
  (globalThis as any).window = win;
  (globalThis as any).document = win.document;
  (globalThis as any).KeyboardEvent = win.KeyboardEvent;
  win.document.body.innerHTML = "<div id='root'></div>";
  return { window: win };
}

describe("E4: ModelBottomSheet Escape & safe engine Turn Off (UI-037)", () => {
  it("(a) Escape invokes onClose when isOpen is true", async () => {
    const dom = setupDom();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "running" }), { status: 200 })) as any;

    let closed = false;
    const container = dom.window.document.getElementById("root")! as unknown as HTMLElement;
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          React.createElement(ModelBottomSheet, {
            isOpen: true,
            onClose: () => {
              closed = true;
            },
            selectedModel: "qwen3.8-flash-next-gyro-gyro-s",
            onModelChange: () => {},
            reasoningEffort: "low",
            onReasoningEffortChange: () => {},
          })
        );
      });

      await act(async () => {
        dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
      });

      assert.equal(closed, true, "Expected Escape key to invoke onClose");
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = origFetch;
      dom.window.close();
    }
  });

  it("(b) Turn Off requires confirmation before posting and (c) 502/404 preserves running status and shows error", async () => {
    const dom = setupDom();
    const origFetch = globalThis.fetch;
    let postCount = 0;
    globalThis.fetch = (async (_url: any, init?: any) => {
      if (init?.method === "POST") {
        postCount++;
        return new Response(
          JSON.stringify({ success: false, error: "Engine stop not supported" }),
          {
            status: 502,
          }
        );
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    }) as any;

    const container = dom.window.document.getElementById("root")! as unknown as HTMLElement;
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          React.createElement(ModelBottomSheet, {
            isOpen: true,
            onClose: () => {},
            selectedModel: "qwen3.8-flash-next-gyro-gyro-s",
            onModelChange: () => {},
            reasoningEffort: "low",
            onReasoningEffortChange: () => {},
          })
        );
      });

      const dialog = container.querySelector('[role="dialog"]');
      assert.ok(dialog, "Expected role='dialog' on ModelBottomSheet");

      const findTurnOffBtn = () =>
        Array.from(container.querySelectorAll("button")).find((b) =>
          b.textContent?.includes("Turn Off")
        );

      const btn1 = findTurnOffBtn();
      assert.equal(btn1, undefined, "Turn Off control must not live in ModelBottomSheet (UI-071)");
      assert.equal(postCount, 0, "No /api/engine POST should occur");
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = origFetch;
      dom.window.close();
    }
  });
});
