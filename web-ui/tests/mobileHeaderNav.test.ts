import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

describe("Mobile Header Navigation & 390px Viewport Touch Targets", () => {
  const componentsDir = path.resolve(__dirname, "../components");

  it("ensures ChatStream header buttons have >= 44px hit targets and clean mobile layout", () => {
    const file = fs.readFileSync(path.join(componentsDir, "ChatStream.tsx"), "utf-8");
    assert.ok(
      file.includes("min-h-[44px]") && file.includes("min-w-[44px]"),
      "ChatStream header buttons must provide min-h-[44px] and min-w-[44px] hit targets"
    );
    assert.ok(
      file.includes('aria-label="Toggle Sessions Panel"') || file.includes('aria-label="Toggle sidebar"'),
      "ChatStream must have accessible aria-label on sidebar toggle"
    );
  });

  it("ensures ThreadsSidebar header buttons have >= 44px hit targets and touch accessibility", () => {
    const file = fs.readFileSync(path.join(componentsDir, "ThreadsSidebar.tsx"), "utf-8");
    assert.ok(
      file.includes("min-h-[44px]") && file.includes("min-w-[44px]"),
      "ThreadsSidebar header buttons must provide min-h-[44px] and min-w-[44px] hit targets"
    );
    assert.ok(
      file.includes('aria-label="New session"') || file.includes('aria-label="New chat thread"'),
      "ThreadsSidebar must have accessible new thread action"
    );
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
