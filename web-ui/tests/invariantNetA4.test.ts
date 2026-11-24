import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WEB_UI_ROOT = path.resolve(__dirname, "..");
const drawerSrc = fs.readFileSync(
  path.join(WEB_UI_ROOT, "components", "NavigationDrawer.tsx"),
  "utf8"
);
const settingsSrc = fs.readFileSync(
  path.join(WEB_UI_ROOT, "components", "SettingsView.tsx"),
  "utf8"
);
const boardSrc = fs.readFileSync(path.join(WEB_UI_ROOT, "components", "BoardView.tsx"), "utf8");

test("Phase A4 — NavigationDrawer nav labels use primary text tier (zinc-100 / --tx1)", () => {
  assert.match(
    drawerSrc,
    /text-zinc-100|var\(--tx1\)/,
    "NavigationDrawer must use primary text tier (text-zinc-100 or --tx1) for nav labels"
  );
  // Ensure nav destination buttons don't drop to dim tiers like text-zinc-500 or text-zinc-600
  const navSectionMatch = drawerSrc.match(/Destination: Sessions[\s\S]*?onNavigate\("skills"\)/);
  assert.ok(navSectionMatch, "Expected NavigationDrawer destination buttons block");
  assert.equal(
    /text-zinc-500|text-zinc-600/.test(navSectionMatch[0]),
    false,
    "NavigationDrawer destination labels must not use dimmer tiers (zinc-500/zinc-600)"
  );
});

test("Phase A4 — SettingsView section/menu labels use primary text tier (zinc-100 / --tx1)", () => {
  assert.match(
    settingsSrc,
    /text-zinc-100|var\(--tx1\)/,
    "SettingsView must use primary text tier (text-zinc-100 or --tx1) for section/menu labels"
  );
});

test("Phase A4 — BoardView column headers stay at primary/high-contrast tier (zinc-100..zinc-300, never zinc-500+)", () => {
  const headerMatches = [...boardSrc.matchAll(/<h2[^>]*className="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(headerMatches.length > 0, "Expected BoardView <h2> column headers");
  for (const cls of headerMatches) {
    // The rule governs the DARK canvas tier: when a class pairs a light-mode
    // text-zinc-* with a dark: variant, the dark: variant is what renders on
    // the dark canvas (a light-mode text-zinc-900 is the highest-contrast
    // choice there, not a dim tier). Only an unpaired unprefixed class is
    // judged directly.
    const darkTier =
      /dark:text-zinc-(\d+)00/.exec(cls)?.[1] ?? /(?<![:\w-])text-zinc-(\d+)00/.exec(cls)?.[1];
    assert.ok(
      darkTier === undefined || Number(darkTier) < 5,
      `BoardView column header class "${cls}" must not drop to zinc-500 or dimmer on the dark canvas`
    );
  }
});
