import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { NavigationDrawer } from "../components/NavigationDrawer";

describe("UI-038: Overlay mutual exclusion & session action sheet scrim/title", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    win = new GlobalWindow();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = win as any;
    globalThis.document = win.document as any;
    globalThis.localStorage = win.localStorage as any;
    globalThis.CustomEvent = win.CustomEvent as any;
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

  it("renders full untruncated session title, visible scrim, and closes when another overlay opens", () => {
    const longTitle = "Very Long Session Title That Should Never Be Truncated In The Action Sheet Header";
    act(() => {
      root.render(
        React.createElement(NavigationDrawer, {
          isOpen: true,
          onClose: () => {},
          activeTab: "chat",
          onSelectTab: () => {},
          threads: [
            {
              id: "t-1",
              title: longTitle,
              updatedAt: Date.now(),
              createdAt: Date.now(),
              messageCount: 2,
            } as any,
          ],
          activeThreadId: "t-1",
          onSelectThread: () => {},
          onNewThread: () => {},
          onDeleteThread: () => {},
        })
      );
    });

    // Open the action sheet via the thread's "..." button
    const moreBtn = container.querySelector("button[aria-label='Session options'], button[title='Session options'], button[data-testid='thread-more-t-1']")
      ?? Array.from(container.querySelectorAll("button")).find((b) => b.querySelector("svg") && b.getAttribute("aria-label")?.toLowerCase().includes("option"));
    assert.ok(moreBtn, "Thread action sheet trigger button should exist");

    act(() => {
      moreBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as any);
    });

    const sheet = container.querySelector("[data-testid='thread-action-sheet']");
    assert.ok(sheet, "Action sheet should be open");

    // Visible scrim check
    assert.ok(
      sheet!.className.includes("bg-black/60") || sheet!.className.includes("bg-black/65") || sheet!.className.includes("bg-black/70"),
      `Action sheet scrim should be visible (>= bg-black/60), got: ${sheet!.className}`
    );

    // Full untruncated title check
    const heading = sheet!.querySelector("h3");
    assert.ok(heading, "Action sheet heading should exist");
    assert.equal(heading!.textContent, longTitle);
    assert.ok(
      !heading!.className.includes("truncate"),
      `Action sheet heading must not have 'truncate', got: ${heading!.className}`
    );

    // Mutual exclusion: another overlay opens -> action sheet closes
    act(() => {
      win.dispatchEvent(new win.CustomEvent("ui:overlay-open", { detail: { source: "header-overflow" } }) as any);
    });

    const sheetAfter = container.querySelector("[data-testid='thread-action-sheet']");
    assert.equal(sheetAfter, null, "Action sheet should close when another overlay opens");
  });
});
