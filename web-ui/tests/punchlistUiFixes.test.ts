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
