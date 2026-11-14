import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const componentsDir = path.join(process.cwd(), "components");
const canvas = fs.readFileSync(path.join(componentsDir, "ArtifactCanvas.tsx"), "utf8");
const renderers = fs.readFileSync(path.join(componentsDir, "ArtifactRenderers.tsx"), "utf8");
const morningReport = fs.readFileSync(path.join(componentsDir, "MorningReportView.tsx"), "utf8");
const executionTrace = fs.readFileSync(path.join(componentsDir, "ExecutionTrace.tsx"), "utf8");
const traceWaterfall = fs.readFileSync(path.join(componentsDir, "TraceWaterfall.tsx"), "utf8");

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

function between(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker);
  assert.ok(a >= 0, `marker present: ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  assert.ok(b > a, `marker present after start: ${endMarker}`);
  return src.slice(a, b);
}

describe("parity PR4 — canvas pane chrome (board: bg-1 bar, muted mono filename, bg-2/bg-3 tabs)", () => {
  it("pane header sits on the board's bg-1 surface", () => {
    const header = segment(canvas, '<div className="flex items-center gap-2 h-12 px-2.5', 300);
    assert.ok(header.includes("dark:bg-[#121215]"), "board canvas bar bg is #121215 (bg-1)");
  });

  it("filename in the bar is the board's muted mono 12.5px, normal weight", () => {
    const name = around(canvas, "title={title}", 170, 40);
    assert.ok(name.includes("text-[12.5px]"), "board filename is 12.5px");
    assert.ok(name.includes("dark:text-zinc-400"), "board filename is muted (#a1a1aa family)");
    assert.ok(name.includes("font-normal"), "board filename is normal weight");
    assert.ok(!name.includes("font-semibold"), "the old semibold filename is gone");
  });

  it("desktop tab control uses the board's bg-2 container and bg-3 active tab", () => {
    const container = segment(canvas, "hidden lg:flex items-center", 300);
    assert.ok(container.includes("dark:bg-[#18181b]"), "board tab container bg is #18181b (bg-2)");
    assert.ok(container.includes("rounded-[10px]"), "board tab container radius is 10px");
    const tabs = segment(canvas, "const tabButton", 1500);
    assert.ok(tabs.includes("dark:bg-[#27272a]"), "board active tab bg is #27272a (bg-3)");
    assert.ok(tabs.includes("dark:text-zinc-100"), "board active tab text is near-white, not emerald");
  });

  it("mobile bottom tabs are individual bordered buttons with a brand-border active state", () => {
    const tabs = segment(canvas, "const tabButton", 2200);
    assert.ok(tabs.includes("dark:border-emerald-500"), "board mobile active tab carries the brand border");
    assert.ok(tabs.includes("rounded-[10px]"), "board mobile tabs are 10px-radius buttons");
  });

  it("icon buttons take the board's 32px desktop form on a bg-2 surface", () => {
    const btn = segment(canvas, "const iconBtnClass", 400);
    assert.ok(btn.includes("lg:h-8 lg:w-8"), "board icon buttons are 32px on desktop");
    assert.ok(btn.includes("dark:bg-[#18181b]"), "board icon buttons sit on bg-2");
    assert.ok(btn.includes("rounded-[9px]"), "board icon button radius is 9px (desktop)");
  });

  it("the active device toggle reads brand-hi, not a white pill", () => {
    const full = around(canvas, 'aria-label="Full width preview"', 800, 60);
    assert.ok(full.includes("text-[#34d399]"), "board active device icon is brand-hi #34d399");
  });

  it("the ArtifactCanvas file carries no zinc-900 dark surfaces left", () => {
    assert.ok(!canvas.includes("dark:bg-zinc-900"), "canvas surfaces align to bg-1/bg-2 board tokens");
  });
});

describe("parity PR4 — canvas diff (board: single gutter, tinted rows, rail header, chips)", () => {
  it("diff rows use ONE 34px gutter showing the line's own number", () => {
    const rows = segment(canvas, "function DiffRows", 2200);
    assert.ok(rows.includes("w-[34px]"), "board gutter is a single 34px column");
    assert.ok(
      rows.includes('row.kind === "del" ? row.oldLine : row.newLine'),
      "gutter shows the old number for deletions, the new number otherwise",
    );
    assert.ok(!rows.includes("w-12"), "the old twin 48px gutters are gone");
  });

  it("diff rows keep near-white text on tinted add/del backgrounds with board type sizes", () => {
    const rows = segment(canvas, "function DiffRows", 2200);
    assert.ok(rows.includes("bg-[rgba(16,185,129,0.13)]"), "board add-row tint rgba(16,185,129,.13)");
    assert.ok(rows.includes("bg-[rgba(248,113,113,0.12)]"), "board del-row tint rgba(248,113,113,.12)");
    assert.ok(rows.includes("text-[#7dd3fc]"), "board hunk text is #7dd3fc");
    assert.ok(rows.includes("lg:text-[12.3px]"), "board desktop diff type is 12.3px");
    assert.ok(rows.includes("lg:leading-[1.75]"), "board desktop diff leading is 1.75");
  });

  it("desktop rail gains the board's totals header and rounded card rows", () => {
    const rail = segment(canvas, "Desktop: file rail", 1800);
    assert.ok(rail.includes("canvas-diff-rail-header"), "rail carries the totals header row");
    assert.ok(rail.includes("FILES"), "rail header names the file count");
    assert.ok(rail.includes("rounded-[10px]"), "board rail rows are rounded-10 cards");
    assert.ok(!rail.includes("border-l-2"), "the 2px emerald left-border accent is gone");
  });

  it("the totals strip stays for mobile only (the rail header carries it on desktop)", () => {
    const strip = around(canvas, "unified · every line, nothing truncated", 600, 60);
    assert.ok(strip.includes("lg:hidden"), "totals strip hides on desktop where the rail header shows");
  });

  it("mobile file chips take the board's pill form", () => {
    const chip = around(canvas, 'data-testid="canvas-diff-chip"', 60, 500);
    assert.ok(chip.includes("rounded-full"), "board mobile diff chips are pills");
  });

  it("the board's mobile diff note is present under the diff", () => {
    const note = around(canvas, "Code lines never wrap", 200, 200);
    assert.ok(note.includes("lg:hidden"), "the diff note is mobile-only");
    assert.ok(canvas.includes("nothing is cut to fit the phone"), "board note text is complete");
  });

  it("code view sits on bg-1 like the rest of the pane", () => {
    const view = segment(canvas, "function CanvasFileView", 2600);
    assert.ok(view.includes("dark:bg-[#121215]"), "board code view bg aligns to bg-1 #121215");
  });
});

describe("parity PR4 — chat-side canvas doors (board: bg-2 diff card, plain-text actions, pill badge)", () => {
  it("the diff card drops the icon tile for the board's bg-2 mono form", () => {
    const card = between(canvas, "export function CanvasDiffCard", "export function CanvasFileOpenButton");
    assert.ok(card.includes("dark:bg-[#18181b]"), "board diff card bg is #18181b (bg-2)");
    assert.ok(card.includes("font-mono"), "board diff card title is mono");
    assert.ok(card.includes("text-[12.5px]"), "board diff card title is 12.5px");
    assert.ok(!card.includes("bg-emerald-950"), "the emerald icon tile is gone");
    assert.ok(!card.includes("border-emerald"), "the boxed emerald action button is gone");
  });

  it("the file open door is plain brand-hi text, not a boxed button", () => {
    const btn = between(canvas, "export function CanvasFileOpenButton", "function DiffRows");
    assert.ok(btn.includes("text-[#34d399]"), "board Open action is brand-hi text");
    assert.ok(!btn.includes("border-emerald"), "the boxed emerald outline is gone");
  });

  it("the unseen-update badge is the board's translucent pill with the refresh glyph", () => {
    const badge = around(renderers, 'data-testid="canvas-update-badge"', 100, 400);
    assert.ok(badge.includes("dark:text-[#34d399]"), "board badge text is brand-hi");
    assert.ok(badge.includes("text-[11px]"), "board badge text is 11px");
    assert.ok(renderers.includes("↻ Updated · file changed"), "board badge carries the ↻ glyph text");
    assert.ok(!renderers.includes("bg-emerald-600 text-white"), "the solid emerald badge is gone");
  });
});

describe("parity PR4 — Morning Report forms (board: verdict card + inline KPI strip, neutral attention)", () => {
  it("the verdict banner becomes a neutral bg-1 card (state lives in icon/border accents)", () => {
    const banner = around(morningReport, 'data-testid="verdict-banner"', 100, 1400);
    assert.ok(banner.includes("dark:bg-[#121215]"), "board verdict card bg is #121215 (bg-1)");
    assert.ok(!banner.includes("bg-rose-950"), "the tinted verdict wash is gone from the banner");
    assert.ok(!banner.includes("bg-amber-950"), "the tinted verdict wash is gone from the banner");
    assert.ok(!banner.includes("bg-emerald-950"), "the tinted verdict wash is gone from the banner");
  });

  it("the KPI tiles become an inline strip inside the verdict card, with the board footnote", () => {
    assert.ok(morningReport.includes('data-testid="kpi-strip"'), "verdict card carries the inline KPI strip");
    assert.ok(morningReport.includes("Stats shown for the"), "board footnote follows the strip");
    assert.ok(
      !morningReport.includes("grid grid-cols-2 sm:grid-cols-4 gap-3"),
      "the four tinted KPI tiles are gone",
    );
    const strip = segment(morningReport, 'data-testid="kpi-strip"', 2200);
    assert.ok(strip.includes("Total Tasks"), "strip names the task total");
    assert.ok(strip.includes("Stalled"), "strip names the stalled count");
  });

  it("the summary card aligns to bg-1 once the tiles move out", () => {
    const summary = around(morningReport, "Overnight Autonomous Summary", 1600, 60);
    assert.ok(summary.includes("dark:bg-[#121215]"), "summary card bg is #121215 (bg-1)");
  });

  it("attention items go neutral with a 3px accent bar and a solid emerald session action", () => {
    const items = segment(morningReport, "overnight.attentionItems.map", 2800);
    assert.ok(items.includes("inset_3px_0_0"), "board attention cards carry the 3px left accent bar");
    assert.ok(items.includes("bg-emerald-500"), "board primary action is solid emerald");
    assert.ok(!morningReport.includes("dark:bg-amber-950/30"), "the tinted attention wash is gone");
    assert.ok(!morningReport.includes("dark:bg-rose-950/30"), "the tinted attention wash is gone");
  });

  it("owner flags take the same neutral + accent-bar form, with an emerald submit", () => {
    const flags = segment(morningReport, "flags.map((flag)", 2400);
    assert.ok(flags.includes("inset_3px_0_0"), "board flag cards carry the accent bar form");
    assert.ok(!morningReport.includes("bg-indigo-600"), "the indigo submit gives way to emerald");
  });
});

describe("parity PR4 — UI-021 remainder (completed-turn trace surfaces to the live-row standard)", () => {
  it("ExecutionTrace cards sit on bg-1 with near-white tool names", () => {
    assert.ok(!executionTrace.includes("dark:bg-zinc-900"), "trace cards align to bg-1");
    assert.ok(executionTrace.includes("dark:bg-[#121215]"), "trace card bg is #121215 (bg-1)");
    const tool = segment(executionTrace, "font-mono text-xs font-semibold", 140);
    assert.ok(tool.includes("dark:text-zinc-100"), "tool names render near-white");
  });

  it("ExecutionTrace section labels and empty state lift off the dim tokens", () => {
    const payload = around(executionTrace, "Payload Arguments:", 260, 40);
    assert.ok(payload.includes("dark:text-zinc-300"), "section labels lift to zinc-300");
    const empty = around(executionTrace, "No Tool Executions Yet", 500, 200);
    assert.ok(empty.includes("dark:text-zinc-100"), "empty-state title renders near-white");
    assert.ok(empty.includes("dark:text-zinc-400"), "empty-state icon lifts to zinc-400 (UI-050 text floor)");
  });

  it("TraceWaterfall panels sit on bg-1 with lifted stat labels", () => {
    assert.ok(!traceWaterfall.includes("dark:bg-zinc-900"), "waterfall panels align to bg-1");
    assert.ok(traceWaterfall.includes("dark:bg-[#121215]"), "panel bg is #121215 (bg-1)");
    const stats = segment(traceWaterfall, "Overview Stat Cards", 1800);
    assert.ok(stats.includes("dark:text-zinc-300"), "stat labels lift to zinc-300");
  });
});
