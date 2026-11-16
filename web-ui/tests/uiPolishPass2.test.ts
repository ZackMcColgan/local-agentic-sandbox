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
