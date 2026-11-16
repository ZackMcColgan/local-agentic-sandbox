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
