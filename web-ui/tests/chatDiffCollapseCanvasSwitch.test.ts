// UI-023 + UI-024 (owner-reported Nov 13, 2026, phone tap-through of prod 9d94628):
//
// UI-023 — chat diff cards must start COLLAPSED. DiffViewer defaults to open
// (useState(true)) and ChatStream passed no default, so every per-file diff in
// every assistant message rendered its full body inline. The fix: DiffViewer
// gains a `defaultOpen` prop (default true, so ProjectsView and the workspace
// inspector keep their behavior) and ChatStream's chat diff cards pass
// defaultOpen={false}.
//
// UI-024 — in the Canvas "Changes" view, switching files at the top did not
// change the displayed file. Root cause is DATA, not selection mechanics:
// trace-derived diffs (brand-new files) are capped at a 40-line diffPreview,
// and ChatStream fed the canvas only that preview. The owner's repro turn
// (thread-1794558725769-luei) wrote the same 177-line HTML file to two paths
// whose first 40 lines are byte-identical (first difference at line 76), so
// both canvas files rendered the exact same body. The fix: the extractor also
// returns the uncapped `diffFull`, ChatStream hands the canvas diffFull (the
// inline card keeps the capped preview), and canvas file chips/rail labels
// use a basename that splits on Windows backslashes as well as slashes.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { extractFileWriteDiffsFromTraces } from "../lib/chatUtils";
import { CanvasProvider } from "../components/CanvasContext";
import { ArtifactCanvasPane, CanvasDiffCard } from "../components/ArtifactCanvas";
import { DiffViewer } from "../components/DiffViewer";

const webUiDir = process.cwd();
const chatStreamSrc = fs.readFileSync(path.join(webUiDir, "components/ChatStream.tsx"), "utf8");
const diffViewerSrc = fs.readFileSync(path.join(webUiDir, "components/DiffViewer.tsx"), "utf8");

// Two 90-line file bodies, identical for the first 75 lines, first real
// difference at line 76 — the shape of the owner's repro turn, shrunk.
function makeContent(marker: string): string {
  const lines: string[] = [];
  for (let i = 1; i <= 90; i++) {
    lines.push(i === 76 ? `<caption>${marker}</caption>` : `<div>shared line ${i}</div>`);
  }
  return lines.join("\n");
}

const PATH_A = ".agent/threads/thread-x/files/weather-spanish-fort.html";
const PATH_B = "D:\\AI\\orchestrator-scratch\\weather-spanish-fort.html";

function reproTraces() {
  return [
    {
      tool: "workspace_write_file",
      args: { path: PATH_A, content: makeContent("FILE-ONE-MARKER") },
      status: "ok",
    },
    {
      tool: "host_write_file",
      args: { path: PATH_B, content: makeContent("FILE-TWO-MARKER") },
      status: "ok",
    },
  ];
}

describe("UI-024 — extractor returns the full diff alongside the capped preview", () => {
  it("keeps diffPreview capped at 40 lines (inline card stays compact)", () => {
    const items = extractFileWriteDiffsFromTraces(reproTraces());
    assert.equal(items.length, 2, "both write traces produce diff items");
    for (const item of items) {
      assert.ok(item.diffPreview.includes("more lines"), "preview keeps its truncation marker");
      assert.ok(
        !item.diffPreview.includes("FILE-ONE-MARKER") && !item.diffPreview.includes("FILE-TWO-MARKER"),
        "preview is capped before line 76, so it cannot contain either file's marker"
      );
    }
  });

  it("diffFull carries every line, uncapped, per file", () => {
    const items = extractFileWriteDiffsFromTraces(reproTraces());
    const [a, b] = items;
    assert.ok(a.diffFull, "write item exposes diffFull");
    assert.ok(b.diffFull, "host write item exposes diffFull");
    assert.ok(a.diffFull.includes("FILE-ONE-MARKER"), "file A's full diff has A's line 76");
    assert.ok(b.diffFull.includes("FILE-TWO-MARKER"), "file B's full diff has B's line 76");
    assert.ok(!a.diffFull.includes("FILE-TWO-MARKER"), "full diffs are per-file, not merged");
    assert.ok(!b.diffFull.includes("FILE-ONE-MARKER"), "full diffs are per-file, not merged");
    assert.ok(a.diffFull.includes("shared line 90"), "full diff reaches the last line");
    assert.ok(!a.diffFull.includes("more lines"), "full diff has no truncation marker");
    assert.notEqual(a.diffFull, b.diffFull, "the two full diffs actually differ");
    const addLines = a.diffFull.split("\n").filter((l) => l.startsWith("+ ")).length;
    assert.equal(addLines, 90, "full diff counts all 90 written lines, not the 40-line cap");
  });

  it("diffFull is uncapped for patch search/replace items too", () => {
    const oldLines = Array.from({ length: 30 }, (_, i) => `old line ${i + 1}`);
    const newLines = Array.from({ length: 30 }, (_, i) => `new line ${i + 1}`);
    const items = extractFileWriteDiffsFromTraces([
      {
        tool: "workspace_patch_file",
        args: { path: "src/x.ts", search: oldLines.join("\n"), replace: newLines.join("\n") },
        status: "ok",
      },
    ]);
    assert.equal(items.length, 1);
    assert.ok(items[0].diffFull.includes("new line 30"), "patch full diff reaches past the 20-line preview cap");
    assert.ok(items[0].diffFull.includes("old line 30"), "patch full diff includes every removed line");
  });
});

