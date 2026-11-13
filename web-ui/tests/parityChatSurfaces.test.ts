import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const componentsDir = path.join(process.cwd(), "components");
const chatStream = fs.readFileSync(path.join(componentsDir, "ChatStream.tsx"), "utf8");
const thinkingPanel = fs.readFileSync(path.join(componentsDir, "ThinkingPanel.tsx"), "utf8");
const liveRunBlock = fs.readFileSync(path.join(componentsDir, "LiveRunBlock.tsx"), "utf8");
const activityHeader = fs.readFileSync(path.join(componentsDir, "LiveActivityHeader.tsx"), "utf8");

function segment(src: string, startMarker: string, length = 1600): string {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, `marker present: ${startMarker}`);
  return src.slice(i, i + length);
}

function around(src: string, marker: string, before: number, after: number): string {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, `marker present: ${marker}`);
  return src.slice(Math.max(0, i - before), i + after);
}

describe("parity PR2 — brief bubble (board: sky tint, 16px radius, footer toggle row)", () => {
  it("bubble uses the board's exact dark sky tokens and 16px radius", () => {
    const bubble = segment(chatStream, "User Bubble", 800);
    assert.ok(bubble.includes("rounded-2xl"), "board radius is 16px (rounded-2xl)");
    assert.ok(
      bubble.includes("dark:bg-[rgba(14,116,144,0.18)]"),
      "board bubble bg rgba(14,116,144,.18)",
    );
    assert.ok(
      bubble.includes("dark:border-[rgba(56,189,248,0.32)]"),
      "board bubble border rgba(56,189,248,.32)",
    );
    assert.ok(!bubble.includes("rounded-3xl"), "the old 24px radius is gone");
  });

  it("collapse toggle is a centered footer row with a char count", () => {
    const toggle = around(chatStream, 'data-testid="brief-collapse-toggle"', 500, 900);
    assert.ok(toggle.includes("border-t"), "toggle sits in a footer row with a top border");
    assert.ok(toggle.includes("justify-center"), "toggle row is centered");
    assert.ok(toggle.includes("chars)"), "toggle label carries the brief char count");
    assert.ok(
      toggle.includes("dark:text-[#bae6fd]"),
      "toggle label uses the board's pale sky text in dark mode",
    );
  });
});

describe("parity PR2 — thinking card (board structure + UI-018 near-white reasoning)", () => {
  it("header leads with the board's glowing emerald dot", () => {
    assert.ok(
      thinkingPanel.includes("shadow-[0_0_10px_rgba(52,211,153,0.9)]"),
      "glowing emerald dot in the thinking header",
    );
  });

  it("narrative renders directly in the card at 13px near-white, no nested box", () => {
    const narrative = around(thinkingPanel, "phaseItem.narrative", 500, 60);
    assert.ok(narrative.includes("text-[13px]"), "board body size 13px");
    assert.ok(
      narrative.includes("dark:text-zinc-100"),
      "UI-018: reasoning text near-white in dark mode",
    );
    assert.ok(
      !narrative.includes("rounded-lg"),
      "the nested inner box around the narrative is gone",
    );
    assert.ok(
      !thinkingPanel.includes("rounded-lg bg-slate-50 dark:bg-black"),
      "old nested narrative surface removed file-wide",
    );
  });
});

describe("parity PR2 — live trace rows (board rows + UI-021 brightening)", () => {
  it("live rows use board colors: near-white titles, lifted durations, brand-hi checks", () => {
    const rows = segment(chatStream, 'data-testid="live-trace-rows"', 2800);
    assert.ok(rows.includes("dark:text-zinc-200"), "block header brightened off zinc-400");
    assert.ok(rows.includes("dark:text-zinc-100"), "step titles near-white");
    assert.ok(rows.includes("dark:text-zinc-400"), "durations lifted off zinc-500");
    assert.ok(rows.includes("text-emerald-400"), "check marks in brand-hi emerald");
    assert.ok(rows.includes("text-[12.8px]"), "board mono row size 12.8px");
  });

  it("older calls collapse behind an earlier-calls row (board grouping)", () => {
    assert.ok(chatStream.includes("earlier tool calls"), "earlier-calls grouping label");
    assert.ok(
      chatStream.includes('data-testid="earlier-calls-toggle"'),
      "earlier-calls toggle carries its test id",
    );
  });

  it("LiveRunBlock trace rows get the same brightening", () => {
    const rows = segment(liveRunBlock, 'data-testid="live-trace-rows"', 1200);
    assert.ok(rows.includes("dark:text-zinc-100"), "tool names near-white");
    assert.ok(rows.includes("dark:text-zinc-400"), "timestamps lifted");
  });

  it("assistant streaming text carries the board's emerald block cursor", () => {
    assert.ok(chatStream.includes('data-testid="stream-cursor"'), "stream cursor test id");
    assert.ok(chatStream.includes("▍"), "block cursor glyph");
  });
});

describe("parity PR2 — RUNNING pill + activity header details", () => {
  it("LiveRunBlock running state is the board's solid emerald pill", () => {
    const pill = segment(liveRunBlock, 'data-testid="running-pill"', 500);
    assert.ok(pill.includes("bg-emerald-500"), "solid emerald fill");
    assert.ok(pill.includes("text-[#052e16]"), "dark text on the pill");
    assert.ok(pill.includes("RUNNING ·"), "pill reads RUNNING · elapsed");
  });

  it("LiveRunBlock card uses the board bg-1 surface in dark mode", () => {
    assert.ok(liveRunBlock.includes("dark:bg-[#121215]"), "board --bg-1 #121215");
  });

  it("activity header: bg-1 card, phone hero 27px, gradient pulse, mono tool split", () => {
    assert.ok(activityHeader.includes("dark:bg-[#121215]"), "board --bg-1 #121215");
    assert.ok(
      activityHeader.includes("text-[27px]") && activityHeader.includes("sm:text-[34px]"),
      "hero elapsed 27px phone / 34px desktop",
    );
    assert.ok(
      activityHeader.includes("from-emerald-600 via-emerald-500 to-emerald-400"),
      "pulse track carries the moving emerald gradient",
    );
    assert.ok(
      activityHeader.includes('data-testid="live-activity-tool"'),
      "the tool half of the phase line renders as its own mono muted span",
    );
  });
});
