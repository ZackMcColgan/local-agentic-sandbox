import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

/**
 * Manifest-completeness invariant: every test file on disk under web-ui/tests
 * must appear in at least one MAPPING_RULES entry in lib/testGate.ts, so the
 * change-aware gate can never silently skip a suite when its guarded source
 * file changes.
 *
 * This test reads the gate's own source text (same source-content assertion
 * style used by chatRoundBudget/chatToolDegradation) and extracts every
 * quoted "tests/<name>.test.ts" literal from the MAPPING_RULES array region.
 */
describe("Gate manifest completeness", () => {
  const gatePath = path.resolve(__dirname, "../lib/testGate.ts");
  const testsDir = __dirname;

  it("every web-ui/tests/*.test.ts file on disk is wired into MAPPING_RULES", () => {
    const src = fs.readFileSync(gatePath, "utf8");
    const start = src.indexOf("const MAPPING_RULES");
    assert.ok(start >= 0, "lib/testGate.ts must declare MAPPING_RULES");
    // The rules array ends at the closing bracket of the array literal.
    const end = src.indexOf("\n];", start);
    assert.ok(end > start, "MAPPING_RULES array must have a closing bracket");
    const rulesRegion = src.slice(start, end);

    const wired = new Set<string>();
    for (const match of rulesRegion.matchAll(/"tests\/[^"]+\.test\.ts"/g)) {
      wired.add(match[0].slice(1, -1));
    }

    const diskFiles = fs
      .readdirSync(testsDir)
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => `tests/${f}`)
      .sort();

    assert.ok(diskFiles.length > 0, "expected at least one test file on disk");

    const unwired = diskFiles.filter((f) => !wired.has(f));
    assert.equal(
      unwired.length,
      0,
      `Unwired test files (not referenced by any MAPPING_RULES entry): ${unwired.join(", ")}`
    );
  });
});
