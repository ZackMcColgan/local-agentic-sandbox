// Board #59: single-emerald accent enforcement + dark-mode contrast floor on #000.
// Static source audit: banned cyan/sky accents in BoardView/ChatStream, and
// sub-floor dark text on #000 in the Settings Danger Zone / disabled controls.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const componentsDir = path.resolve(__dirname, "../components");

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

describe("Timeline Iteration 2: light-mode contrast floor for timeline surfaces", () => {
  const timelineFiles = ["ActivityTimeline.tsx", "NowLineBar.tsx", "StintCard.tsx"];

  it("timeline components never use unprefixed dark-only zinc text or bare bg-black in light mode", () => {
    const unprefixedLightZincText = /(?<![:\w-])text-zinc-(?:100|200|300|400|500)\b/g;
    const unprefixedBgBlack = /(?<![:\w-])bg-black(?:\/\d+)?\b/g;

    for (const file of timelineFiles) {
      const src = read(file);
      const zincHits = src.match(unprefixedLightZincText) ?? [];
      assert.equal(
        zincHits.length,
        0,
        `${file} has washed-out light-mode zinc text: ${zincHits.join(", ")}`
      );
      const blackHits = src.match(unprefixedBgBlack) ?? [];
      assert.equal(
        blackHits.length,
        0,
        `${file} has unprefixed bg-black that renders dark in light mode: ${blackHits.join(", ")}`
      );
      assert.equal(/\btext-zinc-500\b/.test(src), false, `${file} must never use zinc-500`);
    }
  });

  it("ActivityTimeline error surfaces use rose-700 on rose-50 with rose-300 border in light mode", () => {
    const src = read("ActivityTimeline.tsx");
    assert.ok(src.includes("text-rose-700"), "light-mode error text floor is rose-700");
    assert.ok(src.includes("bg-rose-50"), "light-mode error surface is rose-50");
    assert.ok(src.includes("border-rose-300"), "light-mode error border is rose-300");
    assert.ok(
      src.includes("border-zinc-300 dark:border-zinc-800"),
      "fold/card borders visible on white"
    );
  });

  it("StintCard and NowLineBar preserve dark-mode classes while meeting light-mode floors", () => {
    const stint = read("StintCard.tsx");
    assert.ok(stint.includes("text-zinc-600 dark:text-zinc-400"), "stint labels mode-aware");
    assert.ok(stint.includes("text-zinc-800 dark:text-zinc-200"), "stint values mode-aware");
    assert.ok(stint.includes("bg-zinc-50 dark:bg-black"), "stint card surface mode-aware");

    const nowLine = read("NowLineBar.tsx");
    assert.ok(nowLine.includes("bg-zinc-50 dark:bg-black"), "now-line surface mode-aware");
    assert.ok(
      nowLine.includes("text-zinc-600 dark:text-zinc-400"),
      "now-line secondary text mode-aware"
    );
  });
});

// ============================================================================
// Rank 13 (U-F5 + U-F6): Repo-wide Design Locks #1–#4 enforcement
// ============================================================================

const WEB_UI_ROOT = path.resolve(__dirname, "..");

function collectSourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(?:tsx|ts)$/.test(entry.name)) out.push(full);
    }
  };
  for (const d of dirs) walk(path.join(WEB_UI_ROOT, d));
  return out;
}

