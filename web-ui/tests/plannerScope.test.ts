import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTaskComplexity, generatePlanSpec } from "../lib/subagents/planner";

describe("Planner Scope Calibration — Stop Overbuilding Simple Tasks", () => {
  it("classifies 'Create a svg of the weather tomorrow' as SINGLE_ARTIFACT", () => {
    const complexity = classifyTaskComplexity("Create a svg of the weather tomorrow");
    assert.equal(complexity, "SINGLE_ARTIFACT");
  });

  it("classifies create/generate filetype patterns as SINGLE_ARTIFACT", () => {
    assert.equal(classifyTaskComplexity("generate a html report for monthly sales"), "SINGLE_ARTIFACT");
    assert.equal(classifyTaskComplexity("make me a json file with user configuration"), "SINGLE_ARTIFACT");
    assert.equal(classifyTaskComplexity("Create an svg icon of a sun"), "SINGLE_ARTIFACT");
    assert.equal(classifyTaskComplexity("create a csv of mock employee data"), "SINGLE_ARTIFACT");
    assert.equal(classifyTaskComplexity("generate a md document explaining architecture"), "SINGLE_ARTIFACT");
    assert.equal(classifyTaskComplexity("make a txt log of recent transactions"), "SINGLE_ARTIFACT");
  });

  it("classifies explicit single file outputs as SINGLE_ARTIFACT", () => {
    assert.equal(classifyTaskComplexity("Write weather.svg with tomorrow forecast"), "SINGLE_ARTIFACT");
    assert.equal(classifyTaskComplexity("Create output/weather.svg"), "SINGLE_ARTIFACT");
    assert.equal(classifyTaskComplexity("Build index.html landing page"), "SINGLE_ARTIFACT");
  });

  it("classifies single script or small utility prompts as SIMPLE_SCRIPT", () => {
    assert.equal(classifyTaskComplexity("write a python script to ping servers"), "SIMPLE_SCRIPT");
    assert.equal(classifyTaskComplexity("create a small utility to resize images"), "SIMPLE_SCRIPT");
    assert.equal(classifyTaskComplexity("make a bash script to backup database"), "SIMPLE_SCRIPT");
  });

  it("defaults multi-file or full systems to PROJECT", () => {
    assert.equal(classifyTaskComplexity("Build a full stack Next.js app with auth, database, and telemetry"), "PROJECT");
    assert.equal(classifyTaskComplexity("Refactor the supervisor and worker pool architecture"), "PROJECT");
    assert.equal(classifyTaskComplexity("Implement microservices mesh with ingress and redis"), "PROJECT");
  });

  it("SINGLE_ARTIFACT generates exactly 1 milestone with plannedFiles containing 1 entry", async () => {
    const spec = await generatePlanSpec({
      taskId: "task-single-artifact-test",
      goal: "Create a svg of the weather tomorrow"
    });

    assert.equal(spec.complexity, "SINGLE_ARTIFACT");
    assert.equal(spec.milestones.length, 1);
    const m = spec.milestones[0];
    assert.ok(m.title.toLowerCase().includes("svg") || m.title.toLowerCase().includes("weather"));
    assert.equal(m.plannedFiles?.length, 1);
    assert.ok(m.plannedFiles![0].endsWith(".svg"));
    assert.ok(m.skipCriticOnValidSyntax === true);

    // Acceptance criteria check
    assert.ok(m.acceptanceCriteria.length >= 1);
    const hasValidCriteria = m.acceptanceCriteria.some(
      (ac) => ac.assertion.toLowerCase().includes("valid") || ac.assertion.toLowerCase().includes("exists")
    );
    assert.ok(hasValidCriteria);
  });
});
