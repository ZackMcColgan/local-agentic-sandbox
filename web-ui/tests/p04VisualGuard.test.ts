import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("P0.4 — Visual-rule computed-style guard", () => {
  const globalsCss = fs.readFileSync(path.resolve(process.cwd(), "app/globals.css"), "utf8");
  const layoutTsx = fs.readFileSync(path.resolve(process.cwd(), "app/layout.tsx"), "utf8");

  it("enforces emerald-only --accent (160 84% 39%) in both light and dark tokens", () => {
    const accentMatches = [...globalsCss.matchAll(/--accent:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.ok(accentMatches.length >= 2, "Expected --accent in :root and .dark");
    for (const val of accentMatches) {
      assert.equal(val, "160 84% 39%", `Expected emerald accent 160 84% 39%, got ${val}`);
    }
  });

  it("enforces pure #000000 dark themeColor in layout.tsx", () => {
    assert.match(layoutTsx, /prefers-color-scheme:\s*dark[^}]*color:\s*"#000000"/);
  });

  it("enforces pure white (#ffffff / 0 0% 100%) light background and card, and pure black (0 0% 0%) dark background", () => {
    assert.match(globalsCss, /:root\s*\{[\s\S]*?--background:\s*0 0% 100%;/);
    assert.match(globalsCss, /:root\s*\{[\s\S]*?--card:\s*0 0% 100%;/);
    assert.match(globalsCss, /\.dark,\s*\[data-theme="dark"\]\s*\{[\s\S]*?--background:\s*0 0% 0%;/);
  });
});
