// uir-2 Canvas: artifact canvas core logic (lib/canvas.ts).
//
// Tests-first for the UI refresh Phase 2 (Canvas). The pure logic lives in
// lib/canvas.ts so it is testable without a DOM: unified-diff splitting,
// full-diff row building with old/new line numbers (NO truncation — the
// canvas shows every line, unlike the capped trace-card preview), the
// feature-flag read, the unseen-update badge rule, and scroll capture /
// restore used by the mobile sheet's exact-position return to chat.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CanvasProvider } from "../components/CanvasContext";
import {
  ArtifactCanvasPane,
  CanvasDiffCard,
} from "../components/ArtifactCanvas";
import { CodeBlock } from "../components/ArtifactRenderers";
import {
  CANVAS_FLAG_KEY,
  isCanvasEnabled,
  artifactVersion,
  hasUnseenUpdate,
  countDiffLines,
  splitUnifiedDiff,
  diffTotals,
  buildDiffRows,
  availableViews,
  isPreviewable,
  captureScrollPosition,
  restoreScrollPosition,
  type CanvasArtifact,
} from "../lib/canvas";

const TWO_FILE_DIFF = [
  "diff --git a/src/LiveRunBlock.tsx b/src/LiveRunBlock.tsx",
  "index 1111111..2222222 100644",
  "--- a/src/LiveRunBlock.tsx",
  "+++ b/src/LiveRunBlock.tsx",
  "@@ -212,7 +212,9 @@ export function LiveRunBlock",
  " const rows = traces.map(t => (",
  "-  <TraceRow key={t.id} trace={t} />",
  "+  <TraceRow key={t.id} trace={t}",
  "+    live={isStreaming} />",
  " ));",
  "diff --git a/src/page.tsx b/src/page.tsx",
  "index 3333333..4444444 100644",
  "--- a/src/page.tsx",
  "+++ b/src/page.tsx",
  "@@ -10,3 +10,4 @@ export default function Page",
  " return (",
  "+  <Canvas />",
  " );",
  " }",
].join("\n");

describe("uir-2 canvas: feature flag", () => {
  it("is enabled by default when nothing is stored", () => {
    const storage = { getItem: (_k: string) => null };
    assert.equal(isCanvasEnabled(storage), true);
  });

  it("is disabled only by an explicit off value under the flag key", () => {
    for (const off of ["0", "false", "off"]) {
      const storage = {
        getItem: (k: string) => (k === CANVAS_FLAG_KEY ? off : null),
      };
      assert.equal(isCanvasEnabled(storage), false, `value ${off} must disable`);
    }
    const on = { getItem: (k: string) => (k === CANVAS_FLAG_KEY ? "1" : null) };
    assert.equal(isCanvasEnabled(on), true);
  });

  it("stays enabled when storage throws (private mode / SSR guard)", () => {
    const storage = {
      getItem: (_k: string): string | null => {
        throw new Error("storage unavailable");
      },
    };
    assert.equal(isCanvasEnabled(storage), true);
  });
});

describe("uir-2 canvas: unified diff splitting", () => {
  it("splits a combined diff into per-file sections with paths and counts", () => {
    const files = splitUnifiedDiff(TWO_FILE_DIFF);
    assert.equal(files.length, 2);
    assert.equal(files[0].path, "src/LiveRunBlock.tsx");
    assert.equal(files[0].addedLines, 2);
    assert.equal(files[0].removedLines, 1);
    assert.equal(files[1].path, "src/page.tsx");
    assert.equal(files[1].addedLines, 1);
    assert.equal(files[1].removedLines, 0);
    assert.ok(files[0].diff.includes("@@ -212,7 +212,9 @@"));
    assert.ok(!files[0].diff.includes("src/page.tsx"));
  });

  it("treats a headerless diff as a single file under the fallback path", () => {
    const bare = "@@ -1,2 +1,2 @@\n-old\n+new\n";
    const files = splitUnifiedDiff(bare, "src/one.ts");
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "src/one.ts");
    assert.equal(files[0].addedLines, 1);
    assert.equal(files[0].removedLines, 1);
  });

  it("returns no files for an empty diff", () => {
    assert.deepEqual(splitUnifiedDiff(""), []);
    assert.deepEqual(splitUnifiedDiff("   \n"), []);
  });

  it("diffTotals rolls up file count and line counts", () => {
    const totals = diffTotals(splitUnifiedDiff(TWO_FILE_DIFF));
    assert.deepEqual(totals, { fileCount: 2, addedLines: 3, removedLines: 1 });
  });

  it("countDiffLines ignores the ---/+++ header lines", () => {
    const counts = countDiffLines("--- a/x\n+++ b/x\n+a\n-b\n context\n");
    assert.deepEqual(counts, { addedLines: 1, removedLines: 1 });
  });
});

