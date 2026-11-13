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

describe("parity PR3 — sessions panel chrome (board: bg-1 panel, emerald + button, bg-2 search)", () => {
  it("panel root uses the board's bg-1 surface in dark mode", () => {
    const root = segment(sidebar, "<aside", 220);
    assert.ok(root.includes("dark:bg-[#121215]"), "board panel bg is #121215 (bg-1)");
  });

  it("new-session button is the board's 30px emerald square with 9px radius", () => {
    const btn = around(sidebar, 'aria-label="New session"', 700, 120);
    assert.ok(btn.includes("bg-emerald-500"), "board + button is solid emerald");
    assert.ok(btn.includes("rounded-[9px]"), "board + button radius is 9px");
    assert.ok(btn.includes("h-[30px] w-[30px]"), "board + button is 30px");
    assert.ok(btn.includes("text-[#052e16]"), "board + glyph is dark on emerald");
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

describe("parity PR3 — session cards (board: bg-2, 14px radius, mono meta, status chips)", () => {
  it("card uses bg-2, 14px radius, and board padding", () => {
    const card = segment(sidebar, "group relative overflow-hidden", 600);
    assert.ok(card.includes("rounded-[14px]"), "board card radius is 14px");
    assert.ok(card.includes("dark:bg-[#18181b]"), "board card bg is #18181b (bg-2)");
    assert.ok(card.includes("px-[14px]"), "board card horizontal padding is 14px");
    assert.ok(card.includes("py-[13px]"), "board card vertical padding is 13px");
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

  it("running card gets the board's emerald border, inset bar, and actions", () => {
    assert.ok(
      sidebar.includes("border-[rgba(16,185,129,0.45)]"),
      "board running border rgba(16,185,129,.45)",
    );
    assert.ok(
      sidebar.includes("shadow-[inset_3px_0_0_#10b981]"),
      "board running card has the inset 3px emerald left bar",
    );
    const resume = around(sidebar, "thread-resume-", 120, 500);
    assert.ok(resume.includes("bg-emerald-500"), "Resume is solid emerald");
    assert.ok(sidebar.includes("Open settings"), "board ghost action label");
  });
});

describe("parity PR3 — drawer rows + rail (board language on the secondary surfaces)", () => {
  it("drawer session rows use the board card surface and wrap titles", () => {
    const row = around(drawer, "data-testid={`thread-row-", 200, 900);
    assert.ok(row.includes("rounded-[14px]"), "drawer rows take the board card radius");
    assert.ok(row.includes("dark:bg-[#18181b]"), "drawer rows take the board card bg (bg-2)");
    const title = around(drawer, "title={thread.title}", 40, 220);
    assert.ok(title.includes("line-clamp-2"), "drawer titles wrap like board cards");
    assert.ok(!title.includes("truncate"), "drawer titles no longer single-line truncate");
  });

  it("the selected rail button is the board's solid emerald with dark text", () => {
    assert.ok(
      page.includes("bg-emerald-500 text-[#052e16]"),
      "board rail selection is solid emerald, dark text",
    );
  });
});
