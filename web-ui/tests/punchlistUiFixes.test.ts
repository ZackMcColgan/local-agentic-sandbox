import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

function findRepoRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../..")
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "web-ui"))) {
      return dir;
    }
  }
  return process.cwd();
}

describe("Flash 3.8 Frontend Shakeout — Fix 1: UI-P0-3 Composer Chat | Build Routing & Scope Cleanup", () => {
  it("ChatStream does NOT define or export BUILDER_PROMPT_REGEX or isBuilderPrompt", async () => {
    const chatStreamFile = path.resolve(findRepoRoot(), "web-ui/components/ChatStream.tsx");
    const content = fs.readFileSync(chatStreamFile, "utf8");

    assert.doesNotMatch(
      content,
      /BUILDER_PROMPT_REGEX/,
      "BUILDER_PROMPT_REGEX must be completely deleted from ChatStream.tsx (Anti-Shit Protocol Rule 3)"
    );
    assert.doesNotMatch(
      content,
      /function\s+isBuilderPrompt/,
      "isBuilderPrompt function must be completely removed from ChatStream.tsx"
    );
    assert.doesNotMatch(
      content,
      /isBuilderPrompt\s*\(/,
      "There must be zero call sites of isBuilderPrompt in ChatStream.tsx"
    );
  });

  it("handleSend routes to builder ONLY when composerMode === 'build' or prompt starts with '/build '", async () => {
    const chatStreamFile = path.resolve(findRepoRoot(), "web-ui/components/ChatStream.tsx");
    const content = fs.readFileSync(chatStreamFile, "utf8");

    // Must determine isBuilder solely from composerMode and /build prefix
    assert.match(
      content,
      /const\s+isBuilder\s*=\s*composerMode\s*===\s*["']build["']\s*\|\|\s*isBuildPrefix;/,
      "isBuilder must strictly check composerMode === 'build' || isBuildPrefix without prompt regex hijacking"
    );

    // selectedScope state must be purged in favor of initialScope directly
    assert.doesNotMatch(
      content,
      /const\s*\[selectedScope,\s*setSelectedScope\]/,
      "selectedScope state must be removed since scope is passed via initialScope"
    );
  });
});

describe("Flash 3.8 Frontend Shakeout — Fix 2: UI-P1-4 & UI-P2-1 Ultrawide 840px Track & Banned Color Tokens", () => {
  it("ChatStream uses max-w-[840px] and has zero occurrences of max-w-2xl", () => {
    const chatStreamFile = path.resolve(findRepoRoot(), "web-ui/components/ChatStream.tsx");
    const content = fs.readFileSync(chatStreamFile, "utf8");

    assert.doesNotMatch(
      content,
      /max-w-2xl/,
      "max-w-2xl must be replaced with max-w-[840px] across all message and composer tracks"
    );
  });

  it("ChatStream and LiveRunBlock have zero occurrences of banned purple/indigo tokens (#5b32e6, #3b0799)", () => {
    const chatStreamFile = path.resolve(findRepoRoot(), "web-ui/components/ChatStream.tsx");
    const liveRunFile = path.resolve(findRepoRoot(), "web-ui/components/LiveRunBlock.tsx");
    const csContent = fs.readFileSync(chatStreamFile, "utf8");
    const lrbContent = fs.readFileSync(liveRunFile, "utf8");

    assert.doesNotMatch(csContent, /#5b32e6/i, "ChatStream.tsx must not contain #5b32e6");
    assert.doesNotMatch(csContent, /bg-purple-/i, "ChatStream.tsx must not contain bg-purple- classes");
    assert.doesNotMatch(csContent, /text-indigo-/i, "ChatStream.tsx must not contain text-indigo- classes");
    assert.doesNotMatch(csContent, /bg-indigo-/i, "ChatStream.tsx must not contain bg-indigo- classes");

    assert.doesNotMatch(lrbContent, /#5b32e6/i, "LiveRunBlock.tsx must not contain #5b32e6");
    assert.doesNotMatch(lrbContent, /#3b0799/i, "LiveRunBlock.tsx must not contain #3b0799");
    assert.doesNotMatch(lrbContent, /text-indigo-/i, "LiveRunBlock.tsx must not contain text-indigo- classes");
  });
});

describe("Flash 3.8 Frontend Shakeout — Fix 3: UI-P0-1 & UI-P0-2 Mobile Slide-Over Drawers & Z-Index Stacking", () => {
  it("app-main remains visible on mobile without selectedThreadId hidden deadlock", () => {
    const pageFile = path.resolve(findRepoRoot(), "web-ui/app/page.tsx");
    const content = fs.readFileSync(pageFile, "utf8");

    assert.doesNotMatch(
      content,
      /selectedThreadId\s*===\s*null\s*&&\s*isSidebarOpen\s*\?\s*["']hidden md:flex["']/,
      "app-main must never be hidden on mobile when selectedThreadId === null"
    );
    assert.match(
      content,
      /className=["']app-main flex flex-1 min-h-0 flex-col h-full overflow-hidden bg-white dark:bg-zinc-950["']/,
      "app-main must always be flex flex-1 min-h-0 flex-col h-full overflow-hidden bg-white dark:bg-zinc-950"
    );
  });

  it("app-sidebar and app-inspector use fixed md:relative slide-over styling with z-50 above backdrop z-40", () => {
    const pageFile = path.resolve(findRepoRoot(), "web-ui/app/page.tsx");
    const content = fs.readFileSync(pageFile, "utf8");

    // app-sidebar must be fixed on mobile with z-50
    assert.match(
      content,
      /className=["']app-sidebar fixed md:relative inset-y-0 left-0 [^"']*z-50 md:z-10[^"']*["']/,
      "app-sidebar must render as a fixed slide-over drawer with z-50 md:z-10 on mobile"
    );

    // app-inspector must be fixed on mobile with z-50
    assert.match(
      content,
      /className=["']app-inspector fixed md:relative right-0 top-0 bottom-0 [^"']*z-50 md:z-20[^"']*["']/,
      "app-inspector must render as a fixed slide-over drawer with z-50 md:z-20 on mobile"
    );

    // mobile-backdrop must be z-40 and close both drawers on click
    assert.match(
      content,
      /mobile-backdrop\s+\$\{\s*\(isSidebarOpen\s*\|\|\s*isWorkspaceOpen\)\s*\?\s*["']block md:hidden["']\s*:\s*["']hidden["']\s*\}\s*fixed inset-0 bg-black\/60 z-40 md:hidden/,
      "mobile-backdrop must render at z-40 when either sidebar or workspace is open on mobile"
    );
    assert.doesNotMatch(
      content,
      /mobile-backdrop[^"']*backdrop-blur/,
      "mobile-backdrop must not apply backdrop-blur over lower z-index drawers"
    );
  });
});

describe("Flash 3.8 Frontend Shakeout — Fix 4: UI-P0-4 & UI-P2-2 Fake Telemetry Purge & Honest Workspace Tabs", () => {
  it("page.tsx has zero fake telemetry strings and fake file diffs", () => {
    const pageFile = path.resolve(findRepoRoot(), "web-ui/app/page.tsx");
    const content = fs.readFileSync(pageFile, "utf8");

    assert.doesNotMatch(content, /6 passed in 0\.21s/, "page.tsx must not contain fake '6 passed in 0.21s'");
    assert.doesNotMatch(content, /Zero gate failures detected/, "page.tsx must not contain fake gate failure string");
    assert.doesNotMatch(content, /workspace\/csv_parser\.py/, "page.tsx must not contain fake planned deliverables");
    assert.doesNotMatch(content, /diff --git a\/workspace\/output\.ts/, "page.tsx must not contain fake output.ts diff");
  });

  it("page.tsx renders honest empty states for diff, output, and files tabs", () => {
    const pageFile = path.resolve(findRepoRoot(), "web-ui/app/page.tsx");
    const content = fs.readFileSync(pageFile, "utf8");

    assert.match(content, /No test output recorded yet/, "page.tsx must display honest empty state when no output");
    assert.match(content, /No file diffs recorded for this run/, "page.tsx must display honest empty state when no diff");
    assert.match(content, /No workspace files modified yet/, "page.tsx must display honest empty state when no files");
  });

  it("DiffViewer defaults to open (isOpen = true)", () => {
    const diffViewerFile = path.resolve(findRepoRoot(), "web-ui/components/DiffViewer.tsx");
    const content = fs.readFileSync(diffViewerFile, "utf8");

    assert.match(content, /useState\(true\)/, "DiffViewer must initialize isOpen = true by default");
  });
});

describe("Flash 3.8 Frontend Shakeout — Fix 5: UI-P1-1 Honest BuildsView Gate & Deploy Status", () => {
  it("BuildsView has zero hardcoded fake status strings or fake branch names", () => {
    const buildsFile = path.resolve(findRepoRoot(), "web-ui/components/BuildsView.tsx");
    const content = fs.readFileSync(buildsFile, "utf8");

    assert.doesNotMatch(content, /feat\/task-autonomy-a1/, "BuildsView must not contain hardcoded task-autonomy-a1 branch");
    assert.doesNotMatch(content, /test:gate Green/, "BuildsView must not contain hardcoded 'test:gate Green' badge");
    assert.doesNotMatch(content, /test:gate Passed/, "BuildsView must not contain hardcoded 'test:gate Passed' tile");
    assert.doesNotMatch(content, /HTTP 200 Verified/, "BuildsView must not contain hardcoded 'HTTP 200 Verified' tile");
  });
});

describe("Flash 3.8 Frontend Shakeout — Fix 6: UI-P1-2 Theme Synchronization & Key Consistency", () => {
  it("layout.tsx and morning-report page.tsx check both app-theme and theme keys", () => {
    const layoutFile = path.resolve(findRepoRoot(), "web-ui/app/layout.tsx");
    const mrFile = path.resolve(findRepoRoot(), "web-ui/app/morning-report/page.tsx");
    const layoutContent = fs.readFileSync(layoutFile, "utf8");
    const mrContent = fs.readFileSync(mrFile, "utf8");

    assert.match(
      layoutContent,
      /localStorage\.getItem\(['"]app-theme['"]\)\s*\|\|\s*localStorage\.getItem\(['"]theme['"]\)/,
      "layout.tsx must check both app-theme and theme localStorage keys"
    );

    assert.match(
      mrContent,
      /localStorage\.getItem\(['"]app-theme['"]\)\s*\|\|\s*localStorage\.getItem\(['"]theme['"]\)/,
      "morning-report/page.tsx must check both app-theme and theme localStorage keys"
    );
  });
});

