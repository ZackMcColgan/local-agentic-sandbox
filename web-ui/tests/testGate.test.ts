import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAffectedTests, runTestGate, discoverAllTests } from "../lib/testGate.js";
import {
  checkOllama,
  enableOllamaMock,
  disableOllamaMock,
  logServiceMode,
} from "./helpers/serviceMocks.js";

describe("Phase C — Test Gate & Tiering Suite", () => {
  let useRealOllama = false;

  before(async () => {
    useRealOllama = await checkOllama();
    logServiceMode("ollama", useRealOllama);
    if (!useRealOllama) enableOllamaMock();
  });

  after(() => {
    if (!useRealOllama) disableOllamaMock();
  });
  it("maps modified source files to their corresponding test suites", () => {
    // 1. SvgViewer and svgUtils map to SVG test suites
    const svgResult = resolveAffectedTests([
      "web-ui/lib/svgUtils.ts",
      "web-ui/components/SvgViewer.tsx",
    ]);
    assert.ok(svgResult.tests.includes("tests/svgRendering.test.ts"));
    assert.ok(svgResult.tests.includes("tests/svgComponent.test.ts"));
    assert.ok(svgResult.uncoveredFiles.length === 0, "No uncovered files for svgUtils");

    // 2. Supervisor & WorkerPool map to LangGraph and supervisor test suites
    const agentResult = resolveAffectedTests([
      "web-ui/lib/subagents/supervisor.ts",
      "web-ui/lib/subagents/workerPool.ts",
    ]);
    assert.ok(agentResult.tests.includes("tests/supervisor.test.ts"));
    assert.ok(agentResult.tests.includes("tests/langgraphSupervisorNodes.test.ts"));
    assert.ok(agentResult.tests.includes("tests/workerPool.test.ts"));
    assert.ok(agentResult.uncoveredFiles.length === 0, "No uncovered files for supervisor");

    // 3. Test files themselves directly map to their own test suite
    const selfResult = resolveAffectedTests(["web-ui/tests/toolParser.test.ts"]);
    assert.deepStrictEqual(selfResult.tests, ["tests/toolParser.test.ts"]);
    assert.ok(selfResult.uncoveredFiles.length === 0);

    // 4. Ignored non-code files (documentation, image artifacts) do not require test suites
    const docResult = resolveAffectedTests([
      "README.md",
      "docs/architecture.drawio.png",
      ".gitignore",
    ]);
    assert.ok(docResult.uncoveredFiles.length === 0, "Doc files must not trigger uncovered error");
  });

  it("enforces zero-coverage-is-an-error: fails if a changed source file has no test suite", () => {
    const unmappedResult = resolveAffectedTests([
      "web-ui/lib/untestedSubsystemFeature.ts",
      "web-ui/components/SecretUntestedWidget.tsx",
    ]);

    assert.ok(unmappedResult.uncoveredFiles.includes("web-ui/lib/untestedSubsystemFeature.ts"));
    assert.ok(unmappedResult.uncoveredFiles.includes("web-ui/components/SecretUntestedWidget.tsx"));

    // Attempting to run testGate with uncovered files must fail
    const gateOutcome = runTestGate({
      changedFiles: ["web-ui/lib/untestedSubsystemFeature.ts"],
      dryRun: true,
    });

    assert.equal(gateOutcome.status, "failed");
    assert.equal(gateOutcome.exitCode, 1);
    assert.ok(
      gateOutcome.error?.includes("Zero test coverage detected"),
      "Must report zero coverage error"
    );
    assert.ok(gateOutcome.error?.includes("web-ui/lib/untestedSubsystemFeature.ts"));
  });

  it("runs change-aware tests within the 90-second budget and reports honest test outcomes", () => {
    const startTime = Date.now();

    const gateOutcome = runTestGate({
      changedFiles: ["web-ui/lib/toolParser.ts"],
      budgetSeconds: 90,
    });

    const elapsedSeconds = (Date.now() - startTime) / 1000;

    assert.equal(gateOutcome.status, "passed");
    assert.equal(gateOutcome.exitCode, 0);
    assert.ok(gateOutcome.testsRan.includes("tests/toolParser.test.ts"));
    assert.ok(gateOutcome.passed > 0, "Must have passed tests");
    assert.equal(gateOutcome.failed, 0, "Must have 0 failed tests");
    assert.ok(gateOutcome.durationSeconds < 90, "Duration must be under 90s budget");
    assert.ok(elapsedSeconds < 90, "Wall clock time must be under 90s budget");
  });

  it("fails test gate when budget is exceeded", () => {
    // Artificial 0.0001s budget to test budget limit enforcement
    const gateOutcome = runTestGate({
      changedFiles: ["web-ui/lib/toolParser.ts"],
      budgetSeconds: 0.00001,
    });

    assert.equal(gateOutcome.status, "failed");
    assert.equal(gateOutcome.exitCode, 1);
    assert.ok(gateOutcome.error?.includes("exceeded budget"), "Must error on budget overrun");
  });

  it("maps browser-mcp changes to browser-mcp:tests and exports CANONICAL_WORKSPACES", () => {
    const browserResult = resolveAffectedTests([
      "browser-mcp/src/index.ts",
      "browser-mcp/tests/tools.test.ts",
    ]);
    assert.ok(
      browserResult.tests.includes("browser-mcp:tests"),
      "Must map browser-mcp files to browser-mcp:tests"
    );
    assert.ok(
      !browserResult.tests.includes("browser-mcp/tests/tools.test.ts"),
      "Must not pass browser-mcp test paths to web-ui tsx runner"
    );
    assert.equal(
      browserResult.uncoveredFiles.length,
      0,
      "No uncovered files for browser-mcp changes"
    );
  });

  it("maps the 4 real charter modules to their test suites with zero uncovered files", () => {
    const charterModules = [
      ["web-ui/lib/board/boardStore.ts", "tests/boardStore.test.ts"],
      ["web-ui/lib/board/dispatcher.ts", "tests/dispatcher.test.ts"],
      ["web-ui/lib/board/flowMonitor.ts", "tests/flowMonitor.test.ts"],
      ["web-ui/lib/board/reviewerGate.ts", "tests/reviewerGate.test.ts"],
    ];

    const result = resolveAffectedTests(charterModules.map(([mod]) => mod));
    assert.deepEqual(result.uncoveredFiles, []);
    for (const [, expectedTest] of charterModules) {
      assert.ok(result.tests.includes(expectedTest), `Expected ${expectedTest} in mapped tests`);
    }
  });

  it("rejects ghost test paths: no MAPPING_RULES entry references nonexistent suites", () => {
    const gatePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../lib/testGate.ts"
    );
    const src = fs.readFileSync(gatePath, "utf8");
    const ghosts = [
      "tests/liveStatus.test.ts",
      "tests/executionSummary.test.ts",
      "tests/modelEval.test.ts",
    ];
    for (const ghost of ghosts) {
      assert.ok(
        !src.includes(`"${ghost}"`),
        `Ghost test path ${ghost} must not appear in lib/testGate.ts`
      );
    }
  });

  it("maps changed e2e spec files to themselves despite the ignore list (evaluation order)", () => {
    const specs = [
      "web-ui/tests/e2e/explorerPanel.spec.ts",
      "web-ui/tests/e2e/boardControl.spec.ts",
      "web-ui/tests/e2e/flows.spec.ts",
      "web-ui/tests/e2e/layoutInvariants.spec.ts",
      "web-ui/tests/e2e/realmode.spec.ts",
      "web-ui/tests/e2e/regressions.spec.ts",
      "web-ui/tests/e2e/scenarios.spec.ts",
      "web-ui/tests/e2e/settingsMobile.spec.ts",
      "web-ui/tests/e2e/board-intake.spec.ts",
      "web-ui/tests/e2e/board-orchestrator.spec.ts",
    ];
    const result = resolveAffectedTests(specs);
    assert.deepEqual(result.uncoveredFiles, [], "Spec changes must not be flagged uncovered");
    assert.deepEqual(result.ignoredFiles, [], "Spec changes must not be silently ignored");
    for (const spec of specs) {
      const expected = spec.replace(/^web-ui\//, "");
      assert.ok(result.tests.includes(expected), `Expected ${expected} in mapped tests`);
    }
  });

  it("maps scripts/llamacpp-standalone.js and supervisorControl.test.js to the supervisor suite", () => {
    const result = resolveAffectedTests([
      "scripts/llamacpp-standalone.js",
      "scripts/tests/supervisorControl.test.js",
    ]);
    assert.deepEqual(result.uncoveredFiles, []);
    assert.ok(
      result.tests.includes("scripts/tests/supervisorControl.test.js"),
      "supervisorControl.test.js must be wired into the gate"
    );
  });

  it("includes TypeScript typecheck stage in gate run", () => {
    const gateOutcome = runTestGate({
      changedFiles: ["web-ui/lib/toolParser.ts"],
      dryRun: true,
    });
    assert.equal(gateOutcome.status, "passed");
    assert.ok(
      Array.isArray(gateOutcome.stages) && gateOutcome.stages.includes("tsc --noEmit"),
      "Gate outcome must include 'tsc --noEmit' in stages"
    );
  });

  it("discoverAllTests returns the full on-disk test set, not a 7-file seed", () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const all = discoverAllTests();

    // Every web-ui/tests/*.test.ts on disk must be included
    const diskUnit = fs
      .readdirSync(testDir)
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => `tests/${f}`);
    for (const t of diskUnit) {
      assert.ok(all.includes(t), `--all discovery must include ${t}`);
    }

    // Every Playwright spec (tests/e2e + relocated tests-live specs) must be included
    const diskSpecs = fs
      .readdirSync(path.join(testDir, "e2e"))
      .filter((f) => f.endsWith(".spec.ts"))
      .map((f) => `tests/e2e/${f}`);
    for (const s of diskSpecs) {
      assert.ok(all.includes(s), `--all discovery must include ${s}`);
    }

    // The orphaned supervisor control suite must be included
    assert.ok(
      all.includes("scripts/tests/supervisorControl.test.js"),
      "--all discovery must include scripts/tests/supervisorControl.test.js"
    );

    // Workspace suites must be included
    assert.ok(all.includes("mcp-server:tests"), "--all must include mcp-server:tests");
    assert.ok(all.includes("browser-mcp:tests"), "--all must include browser-mcp:tests");
    assert.ok(all.includes("host-bridge:tests"), "--all must include host-bridge:tests");

    // Ghost suites must never appear
    for (const ghost of [
      "tests/liveStatus.test.ts",
      "tests/executionSummary.test.ts",
      "tests/modelEval.test.ts",
    ]) {
      assert.ok(!all.includes(ghost), `Ghost suite ${ghost} must not be discovered`);
    }
  });

  it("host-bridge package.json test script points at files that exist", () => {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../host-bridge/package.json"
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts: Record<string, string> };
    const testScript = pkg.scripts.test ?? "";
    assert.ok(
      !testScript.includes("tests/**/*.test.ts"),
      "host-bridge test script must not point at the nonexistent host-bridge/tests/ directory"
    );
    assert.ok(
      testScript.includes("web-ui/tests"),
      "host-bridge test script must run the real host-bridge suites living in web-ui/tests"
    );
  });
});
