import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import type { Milestone, TaskScope } from "./types";
import type { GenerateFn } from "./llmClient";
import {
  WorkerPool,
  createBuilderWorker,
  createCriticWorker,
  getResolvedGitSha,
} from "./workerPool";
import { recordObservedPattern } from "./skillGate";
import { sumRoundPromptTokens } from "../tokenEconomics";
import { DEFAULT_PRIMARY_MODEL } from "../../config/models";
import { executeInSandboxTier } from "../sandbox/tierRunner";
import { formatTestFailureForBuilder } from "../ci/workerCiFeedback";

export interface StepExecutorResult {
  status: "completed" | "failed";
  gitSha?: string;
  diff?: string;
  builderIterations?: number;
  criticRounds?: number;
  builderModel?: string;
  targetFile?: string;
  modifiedFiles?: string[];
  deliverableContent?: string;
  thinking?: string;
  reason?: string;
  rounds?: number;
  promptTokens?: number;
  outputTokens?: number;
  roundPromptTokens?: number[];
}

export type StepExecutor = (
  milestone: Milestone,
  attempt: number,
  context?: { repoRoot?: string }
) => Promise<StepExecutorResult>;

export interface ProductionStepExecutorOptions {
  workerPool?: WorkerPool;
  repoRoot?: string;
  model?: string;
  scope?: string;
  signal?: AbortSignal;
  onThinkingChunk?: (chunk: string, totalThinking: string) => void;
  testRunner?: (
    milestone: Milestone,
    targetFile: string,
    repoRoot: string
  ) => Promise<{
    exitCode: number | null;
    passed: number;
    failed: number;
    testsRun?: number;
    output: string;
  }>;
}

export interface MilestoneTestRunResult {
  passed: number;
  failed: number;
  testsRun: number;
  exitCode: number | null;
  output: string;
}

/**
 * Honest milestone acceptance criteria test runner.
 * If no command is defined on criteria, runs milestone.testFile.
 * If zero commands can be run, returns exitCode: null, testsRun: 0 (banning dishonest exitCode: 0 passes).
 */
export async function runMilestoneTestRunner(
  m: Milestone,
  workspaceDir?: string
): Promise<MilestoneTestRunResult> {
  const root = workspaceDir || process.cwd();
  let passed = 0;
  let failed = 0;
  let combinedOutput = "";
  let finalExitCode: number | null = 0;

  const criteriaWithCmd = (m.acceptanceCriteria || []).filter((c) =>
    Boolean(c.command && c.command.trim())
  );

  if (criteriaWithCmd.length === 0) {
    if (m.testFile) {
      const testCmd = `npx tsx --test ${m.testFile}`;
      try {
        const res = await executeInSandboxTier({
          tier: "build",
          command: testCmd,
          workspaceDir: root,
          toolchain: m.toolchain,
        });
        combinedOutput += `[${m.testFile}] $ ${testCmd}\n${res.stdout}\n${res.stderr}\n`;
        if (res.exitCode === 0) {
          passed++;
          finalExitCode = 0;
        } else {
          failed++;
          finalExitCode = res.exitCode || 1;
        }
      } catch (err: unknown) {
        failed++;
        finalExitCode = 1;
        combinedOutput += `[${m.testFile}] Error: ${err instanceof Error ? err.message : String(err)}\n`;
      }
      return {
        passed,
        failed,
        testsRun: passed + failed,
        exitCode: finalExitCode,
        output: combinedOutput.trim(),
      };
    }

    // No automated tests configured: honest null exitCode and 0 testsRun
    return {
      passed: 0,
      failed: 0,
      testsRun: 0,
      exitCode: null,
      output: "No automated test commands configured for this milestone.",
    };
  }

  for (const criterion of criteriaWithCmd) {
    if (!criterion.command) continue;
    try {
      const res = await executeInSandboxTier({
        tier: "build",
        command: criterion.command,
        workspaceDir: root,
        toolchain: m.toolchain,
      });
      combinedOutput += `[${criterion.id}] $ ${criterion.command}\n${res.stdout}\n${res.stderr}\n`;
      if (res.exitCode === (criterion.expectedExitCode ?? 0)) {
        passed++;
      } else {
        failed++;
        finalExitCode = res.exitCode || 1;
      }
    } catch (err: unknown) {
      failed++;
      finalExitCode = 1;
      combinedOutput += `[${criterion.id}] Error: ${err instanceof Error ? err.message : String(err)}\n`;
    }
  }

  return {
    passed,
    failed,
    testsRun: passed + failed,
    exitCode: finalExitCode,
    output: combinedOutput.trim(),
  };
}

