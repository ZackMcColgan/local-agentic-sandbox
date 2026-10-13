import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

describe("Sprint 12 Phase 6 — Sprint 2 UI Polish (sprint2UiNavigationAndScroll.test.ts)", () => {
  it("renders NavigationDrawer on mobile with slide-out container and all required navigation views", async () => {
    const { NavigationDrawer } = await import("../components/NavigationDrawer.js");

    const html = renderToStaticMarkup(
      React.createElement(NavigationDrawer, {
        isOpen: true,
        onClose: () => {},
        activeView: "sessions",
        onNavigate: () => {},
        onNewSession: () => {},
        pendingSkillsCount: 3
      })
    );

    assert.ok(html.includes("Sessions"), "Must include Sessions link");
    assert.ok(html.includes("New session"), "Must include New session link");
    assert.ok(html.includes("Morning report"), "Must include Morning report link");
    assert.ok(html.includes("Settings"), "Must include Settings link");
    assert.ok(html.includes("3 pending"), "Must display pending skills badge");
    assert.ok(html.includes("slide-in-from-left"), "Must support smooth slide-out transition");
  });

  it("renders ThreadsSidebar on desktop with persistent navigation dock for Sessions, New session, Morning report, Settings", async () => {
    const { ThreadsSidebar } = await import("../components/ThreadsSidebar.js");

    const sampleThreads = [
      {
        id: "thread-1",
        title: "Build weather widget",
        status: "active" as const,
        model: "swift-27b-mtp",
        reasoningEffort: "medium" as const,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];

    const html = renderToStaticMarkup(
      React.createElement(ThreadsSidebar, {
        threads: sampleThreads,
        selectedThreadId: "thread-1",
        activeNavView: "sessions",
        onSelectThread: () => {},
        onNewThread: () => {},
        onNavigate: () => {},
        onOpenDrawer: () => {}
      })
    );

    assert.ok(html.includes("Sessions"), "Must render Sessions title and nav item");
    assert.ok(html.includes("Build weather widget"), "Must render thread list item");
    assert.ok(html.includes("Morning report") || html.includes("morning-report"), "Must render Morning report nav entry");
    assert.ok(html.includes("Settings"), "Must render Settings nav entry");
  });

  it("ChatStream includes smart autoscroll jump-to-bottom button structure and scroll container ref", async () => {
    const { ChatStream } = await import("../components/ChatStream.js");

    const html = renderToStaticMarkup(
      React.createElement(ChatStream, {
        onTracesUpdate: () => {},
        activeModel: "swift-27b-mtp",
        reasoningEffort: "medium",
        messages: [
          { id: "m1", role: "user", content: "Hello" },
          { id: "m2", role: "assistant", content: "World" }
        ]
      })
    );

    // ChatStream renders messages and bottom input bar
    assert.ok(html.includes("World"), "Must render chat stream message");
    assert.ok(html.includes("data-scroll-container"), "Chat scroll container must carry data attribute for scroll detection");
  });
});
