#!/usr/bin/env node
/**
 * Test:All Unified Suite Runner (Addendum B1)
 *
 * Runs the full verification stack in order:
 * 1. Unit & Change-Aware Gate: npm run test:gate
 * 2. Stubbed Playwright UI Suite: npm run test:ui
 * 3. Live End-to-End Acceptance Battery: npm run test:e2e:live
 *
 * Each layer fails fast. A combined summary is emitted at the end.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

const layers = [
  { name: "Layer 1: Change-Aware Unit Gate (test:gate)", command: "npm run test:gate" },
  { name: "Layer 2: Fast Stubbed UI Suite (test:ui)", command: "npm run test:ui" },
  { name: "Layer 3: Live End-to-End Acceptance Battery (test:e2e:live)", command: "npm run test:e2e:live" }
];

const results = [];
let overallPass = true;
const totalStart = Date.now();

console.log("===================================================================");
console.log("  TEST:ALL — FULL-SUITE UNIFIED VERIFICATION GATE (Addendum B1)");
console.log("===================================================================\n");

for (const layer of layers) {
  console.log(`\n>>> STARTING ${layer.name}...\n`);
  const start = Date.now();
  const [cmd, ...args] = layer.command.split(" ");
  const isWindows = process.platform === "win32";
  const runCmd = isWindows ? "cmd.exe" : cmd;
  const runArgs = isWindows ? ["/d", "/s", "/c", layer.command] : args;

  const child = spawnSync(runCmd, runArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, TEST_ENGINE: "live" }
  });

  const durationSec = parseFloat(((Date.now() - start) / 1000).toFixed(1));
  const passed = child.status === 0;

  results.push({
    name: layer.name,
    command: layer.command,
    verdict: passed ? "PASS" : "FAIL",
    durationSeconds: durationSec
  });

  if (!passed) {
    overallPass = false;
    console.error(`\n❌ [test:all] ${layer.name} FAILED in ${durationSec}s. Failing fast; aborting remaining layers.\n`);
    break;
  } else {
    console.log(`\n✔ [test:all] ${layer.name} PASSED in ${durationSec}s.\n`);
  }
}

const totalDurationSec = parseFloat(((Date.now() - totalStart) / 1000).toFixed(1));

console.log("\n===================================================================");
console.log("  TEST:ALL COMBINED EXECUTION SUMMARY");
console.log("===================================================================");
for (const r of results) {
  const mark = r.verdict === "PASS" ? "✔" : "❌";
  console.log(`  ${mark} ${r.name.padEnd(55)} [${r.verdict}] (${r.durationSeconds}s)`);
}
for (let i = results.length; i < layers.length; i++) {
  console.log(`  - ${layers[i].name.padEnd(55)} [SKIPPED]`);
}
console.log("-------------------------------------------------------------------");
console.log(`  OVERALL VERDICT: ${overallPass ? "ALL GREEN (FULL SUITE GREEN)" : "FAILED"}`);
console.log(`  TOTAL TIME:      ${totalDurationSec}s (${(totalDurationSec / 60).toFixed(1)}m)`);
console.log("===================================================================\n");

process.exit(overallPass ? 0 : 1);
