// Board #59: single-emerald accent enforcement + dark-mode contrast floor on #000.
// Static source audit: banned cyan/sky accents in BoardView/ChatStream, and
// sub-floor dark text on #000 in the Settings Danger Zone / disabled controls.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const componentsDir = path.join(process.cwd(), "components");

function read(rel: string): string {
  return fs.readFileSync(path.join(componentsDir, rel), "utf8");
}

// WCAG relative luminance + contrast ratio against #000.
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrastOnBlack(hex: string): number {
  return (luminance(hex) + 0.05) / 0.05;
}

// The dark-mode contrast floor is zinc-400 (#a1a1aa) on #000.
const FLOOR = contrastOnBlack("#a1a1aa");

// Tailwind palette hexes for cyan/sky families (banned accents).
const BANNED_ACCENTS =
  /\b(?:text|bg|border|hover:bg|dark:hover:bg|shadow-\[[^\]]*)-(?:cyan|sky)-\d{2,3}\b/g;

describe("Board #59: single-emerald accent enforcement", () => {
  it("BoardView.tsx carries no cyan or sky accent classes", () => {
    const src = read("BoardView.tsx");
    const hits = src.match(BANNED_ACCENTS) ?? [];
    assert.equal(hits.length, 0, `BoardView banned accents: ${hits.join(", ")}`);
    assert.ok(
      src.includes("bg-emerald-400 animate-pulse"),
      "working/live dot uses the approved emerald pulse"
    );
    assert.ok(src.includes("border-emerald-500/40"), "live card border uses approved emerald");
  });

  it("ChatStream.tsx carries no cyan or sky accent classes", () => {
    const src = read("ChatStream.tsx");
    const hits = src.match(BANNED_ACCENTS) ?? [];
    assert.equal(hits.length, 0, `ChatStream banned accents: ${hits.join(", ")}`);
    assert.ok(
      src.includes("bg-emerald-600 hover:bg-emerald-500 text-white"),
      "steer send button uses approved emerald"
    );
  });
});

describe("Board #59: dark-mode contrast floor on #000", () => {
  it("Danger Zone heading lifts above the zinc-400 floor on #000", () => {
    const src = read("settings/DangerZone.tsx");
    assert.ok(
      !src.includes("dark:text-rose-400"),
      "rose-400 heading (contrast 7.80) is below the floor and must be lifted"
    );
    assert.ok(
      src.includes("dark:text-rose-300"),
      "heading uses rose-300 (contrast 11.11 >= floor)"
    );
    assert.ok(
      contrastOnBlack("#fda4af") >= FLOOR,
      `rose-300 contrast ${contrastOnBlack("#fda4af").toFixed(2)} must be >= floor ${FLOOR.toFixed(2)}`
    );
  });

  it("disabled engine controls lift above the floor (no opacity-50 dimming)", () => {
    const src = read("settings/EngineZone.tsx");
    assert.ok(
      !/opacity-50[^"]*dark:text-zinc-400/.test(src),
      "disabled controls must not dim zinc-400 text with opacity-50 (contrast 3.13)"
    );
    assert.ok(
      src.includes("dark:text-zinc-300"),
      "disabled controls use zinc-300 (contrast 10.08 on zinc-800 >= floor)"
    );
  });
});