describe("uir-2 canvas: full diff rows with line numbers", () => {
  it("assigns old/new line numbers from hunk headers across multiple hunks", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -10,3 +10,4 @@ fn",
      " ctx-a",
      "-old",
      "+new-1",
      "+new-2",
      "@@ -30,2 +31,2 @@ other",
      " ctx-b",
      "-gone",
      "+back",
    ].join("\n");
    const rows = buildDiffRows(diff);
    const byText = new Map(rows.map((r) => [r.text, r]));
    assert.equal(byText.get("ctx-a")?.oldLine, 10);
    assert.equal(byText.get("ctx-a")?.newLine, 10);
    assert.equal(byText.get("old")?.kind, "del");
    assert.equal(byText.get("old")?.oldLine, 11);
    assert.equal(byText.get("old")?.newLine, null);
    assert.equal(byText.get("new-1")?.kind, "add");
    assert.equal(byText.get("new-1")?.newLine, 11);
    assert.equal(byText.get("new-2")?.newLine, 12);
    assert.equal(byText.get("ctx-b")?.oldLine, 30);
    assert.equal(byText.get("ctx-b")?.newLine, 31);
    assert.equal(byText.get("gone")?.oldLine, 31);
    assert.equal(byText.get("back")?.newLine, 32);
    assert.equal(byText.get("@@ -10,3 +10,4 @@ fn")?.kind, "hunk");
    assert.equal(byText.get("diff --git a/a.ts b/a.ts")?.kind, "meta");
  });

  it("never truncates: a 400-line diff yields a row for every line", () => {
    const body: string[] = ["@@ -1,400 +1,400 @@ big"];
    for (let i = 0; i < 400; i++) body.push(` line-${i}`);
    const diff = body.join("\n");
    const rows = buildDiffRows(diff);
    assert.equal(rows.length, 401);
    assert.equal(rows[400].text, "line-399");
    assert.equal(rows[400].oldLine, 400);
    assert.equal(rows[400].newLine, 400);
  });
});

describe("uir-2 canvas: artifact versions and the unseen-update badge", () => {
  const fileArtifact = (code: string): CanvasArtifact => ({
    kind: "file",
    id: "file:page.html",
    filename: "page.html",
    language: "html",
    code,
  });

  it("version is stable for identical content and changes when content changes", () => {
    assert.equal(artifactVersion(fileArtifact("<p>a</p>")), artifactVersion(fileArtifact("<p>a</p>")));
    assert.notEqual(artifactVersion(fileArtifact("<p>a</p>")), artifactVersion(fileArtifact("<p>b</p>")));
  });

  it("badge shows only when a seen artifact changed while the canvas is closed", () => {
    const v1 = artifactVersion(fileArtifact("<p>a</p>"));
    const v2 = artifactVersion(fileArtifact("<p>b</p>"));
    assert.equal(hasUnseenUpdate(undefined, v2, false), false, "never opened: no badge");
    assert.equal(hasUnseenUpdate(v1, v1, false), false, "unchanged: no badge");
    assert.equal(hasUnseenUpdate(v1, v2, false), true, "changed while closed: badge");
    assert.equal(hasUnseenUpdate(v1, v2, true), false, "changed while open: no badge");
  });
});

describe("uir-2 canvas: views per artifact", () => {
  it("an HTML file artifact offers preview and code; a diff artifact offers diff", () => {
    const html: CanvasArtifact = {
      kind: "file",
      id: "file:a.html",
      filename: "a.html",
      language: "html",
      code: "<html></html>",
    };
    assert.deepEqual(availableViews(html), ["preview", "code"]);
    const diff: CanvasArtifact = {
      kind: "diff",
      id: "diff:m1",
      title: "Changes",
      files: splitUnifiedDiff(TWO_FILE_DIFF),
    };
    assert.deepEqual(availableViews(diff), ["diff"]);
  });

  it("a plain code file offers code only", () => {
    const ts: CanvasArtifact = {
      kind: "file",
      id: "file:a.ts",
      filename: "a.ts",
      language: "typescript",
      code: "export const x = 1;",
    };
    assert.deepEqual(availableViews(ts), ["code"]);
  });

  it("isPreviewable matches the inline renderer's document classification", () => {
    assert.equal(isPreviewable("page.html", "html", "<p>x</p>"), true);
    assert.equal(isPreviewable(undefined, undefined, "<!DOCTYPE html><html></html>"), true);
    assert.equal(isPreviewable("icon.svg", "svg", "<svg></svg>"), true);
    assert.equal(isPreviewable("main.ts", "typescript", "const a = 1;"), false);
  });
});

