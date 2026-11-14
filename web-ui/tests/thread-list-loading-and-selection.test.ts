import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webUiRoot = path.resolve(__dirname, "..");

describe("B2: Loading state + initial selection parity", () => {
  it("page.tsx tracks isLoadingThreads and auto-selects most recent thread on mobile and desktop", () => {
    const pageSrc = fs.readFileSync(path.join(webUiRoot, "app", "page.tsx"), "utf8");
    assert.ok(pageSrc.includes("isLoadingThreads"), "page.tsx must define isLoadingThreads state");
    assert.ok(
      !pageSrc.includes("else if (!isMobile && data.threads[0])"),
      "page.tsx must not skip auto-selection on mobile"
    );
    assert.ok(pageSrc.includes("data.threads[0]"), "page.tsx must auto-select data.threads[0]");
  });

  it("ThreadsSidebar.tsx renders loading placeholders when isLoadingThreads is true instead of No sessions yet", () => {
    const src = fs.readFileSync(path.join(webUiRoot, "components", "ThreadsSidebar.tsx"), "utf8");
    assert.ok(src.includes("isLoadingThreads"), "ThreadsSidebar.tsx must accept isLoadingThreads");
    assert.ok(src.includes("animate-pulse"), "ThreadsSidebar.tsx must render loading skeleton placeholders");
  });

  it("NavigationDrawer.tsx renders loading placeholders when isLoadingThreads is true instead of No sessions yet", () => {
    const src = fs.readFileSync(path.join(webUiRoot, "components", "NavigationDrawer.tsx"), "utf8");
    assert.ok(src.includes("isLoadingThreads"), "NavigationDrawer.tsx must accept isLoadingThreads");
    assert.ok(src.includes("animate-pulse"), "NavigationDrawer.tsx must render loading skeleton placeholders");
  });
});
