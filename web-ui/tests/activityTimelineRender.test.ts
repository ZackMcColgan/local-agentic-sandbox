import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { GlobalWindow } from "happy-dom";
import fs from "node:fs";
import path from "node:path";
import {
  ActivityTimeline,
  ThinkingPreviewBlock,
  deriveThinkingPreviewState,
  extractMiniDiffLines,
} from "../components/ActivityTimeline";
import { buildActivityTimeline } from "../lib/activityTimeline";

describe("ActivityTimeline — thinking preview & turn rendering", () => {
  it("shows live preview while streaming and folds to 'Thought for Ns' on completion", () => {
    const streaming = deriveThinkingPreviewState({
      isStreaming: true,
      hasContent: false,
      thought: "Inspecting roundLoop.ts to check per-round timing...",
      durationMs: 3200,
      userExpanded: null,
    });
    assert.equal(streaming.visible, true);
    assert.equal(streaming.isExpanded, true);
    assert.equal(streaming.summaryLabel, "Thinking…");

    const completed = deriveThinkingPreviewState({
      isStreaming: false,
      hasContent: true,
      thought: "Inspecting roundLoop.ts to check per-round timing...",
      durationMs: 7400,
      userExpanded: null,
    });
    assert.equal(completed.visible, true);
    assert.equal(completed.isExpanded, false);
    assert.equal(completed.summaryLabel, "Thought for 7s");

    const expanded = deriveThinkingPreviewState({
      isStreaming: false,
      hasContent: true,
      thought: "Inspecting roundLoop.ts to check per-round timing...",
      durationMs: 7400,
      userExpanded: true,
    });
    assert.equal(expanded.isExpanded, true);
    assert.equal(expanded.summaryLabel, "Thought for 7s");
  });

  it("handles a trace-less turn cleanly with zero action rows", () => {
    const rows = buildActivityTimeline([]);
    assert.equal(rows.length, 0);

    const thinking = deriveThinkingPreviewState({
      isStreaming: false,
      hasContent: true,
      thought: "Quick reasoning",
      durationMs: 2000,
      userExpanded: null,
    });
    assert.equal(thinking.visible, true);
    assert.equal(thinking.summaryLabel, "Thought for 2s");
  });

  it("extracts compact mini-diff lines capped at maxLines", () => {
    const diff = [
      "@@ -1,3 +1,5 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      "+const d = 5;",
      "+const e = 6;",
      "+const f = 7;",
    ].join("\n");

    const preview = extractMiniDiffLines(diff, 4);
    assert.equal(preview.lines.length, 4);
    assert.equal(preview.truncated, true);
    assert.equal(preview.lines[0].kind, "hunk");
    assert.equal(preview.lines[2].kind, "del");
    assert.equal(preview.lines[3].kind, "add");
  });

  it("guard: ActivityTimeline.tsx never uses banned zinc-500 text classes", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../components/ActivityTimeline.tsx"),
      "utf8"
    );
    assert.equal(
      /\btext-zinc-500\b/.test(src),
      false,
      "text-zinc-500 is banned; use text-zinc-400 or brighter"
    );
  });

  it("Fix 2: ThinkingPreviewBlock renders mock card with emerald left edge, caps Reasoning label, toggle, and omits duration when unrecorded", () => {
    const html = renderToString(
      React.createElement(ThinkingPreviewBlock, {
        thought: "Checking the diff preview theme classes",
        isStreaming: false,
        hasContent: true,
        durationMs: undefined,
      })
    );
    assert.ok(html.includes('data-testid="thinking-panel"'));
    assert.ok(html.includes('aria-expanded="false"'));
    assert.ok(html.includes("border-l-emerald-500"));
    assert.ok(html.includes("uppercase"));
    assert.ok(html.includes("Reasoning"));
    assert.ok(
      !html.includes("Thought for "),
      "must not fabricate duration when generation data is missing"
    );

    const messageRenderSrc = fs.readFileSync(
      path.resolve(__dirname, "../components/chat/messageRender.tsx"),
      "utf8"
    );
    assert.ok(
      !messageRenderSrc.includes("m.thinkingDurationMs ?? m.durationMs"),
      "messageRender must never fall back to wall-clock m.durationMs for thinking duration"
    );
  });

  it("Fix 3: folded groups render as bordered cards with title, context subline, and '› expand' affordance", () => {
    const html = renderToString(
      React.createElement(ActivityTimeline, {
        traces: [
          { tool: "workspace_read_file", args: { path: "web-ui/a.ts" }, durationMs: 10 },
          { tool: "workspace_read_file", args: { path: "web-ui/b.ts" }, durationMs: 20 },
          { tool: "workspace_read_file", args: { path: "web-ui/c.ts" }, durationMs: 30 },
        ],
      })
    );
    assert.ok(html.includes('data-testid="timeline-group-card"'));
    assert.ok(html.includes("Read 3 files"));
    assert.ok(html.includes("a.ts, b.ts +1 more"));
    assert.ok(html.includes("› expand"));
  });

  it("Fix 4: error runs render as rose-accented fold card and error output panels start collapsed", () => {
    const html = renderToString(
      React.createElement(ActivityTimeline, {
        traces: [
          {
            tool: "host_run_powershell",
            args: { command: "c1" },
            durationMs: 100,
            isError: true,
            result: "Exit code 1: fail 1",
          },
          {
            tool: "host_run_powershell",
            args: { command: "c2" },
            durationMs: 200,
            isError: true,
            result: "Exit code 1: fail 2",
          },
          {
            tool: "host_run_powershell",
            args: { command: "c3" },
            durationMs: 300,
            isError: true,
            result: "Exit code 1: fail 3",
          },
          { tool: "workspace_read_file", args: { path: "ok.ts" }, durationMs: 10 },
          {
            tool: "host_run_powershell",
            args: { command: "solo" },
            durationMs: 50,
            isError: true,
            result: "Exit code 1: solo boom",
          },
        ],
      })
    );
    assert.ok(html.includes("3 commands failed"));
    assert.ok(html.includes("border-rose-300"));
    assert.ok(html.includes("bg-rose-50"));
    assert.ok(html.includes('data-testid="timeline-error-toggle"'));
    assert.ok(
      !html.includes('data-testid="timeline-row-error"'),
      "error output must start collapsed"
    );
  });

  it("Fix 6: write row diff preview is theme-aware and shows synthesized creation diff lines with emerald Open button", () => {
    const html = renderToString(
      React.createElement(ActivityTimeline, {
        traces: [
          {
            tool: "workspace_write_file",
            args: {
              path: "web-ui/lib/newFile.ts",
              content: "export const a = 1;\nexport const b = 2;",
            },
            durationMs: 35,
          },
        ],
        onOpenCanvasDiff: () => {},
      })
    );
    assert.ok(html.includes("Wrote newFile.ts"));
    assert.ok(html.includes("+export const a = 1;"));
    assert.ok(
      html.includes("bg-zinc-50 dark:bg-black"),
      "preview card must be theme-aware (not solid black in light mode)"
    );
    assert.ok(html.includes('data-testid="open-in-canvas-btn"'));
    assert.ok(html.includes("Open"));
  });

  it("U-F2: 120-line multi-line command trace renders uncollapsed newlines inside max-h-* overflow-y-auto overscroll-contain <pre> on both error and success rows", async () => {
    const errorLines = Array.from(
      { length: 120 },
      (_, i) => `err-line-${i + 1}: failure diagnostic details`
    ).join("\n");
    const okLines = Array.from(
      { length: 120 },
      (_, i) => `ok-line-${i + 1}: command stdout details`
    ).join("\n");

    const win = new GlobalWindow();
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;
    const container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(
      container as unknown as Parameters<typeof win.document.body.appendChild>[0]
    );
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          React.createElement(ActivityTimeline, {
            traces: [
              {
                tool: "host_run_powershell",
                args: { command: "failing-cmd" },
                durationMs: 120,
                isError: true,
                result: {
                  success: false,
                  exitCode: 1,
                  stderr: errorLines,
                  output: errorLines,
                },
              },
              {
                tool: "host_run_powershell",
                args: { command: "passing-cmd" },
                durationMs: 80,
                isError: false,
                result: {
                  success: true,
                  exitCode: 0,
                  stdout: okLines,
                  output: okLines,
                },
              },
            ],
          })
        );
      });

      const errToggle = container.querySelector(
        '[data-testid="timeline-error-toggle"]'
      ) as HTMLButtonElement | null;
      assert.ok(errToggle, "error row must render timeline-error-toggle");
      await act(async () => {
        errToggle!.click();
      });

      const errPre = container.querySelector(
        'pre[data-testid="timeline-row-error"]'
      ) as HTMLPreElement | null;
      assert.ok(errPre, "expanded error output must render inside a <pre>");
      const errClasses = errPre!.className;
      assert.ok(/\bmax-h-/.test(errClasses), `missing max-h-* in ${errClasses}`);
      assert.ok(/\boverflow-y-auto\b/.test(errClasses), `missing overflow-y-auto in ${errClasses}`);
      assert.ok(
        /\boverscroll-contain\b/.test(errClasses),
        `missing overscroll-contain in ${errClasses}`
      );
      const errText = errPre!.textContent || "";
      assert.ok(errText.includes("err-line-1:"), "missing first error line");
      assert.ok(errText.includes("err-line-120:"), "missing 120th error line");
      assert.ok(
        errText.split("\n").length >= 120,
        `expected >= 120 uncollapsed lines, got ${errText.split("\n").length}`
      );

      const okRowBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        (b.textContent || "").includes("Ran passing-cmd")
      );
      assert.ok(okRowBtn, "success row button must be present");
      await act(async () => {
        okRowBtn!.click();
      });

      const okPre = container.querySelector(
        'pre[data-testid="timeline-row-output"]'
      ) as HTMLPreElement | null;
      assert.ok(okPre, "expanded success row must render traceResult output inside a <pre>");
      const okClasses = okPre!.className;
      assert.ok(/\bmax-h-/.test(okClasses), `missing max-h-* in ${okClasses}`);
      assert.ok(/\boverflow-y-auto\b/.test(okClasses), `missing overflow-y-auto in ${okClasses}`);
      assert.ok(
        /\boverscroll-contain\b/.test(okClasses),
        `missing overscroll-contain in ${okClasses}`
      );
      const okText = okPre!.textContent || "";
      assert.ok(okText.includes("ok-line-1:"), "missing first ok line");
      assert.ok(okText.includes("ok-line-120:"), "missing 120th ok line");
      assert.ok(
        okText.split("\n").length >= 120,
        `expected >= 120 uncollapsed lines, got ${okText.split("\n").length}`
      );
    } finally {
      act(() => {
        root.unmount();
      });
      const g = globalThis as unknown as Partial<Record<"window" | "document", unknown>>;
      delete g.window;
      delete g.document;
    }
  });
});
