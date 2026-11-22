import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { partitionWebUiTests, parsePlaywrightReport } from "../lib/testGate.js";

/**
 * Captured from a real local `npx playwright test tests/e2e/inTurnExperience.spec.ts --project=desktop-light`
 * run's `playwright-report/test-results.json`, trimmed to the top-level fields read by the parser.
 */
const REAL_PLAYWRIGHT_REPORT_PASSING = {
  errors: [] as unknown[],
  stats: {
    startTime: "2026-11-17T09:00:59.449Z",
    duration: 26667.071,
    expected: 14,
    skipped: 0,
    unexpected: 0,
    flaky: 0,
  },
};

describe("Test Gate — Playwright Runner Partition & Report Parsing", () => {
  it("partitions tests/e2e/*.spec.ts into playwrightSpecs and keeps non-e2e tests in tsxTests", () => {
    const mixed = [
      "tests/toolParser.test.ts",
      "tests/explorerPanel.spec.ts",
      "tests/e2e/inTurnExperience.spec.ts",
      "tests\\e2e\\invariantNet.spec.ts",
      "tests/testGate.test.ts",
    ];

    const { playwrightSpecs, tsxTests } = partitionWebUiTests(mixed);

    assert.deepStrictEqual(playwrightSpecs, [
      "tests/e2e/inTurnExperience.spec.ts",
      "tests\\e2e\\invariantNet.spec.ts",
    ]);
    assert.deepStrictEqual(tsxTests, [
      "tests/toolParser.test.ts",
      "tests/explorerPanel.spec.ts",
      "tests/testGate.test.ts",
    ]);
    assert.ok(tsxTests.includes("tests/explorerPanel.spec.ts"));
    assert.ok(!playwrightSpecs.includes("tests/explorerPanel.spec.ts"));
  });

  it("parses a passing Playwright JSON report", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-report-pass-"));
    const reportPath = path.join(tmpDir, "test-results.json");
    try {
      fs.writeFileSync(reportPath, JSON.stringify(REAL_PLAYWRIGHT_REPORT_PASSING), "utf8");
      const counts = parsePlaywrightReport(reportPath);
      assert.deepStrictEqual(counts, { passed: 14, failed: 0 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses a Playwright JSON report with failing tests", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-report-fail-"));
    const reportPath = path.join(tmpDir, "test-results.json");
    try {
      const withFailures = {
        ...REAL_PLAYWRIGHT_REPORT_PASSING,
        stats: {
          ...REAL_PLAYWRIGHT_REPORT_PASSING.stats,
          expected: 11,
          unexpected: 3,
        },
      };
      fs.writeFileSync(reportPath, JSON.stringify(withFailures), "utf8");
      const counts = parsePlaywrightReport(reportPath);
      assert.deepStrictEqual(counts, { passed: 11, failed: 3 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when the Playwright JSON report file is missing", () => {
    const missingPath = path.join(os.tmpdir(), "nonexistent-pw-report-12345.json");
    assert.throws(() => parsePlaywrightReport(missingPath));
  });

  it("throws when the Playwright JSON report file is malformed or missing stats", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-report-bad-"));
    const malformedPath = path.join(tmpDir, "malformed.json");
    const missingStatsPath = path.join(tmpDir, "missing-stats.json");
    try {
      fs.writeFileSync(malformedPath, "{not valid json", "utf8");
      fs.writeFileSync(missingStatsPath, JSON.stringify({ errors: [] }), "utf8");
      assert.throws(() => parsePlaywrightReport(malformedPath));
      assert.throws(() => parsePlaywrightReport(missingStatsPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
