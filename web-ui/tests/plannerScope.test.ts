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

  describe("Explicit Task Scope Options (SNIPPET / SCRIPT / PROJECT)", () => {
    it("SNIPPET scope forces exactly 1 milestone, 1 plannedFile, and no scaffolding for 'Create a typescript hello world'", async () => {
      const spec = await generatePlanSpec({
        taskId: "task-snippet-ts-hello",
        goal: "Create a typescript hello world",
        scope: "SNIPPET"
      });

      assert.equal(spec.scope, "SNIPPET");
      assert.equal(spec.milestones.length, 1, "SNIPPET must never produce more than 1 milestone");
      const m = spec.milestones[0];
      assert.equal(m.plannedFiles?.length, 1);
      assert.ok(
        m.description.includes("Generate ONLY the requested file") &&
        m.description.includes("Do NOT create supporting code, project scaffolding, build configs, or API clients"),
        "Builder prompt must forbid scaffolding and extra code"
      );
      assert.ok(!spec.milestones.some((item) => item.title.includes("Initialize TypeScript project")), "Must not have project initialization step");
    });

    it("SNIPPET scope forces exactly 1 milestone for 'Create a svg of the weather tomorrow'", async () => {
      const spec = await generatePlanSpec({
        taskId: "task-snippet-weather-svg",
        goal: "Create a svg of the weather tomorrow",
        scope: "SNIPPET"
      });

      assert.equal(spec.scope, "SNIPPET");
      assert.equal(spec.milestones.length, 1);
      assert.equal(spec.milestones[0].plannedFiles?.length, 1);
      assert.ok(spec.milestones[0].plannedFiles![0].endsWith(".svg"));
    });

    it("SCRIPT scope constrains decomposition to 1-2 milestones max", async () => {
      // Mock generate function returning 4 milestones
      const mockGenerate = async () => ({
        text: JSON.stringify({
          milestones: [
            { id: "M1", title: "Write ping script", plannedFiles: ["ping.py"] },
            { id: "M2", title: "Add timeout handler", plannedFiles: ["ping.py"] },
            { id: "M3", title: "Add extra docs", plannedFiles: ["README.md"] },
            { id: "M4", title: "Add extra tests", plannedFiles: ["test_ping.py"] }
          ]
        })
      });

      const spec = await generatePlanSpec({
        taskId: "task-script-test",
        goal: "write a python script to ping servers",
        scope: "SCRIPT",
        generate: mockGenerate as any
      });

      assert.equal(spec.scope, "SCRIPT");
      assert.ok(spec.milestones.length <= 2, `SCRIPT must cap at 2 milestones max, got ${spec.milestones.length}`);
    });

    it("PROJECT scope preserves full multi-milestone decomposition for 'Build a REST API'", async () => {
      const mockGenerate = async () => ({
        text: JSON.stringify({
          milestones: [
            { id: "M1", title: "Define routes & schema", plannedFiles: ["src/routes.ts"] },
            { id: "M2", title: "Implement controller logic", plannedFiles: ["src/controller.ts"] },
            { id: "M3", title: "Add authentication & integration tests", plannedFiles: ["src/auth.ts"] }
          ]
        })
      });

      const spec = await generatePlanSpec({
        taskId: "task-project-rest-api",
        goal: "Build a REST API",
        scope: "PROJECT",
        generate: mockGenerate as any
      });

      assert.equal(spec.scope, "PROJECT");
      assert.equal(spec.milestones.length, 3, "PROJECT should retain full decomposition");
    });

    it("createProductionStepExecutor forwards scope='PROJECT' to Builder and Critic generate calls", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-test-"));

      const { createProductionStepExecutor } = await import("../lib/subagents/supervisor");
      const { WorkerPool } = await import("../lib/subagents/workerPool");
      const capturedRequests: any[] = [];
      const spyGenerate = async (req: any) => {
        capturedRequests.push(req);
        if (req.prompt && (req.prompt.includes("CRITIC") || req.prompt.includes("grade") || req.prompt.includes("VERDICT"))) {
          return { text: "VERDICT: APPROVED\nAll tests pass" };
        }
        return { text: "```typescript\nexport const foo = 42;\n```" };
      };

      const workerPool = new WorkerPool({
        scope: "PROJECT",
        generate: spyGenerate as any
      });

      const executor = createProductionStepExecutor({
        workerPool,
        scope: "PROJECT",
        repoRoot: tmpDir
      });

      const milestone = {
        id: "M1",
        title: "Test milestone",
        description: "Write foo.ts",
        status: "pending" as const,
        builderIterations: 0,
        criticRounds: 0,
        plannedFiles: ["foo.ts"],
        acceptanceCriteria: [{ id: "AC1", assertion: "foo exists", fileMatch: "foo.ts" }]
      };

      try {
        await executor(milestone, 1);

        assert.ok(capturedRequests.length >= 1, "At least one generate request must be captured");
        for (const req of capturedRequests) {
          assert.equal(req.scope, "PROJECT", `Expected req.scope to be PROJECT, got ${req.scope}`);
        }
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    });
  });
});
