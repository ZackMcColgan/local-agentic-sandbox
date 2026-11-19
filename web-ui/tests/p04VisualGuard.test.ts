import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("P0.4 — Visual-rule computed-style guard", () => {
  const globalsCss = fs.readFileSync(path.resolve(process.cwd(), "app/globals.css"), "utf8");
  const layoutTsx = fs.readFileSync(path.resolve(process.cwd(), "app/layout.tsx"), "utf8");

  it("enforces Obsidian Atelier burnished-amber --accent in both light (32 95% 37%) and dark (38 92% 50%) tokens", () => {
    const accentMatches = [...globalsCss.matchAll(/--accent:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.ok(accentMatches.length >= 2, "Expected --accent in :root and .dark");
    assert.equal(accentMatches[0], "32 95% 37%", `Expected light amber accent 32 95% 37%, got ${accentMatches[0]}`);
    assert.equal(accentMatches[1], "38 92% 50%", `Expected dark amber accent 38 92% 50%, got ${accentMatches[1]}`);
  });

  it("enforces pure #000000 dark themeColor in layout.tsx", () => {
    assert.match(layoutTsx, /prefers-color-scheme:\s*dark[^}]*color:\s*"#000000"/);
  });

  it("enforces warm alabaster (60 9% 98%) light background, pure white card, and pure black (0 0% 0%) dark background", () => {
    assert.match(globalsCss, /:root\s*\{[\s\S]*?--background:\s*60 9% 98%;/);
    assert.match(globalsCss, /:root\s*\{[\s\S]*?--card:\s*0 0% 100%;/);
    assert.match(globalsCss, /\.dark,\s*\[data-theme="dark"\]\s*\{[\s\S]*?--background:\s*0 0% 0%;/);
  });
});
