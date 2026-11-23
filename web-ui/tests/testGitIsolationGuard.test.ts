import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProductionStepExecutor } from "../lib/subagents/supervisor";
import { WorkerGitOps } from "../lib/git/workerGitOps";
import type { Milestone } from "../lib/subagents/types";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_UI_ROOT = path.resolve(THIS_DIR, "..");
const REPO_ROOT = path.resolve(WEB_UI_ROOT, "..");

function resolveTsxCli(): string {
  const candidates = [
    path.join(WEB_UI_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate tsx CLI in: ${candidates.join(", ")}`);
}

function getRepoHead(repoDir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
  }).trim();
}

describe("Test Git Isolation Guard", () => {
  it("running the supervisor milestone test subset leaves working repo HEAD unchanged and creates no root hello.txt", () => {
    const headBefore = getRepoHead(REPO_ROOT);
    const rootHelloPath = path.join(REPO_ROOT, "hello.txt");
    assert.equal(
      fs.existsSync(rootHelloPath),
      false,
      "Precondition: hello.txt must not exist at repo root before running supervisor tests"
    );

    const tsxCli = resolveTsxCli();
    const subsetTests = [
      "tests/activeTaskRehydration.test.ts",
      "tests/supervisorGitOpsIntegration.test.ts",
      "tests/stepExecutor.test.ts",
      "tests/canonicalLifecycle.test.ts",
      "tests/tasksApi.test.ts",
    ];

    execFileSync(process.execPath, [tsxCli, "--test", ...subsetTests], {
      cwd: WEB_UI_ROOT,
      stdio: "pipe",
      encoding: "utf8",
      timeout: 120000,
    });

    const headAfter = getRepoHead(REPO_ROOT);
    assert.equal(
      headAfter,
      headBefore,
      `Supervisor milestone test subset mutated working repo HEAD (${headBefore} -> ${headAfter})`
    );
    assert.equal(
      fs.existsSync(rootHelloPath),
      false,
      "Supervisor milestone test subset leaked hello.txt into repo root"
    );
  });

  it("createProductionStepExecutor rejects missing repoRoot/WORKSPACE_DIR in test context instead of committing to cwd", async () => {
    const headBefore = getRepoHead(REPO_ROOT);
    const prevWorkspaceDir = process.env.WORKSPACE_DIR;
    delete process.env.WORKSPACE_DIR;

    try {
      const mockPool = {
        getModelForRole: () => "test-model",
        keepAliveFor: () => "24h",
        executeJob: async (job: { role: string }) => {
          if (job.role === "builder") {
            return {
              diff: "+hello",
              gitSha: headBefore,
              iterations: 1,
              synthetic: false,
              targetFile: "should-not-commit.txt",
            };
          }
          return { approved: true, feedback: [] };
        },
      } as unknown as NonNullable<Parameters<typeof createProductionStepExecutor>[0]>["workerPool"];

      const executor = createProductionStepExecutor({
        workerPool: mockPool,
        testRunner: async () => ({ exitCode: 0, passed: 1, failed: 0, output: "ok" }),
      });

      const milestone: Milestone = {
        id: "M-ISOLATION",
        title: "Must not commit to cwd",
        description: "Guard check",
        status: "pending",
        builderIterations: 0,
        criticRounds: 0,
        acceptanceCriteria: [],
      };

      await assert.rejects(async () => {
        await executor(milestone, 1);
      }, /Refusing to run git stage\/commit in test context without an explicit isolated repoRoot or WORKSPACE_DIR/i);

      assert.equal(getRepoHead(REPO_ROOT), headBefore, "Working repo HEAD must remain unchanged");
    } finally {
      if (prevWorkspaceDir !== undefined) {
        process.env.WORKSPACE_DIR = prevWorkspaceDir;
      }
    }
  });

  it("WorkerGitOps.stageAndCommit rejects missing repoDir in test context instead of mutating cwd", async () => {
    const headBefore = getRepoHead(REPO_ROOT);
    const gitOps = new WorkerGitOps({ runId: "isolation-guard-test" });

    await assert.rejects(async () => {
      await gitOps.stageAndCommit(["README.md"], "chore: should be blocked");
    }, /refusing to mutate git repository in test context without an explicit repoDir/i);

    assert.equal(getRepoHead(REPO_ROOT), headBefore, "Working repo HEAD must remain unchanged");
  });
});