describe("uir-2 canvas: UI wiring (source assertions)", () => {
  it("testGate maps the canvas sources to this suite", () => {
    const gate = fs.readFileSync(path.resolve(__dirname, "../lib/testGate.ts"), "utf8");
    assert.ok(
      gate.includes('"tests/uirCanvas.test.ts"'),
      "MAPPING_RULES must run tests/uirCanvas.test.ts for canvas changes"
    );
  });

  it("ChatStream mounts the canvas provider and pane around the chat column", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
    assert.ok(src.includes("CanvasProvider"), "ChatStream must wrap its tree in CanvasProvider");
    assert.ok(src.includes("ArtifactCanvasPane"), "ChatStream must mount the ArtifactCanvasPane");
    assert.ok(src.includes("CanvasDiffCard"), "ChatStream diff cards must offer the canvas diff door");
    assert.ok(src.includes("CanvasFileOpenButton"), "ChatStream file cards must offer the canvas open door");
  });

  it("CodeBlock cards carry the Open affordance and the update badge hook", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../components/ArtifactRenderers.tsx"), "utf8");
    assert.ok(src.includes('data-testid="canvas-open"'), "CodeBlock must render the canvas Open button");
    assert.ok(src.includes('data-testid="canvas-update-badge"'), "CodeBlock must render the unseen-update badge");
    assert.ok(src.includes("Open"), "the affordance is labelled Open");
  });
});

describe("uir-2 canvas: scroll capture and restore", () => {
  it("captures and restores the exact scrollTop of the chat container", () => {
    const el = { scrollTop: 1234 };
    const saved = captureScrollPosition(el);
    assert.equal(saved, 1234);
    el.scrollTop = 0;
    restoreScrollPosition(el, saved);
    assert.equal(el.scrollTop, 1234);
  });

  it("is a no-op for a missing element", () => {
    assert.equal(captureScrollPosition(null), 0);
    restoreScrollPosition(null, 500);
    restoreScrollPosition(undefined, 500);
  });
});

