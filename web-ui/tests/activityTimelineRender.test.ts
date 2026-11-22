import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deriveThinkingPreviewState, extractMiniDiffLines } from "../components/ActivityTimeline";
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
      path.resolve(process.cwd(), "web-ui/components/ActivityTimeline.tsx"),
      "utf8"
    );
    assert.equal(
      /\btext-zinc-500\b/.test(src),
      false,
      "text-zinc-500 is banned; use text-zinc-400 or brighter"
    );
  });
});