/**
 * ARCHITECTURAL NOTE — Dual Execution Paths (Item 4 review, Oct 6 2026):
 * 1. createOvernightGraph(): The LangGraph StateGraph pipeline compiled with memory/file
 *    checkpointers, state transitions, and node reducers. Tested and verified in
 *    tests/langgraphSupervisorNodes.test.ts to preserve LangGraph engine conformance.
 * 2. createProductionStepExecutor(): The standalone step executor function used in production
 *    by POST /api/threads (and overnight scheduled runs) via executeTaskWithRecovery.
 * Both paths are intentionally preserved: unifying them in-place introduces regression risk
 * to either the LangGraph test contract or the live Next.js API thread dispatch loop.
 *
 * Constructs a production-grade stepExecutor that runs each milestone
 * through WorkerPool against swift-15-27b-mtp:
 * (builder generates -> critic reviews -> git commit).
 */
export function createProductionStepExecutor(
  options?: ProductionStepExecutorOptions
): StepExecutor {
  const modelToUse =
    options?.model || process.env.BUILDER_MODEL || process.env.MODEL_NAME || DEFAULT_PRIMARY_MODEL;
  const workerPool =
    options?.workerPool ||
    new WorkerPool({
      scope: options?.scope,
      modelRoster: {
        builder: modelToUse,
        critic: modelToUse,
        planner: modelToUse,
        explorer: modelToUse,
        recorder: modelToUse,
      },
    });
  const explicitRepoRoot = options?.repoRoot || process.env.WORKSPACE_DIR;
  const repoRoot =
    explicitRepoRoot ||
    (fs.existsSync("/workspace") && fs.existsSync(path.join("/workspace", ".git"))
      ? "/workspace"
      : fs.existsSync(path.join(process.cwd(), "deploy"))
        ? process.cwd()
        : path.resolve(process.cwd(), ".."));

  const effectiveScope = options?.scope || workerPool.scope;

  const stepExec: StepExecutor = async (
    milestone: Milestone,
    attempt: number,
    execCtx?: { repoRoot?: string }
  ): Promise<StepExecutorResult> => {
    const explicitActiveRepo = execCtx?.repoRoot || explicitRepoRoot;
    const activeRepoRoot = explicitActiveRepo || repoRoot;
    console.log(`[executor] step start milestone=${milestone.id} attempt=${attempt}`);
    try {
      const builderModel = workerPool.getModelForRole("builder") || modelToUse;
      const criticModel = workerPool.getModelForRole("critic") || modelToUse;

      const stepRoundPromptTokens: number[] = [];
      let stepOutputTokens = 0;
      let stepRounds = 0;
      const baseGenerate = workerPool.generate;
      const trackedGenerate: GenerateFn | undefined = baseGenerate
        ? async (req) => {
            const genRes = await baseGenerate(req);
            const pTokens =
              typeof genRes?.promptTokens === "number" &&
              Number.isFinite(genRes.promptTokens) &&
              genRes.promptTokens > 0
                ? genRes.promptTokens
                : typeof genRes?.prompt_eval_count === "number" &&
                    Number.isFinite(genRes.prompt_eval_count) &&
                    genRes.prompt_eval_count > 0
                  ? genRes.prompt_eval_count
                  : 0;
            const oTokens =
              typeof genRes?.outputTokens === "number" &&
              Number.isFinite(genRes.outputTokens) &&
              genRes.outputTokens > 0
                ? genRes.outputTokens
                : typeof genRes?.eval_count === "number" &&
                    Number.isFinite(genRes.eval_count) &&
                    genRes.eval_count > 0
                  ? genRes.eval_count
                  : 0;
            if (pTokens > 0 || oTokens > 0) {
              stepRounds += 1;
              if (pTokens > 0) stepRoundPromptTokens.push(pTokens);
              stepOutputTokens += oTokens;
            }
            return genRes;
          }
        : undefined;
      const buildUsageFields = () =>
        stepRounds > 0
          ? {
              rounds: stepRounds,
              promptTokens: sumRoundPromptTokens(stepRoundPromptTokens),
              outputTokens: stepOutputTokens,
              roundPromptTokens: [...stepRoundPromptTokens],
            }
          : {};

      const builder = createBuilderWorker({
        model: builderModel,
        generate: trackedGenerate,
        keepAlive: workerPool.keepAliveFor ? workerPool.keepAliveFor(builderModel) : "24h",
        scope: effectiveScope,
      });

      const critic = createCriticWorker({
        model: criticModel,
        generate: trackedGenerate,
        keepAlive: workerPool.keepAliveFor ? workerPool.keepAliveFor(criticModel) : "24h",
        scope: effectiveScope,
      });

      let currentDiff = "";
      let criticFeedback: string[] = [];
      let builderIterations = 0;
      let criticRounds = 0;
      let lastGitSha = "";
      let lastTargetFile = "";

      const maxIterations = 5;

      for (let iter = 1; iter <= maxIterations; iter++) {
        builderIterations = iter;

        // 1. Builder worker generates code
        console.log(`[executor] calling builder.executeMilestoneWork`);
        const builderStartTime = Date.now();
        const heartbeatInterval = setInterval(() => {
          const elapsedSec = Math.round((Date.now() - builderStartTime) / 1000);
          console.log(
            `[executor] still waiting on builder for milestone ${milestone.id}, ${elapsedSec}s elapsed`
          );
        }, 60000);

        let builderRes;
        try {
          builderRes = await workerPool.executeJob({
            role: "builder",
            taskId: milestone.id,
            abortSignal: options?.signal,
            taskFn: async (signal) => {
              return await builder.executeMilestoneWork(milestone, {
                repoRoot: activeRepoRoot,
                previousDiff: currentDiff,
                criticFeedback,
                iteration: iter,
                signal,
                onThinkingChunk: options?.onThinkingChunk,
              });
            },
          });
        } finally {
          clearInterval(heartbeatInterval);
        }
        console.log(`[executor] builder returned, diff length=${builderRes.diff?.length}`);

        currentDiff = builderRes.diff;
        lastGitSha = builderRes.gitSha;
        lastTargetFile = builderRes.targetFile;

        if (builderRes.stuck) {
          return {
            status: "failed",
            gitSha: builderRes.gitSha,
            diff: builderRes.diff,
            builderIterations,
            criticRounds,
            builderModel: builderRes.model || builderModel,
          };
        }

        let testExitCode: number | null =
          milestone.testsFailed && milestone.testsFailed > 0 ? 1 : null;
        let testOutput = "";

        // Task 1 (Sprint A2): Default testRunner executes milestone.acceptanceCriteria commands in sandbox tier
        const effectiveTestRunner =
          options?.testRunner ||
          (async (m: Milestone, _targetFile?: string, rRoot?: string) => {
            return await runMilestoneTestRunner(m, rRoot || activeRepoRoot);
          });

        try {
          console.log(`[executor] running testRunner for milestone ${milestone.id}`);
          const testRes = await effectiveTestRunner(milestone, lastTargetFile, activeRepoRoot);
          milestone.testsPassed = testRes.passed;
          milestone.testsFailed = testRes.failed;
          milestone.testsRun =
            (testRes as { testsRun?: number }).testsRun ?? testRes.passed + testRes.failed;
          milestone.testExitCode = testRes.exitCode;
          testExitCode = testRes.exitCode;
          testOutput = testRes.output;
          console.log(
            `[executor] testRunner result: exitCode=${testExitCode}, passed=${testRes.passed}, failed=${testRes.failed}, testsRun=${milestone.testsRun}`
          );
        } catch (tErr: unknown) {
          console.error(`[executor] testRunner error for milestone ${milestone.id}:`, tErr);
          testExitCode = 1;
          milestone.testsFailed = (milestone.testsFailed || 0) + 1;
          milestone.testExitCode = 1;
        }

        // Task 2 (Sprint A2): When testExitCode !== 0 and testExitCode !== null, format failure via workerCiFeedback.ts and inject into milestone.lastError & criticFeedback
        if (testExitCode !== null && testExitCode !== 0) {
          const failingCmd =
            (milestone.acceptanceCriteria || []).find((c) => c.command)?.command ||
            (milestone.testFile ? `npx tsx --test ${milestone.testFile}` : "test");
          const formattedFailure = formatTestFailureForBuilder(
            failingCmd,
            testExitCode,
            testOutput
          );
          milestone.lastError = formattedFailure;
          if (!criticFeedback.includes(formattedFailure)) {
            criticFeedback.push(formattedFailure);
          }
        }

        // 2. Critic worker evaluates diff (Skip critic loop if milestone has skipCriticOnValidSyntax enabled and tests passed)
        let isApproved = false;
        if (
          milestone.skipCriticOnValidSyntax &&
          builderRes.targetFile &&
          !builderRes.stuck &&
          testExitCode === 0
        ) {
          console.log(
            `[executor] SINGLE_ARTIFACT valid deliverable produced (${builderRes.targetFile}) — skipping critic loop.`
          );
          isApproved = true;
        } else {
          criticRounds++;
          console.log(`[executor] calling critic.evaluate`);
          const criticRes = await workerPool.executeJob({
            role: "critic",
            taskId: milestone.id,
            abortSignal: options?.signal,
            taskFn: async (signal) => {
              return await critic.evaluateMilestoneDiff(
                milestone,
                {
                  diff: builderRes.diff,
                  filesChanged: builderRes.targetFile ? [builderRes.targetFile] : undefined,
                  testExitCode: testExitCode ?? undefined,
                  testOutput,
                  noChangeReason: milestone.diffSummary,
                },
                { signal }
              );
            },
          });
          console.log(
            `[executor] critic verdict=${criticRes.verdict || (criticRes.approved ? "approved" : "needs_fix")}`
          );
          isApproved = criticRes.approved;
          if (!isApproved) {
            criticFeedback = criticRes.feedback || [];
          }
        }

        if (isApproved) {
          if (builderIterations >= 2) {
            try {
              recordObservedPattern(`milestone-${milestone.id}-multifix`, {
                title: `Fix pattern for ${milestone.title}`,
                solutionSummary: `Resolved after ${builderIterations} iterations: ${lastTargetFile}`,
              });
            } catch (pErr: unknown) {
              console.warn(
                `[executor] Failed to record observed pattern:`,
                pErr instanceof Error ? pErr.message : pErr
              );
            }
          }
          // Enforce commit scoping: stage ONLY builder's explicit target file.
          // If targetFile is missing/empty, do NOT commit - return status "failed". Never git add ".".
          if (!lastTargetFile || !lastTargetFile.trim()) {
            return {
              status: "failed",
              gitSha: lastGitSha,
              diff: currentDiff,
              builderIterations,
              criticRounds,
              builderModel: builderRes.model || builderModel,
              reason:
                "Commit scoping violation: Builder did not provide an explicit target file; refusing to stage working tree.",
            };
          }

          // 3. Stage and commit changes to git using safe argv arrays (immune to shell injection)
          const isTestEnv = Boolean(
            process.env.NODE_TEST_CONTEXT ||
            process.env.FAST_GRAPH_TEST === "1" ||
            process.env.FORCE_MOCK === "1"
          );
          if (isTestEnv && !explicitActiveRepo) {
            throw new Error(
              "Refusing to run git stage/commit in test context without an explicit isolated repoRoot or WORKSPACE_DIR."
            );
          }
          if (fs.existsSync(path.join(activeRepoRoot, ".git"))) {
            try {
              const gitEnv = {
                ...process.env,
                GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(activeRepoRoot)),
              };
              execFileSync("git", ["add", lastTargetFile], {
                cwd: activeRepoRoot,
                env: gitEnv,
                stdio: ["pipe", "pipe", "ignore"],
              });
              const commitMsg = `feat: complete milestone ${milestone.id} - ${milestone.title.slice(0, 50)}`;
              execFileSync("git", ["commit", "-m", commitMsg], {
                cwd: activeRepoRoot,
                env: gitEnv,
                stdio: ["pipe", "pipe", "ignore"],
              });
            } catch (err: unknown) {
              console.error(
                `[supervisor] Git stage/commit failed for milestone ${milestone.id} (file: ${lastTargetFile}):`,
                err instanceof Error ? err.message : err
              );
            }
          }

          let finalSha = lastGitSha;
          try {
            finalSha = getResolvedGitSha(activeRepoRoot);
          } catch (err: unknown) {
            console.error(
              `[supervisor] Failed to resolve git SHA for milestone ${milestone.id}:`,
              err instanceof Error ? err.message : err
            );
            finalSha = lastGitSha || "uncommitted";
          }

          return {
            status: "completed",
            gitSha: finalSha,
            diff: currentDiff,
            builderIterations,
            criticRounds,
            builderModel: builderRes.model || builderModel,
            targetFile: lastTargetFile,
            deliverableContent: builderRes.rawContent,
            thinking: builderRes.thinking,
            ...buildUsageFields(),
          };
        }
      }

      return {
        status: "failed",
        gitSha: lastGitSha,
        diff: currentDiff,
        builderIterations,
        criticRounds,
        builderModel: builderModel,
        reason:
          !lastTargetFile || !lastTargetFile.trim()
            ? "Commit scoping violation: Builder did not provide an explicit target file."
            : "Critic did not approve milestone diff after maximum iterations.",
      };
    } catch (err: unknown) {
      console.error(
        `[executor] FATAL for milestone ${milestone.id}:`,
        err instanceof Error ? err.stack || err.message : err
      );
      throw err;
    }
  };
  (stepExec as typeof stepExec & { scope?: TaskScope }).scope = effectiveScope as
    TaskScope | undefined;
  return stepExec;
}
