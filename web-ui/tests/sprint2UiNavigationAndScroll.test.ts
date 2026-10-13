import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ChatStream } from "../components/ChatStream";
import { ThreadsSidebar } from "../components/ThreadsSidebar";
import { NavigationDrawer } from "../components/NavigationDrawer";

describe("Sprint 12 Phase 6 — Sprint 2 UI Behavioral Test Suite (sprint2UiNavigationAndScroll.test.ts)", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root | null = null;
  let scrollIntoViewCalls: any[] = [];

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    win = new GlobalWindow({ url: "http://localhost:3000" });
    globalThis.window = win as any;
    globalThis.document = win.document as any;
    globalThis.localStorage = win.localStorage as any;

    scrollIntoViewCalls = [];
    (win.Element.prototype as any).scrollIntoView = function (opts: any) {
      scrollIntoViewCalls.push(opts);
    };

    const div = win.document.createElement("div");
    win.document.body.appendChild(div);
    container = div as unknown as HTMLDivElement;
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
  });

  it("Fix 3.1 & 3.2: ChatStream simulates scroll, shows/hides jump-to-bottom button without mid-flight flicker, and controls autoscroll", async () => {
    root = createRoot(container);

    let messages = [
      { id: "m1", role: "user" as const, content: "Initial user prompt" },
      { id: "m2", role: "assistant" as const, content: "First assistant reply" }
    ];

    const renderChat = (msgs: typeof messages) => {
      act(() => {
        root!.render(
          React.createElement(ChatStream, {
            messages: msgs,
            setMessages: () => {},
            onTracesUpdate: () => {},
            activeModel: "swift-27b-mtp",
            reasoningEffort: "medium",
            threadId: "test-thread-scroll"
          })
        );
      });
    };

    renderChat(messages);

    const scrollContainer = container.querySelector('[data-scroll-container="true"]') as HTMLDivElement;
    assert.ok(scrollContainer, "ChatStream must render a data-scroll-container element");

    let mockScrollHeight = 1000;
    let mockClientHeight = 500;
    let mockScrollTop = 500; // Initially at bottom: distanceFromBottom = 1000 - (500 + 500) = 0 <= 90

    Object.defineProperty(scrollContainer, "scrollHeight", {
      get: () => mockScrollHeight,
      configurable: true
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      get: () => mockClientHeight,
      configurable: true
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      get: () => mockScrollTop,
      set: (v) => { mockScrollTop = v; },
      configurable: true
    });

    // 1. At bottom: "Jump to bottom" button must NOT be present
    let jumpButton = container.querySelector('button[title="Jump to bottom"]');
    assert.equal(jumpButton, null, "Jump to bottom button must not render when user is at bottom");

    // 2. Simulate scrolling up (> 90px from bottom): scrollTop = 200 -> distanceFromBottom = 300
    mockScrollTop = 200;
    act(() => {
      scrollContainer.dispatchEvent(new win.Event("scroll") as any);
    });

    jumpButton = container.querySelector('button[title="Jump to bottom"]');
    assert.ok(jumpButton, "Jump to bottom button MUST appear when scrolled up > 90px from bottom");

    // 3. Simulate scrolling back to bottom (distanceFromBottom = 0 <= 90):
    mockScrollTop = 500;
    act(() => {
      scrollContainer.dispatchEvent(new win.Event("scroll") as any);
    });

    jumpButton = container.querySelector('button[title="Jump to bottom"]');
    assert.equal(jumpButton, null, "Jump to bottom button MUST disappear when user returns to bottom");

    // 4. Fix 3.2: Anti-flicker test during smooth scroll
    // Scroll up again
    mockScrollTop = 200;
    act(() => {
      scrollContainer.dispatchEvent(new win.Event("scroll") as any);
    });
    jumpButton = container.querySelector('button[title="Jump to bottom"]') as HTMLButtonElement;
    assert.ok(jumpButton, "Jump to bottom button is visible before click");

    // Click jump to bottom
    act(() => {
      (jumpButton as HTMLButtonElement).click();
    });
    // Immediately hidden
    assert.equal(container.querySelector('button[title="Jump to bottom"]'), null, "Button disappears immediately upon click");

    // Simulate mid-flight onScroll firing while distanceFromBottom > 90 before animation reaches bottom:
    act(() => {
      scrollContainer.dispatchEvent(new win.Event("scroll") as any);
    });
    assert.equal(
      container.querySelector('button[title="Jump to bottom"]'),
      null,
      "Fix 3.2: isProgrammaticScrollRef suppresses flicker during scroll animation"
    );

    // 5. Test autoscroll suppression while scrolled up:
    // Re-engage scrolled-up state without programmatic flag (wait until programmatic timer expires or reset state)
    mockScrollTop = 150;
    // Dispatch scroll with small timeout to ensure programmatic scroll ref cleared
    await new Promise((r) => setTimeout(r, 650));
    act(() => {
      scrollContainer.dispatchEvent(new win.Event("scroll") as any);
    });
    assert.ok(container.querySelector('button[title="Jump to bottom"]'), "Scrolled up state re-engaged");

    scrollIntoViewCalls = [];
    messages = [
      ...messages,
      { id: "m3", role: "assistant" as const, content: "Incoming streamed token while scrolled up" }
    ];
    renderChat(messages);
    assert.equal(
      scrollIntoViewCalls.length,
      0,
      "Autoscroll must NOT trigger when messages arrive while user is scrolled up"
    );

    // 6. Test autoscroll triggers when user is at bottom:
    mockScrollTop = 500;
    act(() => {
      scrollContainer.dispatchEvent(new win.Event("scroll") as any);
    });
    scrollIntoViewCalls = [];
    messages = [
      ...messages,
      { id: "m4", role: "assistant" as const, content: "Incoming token at bottom" }
    ];
    renderChat(messages);
    assert.ok(
      scrollIntoViewCalls.length > 0,
      "Autoscroll MUST trigger when messages arrive while user is at bottom"
    );
  });

  it("Fix 3.4: ThreadsSidebar renders navigation dock with aria-current on active view", () => {
    root = createRoot(container);

    const sampleThreads = [
      {
        id: "thread-1",
        title: "Test Thread",
        status: "active" as const,
        model: "swift-27b-mtp",
        reasoningEffort: "medium" as const,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];

    let navigatedView: string | null = null;

    act(() => {
      root!.render(
        React.createElement(ThreadsSidebar, {
          threads: sampleThreads,
          selectedThreadId: "thread-1",
          activeNavView: "sessions",
          onSelectThread: () => {},
          onNewThread: () => {},
          onNavigate: (view) => {
            navigatedView = view;
          },
          onOpenDrawer: () => {}
        })
      );
    });

    const sessionsBtn = container.querySelector('button[title="Sessions"]') as HTMLButtonElement;
    assert.ok(sessionsBtn);
    assert.equal(sessionsBtn.getAttribute("aria-current"), "page", "Active sessions button must have aria-current='page'");

    const reportBtn = container.querySelector('button[title="Morning report"]') as HTMLButtonElement;
    assert.ok(reportBtn);
    assert.equal(reportBtn.getAttribute("aria-current"), null, "Inactive report button must not have aria-current='page'");

    // Click report button
    act(() => {
      reportBtn.click();
    });
    assert.equal(navigatedView, "morning-report", "Clicking nav button triggers onNavigate callback");
  });

  it("NavigationDrawer renders mobile drawer with all navigation items and pending badge", () => {
    root = createRoot(container);

    act(() => {
      root!.render(
        React.createElement(NavigationDrawer, {
          isOpen: true,
          onClose: () => {},
          activeView: "sessions",
          onNavigate: () => {},
          onNewSession: () => {},
          pendingSkillsCount: 3
        })
      );
    });

    const textContent = container.textContent || "";
    assert.ok(textContent.includes("Sessions"), "Drawer must show Sessions");
    assert.ok(textContent.includes("Morning report"), "Drawer must show Morning report");
    assert.ok(textContent.includes("Settings"), "Drawer must show Settings");
    assert.ok(textContent.includes("3 pending"), "Drawer must display pending skills count");
  });
});
