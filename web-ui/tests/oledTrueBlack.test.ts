import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// OLED true-black (owner request, Nov 13 2026): in dark mode the sections
// that read as "black" must be pure #000000 so OLED pixels switch off.
// Elevated surfaces (cards, sidebar panels) intentionally stay lifted
// zinc shades so layers still read; only the canvas-level blacks change.

const webUi = path.resolve(__dirname, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(webUi, rel), "utf8");
}

function darkBlock(css: string): string {
  const start = css.indexOf('[data-theme="dark"]');
  assert.ok(start >= 0, "dark theme block exists");
  return css.slice(start, css.indexOf("\n}", start));
}

describe("OLED true black — dark mode canvas surfaces", () => {
  it("design tokens: dark canvas and code well are pure black", () => {
    const block = darkBlock(read("app/design-tokens.css"));
    assert.match(block, /--bg-canvas:\s*#000000/, "canvas is #000000");
    assert.match(block, /--code-bg:\s*#000000/, "code well is #000000");
    assert.ok(!block.includes("#09090b"), "no zinc-950 left in dark tokens");
  });

  it("design tokens: elevated surfaces stay lifted (layers still read)", () => {
    const block = darkBlock(read("app/design-tokens.css"));
    assert.match(block, /--bg-surface-2:\s*#18181b/, "card surface stays zinc-900");
    assert.match(block, /--bg-surface-3:\s*#27272a/, "pill surface stays zinc-800");
  });

  it("globals: dark background token and body paint are pure black", () => {
    const css = read("app/globals.css");
    const dark = css.slice(css.indexOf('.dark, [data-theme="dark"]'));
    assert.match(dark, /--background:\s*0 0% 0%/, "shadcn background is 0 0% 0%");
    assert.match(
      css,
      /html\.dark body,\s*\nhtml\[data-theme="dark"\] body \{\s*\n\s*color-scheme: dark !important;\s*\n\s*background-color: #000000 !important;/,
      "body paints #000000 in dark mode",
    );
    assert.ok(!css.includes("#09090b"), "no zinc-950 left in globals");
  });

  it("components: no dark:bg-zinc-950 remains (canvas classes are bg-black)", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          if (fs.readFileSync(full, "utf8").includes("dark:bg-zinc-950")) {
            offenders.push(path.relative(webUi, full));
          }
        }
      }
    };
    walk(path.join(webUi, "components"));
    walk(path.join(webUi, "app"));
    assert.deepEqual(offenders, [], `still zinc-950: ${offenders.join(", ")}`);
  });
});
