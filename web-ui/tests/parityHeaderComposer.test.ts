import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { formatContextK } from "../lib/tokenEconomics";

const chatStreamPath = path.join(process.cwd(), "components", "ChatStream.tsx");
const src = fs.readFileSync(chatStreamPath, "utf8");

function segment(startMarker: string, length = 1600): string {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, `marker present: ${startMarker}`);
  return src.slice(i, i + length);
}

describe("parity PR1 — context meter format (board: one decimal, 72.4K style)", () => {
  it("formats token counts with one decimal place", () => {
    assert.equal(formatContextK(72400), "72.4K");
    assert.equal(formatContextK(3000), "3.0K");
    assert.equal(formatContextK(100000), "100.0K");
    assert.equal(formatContextK(85600), "85.6K");
  });

  it("the header meter renders the value through formatContextK", () => {
    assert.ok(
      src.includes("formatContextK(displayContextTokens)"),
      "meter value must use the one-decimal formatter",
    );
    assert.ok(
      !src.includes("Math.round(displayContextTokens / 1000)"),
      "whole-K rounding must be gone from the meter value",
    );
  });
});

describe("parity PR1 — meter track geometry (board: 128px phone / 240px desktop)", () => {
  it("track is 128px at all phone widths and 240px on desktop, no 40px tier", () => {
    const track = segment('data-testid="context-meter-track"', 400);
    assert.ok(track.includes("w-[128px]"), "track 128px on phones");
    assert.ok(track.includes("lg:w-[240px]"), "track 240px on desktop");
    assert.ok(!track.includes("w-[40px]"), "the 40px narrow tier is removed");
  });

  it("normal-state fill uses the board emerald gradient", () => {
    const track = segment('data-testid="context-meter-track"', 900);
    assert.ok(
      track.includes("from-emerald-600") && track.includes("to-emerald-400"),
      "fill gradient emerald-600 -> emerald-400 in the normal state",
    );
  });
});

describe("parity PR1 — header composition (UI-019 + board header note)", () => {
  it("Projects button is desktop-only (removed from the mobile header)", () => {
    const projects = segment("{onOpenProjects && (", 700);
    assert.ok(projects.includes("hidden"), "projects button hidden by default");
    assert.ok(projects.includes("md:flex"), "projects button returns at md:");
  });

  it("model label is always visible (board Flash-Next pill), never width-gated", () => {
    assert.ok(
      !src.includes("min-[420px]:inline-block"),
      "model label must not be hidden below 420px",
    );
    const chip = segment("Configure model", 500);
    assert.ok(chip.includes("shortModelLabel"), "model chip still shows the active model");
  });

  it("disconnect chip carries a text label at phone widths too", () => {
    const chip = segment('data-testid="host-disconnect-chip"', 1400);
    assert.ok(
      chip.includes("DISCONNECTED"),
      "chip keeps a visible DISCONNECTED label on small screens",
    );
    assert.ok(
      chip.includes("min-[420px]:hidden"),
      "short label variant for narrow phones exists",
    );
  });
});

describe("parity PR1 — composer (board geometry + send button)", () => {
  it("composer card uses the board surface color and 16px radius in dark mode", () => {
    const form = segment("<form", 600);
    assert.ok(form.includes("dark:bg-[#141418]"), "composer bg is the board #141418");
    assert.ok(form.includes("rounded-2xl"), "composer radius is 16px");
  });

  it("send button is a 40px emerald square with radius 12", () => {
    const send = segment('data-testid="send-button"', 700);
    assert.ok(send.includes("h-10 w-10"), "send button is 40x40");
    assert.ok(send.includes("rounded-xl"), "send button radius is 12px");
    assert.ok(send.includes("bg-emerald-500"), "send button is solid board emerald");
    assert.ok(!send.includes("rounded-full"), "send button is not a circle");
  });
});