describe("UI-023/UI-024 — source wiring", () => {
  it("DiffViewer accepts defaultOpen (default true) and seeds its open state from it", () => {
    assert.match(diffViewerSrc, /defaultOpen\s*=\s*true/, "prop defaults to true so other surfaces keep opening expanded");
    assert.match(diffViewerSrc, /useState\(defaultOpen\)/, "open state initializes from the prop");
  });

  it("ChatStream renders chat diff cards collapsed by default", () => {
    const i = chatStreamSrc.indexOf('data-testid="chat-diff-card"');
    assert.ok(i >= 0, "chat diff card block present");
    const block = chatStreamSrc.slice(i, i + 1600);
    assert.ok(block.includes("defaultOpen={false}"), "chat DiffViewer starts collapsed");
  });

  it("ChatStream hands the canvas the full diff, not the capped preview", () => {
    assert.match(
      chatStreamSrc,
      /diffFull \?\? /,
      "canvas diffs fall back from diffFull to the stored diff only when no full diff exists"
    );
  });
});

describe("UI-023/UI-024 — rendered UI", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root | null = null;
  let scrollRef: { current: HTMLDivElement | null };

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    win = new GlobalWindow({ url: "http://localhost:3000" });
    (globalThis as any).window = win;
    (globalThis as any).document = win.document;
    (globalThis as any).localStorage = win.localStorage;
    container = win.document.createElement("div") as unknown as HTMLDivElement;
    (win.document.body as any).appendChild(container);
    scrollRef = { current: null };
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

  it("DiffViewer with defaultOpen={false} shows the header only until tapped", async () => {
    await renderTree(
      React.createElement(DiffViewer, {
        branch: "src/weather.html",
        diff: "+ const UNIQUE_DIFF_LINE = 1;\n+ second line",
        modifiedFiles: ["src/weather.html"],
        defaultOpen: false,
      } as any)
    );
    assert.ok(container.textContent?.includes("src/weather.html"), "header shows the file path");
    assert.ok(
      !container.textContent?.includes("UNIQUE_DIFF_LINE"),
      "diff body is NOT rendered while collapsed"
    );
    const toggle = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("src/weather.html")
    );
    await click(toggle ?? null);
    assert.ok(
      container.textContent?.includes("UNIQUE_DIFF_LINE"),
      "tapping the header expands the diff"
    );
  });

  it("DiffViewer without the prop still opens expanded (other surfaces unchanged)", async () => {
    await renderTree(
      React.createElement(DiffViewer, {
        branch: "feature/task",
        diff: "+ const DEFAULT_OPEN_LINE = 1;",
        modifiedFiles: [],
      })
    );
    assert.ok(
      container.textContent?.includes("DEFAULT_OPEN_LINE"),
      "default behavior stays expanded"
    );
  });

  it("canvas: switching file chips swaps in the other file's FULL diff", async () => {
    const items = extractFileWriteDiffsFromTraces(reproTraces());
    // The exact hand-off ChatStream performs after the fix.
    const diffs = items.map((d) => ({
      path: d.path,
      diff: (d as any).diffFull ?? d.diffPreview,
      addedLines: d.addedLines,
      removedLines: d.removedLines,
    }));
    await renderTree(
      React.createElement(
        CanvasProvider,
        { scrollElRef: scrollRef },
        React.createElement(CanvasDiffCard, { diffs }),
        React.createElement(ArtifactCanvasPane)
      )
    );
    await click(container.querySelector('[data-testid="canvas-diff-open"]'));
    assert.ok(container.querySelector('[data-testid="canvas-pane"]'), "canvas pane opens");

    // First file is shown in full: its line-76 marker is beyond the old cap.
    assert.ok(container.textContent?.includes(PATH_A), "file A's path heads the diff");
    assert.ok(container.textContent?.includes("FILE-ONE-MARKER"), "file A's full diff renders");
    assert.ok(!container.textContent?.includes("FILE-TWO-MARKER"), "file B's content is not shown yet");

    const chips = container.querySelectorAll('[data-testid="canvas-diff-chip"]');
    assert.equal(chips.length, 2, "one chip per file");
    assert.equal(
      chips[1].textContent?.includes("D:\\AI"),
      false,
      "Windows-path chip label is the basename, not the full path"
    );
    assert.ok(
      chips[1].textContent?.includes("weather-spanish-fort.html"),
      "chip label shows the basename"
    );

    await click(chips[1]);
    assert.ok(container.textContent?.includes(PATH_B), "file B's path heads the diff after switching");
    assert.ok(container.textContent?.includes("FILE-TWO-MARKER"), "switching shows file B's own line 76");
    assert.ok(!container.textContent?.includes("FILE-ONE-MARKER"), "file A's content is replaced, not merged");
    assert.ok(container.textContent?.includes("shared line 90"), "the switched diff is complete to the last line");
  });
});
