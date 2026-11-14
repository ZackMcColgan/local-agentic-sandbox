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
];

// Allowlisted non-text or intentional exceptions (each with a one-line reason):
const ALLOWLIST: Array<{ file: string; reason: string }> = [
  // Add any non-text usages here if needed, e.g.:
  // { file: "components/Foo.tsx", reason: "SVG stroke/border, not text" }
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
        if (ALLOWLIST.some((a) => a.file === relPath)) continue;

        const content = fs.readFileSync(file, "utf8");
        const lines = content.split(/\r?\n/);
        lines.forEach((line, idx) => {
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
});