describe("Design Lock #1: Single emerald (#10b981) accent repo-wide", () => {
  const BANNED_ACCENT_FAMILIES =
    /\b(?:[a-z0-9-:\/\[\]]+:)?(?:text|bg|border|ring|stroke|fill|from|to|via|decoration|shadow)-(?:blue|sky|cyan|indigo|purple|violet)-\d{2,3}(?:\/\d+)?\b/g;

  const BANNED_CYAN_SKY_HEXES =
    /#(?:22d3ee|67e8f9|0891b2|155e75|ecfeff|a5f3fc|7dd3fc|bae6fd|e0f2fe|03151a)\b/gi;

  const AMBER_YELLOW_CLASSES =
    /\b(?:[a-z0-9-:\/\[\]]+:)?(?:text|bg|border|ring|stroke|fill|from|to|via)-(?:amber|yellow)-\d{2,3}(?:\/\d+)?\b/g;

  // Genuine host-disconnect indicators are the sole sanctioned amber sites.
  const DISCONNECT_AMBER_ALLOWLIST = new Set([
    "components/ChatStream.tsx",
    "components/settings/hostCard.ts",
  ]);

  it("contains zero blue/sky/cyan/indigo/purple/violet accent classes across web-ui/components and web-ui/app", () => {
    const files = collectSourceFiles(["components", "app"]).filter((f) => f.endsWith(".tsx"));
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(WEB_UI_ROOT, file).replace(/\\/g, "/");
      const src = fs.readFileSync(file, "utf8");
      const hits = src.match(BANNED_ACCENT_FAMILIES);
      if (hits) violations.push(`${rel}: ${[...new Set(hits)].join(", ")}`);
    }
    assert.deepEqual(violations, [], `Banned accent classes found:\n${violations.join("\n")}`);
  });

  it("contains zero cyan/sky hex tokens in design-tokens.css or components", () => {
    const files = [
      path.join(WEB_UI_ROOT, "app", "design-tokens.css"),
      ...collectSourceFiles(["components"]).filter((f) => f.endsWith(".tsx")),
    ];
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(WEB_UI_ROOT, file).replace(/\\/g, "/");
      const src = fs.readFileSync(file, "utf8");
      const hits = src.match(BANNED_CYAN_SKY_HEXES);
      if (hits) violations.push(`${rel}: ${[...new Set(hits)].join(", ")}`);
    }
    assert.deepEqual(violations, [], `Banned cyan/sky hexes found:\n${violations.join("\n")}`);
  });

  it("contains zero non-disconnect amber/yellow classes across components and app", () => {
    const files = collectSourceFiles(["components", "app"]);
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(WEB_UI_ROOT, file).replace(/\\/g, "/");
      if (DISCONNECT_AMBER_ALLOWLIST.has(rel)) continue;
      const src = fs.readFileSync(file, "utf8");
      const hits = src.match(AMBER_YELLOW_CLASSES);
      if (hits) violations.push(`${rel}: ${[...new Set(hits)].join(", ")}`);
    }
    assert.deepEqual(
      violations,
      [],
      `Non-disconnect amber/yellow classes found:\n${violations.join("\n")}`
    );
  });

  it("LiveRunBlock critic fail branch uses rose (not emerald)", () => {
    const src = read("LiveRunBlock.tsx");
    const blockMatch = src.match(/isPass\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/);
    assert.ok(blockMatch, "LiveRunBlock critic verdict ternary must exist");
    assert.ok(blockMatch[1].includes("emerald"), "critic pass uses emerald");
    assert.ok(blockMatch[2].includes("rose"), "critic fail must use rose, not emerald");
    assert.ok(!blockMatch[2].includes("emerald"), "critic fail must not use emerald");
  });
});

