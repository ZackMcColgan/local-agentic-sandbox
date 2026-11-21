import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const componentsDir = path.join(process.cwd(), "components");
const appDir = path.join(process.cwd(), "app");
const sidebar = fs.readFileSync(path.join(componentsDir, "ThreadsSidebar.tsx"), "utf8");
const drawer = fs.readFileSync(path.join(componentsDir, "NavigationDrawer.tsx"), "utf8");
const page = fs.readFileSync(path.join(appDir, "page.tsx"), "utf8");

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

describe("parity PR3 — sessions panel chrome (#0e0e12 panel, emerald + button, search)", () => {
  it("panel root uses bg-surface-1 in dark mode", () => {
    const root = segment(sidebar, "<aside", 220);
    assert.ok(root.includes("dark:bg-[#0e0e12]"), "panel bg is #0e0e12");
  });

  it("new-session button is the 30px emerald square with 9px radius", () => {
    const btn = around(sidebar, 'aria-label="New session"', 700, 120);
    assert.ok(btn.includes("dark:bg-emerald-500"), "+ button is solid emerald");
    assert.ok(btn.includes("rounded-[9px]"), "+ button radius is 9px");
    assert.ok(btn.includes("h-[30px] w-[30px]"), "+ button is 30px");
    assert.ok(btn.includes("dark:text-black"), "+ glyph is black on emerald");
  });

  it("search field uses bg-2 with the board's 11px radius", () => {
    const field = around(sidebar, 'placeholder="Search sessions..."', 700, 60);
    assert.ok(field.includes("dark:bg-[#18181b]"), "board search bg is #18181b (bg-2)");
    assert.ok(field.includes("rounded-[11px]"), "board search radius is 11px");
  });

  it("the list carries the board's letterspaced RECENTS label", () => {
    const label = around(sidebar, "RECENTS", 220, 40);
    assert.ok(label.includes("tracking"), "RECENTS is letterspaced");
    assert.ok(label.includes("text-[11px]"), "RECENTS is 11px");
  });
});

describe("parity PR3 — session cards (#15151b, rounded-2xl, mono meta, status chips)", () => {
  it("card uses elevated surface, rounded-2xl, and padding", () => {
    const card = segment(sidebar, "group relative overflow-hidden", 600);
    assert.ok(card.includes("rounded-2xl"), "card radius is rounded-2xl");
    assert.ok(card.includes("dark:bg-[#15151b]"), "card bg is #15151b");
    assert.ok(card.includes("px-[14px]"), "card horizontal padding is 14px");
    assert.ok(card.includes("py-[13px]"), "card vertical padding is 13px");
    assert.ok(!card.includes("rounded-3xl"), "the old 24px card radius is gone");
  });

  it("card title is the board's 14.5px", () => {
    const title = around(sidebar, "leading-snug line-clamp-2", 60, 10);
    assert.ok(title.includes("text-[14.5px]"), "board card title is 14.5px");
  });

  it("meta line is mono at the board's 12.3px", () => {
    const meta = segment(sidebar, "Subtext matching Mockup", 320);
    assert.ok(meta.includes("font-mono"), "board meta is mono");
    assert.ok(meta.includes("text-[12.3px]"), "board meta is 12.3px");
  });

  it("status renders as a chip with the board's DONE / FAILED language", () => {
    assert.ok(sidebar.includes("thread-status-chip-"), "status chip carries a testid");
    assert.ok(sidebar.includes("✓ DONE"), "board DONE chip label");
    assert.ok(sidebar.includes("✕ FAILED"), "board FAILED chip label");
    const chip = around(sidebar, "thread-status-chip-", 60, 700);
    assert.ok(chip.includes("rounded-full"), "status chip is a pill");
  });

  it("running card gets the cyan border, inset bar, and actions", () => {
    assert.ok(sidebar.includes("border-cyan-500/40"), "running border cyan-500/40");
    assert.ok(
      sidebar.includes("shadow-[inset_3px_0_0_#22d3ee]"),
      "running card has the inset 3px cyan left bar"
    );
    assert.ok(sidebar.includes("Open settings"), "ghost action label");
  });
});

describe("parity PR3 — drawer rows + rail (secondary surfaces)", () => {
  it("drawer session rows use the elevated card surface and wrap titles", () => {
    const row = around(drawer, "data-testid={`thread-row-", 200, 900);
    assert.ok(row.includes("rounded-2xl"), "drawer rows take the card radius");
    assert.ok(row.includes("dark:bg-[#15151b]"), "drawer rows use #15151b for elevation contrast");
    const title = around(drawer, "title={thread.title}", 40, 220);
    assert.ok(title.includes("line-clamp-2"), "drawer titles wrap like board cards");
    assert.ok(!title.includes("truncate"), "drawer titles no longer single-line truncate");
  });

  it("the selected rail button is emerald with high-contrast text", () => {
    assert.ok(
      page.includes("bg-emerald-600 dark:bg-emerald-500 text-white dark:text-black"),
      "rail selection is emerald with high-contrast text"
    );
  });
});