describe("uir-2 canvas: rendered UI", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root | null = null;
  let scrollEl: HTMLDivElement;
  let scrollRef: { current: HTMLDivElement | null };

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    win = new GlobalWindow({ url: "http://localhost:3000" });
    (globalThis as any).window = win;
    (globalThis as any).document = win.document;
    (globalThis as any).localStorage = win.localStorage;
    container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(container);
    scrollEl = win.document.createElement("div") as unknown as HTMLDivElement;
    scrollRef = { current: scrollEl };
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    root = null;
    win.localStorage.clear();
  });

  const renderTree = async (tree: React.ReactNode) => {
    if (!root) root = createRoot(container);
    await act(async () => {
      root!.render(tree as React.ReactElement);
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  const click = async (el: Element | null) => {
    assert.ok(el, "element to click must exist");
    await act(async () => {
      (el as HTMLElement).click();
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  it("code card Open opens the pane (filename + Preview/Code tabs); closing restores the exact chat scroll position", async () => {
    scrollEl.scrollTop = 777;
    await renderTree(
      React.createElement(
        CanvasProvider,
        { scrollElRef: scrollRef },
        React.createElement(CodeBlock, {
          language: "html",
          code: "<html><body>v1</body></html>",
          filename: "page.html",
        }),
        React.createElement(ArtifactCanvasPane)
      )
    );

    const openBtn = container.querySelector('[data-testid="canvas-open"]');
    assert.ok(openBtn, "Open affordance renders on the artifact card");
    assert.equal(
      container.querySelector('[data-testid="canvas-update-badge"]'),
      null,
      "no update badge before the artifact is ever opened"
    );

    await click(openBtn);
    const pane = container.querySelector('[data-testid="canvas-pane"]');
    assert.ok(pane, "canvas pane opens");
    assert.ok(pane!.textContent?.includes("page.html"), "pane header shows the filename");
    const tabLabels = Array.from(
      container.querySelectorAll('[data-testid="canvas-tab"]')
    ).map((t) => t.textContent);
    assert.deepEqual(
      [...new Set(tabLabels)],
      ["Preview", "Code"],
      "the artifact offers exactly its Preview and Code views"
    );

    // The sheet opening must not lose the chat position: simulate the
    // container being reset while the canvas is up, then close via ‹ Chat.
    scrollEl.scrollTop = 0;
    await click(container.querySelector('[data-testid="canvas-close"]'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    assert.equal(
      container.querySelector('[data-testid="canvas-pane"]'),
      null,
      "pane closes"
    );
    assert.equal(scrollEl.scrollTop, 777, "exact prior scroll position restored");
  });

  it("shows the Updated badge when a seen artifact changes while the canvas is closed", async () => {
    const tree = (code: string) =>
      React.createElement(
        CanvasProvider,
        { scrollElRef: scrollRef },
        React.createElement(CodeBlock, { language: "html", code, filename: "page.html" }),
        React.createElement(ArtifactCanvasPane)
      );
    await renderTree(tree("<html><body>v1</body></html>"));
    await click(container.querySelector('[data-testid="canvas-open"]'));
    await click(container.querySelector('[data-testid="canvas-close"]'));

    await renderTree(tree("<html><body>v2</body></html>"));
    const badge = container.querySelector('[data-testid="canvas-update-badge"]');
    assert.ok(badge, "badge appears after the artifact changed while closed");
    assert.ok(badge!.textContent?.includes("Updated"), "badge says Updated");
    assert.ok(badge!.textContent?.includes("file changed"), "badge says file changed");
  });

  it("diff card opens the FULL diff — every row, file chips and rail, no truncation", async () => {
    const bigBody: string[] = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,400 +1,400 @@ big",
    ];
    for (let i = 0; i < 400; i++) bigBody.push(` line-${i}`);
    const diffs = [
      { path: "src/a.ts", diff: bigBody.join("\n"), addedLines: 0, removedLines: 0 },
      {
        path: "src/b.ts",
        diff: "@@ -1,1 +1,1 @@\n-old\n+new",
        addedLines: 1,
        removedLines: 1,
      },
    ];
    await renderTree(
      React.createElement(
        CanvasProvider,
        { scrollElRef: scrollRef },
        React.createElement(CanvasDiffCard, { diffs }),
        React.createElement(ArtifactCanvasPane)
      )
    );

    const card = container.querySelector('[data-testid="canvas-diff-card"]');
    assert.ok(card, "diff summary card renders");
    assert.ok(card!.textContent?.includes("2 files changed"), "card counts the files");

    await click(container.querySelector('[data-testid="canvas-diff-open"]'));
    assert.ok(container.querySelector('[data-testid="canvas-pane"]'), "pane opens");
    assert.equal(
      container.querySelectorAll('[data-testid="canvas-diff-chip"]').length,
      2,
      "mobile file chips: one per file"
    );
    assert.equal(
      container.querySelectorAll('[data-testid="canvas-diff-rail-file"]').length,
      2,
      "desktop file rail: one entry per file"
    );
    assert.equal(
      container.querySelectorAll('[data-testid="canvas-diff-row"]').length,
      404,
      "full diff renders a row for every line (4 header/hunk + 400 body)"
    );

    const chips = container.querySelectorAll('[data-testid="canvas-diff-chip"]');
    await click(chips[1]);
    assert.equal(
      container.querySelectorAll('[data-testid="canvas-diff-row"]').length,
      3,
      "switching files swaps the rendered full diff"
    );
  });

  it("feature flag off removes the Open affordance (inline rendering is the fallback)", async () => {
    win.localStorage.setItem("las.canvas.enabled", "0");
    await renderTree(
      React.createElement(
        CanvasProvider,
        { scrollElRef: scrollRef },
        React.createElement(CodeBlock, {
          language: "html",
          code: "<html><body>v1</body></html>",
          filename: "page.html",
        }),
        React.createElement(ArtifactCanvasPane)
      )
    );
    assert.equal(
      container.querySelector('[data-testid="canvas-open"]'),
      null,
      "no Open button when the canvas flag is off"
    );
    assert.ok(container.innerHTML.includes("page.html"), "inline card still renders");
  });
});
