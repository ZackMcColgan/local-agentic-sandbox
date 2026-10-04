import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { resolveAffectedTests, runTestGate, TestGateOptions } from "../lib/testGate.js";

describe("Phase C — Test Gate & Tiering Suite", () => {
  it("maps modified source files to their corresponding test suites", () => {
    // 1. SvgViewer and svgUtils map to SVG test suites
    const svgResult = resolveAffectedTests(["web-ui/lib/svgUtils.ts", "web-ui/components/SvgViewer.tsx"]);
    assert.ok(svgResult.tests.includes("tests/svgRendering.test.ts"));
    assert.ok(svgResult.tests.includes("tests/svgComponent.test.ts"));
    assert.ok(svgResult.uncoveredFiles.length === 0, "No uncovered files for svgUtils");

    // 2. Supervisor & WorkerPool map to LangGraph and supervisor test suites
    const agentResult = resolveAffectedTests([
      "web-ui/lib/subagents/supervisor.ts",
      "web-ui/lib/subagents/workerPool.ts"
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
    const docResult = resolveAffectedTests(["README.md", "docs/architecture.drawio.png", ".gitignore"]);
    assert.ok(docResult.uncoveredFiles.length === 0, "Doc files must not trigger uncovered error");
  });

  it("enforces zero-coverage-is-an-error: fails if a changed source file has no test suite", () => {
    const unmappedResult = resolveAffectedTests([
      "web-ui/lib/untestedSubsystemFeature.ts",
      "web-ui/components/SecretUntestedWidget.tsx"
    ]);

    assert.ok(unmappedResult.uncoveredFiles.includes("web-ui/lib/untestedSubsystemFeature.ts"));
    assert.ok(unmappedResult.uncoveredFiles.includes("web-ui/components/SecretUntestedWidget.tsx"));

    // Attempting to run testGate with uncovered files must fail
    const gateOutcome = runTestGate({
      changedFiles: ["web-ui/lib/untestedSubsystemFeature.ts"],
      dryRun: true
    });

    assert.equal(gateOutcome.status, "failed");
    assert.equal(gateOutcome.exitCode, 1);
    assert.ok(gateOutcome.error?.includes("Zero test coverage detected"), "Must report zero coverage error");
    assert.ok(gateOutcome.error?.includes("web-ui/lib/untestedSubsystemFeature.ts"));
  });

  it("runs change-aware tests within the 90-second budget and reports honest test outcomes", () => {
    const startTime = Date.now();

    const gateOutcome = runTestGate({
      changedFiles: ["web-ui/lib/toolParser.ts"],
      budgetSeconds: 90
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
      budgetSeconds: 0.00001
    });

    assert.equal(gateOutcome.status, "failed");
    assert.equal(gateOutcome.exitCode, 1);
    assert.ok(gateOutcome.error?.includes("exceeded budget"), "Must error on budget overrun");
  });
});
