import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createProductionStepExecutor, runMilestoneTestRunner } from "../lib/subagents/supervisor";
import { WorkerPool } from "../lib/subagents/workerPool";
import type { Milestone } from "../lib/subagents/types";

describe("stepExecutor characterization", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function makeTempGitRepo(prefix: string): string {
    const dir = makeTempDir(prefix);
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync('git config user.name "Test Runner"', { cwd: dir, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" });
    fs.writeFileSync(path.join(dir, "README.md"), "# Init\n", "utf8");
    execSync("git add README.md", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "initial commit"', { cwd: dir, stdio: "ignore" });
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runMilestoneTestRunner runs multiple acceptanceCriteria, honors expectedExitCode, and reports failures", async () => {
    const tmpDir = makeTempDir("step-exec-runner-");
    const milestone: Milestone = {
      id: "M-MULTI",
      title: "Multi-criterion runner check",
      description: "Verify acceptance criteria execution",
      status: "pending",
      builderIterations: 0,
      criticRounds: 0,
      acceptanceCriteria: [
        {
          id: "AC-1",
          assertion: "Exits zero by default",
          command: "node -e \"console.log('pass-1')\"",
        },
        {
          id: "AC-2",
          assertion: "Honors expectedExitCode 2",
          command: "node -e \"console.log('expected-2'); process.exit(2)\"",
          expectedExitCode: 2,
        },
        {
          id: "AC-3",
          assertion: "Detects unexpected non-zero exit",
          command: "node -e \"console.error('boom-3'); process.exit(3)\"",
        },
      ],
    };

    const res = await runMilestoneTestRunner(milestone, tmpDir);
    assert.equal(res.passed, 2);
    assert.equal(res.failed, 1);
    assert.equal(res.testsRun, 3);
    assert.equal(res.exitCode, 3);
    assert.ok(res.output.includes("[AC-1]"));
    assert.ok(res.output.includes("[AC-2]"));
    assert.ok(res.output.includes("[AC-3]"));
    assert.ok(res.output.includes("boom-3"));
  });

  it("returns failed immediately when builder reports stuck without invoking testRunner or critic", async () => {
    let testRunnerCalls = 0;
    let criticCalls = 0;

    const mockPool = {
      getModelForRole: () => "swift-15-27b-mtp",
      keepAliveFor: () => "24h",
      executeJob: async (job: { role: string }) => {
        if (job.role === "builder") {
          return {
            diff: "",
            gitSha: "deadbeef",
            iterations: 1,
            synthetic: false,
            targetFile: "stuck.ts",
            stuck: true,
          };
        }
        criticCalls++;
        return { approved: true, feedback: [] };
      },
    } as unknown as NonNullable<Parameters<typeof createProductionStepExecutor>[0]>["workerPool"];

    const executor = createProductionStepExecutor({
      workerPool: mockPool,
      testRunner: async () => {
        testRunnerCalls++;
        return { exitCode: 0, passed: 1, failed: 0, output: "ok" };
      },
    });

    const milestone: Milestone = {
      id: "M-STUCK",
      title: "Stuck milestone",
      description: "Builder gets stuck",
      status: "pending",
      builderIterations: 0,
      criticRounds: 0,
      acceptanceCriteria: [],
    };

    const result = await executor(milestone, 1);
    assert.equal(result.status, "failed");
    assert.equal(result.builderIterations, 1);
    assert.equal(result.criticRounds, 0);
    assert.equal(result.gitSha, "deadbeef");
    assert.equal(testRunnerCalls, 0);
    assert.equal(criticCalls, 0);
  });

  it("skips critic when skipCriticOnValidSyntax is true and tests pass, committing only targetFile", async () => {
    const repoDir = makeTempGitRepo("step-exec-skip-critic-");
    fs.writeFileSync(path.join(repoDir, "unrelated.txt"), "do not commit\n", "utf8");
    const targetFile = "artifact.ts";
    let criticCalls = 0;

    const mockPool = {
      getModelForRole: () => "swift-15-27b-mtp",
      keepAliveFor: () => "24h",
      executeJob: async (job: { role: string }) => {
        if (job.role === "builder") {
          fs.writeFileSync(path.join(repoDir, targetFile), "export const artifact = 1;\n", "utf8");
          return {
            diff: "+export const artifact = 1;",
            gitSha: "initial",
            iterations: 1,
            synthetic: false,
            targetFile,
            rawContent: "export const artifact = 1;\n",
          };
        }
        criticCalls++;
        return { approved: false, feedback: ["should not be called"] };
      },
    } as unknown as NonNullable<Parameters<typeof createProductionStepExecutor>[0]>["workerPool"];

    const executor = createProductionStepExecutor({
      workerPool: mockPool,
      repoRoot: repoDir,
      testRunner: async () => ({ exitCode: 0, passed: 1, failed: 0, output: "ok" }),
    });

    const milestone: Milestone = {
      id: "M-SKIP-CRITIC",
      title: "Single artifact milestone",
      description: "Skip critic when syntax & tests pass",
      status: "pending",
      skipCriticOnValidSyntax: true,
      builderIterations: 0,
      criticRounds: 0,
      acceptanceCriteria: [],
    };

    const result = await executor(milestone, 1);
    assert.equal(result.status, "completed");
    assert.equal(result.criticRounds, 0);
    assert.equal(criticCalls, 0);
    assert.equal(result.targetFile, targetFile);
    assert.ok(result.gitSha && /^[0-9a-f]{40}$/i.test(result.gitSha));

    const committedFiles = execSync("git show --name-only --format= HEAD", {
      cwd: repoDir,
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    assert.deepEqual(committedFiles, [targetFile]);

    const statusOut = execSync("git status --porcelain", { cwd: repoDir, encoding: "utf8" });
    assert.ok(statusOut.includes("?? unrelated.txt"));
  });

  it("tracks token usage from workerPool.generate across promptTokens and prompt_eval_count shapes", async () => {
    const repoDir = makeTempGitRepo("step-exec-tokens-");
    let callCount = 0;

    const pool = new WorkerPool({
      modelRoster: {
        builder: "test-model",
        critic: "test-model",
        planner: "test-model",
        explorer: "test-model",
        recorder: "test-model",
      },
      generate: async (req) => {
        callCount++;
        if (callCount === 1) {
          return {
            text: "```typescript\nexport const feature = 42;\n```\n",
            model: req.model,
            promptTokens: 120,
            outputTokens: 30,
          };
        }
        return {
          text: JSON.stringify({
            approved: true,
            feedback: [],
            analysis: "Looks good",
          }),
          model: req.model,
          prompt_eval_count: 80,
          eval_count: 20,
        };
      },
    });

    const executor = createProductionStepExecutor({
      workerPool: pool,
      repoRoot: repoDir,
      testRunner: async () => ({ exitCode: 0, passed: 1, failed: 0, output: "ok" }),
    });

    const milestone: Milestone = {
      id: "M-TOKENS",
      title: "Token tracking milestone",
      description: "Create feature.ts",
      status: "pending",
      plannedFiles: ["feature.ts"],
      builderIterations: 0,
      criticRounds: 0,
      acceptanceCriteria: [{ id: "AC-1", assertion: "feature.ts exists" }],
    };

    const result = await executor(milestone, 1);
    assert.equal(result.status, "completed");
    assert.equal(callCount, 2);
    assert.equal(result.rounds, 2);
    assert.equal(result.promptTokens, 200);
    assert.equal(result.outputTokens, 50);
    assert.deepEqual(result.roundPromptTokens, [120, 80]);
  });

  it("fails after 5 iterations when critic rejects every attempt", async () => {
    let builderCalls = 0;
    let criticCalls = 0;

    const mockPool = {
      getModelForRole: () => "swift-15-27b-mtp",
      keepAliveFor: () => "24h",
      executeJob: async (job: { role: string }) => {
        if (job.role === "builder") {
          builderCalls++;
          return {
            diff: `+const iter = ${builderCalls};`,
            gitSha: "abc123",
            iterations: builderCalls,
            synthetic: false,
            targetFile: "work.ts",
          };
        }
        criticCalls++;
        return {
          approved: false,
          feedback: [`Attempt ${criticCalls} needs improvement`],
          verdict: "needs_fix",
        };
      },
    } as unknown as NonNullable<Parameters<typeof createProductionStepExecutor>[0]>["workerPool"];

    const executor = createProductionStepExecutor({
      workerPool: mockPool,
      testRunner: async () => ({ exitCode: 0, passed: 1, failed: 0, output: "ok" }),
    });

    const milestone: Milestone = {
      id: "M-MAX-ITERS",
      title: "Always rejected",
      description: "Never passes critic",
      status: "pending",
      builderIterations: 0,
      criticRounds: 0,
      acceptanceCriteria: [],
    };

    const result = await executor(milestone, 1);
    assert.equal(result.status, "failed");
    assert.equal(builderCalls, 5);
    assert.equal(criticCalls, 5);
    assert.equal(result.builderIterations, 5);
    assert.equal(result.criticRounds, 5);
    assert.match(
      result.reason || "",
      /Critic did not approve milestone diff after maximum iterations/
    );
  });

  it("attaches resolved scope metadata to the returned step executor function", () => {
    const explicitPool = new WorkerPool({ scope: "PROJECT" });
    const execInherited = createProductionStepExecutor({ workerPool: explicitPool });
    assert.equal((execInherited as typeof execInherited & { scope?: string }).scope, "PROJECT");

    const execExplicit = createProductionStepExecutor({
      workerPool: explicitPool,
      scope: "SCRIPT",
    });
    assert.equal((execExplicit as typeof execExplicit & { scope?: string }).scope, "SCRIPT");
  });
});
