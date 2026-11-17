import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const componentsDir = path.join(process.cwd(), "components");
const thinkingPanel = fs.readFileSync(path.join(componentsDir, "ThinkingPanel.tsx"), "utf8");

describe("UI-049 — ThinkingPanel header does not squeeze title on 390px phone", () => {
  it("hides verbose 'Thought process · ' prefix on mobile and allows header pills to wrap/yield", () => {
    const idx = thinkingPanel.indexOf('data-testid="thinking-panel-title"');
    assert.ok(idx >= 0, "thinking-panel-title present");
    const headerSlice = thinkingPanel.slice(Math.max(0, idx - 500), idx + 1500);
    assert.ok(
      headerSlice.includes("hidden sm:inline\">Thought process"),
      "Thought process prefix should be hidden sm:inline on mobile",
    );
    assert.ok(
      headerSlice.includes("flex-wrap"),
      "ThinkingPanel header row should allow wrapping on narrow viewports",
    );
  });
});

const diffViewer = fs.readFileSync(path.join(componentsDir, "DiffViewer.tsx"), "utf8");
const chatStream = fs.readFileSync(path.join(componentsDir, "ChatStream.tsx"), "utf8");

describe("UI-052 — DiffViewer and inline code chips prevent mobile horizontal overflow", () => {
  it("DiffViewer header constrains path width with min-w-0/truncate and keeps +/- badges shrink-0", () => {
    assert.ok(diffViewer.includes("max-w-full min-w-0"), "DiffViewer root should have max-w-full min-w-0");
    assert.ok(diffViewer.includes("truncate min-w-0"), "DiffViewer branch/path label should truncate with min-w-0");
    assert.ok(diffViewer.includes("ml-2 shrink-0"), "DiffViewer +/- badge container should be shrink-0");
  });

  it("ChatStream inline code chips wrap long tokens with break-all", () => {
    const idx = chatStream.indexOf("bg-slate-100 dark:bg-zinc-800 text-emerald-700 dark:text-emerald-400 font-mono text-xs");
    assert.ok(idx >= 0, "inline code className found");
    const line = chatStream.slice(idx, idx + 200);
    assert.ok(line.includes("break-all"), "inline code chip should include break-all");
  });
});

describe("UI-053 & UI-054 — Jump to bottom pill does not occlude content & thread padding is balanced", () => {
  it("Jump to bottom pill docks above composer without negative top margin (-mt-14)", () => {
    const idx = chatStream.indexOf('Floating "Jump to bottom" button');
    assert.ok(idx >= 0, "Jump to bottom comment found");
    const slice = chatStream.slice(idx, idx + 300);
    assert.ok(!slice.includes("-mt-14"), "Jump to bottom wrapper must not use -mt-14");
  });

  it("ChatStream scroll container and chat-track use balanced top/bottom padding", () => {
    const idx = chatStream.indexOf('data-scroll-container="true"');
    assert.ok(idx >= 0, "scroll container found");
    const slice = chatStream.slice(idx, idx + 300);
    assert.ok(slice.includes("pt-[16px] pb-4 sm:px-6 sm:pt-4 sm:pb-6"), "scroll container has balanced top/bottom padding");
    assert.ok(slice.includes("pb-16 sm:pb-20"), "chat-track has clean bottom clearance");
  });
});

describe("UI-055 — DiffViewer exposes a Canvas affordance on mobile and desktop", () => {
  it("DiffViewer imports useCanvas and renders an Open in Canvas button", () => {
    assert.ok(diffViewer.includes("useCanvas"), "DiffViewer should call useCanvas");
    assert.ok(diffViewer.includes("openCanvas("), "DiffViewer should call canvas.openCanvas");
    assert.ok(diffViewer.includes("Open in Canvas"), "DiffViewer should have an accessible Open in Canvas label/title");
    assert.equal(
      diffViewer.includes('<span className="hidden sm:inline">Canvas</span>'),
      false,
      "DiffViewer Canvas label must be visible on mobile (not hidden sm:inline)"
    );
    assert.ok(diffViewer.includes("<span>Canvas</span>"), "DiffViewer Canvas button must render visible Canvas text label");
  });
});

const nextConfigSrc = fs.readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");

describe("UI-056 — HTML document cache headers prevent stale JS bundles across deploys", () => {
  it("next.config.ts sets no-cache, no-store, must-revalidate on HTML routes", () => {
    assert.ok(nextConfigSrc.includes("async headers()"), "next.config.ts should define async headers()");
    assert.ok(
      nextConfigSrc.includes("no-cache, no-store, must-revalidate"),
      "next.config.ts should set Cache-Control: no-cache, no-store, must-revalidate on non-static routes",
    );
  });
});
