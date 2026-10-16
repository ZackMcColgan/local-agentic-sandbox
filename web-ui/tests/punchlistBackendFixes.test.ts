import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

describe("Flash 3.8 Backend Shakeout — Fix 1: B-P0-1 Dockerfile & BuilderWorker Surgical Patch", () => {
  it("web-ui/Dockerfile copies workspace package.json files in Stage 1", () => {
    const dockerfileContent = fs.readFileSync(
      path.resolve(process.cwd(), "web-ui/Dockerfile"),
      "utf8"
    );
    assert.match(
      dockerfileContent,
      /COPY mcp-server\/package\*\.json \.\/mcp-server\//,
      "Dockerfile Stage 1 must copy mcp-server/package*.json"
    );
    assert.match(
      dockerfileContent,
      /COPY browser-mcp\/package\*\.json \.\/browser-mcp\//,
      "Dockerfile Stage 1 must copy browser-mcp/package*.json"
    );
  });

  it("web-ui/lib/subagents/workerPool.ts has zero cross-package relative imports from ../../../mcp-server", () => {
    const workerPoolCode = fs.readFileSync(
      path.resolve(process.cwd(), "web-ui/lib/subagents/workerPool.ts"),
      "utf8"
    );
    assert.doesNotMatch(
      workerPoolCode,
      /\.\.\/\.\.\/\.\.\/mcp-server/,
      "workerPool.ts must not use cross-package relative imports to mcp-server (Anti-Shit Protocol Rule 5)"
    );
  });

  it("BuilderWorker executes surgical patchFile when model returns patch payload for existing file", async () => {
    const { BuilderWorker } = await import("../lib/subagents/workerPool.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-patch-test-"));

    try {
      const targetRel = "src/math.ts";
      const fullTarget = path.join(tmpDir, targetRel);
      fs.mkdirSync(path.dirname(fullTarget), { recursive: true });
      fs.writeFileSync(
        fullTarget,
        "export function add(a: number, b: number): number {\n  return a - b;\n}\n",
        "utf8"
      );

      let patchFileCalled = false;
      const mockGenerate = async () => ({
        text: JSON.stringify({
          patches: [
            {
              search: "return a - b;",
              replace: "return a + b;"
            }
          ]
        })
      });

      const builder = new BuilderWorker({
        workspaceRoot: tmpDir,
        generate: mockGenerate as any
      });

      // Spy on patchFile method
      const originalPatch = builder.patchFile.bind(builder);
      builder.patchFile = async (rel, patches, root) => {
        patchFileCalled = true;
        return originalPatch(rel, patches, root);
      };

      const milestone = {
        id: "M1",
        title: "Fix addition operator in math.ts",
        description: "Replace subtraction with addition",
        status: "pending" as const,
        builderIterations: 0,
        criticRounds: 0,
        plannedFiles: [targetRel],
        acceptanceCriteria: [
          {
            id: "AC-1",
            assertion: "add returns a + b",
            fileMatch: targetRel
          }
        ]
      };

      const result = await builder.executeMilestoneWork(milestone, 1, [], tmpDir);

      assert.equal(patchFileCalled, true, "BuilderWorker.patchFile must be invoked when model returns patch payload");
      const patchedContent = fs.readFileSync(fullTarget, "utf8");
      assert.match(patchedContent, /return a \+ b;/, "File must contain patched content");
      assert.doesNotMatch(patchedContent, /return a - b;/, "Original flaw must be replaced");
      assert.ok(result.diff.includes("+  return a + b;"), "Unified diff must reflect the applied patch");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Flash 3.8 Backend Shakeout — Fix 2: B-P0-2 Planner Schema & Honest Test Runner", () => {
  it("Planner system prompt includes command in acceptance criteria JSON schema", async () => {
    const plannerCode = fs.readFileSync(
      path.resolve(process.cwd(), "web-ui/lib/subagents/planner.ts"),
      "utf8"
    );
    assert.match(
      plannerCode,
      /"command"\s*:/,
      "Planner JSON schema must include 'command' field in acceptanceCriteria"
    );
  });

  it("normalizeMilestone populates command from testFile when command is omitted", async () => {
    const { normalizeMilestone } = await import("../lib/subagents/planner.js");
    assert.equal(typeof normalizeMilestone, "function", "normalizeMilestone must be exported");

    const rawMilestone = {
      id: "M1",
      title: "Write math functions",
      testFile: "tests/math.test.ts",
      acceptanceCriteria: [
        {
          id: "AC-1",
          assertion: "add returns a + b"
        }
      ]
    };

    const normalized = normalizeMilestone(rawMilestone);
    assert.ok(normalized.acceptanceCriteria[0].command, "command should be populated from testFile");
    assert.match(normalized.acceptanceCriteria[0].command!, /tests\/math\.test\.ts/);
  });

  it("Supervisor testRunner does NOT report exitCode: 0 with passed > 0 when 0 tests ran", async () => {
    const { runMilestoneTestRunner } = await import("../lib/subagents/supervisor.js");
    assert.equal(typeof runMilestoneTestRunner, "function", "runMilestoneTestRunner helper must be exported");

    const milestoneWithZeroCommands = {
      id: "M1",
      title: "Manual review only",
      description: "No automated tests",
      status: "pending" as const,
      builderIterations: 0,
      criticRounds: 0,
      acceptanceCriteria: [
        {
          id: "AC-1",
          assertion: "Code visually verified"
        }
      ]
    };

    const res = await runMilestoneTestRunner(milestoneWithZeroCommands, process.cwd());
    assert.equal(res.testsRun, 0, "testsRun must be 0");
    assert.notEqual(res.exitCode, 0, "exitCode must NOT be 0 when 0 tests ran (dishonest success banned)");
  });

  it("Supervisor testRunner automatically executes testFile when acceptance criteria omit command", async () => {
    const { runMilestoneTestRunner } = await import("../lib/subagents/supervisor.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-"));
    const testRel = "tests/pass.test.ts";
    const fullTest = path.join(tmpDir, testRel);
    fs.mkdirSync(path.dirname(fullTest), { recursive: true });
    fs.writeFileSync(
      fullTest,
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('passing test', () => assert.equal(1, 1));\n",
      "utf8"
    );

    try {
      const milestone = {
        id: "M1",
        title: "Test milestone",
        description: "Run testFile",
        status: "pending" as const,
        builderIterations: 0,
        criticRounds: 0,
        testFile: testRel,
        acceptanceCriteria: [
          {
            id: "AC-1",
            assertion: "Passes node test"
          }
        ]
      };

      const res = await runMilestoneTestRunner(milestone, tmpDir);
      assert.equal(res.testsRun, 1, "Should have executed the testFile");
      assert.equal(res.exitCode, 0, "Passing test should exit 0");
      assert.equal(res.passed, 1, "1 test passed");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Flash 3.8 Backend Shakeout — Fix 3: B-P0-3 stripCodeFence & AST Retry Prompt", () => {
  it("stripCodeFence cleanly strips fences with trailing spaces", async () => {
    const { stripCodeFence } = await import("../lib/subagents/llmClient.js");
    const input = "```typescript   \nconst x = 1;\n```";
    assert.equal(stripCodeFence(input), "const x = 1;");
  });

  it("stripCodeFence strips conversational preamble and closing remarks around code fences", async () => {
    const { stripCodeFence } = await import("../lib/subagents/llmClient.js");
    const input = "Here is the fix:\n```typescript\nconst y = 2;\n```\nHope this helps!";
    assert.equal(stripCodeFence(input), "const y = 2;");
  });

  it("stripCodeFence handles CRLF cleanly", async () => {
    const { stripCodeFence } = await import("../lib/subagents/llmClient.js");
    const input = "```\r\nconst z = 3;\r\n```";
    assert.equal(stripCodeFence(input), "const z = 3;");
  });

  it("BuilderWorker AST retry prompt instructs model to enclose code in markdown fence", async () => {
    const workerPoolCode = fs.readFileSync(
      path.resolve(process.cwd(), "web-ui/lib/subagents/workerPool.ts"),
      "utf8"
    );
    const correctionPromptMatch = workerPoolCode.match(/correctionPrompt\s*=\s*`([\s\S]*?)`/);
    assert.ok(correctionPromptMatch, "correctionPrompt must be defined");
    assert.match(
      correctionPromptMatch[1],
      /enclosed in a markdown code fence/,
      "AST retry correctionPrompt must explicitly instruct the model to use a markdown code fence"
    );
  });
});


