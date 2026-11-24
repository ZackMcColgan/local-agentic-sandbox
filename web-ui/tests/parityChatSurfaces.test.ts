import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const componentsDir = path.join(process.cwd(), "components");
const chatStream =
  fs.readFileSync(path.join(componentsDir, "ChatStream.tsx"), "utf8") +
  "\n" +
  fs.readFileSync(path.join(componentsDir, "chat/messageRender.tsx"), "utf8");
const thinkingPanel = fs.readFileSync(path.join(componentsDir, "ThinkingPanel.tsx"), "utf8");
const liveRunBlock = fs.readFileSync(path.join(componentsDir, "LiveRunBlock.tsx"), "utf8");

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

describe("parity PR2 — brief bubble (board: emerald tint, 16px radius, footer toggle row)", () => {
  it("bubble uses the locked emerald tokens and 16px radius", () => {
    const bubble = segment(chatStream, "User Bubble", 800);
    assert.ok(bubble.includes("rounded-2xl"), "board radius is 16px (rounded-2xl)");
    assert.ok(
      bubble.includes("dark:bg-[rgba(16,185,129,0.14)]"),
      "board bubble bg rgba(16,185,129,.14)"
    );
    assert.ok(
      bubble.includes("dark:border-[rgba(16,189,129,0.32)]") ||
        bubble.includes("dark:border-[rgba(16,185,129,0.32)]"),
      "board bubble border rgba(16,185,129,.32)"
    );
    assert.ok(!bubble.includes("rounded-3xl"), "the old 24px radius is gone");
  });

  it("collapse toggle is a centered footer row with a char count", () => {
    const toggle = around(chatStream, 'data-testid="brief-collapse-toggle"', 500, 900);
    assert.ok(toggle.includes("border-t"), "toggle sits in a footer row with a top border");
    assert.ok(toggle.includes("justify-center"), "toggle row is centered");
    assert.ok(toggle.includes("chars)"), "toggle label carries the brief char count");
    assert.ok(
      toggle.includes("dark:text-emerald-300"),
      "toggle label uses emerald text in dark mode"
    );
  });
});

describe("parity PR2 — thinking card (dark surface structure + UI-018 near-white reasoning)", () => {
  it("header leads with the glowing emerald dot", () => {
    assert.ok(
      thinkingPanel.includes("shadow-[0_0_10px_rgba(16,185,129,0.9)]"),
      "glowing emerald dot in the thinking header"
    );
  });

  it("narrative renders directly in the card at 13px near-white, no nested box", () => {
    const narrative = around(thinkingPanel, "phaseItem.narrative", 500, 60);
    assert.ok(narrative.includes("text-[13px]"), "board body size 13px");
    assert.ok(
      narrative.includes("dark:text-zinc-100"),
      "UI-018: reasoning text near-white in dark mode"
    );
    assert.ok(
      !narrative.includes("rounded-lg"),
      "the nested inner box around the narrative is gone"
    );
    assert.ok(
      !thinkingPanel.includes("rounded-lg bg-slate-50 dark:bg-black"),
      "old nested narrative surface removed file-wide"
    );
  });
});

describe("parity PR2 — live trace rows (single timeline in ChatStream + LiveRunBlock brightening)", () => {
  it("ChatStream retires legacy live-trace-rows in favor of ActivityTimeline", () => {
    assert.ok(
      !chatStream.includes('data-testid="live-trace-rows"'),
      "legacy live-trace-rows surface retired in ChatStream"
    );
    assert.ok(chatStream.includes("<ActivityTimeline"), "ChatStream uses single ActivityTimeline");
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

describe("parity PR2 — RUNNING pill + LiveRunBlock surface", () => {
  it("LiveRunBlock running state is the solid emerald pill", () => {
    const pill = segment(liveRunBlock, 'data-testid="running-pill"', 500);
    assert.ok(pill.includes("bg-emerald-500"), "solid emerald fill");
    assert.ok(pill.includes("text-black"), "black text on the pill");
    assert.ok(pill.includes("border-transparent"), "no dark border on solid pill");
    assert.ok(pill.includes("bg-stone-950"), "near-black pulse dot on solid pill");
    assert.ok(pill.includes("RUNNING ·"), "pill reads RUNNING · elapsed");
  });

  it("LiveRunBlock card uses the dark surface in dark mode", () => {
    assert.ok(liveRunBlock.includes("dark:bg-[#0e0e12]"), "dark --bg-surface-1 #0e0e12");
  });
});
