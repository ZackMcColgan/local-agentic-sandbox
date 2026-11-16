import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WEB_UI_ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["components", "app"];

// Sub-floor dark-mode text classes/tokens: anything darker than zinc-400 / --tx2
const SUB_FLOOR_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "dark:text-zinc-500+", regex: /\bdark:text-zinc-[5-9]00(?:\/\d+)?\b/g },
  { name: "dark:text-slate-500+", regex: /\bdark:text-slate-[5-9]00(?:\/\d+)?\b/g },
  { name: "dark:text-neutral-500+", regex: /\bdark:text-neutral-[5-9]00(?:\/\d+)?\b/g },
  { name: "dark:text-gray-500+", regex: /\bdark:text-gray-[5-9]00(?:\/\d+)?\b/g },
  { name: "--txm text color", regex: /\bcolor:\s*var\(--txm\)|text-\[var\(--txm\)\]/g },
  { name: "dark:placeholder sub-floor", regex: /\bdark:placeholder:text-(?:zinc|slate|neutral|gray)-[5-9]00(?:\/\d+)?\b/g },
  { name: "hex text below floor (#52525b)", regex: /\btext-\[#52525b\]/gi },
];

// Allowlisted non-text or intentional exceptions (each with a one-line reason):
const ALLOWLIST: Array<{ file: string; lineMatch?: RegExp; reason: string }> = [
  { file: "components/ProjectsView.tsx", lineMatch: /dark:bg-zinc-100.*dark:text-zinc-900|dark:text-zinc-900.*dark:bg-zinc-100/, reason: "Inverted light-background button (dark:bg-zinc-100)" },
];

function collectTsxFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsxFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts") || entry.name.endsWith(".css"))) {
      results.push(full);
    }
  }
  return results;
}

describe("UI-050: Dark mode text floor (>= zinc-400 / --tx2)", () => {
  it("contains no sub-floor dark-mode text classes in web-ui/components or web-ui/app", () => {
    const violations: string[] = [];

    for (const relDir of SCAN_DIRS) {
      const files = collectTsxFiles(path.join(WEB_UI_ROOT, relDir));
      for (const file of files) {
        const relPath = path.relative(WEB_UI_ROOT, file).replace(/\\/g, "/");
        if (ALLOWLIST.some((a) => a.file === relPath && !a.lineMatch)) continue;

        const content = fs.readFileSync(file, "utf8");
        const lines = content.split(/\r?\n/);
        lines.forEach((line, idx) => {
          if (ALLOWLIST.some((a) => a.file === relPath && a.lineMatch && a.lineMatch.test(line))) return;
          for (const pat of SUB_FLOOR_PATTERNS) {
            pat.regex.lastIndex = 0;
            const matches = line.match(pat.regex);
            if (matches) {
              violations.push(`${relPath}:${idx + 1} [${pat.name}] -> ${matches.join(", ")}`);
            }
          }
        });
      }
    }

    assert.equal(
      violations.length,
      0,
      `Found ${violations.length} sub-floor dark-mode text usage(s):\n${violations.slice(0, 40).join("\n")}`
    );
  });

  it("FP5: design-tokens.css --text-muted is >= #a1a1aa (zinc-400) and ProjectsView button has dark:text-zinc-900", () => {
    const tokens = fs.readFileSync(path.join(WEB_UI_ROOT, "app", "design-tokens.css"), "utf8");
    assert.doesNotMatch(tokens, /--text-muted:\s*#71717a/i, "--text-muted must not be #71717a (zinc-500)");

    const pv = fs.readFileSync(path.join(WEB_UI_ROOT, "components", "ProjectsView.tsx"), "utf8");
    assert.match(pv, /dark:bg-zinc-100[\s\S]{0,80}dark:text-zinc-900/, "ProjectsView inverted button should have dark:text-zinc-900");
  });
});
