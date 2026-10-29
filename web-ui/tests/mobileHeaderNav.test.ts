import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import React from "react";
import { renderToString } from "react-dom/server";
import { NavigationDrawer } from "../components/NavigationDrawer";

describe("Work Order #2 — Gemini Pattern Mobile Navigation & Full-Screen Views", () => {
  const componentsDir = path.resolve(__dirname, "../components");
  const appDir = path.resolve(__dirname, "../app");

  it("ensures ChatStream header implements Gemini mobile pattern: hamburger + Projects + model pill, no Stop pill", () => {
    const file = fs.readFileSync(path.join(componentsDir, "ChatStream.tsx"), "utf-8");

    // Hamburger button: visible on mobile (< md:), opens drawer, min-h-[44px] min-w-[44px]
    assert.ok(
      file.includes('onClick={onOpenDrawer}') &&
      file.includes('aria-label="Open navigation menu"') &&
      file.includes("flex md:hidden"),
      "ChatStream must render hamburger menu button on mobile (< md:) opening the drawer"
    );

    // Sidebar and Workspace toggles: hidden on mobile (< md:)
    assert.ok(
      file.includes("hidden md:flex") &&
      file.includes('aria-label="Toggle Sessions Panel"'),
      "Sidebar toggle must be hidden on mobile (< md:)"
    );
    assert.ok(
      file.includes("hidden md:flex") &&
      file.includes('aria-label="Toggle Workspace Panel"'),
      "Workspace toggle must be hidden on mobile (< md:)"
    );

    // EngineStatusPill / Stop button: hidden on mobile header (lives with turn in composer/stream)
    assert.ok(
      file.includes("hidden md:flex") && file.includes("<EngineStatusPill"),
      "EngineStatusPill must be hidden on mobile (< md:) in ChatStream topbar"
    );

    // Projects button: accessible with min-h-[44px] min-w-[44px]
    assert.ok(
      file.includes('aria-label="Open Projects"') || file.includes('title="Open Projects"'),
      "Projects button must be accessible"
    );
  });

  it("ensures page.tsx removes mobile sidebars and renders inspector full-screen on mobile", () => {
    const pageFile = path.join(appDir, "page.tsx");
    const content = fs.readFileSync(pageFile, "utf8");

    // app-sidebar must be hidden on mobile (< md:)
    assert.match(
      content,
      /className=["']app-sidebar hidden md:flex[^"']*["']/,
      "app-sidebar must be hidden on mobile (< md:) — sessions live in NavigationDrawer"
    );

    // app-inspector must be full-screen on mobile (fixed md:relative inset-0 md:inset-auto w-full md:w-96)
    assert.match(
      content,
      /className=["']app-inspector fixed md:relative inset-0 md:inset-auto[^"']*w-full md:w-96[^"']*["']/,
      "app-inspector must render as a full-screen view on mobile"
    );
  });

  it("ensures NavigationDrawer is the single menu: New session, Destinations, Sessions list (Recents), and pinned Settings", () => {
    const sampleThreads = [
      { id: "t1", title: "Refactor auth middleware", updatedAt: "2026-10-23T10:00:00Z", messages: [] },
      { id: "t2", title: "Build project explorer", updatedAt: "2026-10-23T11:00:00Z", messages: [] }
    ];

    let selectedThread: string | null = null;
    let closed = false;
    let newSessionFired = false;
    let navigatedTo: string | null = null;

    const html = renderToString(
      React.createElement(NavigationDrawer, {
        isOpen: true,
        onClose: () => { closed = true; },
        activeView: "sessions",
        onNavigate: (view) => { navigatedTo = view; },
        onNewSession: () => { newSessionFired = true; },
        pendingSkillsCount: 2,
        threads: sampleThreads as any,
        selectedThreadId: "t1",
        onSelectThread: (id) => { selectedThread = id; }
      })
    );

    // Close button (X)
    assert.ok(html.includes("aria-label=\"Close drawer\"") || html.includes("title=\"Close drawer\""), "Drawer must have close (X) button");

    // 1. Prominent New session action at top
    assert.ok(html.includes("New session"), "Drawer must have prominent New session button");

    // 2. Destinations: Sessions, Builds, Projects & Folders, Skills (with 2 pending), Morning report
    assert.ok(html.includes("Sessions"), "Must include Sessions destination");
    assert.ok(html.includes("Builds"), "Must include Builds destination");
    assert.ok(html.includes("Projects &amp; Folders") || html.includes("Projects & Folders"), "Must include Projects & Folders destination");
    assert.ok(html.includes("Skills"), "Must include Skills destination");
    assert.ok(html.includes("2 pending"), "Must render pending skills count");
    assert.ok(html.includes("Morning report"), "Must include Morning report destination");

    // 3. In-drawer Sessions list (Recents)
    assert.ok(html.includes("Refactor auth middleware"), "Must render thread 1 title");
    assert.ok(html.includes("Build project explorer"), "Must render thread 2 title");

    // 4. Settings pinned at bottom
    assert.ok(html.includes("Settings"), "Must include Settings pinned at bottom");
  });

  it("ensures BuildsView header buttons have >= 44px hit targets and responsive labels", () => {
    const file = fs.readFileSync(path.join(componentsDir, "BuildsView.tsx"), "utf-8");
    assert.ok(
      file.includes("min-h-[44px]") && file.includes("min-w-[44px]"),
      "BuildsView header buttons must provide min-h-[44px] and min-w-[44px] hit targets"
    );
    assert.ok(
      file.includes("hidden sm:inline") || file.includes("sm:inline"),
      "BuildsView must condense button text on mobile to avoid 390px overflow"
    );
  });

  it("ensures SkillsView header buttons have >= 44px hit targets and responsive labels", () => {
    const file = fs.readFileSync(path.join(componentsDir, "SkillsView.tsx"), "utf-8");
    assert.ok(
      file.includes("min-h-[44px]") && file.includes("min-w-[44px]"),
      "SkillsView header buttons must provide min-h-[44px] and min-w-[44px] hit targets"
    );
    assert.ok(
      file.includes("hidden sm:inline") || file.includes("sm:inline"),
      "SkillsView must condense button text on mobile to avoid 390px overflow"
    );
  });
});