describe("Design Lock #2: Pure #000000 dark canvas + light-mode pairing + theme key unification", () => {
  const LIGHT_PAIRED_TARGETS = [
    "components/BoardView.tsx",
    "components/BoardAddSheet.tsx",
    "components/CanvasDiffSheet.tsx",
    "components/ExplorerPanel.tsx",
    "components/CompletionVerificationBadge.tsx",
    "components/SupervisorStatusBadge.tsx",
    "app/error.tsx",
  ];

  it("dark-only views and badges pair light-mode surfaces and drop #0e0e12/#15151b/slate-900 dark-only fills", () => {
    for (const rel of LIGHT_PAIRED_TARGETS) {
      const src = fs.readFileSync(path.join(WEB_UI_ROOT, rel), "utf8");
      assert.ok(
        /\bbg-(?:white|zinc-50|stone-50)\b/.test(src),
        `${rel} must pair light-mode surface classes (bg-white / bg-zinc-50)`
      );
      assert.doesNotMatch(src, /#0e0e12/i, `${rel} must not use #0e0e12`);
      assert.doesNotMatch(src, /#15151b/i, `${rel} must not use #15151b`);
      assert.doesNotMatch(src, /\bbg-slate-900(?:\/\d+)?\b/, `${rel} must not use bg-slate-900`);
      assert.doesNotMatch(src, /\bdark:bg-zinc-950\b/, `${rel} must not use dark:bg-zinc-950`);
    }

    const msgRender = read("chat/messageRender.tsx");
    const disconnectBlock = msgRender.slice(
      msgRender.indexOf('data-testid="host-runner-disconnect-status"'),
      msgRender.indexOf('data-testid="host-runner-disconnect-status"') + 500
    );
    assert.ok(
      disconnectBlock.includes("dark:bg-black") &&
        (disconnectBlock.includes("bg-zinc-50") || disconnectBlock.includes("bg-white")),
      "messageRender.tsx host-runner-disconnect-status must pair light and dark surfaces"
    );
  });

  it("unifies theme storage key lookup to theme || app-theme consistently", () => {
    const themeFiles = [
      "app/layout.tsx",
      "app/morning-report/page.tsx",
      "app/page.tsx",
      "lib/hooks/useTheme.ts",
    ];
    for (const rel of themeFiles) {
      const src = fs.readFileSync(path.join(WEB_UI_ROOT, rel), "utf8");
      assert.doesNotMatch(
        src,
        /localStorage\.getItem\(['"]app-theme['"]\)\s*\|\|\s*localStorage\.getItem\(['"]theme['"]\)/,
        `${rel} must not prioritize app-theme over theme`
      );
      assert.match(
        src,
        /localStorage\.getItem\(['"]theme['"]\)\s*\|\|\s*localStorage\.getItem\(['"]app-theme['"]\)/,
        `${rel} must check theme before app-theme`
      );
    }
  });
});

describe("Design Lock #3: Dark zinc-400 text floor & light-mode >= 4.5:1 contrast", () => {
  it("contains zero banned zinc-500 or un-overridden sub-floor dark text tokens repo-wide", () => {
    const files = collectSourceFiles(["components", "app"]).filter((f) => f.endsWith(".tsx"));
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(WEB_UI_ROOT, file).replace(/\\/g, "/");
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (/(?<![:\w-])text-zinc-500\b/.test(line)) {
          violations.push(`${rel}:${idx + 1} [text-zinc-500]`);
        }
        if (
          /(?<![:\w-])text-(?:slate|neutral|gray|stone)-500\b/.test(line) &&
          !/\bdark:text-/.test(line)
        ) {
          violations.push(`${rel}:${idx + 1} [unpaired text-*-500 without dark:text-*]`);
        }
      });
    }
    assert.deepEqual(violations, [], `Dark text-floor violations:\n${violations.join("\n")}`);
  });

  it("contains zero unprefixed text-*-400 classes on light surfaces across components and app", () => {
    const files = collectSourceFiles(["components", "app"]).filter((f) => f.endsWith(".tsx"));
    const unprefixed400 =
      /(?<![:\w-])text-(?:zinc|slate|stone|neutral|gray|emerald|rose|red|amber)-400(?:\/\d+)?\b/g;
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(WEB_UI_ROOT, file).replace(/\\/g, "/");
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, idx) => {
        const hits = line.match(unprefixed400);
        if (hits) {
          violations.push(`${rel}:${idx + 1} [${hits.join(", ")}]`);
        }
      });
    }
    assert.deepEqual(
      violations,
      [],
      `Unprefixed text-*-400 contrast violations:\n${violations.join("\n")}`
    );
  });
});

describe("Design Lock #4: No personal author metadata in app/layout.tsx", () => {
  it("app/layout.tsx omits authors metadata", () => {
    const src = fs.readFileSync(path.join(WEB_UI_ROOT, "app", "layout.tsx"), "utf8");
    assert.doesNotMatch(src, /\bauthors\s*:/, "app/layout.tsx must not emit metadata.authors");
  });
});
