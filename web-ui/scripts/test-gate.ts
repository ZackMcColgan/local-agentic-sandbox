#!/usr/bin/env node
import { runTestGate, TestGateOptions } from "../lib/testGate.js";

async function main() {
  const args = process.argv.slice(2);
  const options: TestGateOptions = {};

  for (const arg of args) {
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg.startsWith("--budget=")) {
      options.budgetSeconds = parseFloat(arg.split("=")[1]);
    } else if (arg.startsWith("--since=")) {
      options.sinceRef = arg.split("=")[1];
    } else if (arg.startsWith("--files=")) {
      options.changedFiles = arg.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--all") {
      options.changedFiles = [
        "web-ui/lib/svgUtils.ts",
        "web-ui/lib/subagents/supervisor.ts",
        "web-ui/lib/telemetry.ts",
        "web-ui/lib/toolParser.ts",
        "web-ui/lib/fileParser.ts",
        "web-ui/lib/ingestion/pipeline.ts",
        "web-ui/app/api/tasks/route.ts"
      ];
    }
  }

  console.log("===================================================================");
  console.log("  ANTIGRAVITY TEST GATE (Tier 1: Change-Aware Verification)");
  console.log("===================================================================");

  const outcome = runTestGate(options);

  console.log(`  Changed Files Inspected: ${outcome.changedFiles.length}`);
  if (outcome.changedFiles.length > 0) {
    for (const f of outcome.changedFiles.slice(0, 10)) {
      console.log(`    • ${f}`);
    }
    if (outcome.changedFiles.length > 10) {
      console.log(`    ... and ${outcome.changedFiles.length - 10} more`);
    }
  }
  console.log(`  Test Suites Selected:   ${outcome.testsRan.length}`);
  for (const t of outcome.testsRan) {
    console.log(`    -> ${t}`);
  }
  console.log(`  Execution Time:         ${outcome.durationSeconds}s / ${outcome.budgetSeconds}s budget`);

  if (outcome.uncoveredFiles.length > 0) {
    console.error("\n❌ [test:gate] ZERO TEST COVERAGE REJECTION:");
    console.error("  The following modified source files have zero test suite coverage:");
    for (const u of outcome.uncoveredFiles) {
      console.error(`    ⚠️  ${u}`);
    }
    console.error("  Rule: Every change must be covered by a test suite before landing.\n");
    process.exit(1);
  }

  if (outcome.error && outcome.error.includes("budget")) {
    console.error(`\n❌ [test:gate] BUDGET EXCEEDED: ${outcome.error}\n`);
    process.exit(1);
  }

  if (outcome.output) {
    console.log("\n--- Test Execution Output ---");
    console.log(outcome.output.trim());
    console.log("-----------------------------\n");
  }

  if (outcome.status === "passed") {
    console.log(`✅ [test:gate] PASSED: ${outcome.passed} tests passed, 0 failed in ${outcome.durationSeconds}s (<${outcome.budgetSeconds}s budget).\n`);
    process.exit(0);
  } else {
    console.error(`❌ [test:gate] FAILED: ${outcome.passed} passed, ${outcome.failed} failed in ${outcome.durationSeconds}s.\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[test:gate] Fatal error:", err);
  process.exit(1);
});
