import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

function findRepoRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../..")
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "web-ui"))) {
      return dir;
    }
  }
  return process.cwd();
}

describe("Flash 3.8 Backend Shakeout — Fix 1: B-P0-1 Dockerfile & BuilderWorker Surgical Patch", () => {
  it("web-ui/Dockerfile copies workspace package.json files in Stage 1", () => {
    const dockerfileContent = fs.readFileSync(
      path.resolve(findRepoRoot(), "web-ui/Dockerfile"),
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
      path.resolve(findRepoRoot(), "web-ui/lib/subagents/workerPool.ts"),
      "utf8"
    );
    assert.doesNotMatch(
      workerPoolCode,
      /\.\.\/\.\.\/\.\.\/mcp-server/,
      "workerPool.ts must not use cross-package relative imports to mcp-server (Zero-trust package isolation requirement)"
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
      path.resolve(findRepoRoot(), "web-ui/lib/subagents/planner.ts"),
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
      path.resolve(findRepoRoot(), "web-ui/lib/subagents/workerPool.ts"),
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

describe("Flash 3.8 Backend Shakeout — Fix 4: B-P1-1 Task Cancellation & AbortController", () => {
  it("cancelTask aborts the registered AbortController for a taskId", async () => {
    const { cancelTask, OvernightSupervisor } = await import("../lib/subagents/supervisor.js");
    assert.equal(typeof cancelTask, "function", "cancelTask must be exported");

    const supervisor = new OvernightSupervisor();
    const taskId = "task-cancel-test-1";
    const controller = new AbortController();
    supervisor.setAbortController(taskId, controller);

    assert.equal(controller.signal.aborted, false, "Signal should not be aborted initially");
    const cancelled = cancelTask(taskId);
    assert.equal(cancelled, true, "cancelTask should return true for registered task");
    assert.equal(controller.signal.aborted, true, "Signal must be aborted after cancelTask");
    assert.equal(supervisor.getAbortController(taskId), undefined, "Controller must be removed after cancellation");
  });

  it("executeTaskWithRecovery halts between milestone steps when signal is aborted", async () => {
    const { OvernightSupervisor } = await import("../lib/subagents/supervisor.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-abort-"));
    const supervisor = new OvernightSupervisor({ checkpointDirectory: tmpDir });
    const controller = new AbortController();

    let stepsExecuted = 0;
    const mockStepExecutor = async (m: any) => {
      stepsExecuted++;
      // Abort after first milestone
      controller.abort();
      return { status: "completed", targetFile: "file.ts", diff: "diff" };
    };

    const task: any = {
      taskId: "task-abort-loop-test",
      status: "active",
      currentMilestoneIndex: 0,
      journal: [],
      checkpoints: [],
      milestones: [
        { id: "M1", title: "M1", status: "pending", builderIterations: 0, criticRounds: 0, acceptanceCriteria: [] },
        { id: "M2", title: "M2", status: "pending", builderIterations: 0, criticRounds: 0, acceptanceCriteria: [] }
      ]
    };

    try {
      const res = await supervisor.executeTaskWithRecovery(task, {
        stepExecutor: mockStepExecutor as any,
        signal: controller.signal
      });

      assert.equal(stepsExecuted, 1, "Only first milestone should execute before abort halts loop");
      assert.equal(res.status, "cancelled", "Task status must be marked cancelled");
      assert.equal(res.milestones[1].status, "pending", "Second milestone must remain pending");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("createProductionStepExecutor passes abortSignal to workerPool.executeJob", async () => {
    const { createProductionStepExecutor } = await import("../lib/subagents/supervisor.js");
    let signalReceived: AbortSignal | undefined;

    const mockWorkerPool: any = {
      getModelForRole: () => "swift-15-27b-mtp",
      keepAliveFor: () => "24h",
      executeJob: async (job: any) => {
        signalReceived = job.abortSignal;
        return { diff: "diff", gitSha: "a".repeat(40), targetFile: "test.ts" };
      }
    };

    const controller = new AbortController();
    const executor = createProductionStepExecutor({
      workerPool: mockWorkerPool,
      signal: controller.signal
    });

    const milestone: any = {
      id: "M1",
      title: "M1",
      status: "pending",
      builderIterations: 0,
      criticRounds: 0,
      acceptanceCriteria: []
    };

    await executor(milestone, 1);
    assert.equal(signalReceived, controller.signal, "createProductionStepExecutor must pass abortSignal to workerPool.executeJob");
  });
});

describe("Flash 3.8 Backend Shakeout — Fix 5: B-P1-2 SelfDeployPipeline Branch Merge to develop", () => {
  it("executeDeploy rejects main or master branch deployment", async () => {
    const { SelfDeployPipeline } = await import("../lib/deploy/selfDeploy.js");
    const pipeline = new SelfDeployPipeline({
      enabled: true,
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      healthChecker: async () => ({ status: 200, ok: true })
    });

    await assert.rejects(
      async () => {
        await pipeline.executeDeploy({
          branchName: "main",
          previousSha: "sha1",
          newSha: "sha2"
        });
      },
      /strictly blocked by safety rails/i
    );
  });

  it("executeDeploy runs git checkout develop and git merge --no-ff when branchName is feat/task-*", async () => {
    const { SelfDeployPipeline } = await import("../lib/deploy/selfDeploy.js");
    const executedCommands: { file: string; args: string[] }[] = [];

    const pipeline = new SelfDeployPipeline({
      enabled: true,
      commandRunner: async (file: string, args: string[]) => {
        executedCommands.push({ file, args });
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
      healthChecker: async () => ({ status: 200, ok: true })
    });

    const result = await pipeline.executeDeploy({
      branchName: "feat/task-abc123456789",
      previousSha: "sha1",
      newSha: "sha2",
      deploymentName: "web-ui",
      namespace: "local-agentic-sandbox"
    });

    assert.equal(result.status, "deployed");

    const checkoutCmd = executedCommands.find(
      (c) => c.file === "git" && c.args[0] === "checkout" && c.args[1] === "develop"
    );
    assert.ok(checkoutCmd, "executeDeploy must run git checkout develop");

    const mergeCmd = executedCommands.find(
      (c) => c.file === "git" && c.args[0] === "merge" && c.args.includes("feat/task-abc123456789")
    );
    assert.ok(mergeCmd, "executeDeploy must run git merge --no-ff <branchName>");
    assert.ok(mergeCmd.args.includes("--no-ff"), "git merge must use --no-ff flag");

    const mergeIndex = executedCommands.indexOf(mergeCmd);
    const buildIndex = executedCommands.findIndex((c) => c.file === "docker" && c.args[0] === "build");
    assert.ok(buildIndex > mergeIndex, "git merge must happen before docker build");
  });

  it("executeDeploy throws and aborts rollout if git merge fails", async () => {
    const { SelfDeployPipeline } = await import("../lib/deploy/selfDeploy.js");
    const executedCommands: { file: string; args: string[] }[] = [];

    const pipeline = new SelfDeployPipeline({
      enabled: true,
      commandRunner: async (file: string, args: string[]) => {
        executedCommands.push({ file, args });
        if (file === "git" && args[0] === "merge") {
          return { exitCode: 1, stdout: "", stderr: "CONFLICT: Merge conflict in package.json" };
        }
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
      healthChecker: async () => ({ status: 200, ok: true })
    });

    await assert.rejects(
      async () => {
        await pipeline.executeDeploy({
          branchName: "feat/task-conflict-123",
          previousSha: "sha1",
          newSha: "sha2"
        });
      },
      /Git merge .* failed/i
    );

    const buildCmd = executedCommands.find((c) => c.file === "docker" && c.args[0] === "build");
    assert.equal(buildCmd, undefined, "Docker build must not execute when git merge fails");
  });
});

describe("Flash 3.8 Backend Shakeout — Fix 6: B-P1-3 & B-P2-1 Isolated Branch Default, autoDeployOnGreen, & Workspace File Alias", () => {
  it("POST /api/tasks sets isolated branch name default and preserves autoDeployOnGreen", async () => {
    const { POST } = await import("../app/api/tasks/route.js");
    const req = new Request("http://localhost:3000/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: "Test feature for isolated branch",
        scope: "SNIPPET",
        autoDeployOnGreen: true,
        autoExecute: false
      })
    });

    const res = await POST(req);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.taskId, "Must return taskId");
    assert.notEqual(body.manifest.branchName, "feat/v2.5-overnight", "Must not hardcode feat/v2.5-overnight");
    assert.match(body.manifest.branchName, /^feat\/task-/, "branchName must default to feat/task-*");
    assert.equal(body.manifest.autoDeployOnGreen, true, "autoDeployOnGreen must be preserved on manifest");
  });

  it("GET /api/workspace/file route exists and returns 403 on path traversal", async () => {
    const { NextRequest } = await import("next/server");
    const { GET } = await import("../app/api/workspace/file/route.js");
    assert.equal(typeof GET, "function", "GET handler must be exported");

    const reqTraversal = new NextRequest("http://localhost:3000/api/workspace/file?path=../package.json");
    const resTraversal = await GET(reqTraversal);
    assert.equal(resTraversal.status, 403, "Must return 403 on path traversal");

    const reqMissing = new NextRequest("http://localhost:3000/api/workspace/file");
    const resMissing = await GET(reqMissing);
    assert.equal(resMissing.status, 400, "Must return 400 when path is missing");

    const reqValid = new NextRequest("http://localhost:3000/api/workspace/file?path=package.json");
    const resValid = await GET(reqValid);
    assert.equal(resValid.status, 200, "Must return 200 for valid file");
  });
});

describe("Flash 3.8 Backend Shakeout — Fix 7: Writable Fallback in getSkillsBasePath", () => {
  const originalEnv = { ...process.env };
  const fallbackDir = path.join(os.tmpdir(), "local-agentic-sandbox-skills");

  it("getSkillsBasePath falls back to os.tmpdir()/local-agentic-sandbox-skills when primary directory is unwritable", async () => {
    const {
      getSkillsBasePath,
      recordObservedPattern,
      loadPendingQueue,
      approveSkillCandidate,
      listActiveSkills
    } = await import("../lib/subagents/skillGate.js");

    try {
      if (fs.existsSync(fallbackDir)) {
        fs.rmSync(fallbackDir, { recursive: true, force: true });
      }
      // Point SKILLS_DIR to an unwritable / non-creatable path
      const unwritablePath = process.platform === "win32"
        ? "Z:\\nonexistent_unwritable_dir_skills\\nested"
        : "/workspace/.agent/skills";
      process.env.SKILLS_DIR = unwritablePath;

      // Call getSkillsBasePath without customPath
      const resolvedPath = getSkillsBasePath();
      assert.equal(resolvedPath, fallbackDir, "Must fall back to os.tmpdir()/local-agentic-sandbox-skills when preferred path is unwritable");
      assert.ok(fs.existsSync(resolvedPath), "Fallback directory must exist and be created");

      // Verify propose -> load -> approve -> list succeeds without throwing EACCES
      const recordRes = recordObservedPattern("test-fallback-pattern", {
        title: "Test Fallback Skill",
        solutionSummary: "Ensure fallback works cleanly"
      }, { minOccurrences: 1 });
      assert.ok(recordRes.candidate);

      const queue = loadPendingQueue();
      assert.ok(queue.candidates["test-fallback-pattern"]);

      const approveRes = approveSkillCandidate("test-fallback-pattern");
      assert.equal(approveRes.promoted, true);
      assert.ok(approveRes.skillPath && fs.existsSync(approveRes.skillPath));

      const active = listActiveSkills();
      assert.ok(active.some((f: string) => f.includes("test-fallback-pattern")));
    } finally {
      process.env = { ...originalEnv };
      try {
        if (fs.existsSync(fallbackDir)) {
          fs.rmSync(fallbackDir, { recursive: true, force: true });
        }
      } catch {}
    }
  });
});





