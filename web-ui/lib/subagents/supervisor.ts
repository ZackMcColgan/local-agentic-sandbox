import fs from "fs";
import path from "path";
import { atomicWriteFileSync } from "../fsAtomic";
import { FileCheckpointSaver } from "./checkpointSaver";
export { FileCheckpointSaver };
import { buildVerificationAdapters } from "./verification";
export { buildVerificationAdapters };
export { runSycophancyProbe } from "./probes";
export {
  OvernightStateAnnotation,
  createOvernightGraph,
  type CreateGraphOptions,
} from "./overnightGraph";
import {
  runMilestoneTestRunner,
  createProductionStepExecutor,
  type StepExecutorResult,
  type StepExecutor,
  type ProductionStepExecutorOptions,
  type MilestoneTestRunResult,
} from "./stepExecutor";
export {
  runMilestoneTestRunner,
  createProductionStepExecutor,
  type StepExecutorResult,
  type StepExecutor,
  type ProductionStepExecutorOptions,
  type MilestoneTestRunResult,
};
import { TaskManifest, Milestone, CheckpointState, TaskStatus } from "./types";
import { getResolvedGitSha } from "./workerPool";
import { TelemetryTracer } from "../telemetry";
import {
  generateOvernightMorningReport,
  persistOvernightMorningReport,
  MORNING_REPORT_CHECKPOINT_DIR,
  getCanonicalCheckpointDir,
} from "./morningReport";
export {
  generateOvernightMorningReport,
  persistOvernightMorningReport,
  MORNING_REPORT_CHECKPOINT_DIR,
  getCanonicalCheckpointDir,
};
import { getSharedRunLedger, RunLedgerStatus } from "../ledger/runLedger";
import { FlywheelSkillsStore, extractSkillsFromCompletedTask } from "../flywheel/skillsStore";
import {
  verifyJobCompletion,
  writeMilestoneHandoff,
  readMilestoneHandoff,
} from "./finishVerificationGate";
import {
  resolveSupervisorChunkResume,
  resolveThreadChunkBudget,
  handleLiveTurnChunkBudget,
  type ChunkBudgetConfig,
} from "../jobChunking";
import { getHostSettings } from "../hostSettings";
import { touchActiveTurn, ThreadStore } from "../threads/threadStore";
import { buildJobTokenRollup, sumRoundPromptTokens } from "../tokenEconomics";
import { STALL_WINDOW_MS } from "../threads/inAppSupervisor";
import { DEFAULT_PRIMARY_MODEL } from "../../config/models";
import {
  verifyCompletionClaims,
  stampCompletion,
  type CompletionClaims,
  type VerificationAdapters,
} from "../finishVerification";
import { evaluatePrePrGate } from "../prePrPipeline";
import { WorkerGitOps, ensureIsolatedWorktree } from "../git/workerGitOps";
import { SelfDeployPipeline } from "../deploy/selfDeploy";
import { notify } from "../notifications";

/**
 * Resolves genuine Git commit SHA via getResolvedGitSha.
 * Per the Provenance rule, never synthesizes fake SHAs.
 */
export function getRealGitSha(repoRoot?: string): string {
  return getResolvedGitSha(repoRoot);
}

export interface SupervisorOptions {
  checkpointDirectory?: string;
  stallTimeoutMs?: number;
  tracer?: TelemetryTracer;
}

export interface StepExecutorOptions {
  stepExecutor?: StepExecutor;
  gitOps?: WorkerGitOps;
  gateRunner?: () => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  chunkBudget?: ChunkBudgetConfig | null;
  repoRoot?: string;
  signal?: AbortSignal;
}

interface GlobalSupervisorState {
  pausedTasks: Set<string>;
  abortControllers: Map<string, AbortController>;
}

const supervisorGlobal = globalThis as { __supervisorGlobalState?: GlobalSupervisorState };
const globalSupervisorState: GlobalSupervisorState =
  supervisorGlobal.__supervisorGlobalState ||
  (supervisorGlobal.__supervisorGlobalState = {
    pausedTasks: new Set<string>(),
    abortControllers: new Map<string, AbortController>(),
  });

/**
 * Aborts an active task execution and evicts its AbortController from memory.
 */
export function cancelTask(taskId: string): boolean {
  const controller = globalSupervisorState.abortControllers.get(taskId);
  if (controller) {
    controller.abort();
    globalSupervisorState.abortControllers.delete(taskId);
    return true;
  }
  return false;
}

/**
 * Overnight Supervisor / Watchdog
 * Reconciles desired task state against actual state, persists LangGraph checkpoints,
 * handles automatic crash recovery, and performs stall detection.
 */
export class OvernightSupervisor {
  private customCheckpointDirectory?: string;
  get checkpointDirectory(): string {
    return (
      this.customCheckpointDirectory ||
      process.env.AGENT_CHECKPOINT_DIR ||
      process.env.CHECKPOINT_DIR ||
      getCanonicalCheckpointDir()
    );
  }
  readonly stallTimeoutMs: number;
  readonly checkpointer: FileCheckpointSaver;
  readonly tracer?: TelemetryTracer;

  isPaused(taskId?: string): boolean {
    return !!taskId && globalSupervisorState.pausedTasks.has(taskId);
  }

  resumeTask(taskId: string): void {
    if (taskId) {
      globalSupervisorState.pausedTasks.delete(taskId);
    }
  }

  getAbortController(taskId: string): AbortController | undefined {
    return globalSupervisorState.abortControllers.get(taskId);
  }

  setAbortController(taskId: string, controller: AbortController): void {
    globalSupervisorState.abortControllers.set(taskId, controller);
  }

  deleteAbortController(taskId: string): void {
    globalSupervisorState.abortControllers.delete(taskId);
  }

  constructor(options?: SupervisorOptions) {
    this.customCheckpointDirectory = options?.checkpointDirectory;
    // Default stall detection threshold: unified STALL_WINDOW_MS (10 minutes)
    this.stallTimeoutMs = options?.stallTimeoutMs ?? STALL_WINDOW_MS;
    this.checkpointer = new FileCheckpointSaver(this.checkpointDirectory);
    this.tracer = options?.tracer;
  }

  /**
   * Executes a task milestone lifecycle with distributed telemetry tracing.
   * Spans propagate with strict parent-child linkage:
   * supervisor -> planner -> worker (builder) -> critic
   */
  async executeMilestoneWithTelemetry(
    task: TaskManifest,
    milestoneIndex: number,
    executor: (
      milestone: Milestone
    ) => Promise<{ diff: string; gitSha: string; approved: boolean; feedback: string[] }>
  ): Promise<{
    milestone: Milestone;
    traceId: string;
    supervisorSpanId: string;
    plannerSpanId: string;
    workerSpanId: string;
    criticSpanId: string;
  }> {
    const tracer = this.tracer || new TelemetryTracer(`task_${task.taskId}`);
    const traceId = tracer.getTraceId();

    // 1. Root Supervisor Span
    const supSpan = tracer.startSpan("supervisor.task", undefined, {
      taskId: task.taskId,
      milestoneIndex,
    });
    const supervisorSpanId = supSpan.spanId;

    // 2. Planner Span (Child of Supervisor)
    const plannerSpan = tracer.startSpan("supervisor.planner", supervisorSpanId, {
      taskId: task.taskId,
      milestoneId: task.milestones[milestoneIndex]?.id,
    });
    const plannerSpanId = plannerSpan.spanId;
    plannerSpan.end("ok");

    // 3. Worker / Builder Span (Child of Planner)
    const workerSpan = tracer.startSpan("supervisor.worker", plannerSpanId, {
      taskId: task.taskId,
      milestoneId: task.milestones[milestoneIndex]?.id,
    });
    const workerSpanId = workerSpan.spanId;

    const milestone = task.milestones[milestoneIndex];
    const execRes = await executor(milestone);
    workerSpan.end("ok", { gitSha: execRes.gitSha, diffLength: execRes.diff.length });

    // 4. Critic Span (Child of Worker)
    const criticSpan = tracer.startSpan("supervisor.critic", workerSpanId, {
      taskId: task.taskId,
      milestoneId: milestone?.id,
    });
    const criticSpanId = criticSpan.spanId;
    criticSpan.end(execRes.approved ? "ok" : "error", {
      approved: execRes.approved,
      feedback: execRes.feedback.join("; "),
    });

    supSpan.end("ok");

    return {
      milestone,
      traceId,
      supervisorSpanId,
      plannerSpanId,
      workerSpanId,
      criticSpanId,
    };
  }

  getCheckpointFilePath(taskId: string): string {
    return path.join(this.checkpointDirectory, `${taskId}-checkpoint.json`);
  }

  saveCheckpoint(task: TaskManifest, gitSha?: string): CheckpointState {
    if (!fs.existsSync(this.checkpointDirectory)) {
      fs.mkdirSync(this.checkpointDirectory, { recursive: true });
    }

    const currentMilestone = task.milestones[task.currentMilestoneIndex];
    const completed = task.milestones.filter((m) => m.status === "completed").map((m) => m.id);

    const checkpoint: CheckpointState = {
      checkpointId: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      taskId: task.taskId,
      milestoneId: currentMilestone ? currentMilestone.id : "END",
      milestoneIndex: task.currentMilestoneIndex,
      gitHeadSha: gitSha || "HEAD",
      completedMilestones: completed,
      timestamp: new Date().toISOString(),
      recoveryAttempted: false,
    };

    if (!task.checkpoints) {
      task.checkpoints = [];
    }
    task.checkpoints.push(checkpoint);
    task.updatedAt = new Date().toISOString();

    console.log(`[supervisor] saving checkpoint for ${task.taskId}`);
    try {
      atomicWriteFileSync(
        this.getCheckpointFilePath(task.taskId),
        JSON.stringify(task, null, 2),
        0o660
      );
      console.log(`[supervisor] checkpoint saved for ${task.taskId}`);
      this.syncTaskToRunLedger(task);
      if (task.status === "completed") {
        try {
          const extracted = extractSkillsFromCompletedTask(task);
          if (extracted && extracted.length > 0) {
            const store = new FlywheelSkillsStore();
            try {
              store.saveSkills(extracted);
              console.log(
                `[supervisor] Saved ${extracted.length} flywheel skills for completed task ${task.taskId}`
              );
            } finally {
              store.close();
            }
          }
        } catch (fErr: unknown) {
          console.warn(
            `[supervisor] Flywheel skill extraction failed for task ${task.taskId}:`,
            fErr instanceof Error ? fErr.message : fErr
          );
        }
      }
      if (
        task.status === "completed" ||
        task.status === "parked" ||
        task.status === "failed" ||
        task.status === "stopped"
      ) {
        this.syncOvernightMorningReport().catch(() => {});
      }
    } catch (err: unknown) {
      console.error(
        `[supervisor] Failed to persist checkpoint ${checkpoint.checkpointId} for task ${task.taskId} (milestone: ${checkpoint.milestoneId}):`,
        err instanceof Error ? err.message : err
      );
      const cpExt = checkpoint as typeof checkpoint & { failed?: boolean; error?: string };
      cpExt.failed = true;
      cpExt.error = err instanceof Error ? err.message : String(err);
      throw err;
    }

    return checkpoint;
  }

  syncTaskToRunLedger(task: TaskManifest): void {
    try {
      const ledger = getSharedRunLedger();
      const statusMap: Record<string, RunLedgerStatus> = {
        queued: "running",
        active: "running",
        in_progress: "running",
        paused: "paused",
        crashed: "crashed",
        stopped: "stopped",
        cancelled: "stopped",
        completed: "completed",
        parked: "parked",
        failed: "failed",
      };
      const mappedStatus: RunLedgerStatus = statusMap[task.status] || "running";
      const gitShas = Array.from(
        new Set([
          ...(task.milestones || []).map((m) => m.commitSha).filter(Boolean),
          ...(task.checkpoints || []).map((c) => c.gitHeadSha).filter((s) => s && s !== "HEAD"),
        ] as string[])
      );
      const model =
        task.milestones?.find((m) => m.builderModel)?.builderModel ||
        process.env.CODER_MODEL ||
        process.env.BUILDER_MODEL ||
        process.env.MODEL_NAME ||
        DEFAULT_PRIMARY_MODEL;

      ledger.recordRunStart({
        runId: task.taskId,
        parentRunId: task.parentRunId,
        threadId: task.threadId || `thread-${task.taskId}`,
        prompt: task.goal || "Autonomous engineering task",
        status: mappedStatus,
        startedAt: task.startedAt || new Date().toISOString(),
        completedAt: task.completedAt,
        lastHeartbeatAt: task.updatedAt || new Date().toISOString(),
        model,
        gitShas,
        milestoneSummary: (task.milestones || []).map((m) => ({
          id: m.id,
          title: m.title,
          status:
            m.status === "completed"
              ? "completed"
              : m.status === "failed" || m.status === "rejected"
                ? "failed"
                : m.status === "in_progress"
                  ? "in_progress"
                  : "pending",
          commitSha: m.commitSha,
        })),
        deploymentRef: task.deploymentUrl || task.deploymentNamespace || "local",
        checkpointPath: this.getCheckpointFilePath(task.taskId),
        resumable:
          mappedStatus === "paused" || mappedStatus === "crashed" || mappedStatus === "stopped",
        errorMessage: task.parkedReason || task.errorSummary,
      });
    } catch (err: unknown) {
      console.warn(
        `[supervisor] Could not sync task ${task.taskId} to RunLedger:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  async syncOvernightMorningReport(): Promise<void> {
    try {
      const allTasks = await this.listAllTasks();
      const report = generateOvernightMorningReport(allTasks);
      persistOvernightMorningReport(report, this.checkpointDirectory);
    } catch (err: unknown) {
      console.warn(
        `[supervisor] Could not sync overnight morning report:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  async resumeTaskFromCheckpoint(taskId: string): Promise<TaskManifest | null> {
    const file = this.getCheckpointFilePath(taskId);
    if (!fs.existsSync(file)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as TaskManifest;
      return data;
    } catch (err: unknown) {
      console.error(
        `[supervisor] Failed to read or parse checkpoint file for task ${taskId} at ${file}:`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }

  /**
   * Scans checkpoint directory for all persisted task manifests
   */
  async listAllTasks(): Promise<TaskManifest[]> {
    if (!fs.existsSync(this.checkpointDirectory)) return [];
    try {
      const files = fs.readdirSync(this.checkpointDirectory);
      const tasks: TaskManifest[] = [];
      for (const file of files) {
        if (file.endsWith("-checkpoint.json")) {
          try {
            const content = fs.readFileSync(path.join(this.checkpointDirectory, file), "utf8");
            const parsed = JSON.parse(content) as TaskManifest;
            if (parsed && parsed.taskId) {
              tasks.push(parsed);
            }
          } catch (err: unknown) {
            console.warn(
              `[supervisor] Skipping corrupt checkpoint file ${file}:`,
              err instanceof Error ? err.message : err
            );
          }
        }
      }
      return tasks.sort(
        (a, b) =>
          new Date(b.updatedAt || b.startedAt).getTime() -
          new Date(a.updatedAt || a.startedAt).getTime()
      );
    } catch (err: unknown) {
      console.error(
        `[supervisor] Failed to list tasks from checkpoint directory ${this.checkpointDirectory}:`,
        err instanceof Error ? err.message : err
      );
      return [];
    }
  }

  async executeSingleMilestone(
    task: TaskManifest,
    milestoneIndex: number,
    options?: {
      gitSha?: string;
      diff?: string;
      testsPassed?: number;
      testsFailed?: number;
      testFile?: string;
    }
  ): Promise<TaskManifest> {
    task.currentMilestoneIndex = milestoneIndex;
    const m = task.milestones[milestoneIndex];
    const realSha = options?.gitSha || getRealGitSha();
    if (m) {
      m.status = (options?.testsFailed ?? 0) > 0 ? "failed" : "completed";
      m.completedAt = new Date().toISOString();
      m.commitSha = realSha;
      if (options?.diff) m.diffSummary = options.diff;
      if (options?.testsPassed !== undefined) m.testsPassed = options.testsPassed;
      if (options?.testsFailed !== undefined) m.testsFailed = options.testsFailed;
      if (options?.testFile !== undefined) m.testFile = options.testFile;
    }

    task.currentMilestoneIndex = milestoneIndex + 1;
    this.saveCheckpoint(task, realSha);
    return task;
  }

  /**
   * Executes task across milestones with self-healing crash recovery.
   * Resumes seamlessly from last valid checkpoint if a worker throws mid-milestone.
   */
  async executeTaskWithRecovery(
    task: TaskManifest,
    options?: StepExecutorOptions
  ): Promise<TaskManifest> {
    console.log(
      `[supervisor] executeTaskWithRecovery start taskId=${task.taskId} milestones=${task.milestones.length}`
    );
    console.log(`[task:${task.taskId}] phase=start milestones=${task.milestones.length}`);
    if (!Array.isArray(task.milestones) || task.milestones.length === 0) {
      const emptyMsg = "Task has no milestones to execute (milestones: []).";
      task.status = "failed";
      task.errorSummary = emptyMsg;
      task.parkedReason = emptyMsg;
      task.completedAt = new Date().toISOString();
      task.journal.push({
        timestamp: new Date().toISOString(),
        role: "supervisor",
        action: "Empty milestones guard",
        message: emptyMsg,
      });
      this.saveCheckpoint(task);
      console.log(`[task:${task.taskId}] phase=terminal status=failed reason=${emptyMsg}`);
      return task;
    }
    const executor = options?.stepExecutor;
    const hasPending = task.milestones
      .slice(task.currentMilestoneIndex)
      .some((m) => m.status !== "completed");
    if (!executor && hasPending) {
      throw new Error("No stepExecutor provided; refusing to fake completion.");
    }

    const explicitRepoRoot =
      options?.repoRoot ||
      (task as TaskManifest & { worktreePath?: string }).worktreePath ||
      process.env.WORKSPACE_DIR;
    const isTestEnv = Boolean(
      process.env.NODE_TEST_CONTEXT ||
      process.env.FAST_GRAPH_TEST === "1" ||
      process.env.FORCE_MOCK === "1"
    );
    let repoRoot = explicitRepoRoot || "";
    if (!repoRoot) {
      const fallbackCandidates = ["/workspace", process.cwd(), path.resolve(process.cwd(), "..")];
      repoRoot = fallbackCandidates[0];
      for (const d of fallbackCandidates) {
        if (fs.existsSync(path.join(d, ".git"))) {
          repoRoot = d;
          break;
        }
      }
    }
    let effectiveRepoRoot = repoRoot;

    let gitOps =
      options?.gitOps ||
      new WorkerGitOps({
        runId: task.taskId,
        repoDir: explicitRepoRoot || !isTestEnv ? effectiveRepoRoot : undefined,
      });

    const shouldRunGitOps =
      options?.gitOps !== undefined ||
      (!isTestEnv &&
        process.env.DISABLE_GITOPS !== "true" &&
        (task.enableGitOps === true ||
          (task.enableGitOps !== false &&
            Boolean(process.env.WORKSPACE_DIR || fs.existsSync("/workspace/.git"))))) ||
      (task.enableGitOps === true &&
        Boolean(explicitRepoRoot || !isTestEnv) &&
        fs.existsSync(path.join(repoRoot, ".git")));

    if (shouldRunGitOps && !task.gitOpsBranchCreated) {
      const branchToUse = task.branchName || `feat/task-${task.taskId.slice(0, 12)}`;
      console.log(`[task:${task.taskId}] phase=gitops branch=${branchToUse}`);
      try {
        if (options?.gitOps === undefined && fs.existsSync(path.join(repoRoot, ".git"))) {
          const wt = ensureIsolatedWorktree({
            baseRepoDir: repoRoot,
            taskId: task.taskId,
            branchName: branchToUse,
          });
          effectiveRepoRoot = wt.worktreePath;
          (task as TaskManifest & { worktreePath?: string }).worktreePath = wt.worktreePath;
          gitOps = new WorkerGitOps({
            runId: task.taskId,
            repoDir: effectiveRepoRoot,
          });
          task.gitOpsBranchCreated = true;
          task.journal.push({
            timestamp: new Date().toISOString(),
            role: "gitops",
            message: `${wt.reused ? "Reused" : "Created"} isolated worktree at \`${wt.worktreePath}\` on branch \`${branchToUse}\``,
          });
          console.log(
            `[supervisor] GitOps isolated worktree ready: ${wt.worktreePath} (${branchToUse})`
          );
        } else {
          await gitOps.createAndSwitchBranch(branchToUse);
          task.gitOpsBranchCreated = true;
          task.journal.push({
            timestamp: new Date().toISOString(),
            role: "gitops",
            message: `Created and switched to isolated task branch \`${branchToUse}\``,
          });
          console.log(`[supervisor] GitOps switched to branch ${branchToUse}`);
        }
      } catch (gErr: unknown) {
        const errMsg = gErr instanceof Error ? gErr.message : String(gErr);
        console.error(`[supervisor] GitOps bootstrap failed:`, errMsg);
        task.status = "failed";
        task.errorSummary = errMsg;
        task.parkedReason = errMsg;
        task.completedAt = new Date().toISOString();
        task.journal.push({
          timestamp: new Date().toISOString(),
          role: "gitops",
          message: errMsg,
        });
        this.saveCheckpoint(task);
        console.log(`[task:${task.taskId}] phase=terminal status=failed reason=${errMsg}`);
        return task;
      }
    }

    const controller = this.getAbortController(task.taskId) || new AbortController();
    this.setAbortController(task.taskId, controller);
    const signal = options?.signal || controller.signal;
    const isPaused = () => Boolean(task.status === "paused" || this.isPaused(task.taskId));
    const isAbortedOrCancelled = () =>
      Boolean(!isPaused() && (signal?.aborted || (task.status as TaskStatus) === "cancelled"));
    const jobChunkingEnabled = getHostSettings().jobChunkingEnabled;
    const chunkBudget = jobChunkingEnabled
      ? (options?.chunkBudget ??
        resolveThreadChunkBudget(task as Parameters<typeof resolveThreadChunkBudget>[0]))
      : undefined;
    const runStartTime = Date.now();
    let roundsUsed = 0;
    const jobRoundPromptTokens: number[] = [];
    let jobPromptTokens = 0;
    let jobOutputTokens = 0;
    let jobRounds = 0;

    try {
      while (task.currentMilestoneIndex < task.milestones.length) {
        if (isPaused()) {
          task.status = "paused";
          console.log(
            `[supervisor] Task ${task.taskId} paused. Halting milestone loop at boundary.`
          );
          break;
        }
        if (isAbortedOrCancelled()) {
          task.status = "cancelled";
          console.log(
            `[supervisor] Task ${task.taskId} aborted/cancelled. Halting milestone loop at boundary.`
          );
          break;
        }
        const mIdx = task.currentMilestoneIndex;
        const milestone = task.milestones[mIdx];
        let attempt = 0;
        const handoffPath = path.join(this.checkpointDirectory, `${task.taskId}.handoff.json`);
        const priorHandoff = readMilestoneHandoff(handoffPath);
        if (priorHandoff) {
          if (priorHandoff.chunkComplete) {
            const taskChunkExt = task as TaskManifest & { chunkResumeCount?: number };
            const currentResumes = taskChunkExt.chunkResumeCount ?? 0;
            const decision = resolveSupervisorChunkResume(currentResumes);
            if (decision.action === "needs-attention") {
              task.status = "parked";
              task.parkedReason =
                "needs-attention: exceeded max auto-resumes for chunk-complete job";
              this.saveCheckpoint(task);
              break;
            }
            taskChunkExt.chunkResumeCount = decision.nextResumeCount;
          }
          task.journal.push({
            timestamp: new Date().toISOString(),
            role: "supervisor",
            message: `Resumed with handoff from ${priorHandoff.nextMilestone || priorHandoff.jobId}`,
          });
        }
        let milestoneCompleted = false;

        while (!milestoneCompleted && attempt < 3) {
          if (isPaused()) {
            task.status = "paused";
            break;
          }
          if (isAbortedOrCancelled()) {
            task.status = "cancelled";
            break;
          }
          attempt++;
          try {
            if (executor) {
              console.log(`[supervisor] executing milestone ${milestone.id} attempt ${attempt}`);
              console.log(
                `[task:${task.taskId}] phase=step milestone=${milestone.id} attempt=${attempt}`
              );
              const taskThreadId = (task as TaskManifest & { threadId?: string }).threadId;
              if (taskThreadId) {
                touchActiveTurn(taskThreadId);
              }
              task.updatedAt = new Date().toISOString();
              const hasExplicitOrIsolatedRepo = Boolean(
                explicitRepoRoot || task.gitOpsBranchCreated
              );
              const res = await executor(
                milestone,
                attempt,
                hasExplicitOrIsolatedRepo || !isTestEnv
                  ? { repoRoot: effectiveRepoRoot }
                  : undefined
              );
              {
                const stepRoundsArr = Array.isArray(res.roundPromptTokens)
                  ? res.roundPromptTokens.filter(
                      (n) => typeof n === "number" && Number.isFinite(n) && n > 0
                    )
                  : [];
                const stepPrompt =
                  typeof res.promptTokens === "number" &&
                  Number.isFinite(res.promptTokens) &&
                  res.promptTokens > 0
                    ? res.promptTokens
                    : sumRoundPromptTokens(stepRoundsArr);
                const stepOutput =
                  typeof res.outputTokens === "number" &&
                  Number.isFinite(res.outputTokens) &&
                  res.outputTokens > 0
                    ? res.outputTokens
                    : 0;
                const stepRoundsCount =
                  typeof res.rounds === "number" && Number.isFinite(res.rounds) && res.rounds > 0
                    ? res.rounds
                    : stepRoundsArr.length > 0
                      ? stepRoundsArr.length
                      : stepPrompt > 0 || stepOutput > 0
                        ? 1
                        : 0;
                if (stepRoundsCount > 0 || stepPrompt > 0 || stepOutput > 0) {
                  if (stepRoundsArr.length > 0) {
                    jobRoundPromptTokens.push(...stepRoundsArr);
                  } else if (stepPrompt > 0) {
                    jobRoundPromptTokens.push(stepPrompt);
                  }
                  jobPromptTokens += stepPrompt;
                  jobOutputTokens += stepOutput;
                  jobRounds += stepRoundsCount;
                  milestone.tokenThroughput = {
                    promptTokens: (milestone.tokenThroughput?.promptTokens || 0) + stepPrompt,
                    completionTokens:
                      (milestone.tokenThroughput?.completionTokens || 0) + stepOutput,
                  };
                }
              }
              if (isPaused()) {
                task.status = "paused";
                console.log(
                  `[supervisor] Task ${task.taskId} paused during/after milestone ${milestone.id}. Halting.`
                );
                break;
              }
              if (isAbortedOrCancelled()) {
                task.status = "cancelled";
                console.log(
                  `[supervisor] Task ${task.taskId} aborted during milestone ${milestone.id}. Halting.`
                );
                break;
              }
              console.log(
                `[supervisor] milestone ${milestone.id} attempt ${attempt} returned: ${JSON.stringify(res).slice(0, 200)}`
              );
              if (res.status === "completed") {
                milestone.status = "completed";
                if (res.gitSha) milestone.commitSha = res.gitSha;
                if (res.diff) milestone.diffSummary = res.diff;
                if (res.modifiedFiles) milestone.modifiedFiles = res.modifiedFiles;
                if (res.builderIterations !== undefined)
                  milestone.builderIterations = res.builderIterations;
                if (res.criticRounds !== undefined) milestone.criticRounds = res.criticRounds;
                if (res.builderModel) milestone.builderModel = res.builderModel;
                milestone.completedAt = new Date().toISOString();
                milestoneCompleted = true;

                if (shouldRunGitOps && gitOps && res.targetFile) {
                  try {
                    const commitMsg = `feat: complete milestone ${milestone.id} - ${milestone.title.slice(0, 50)}`;
                    const commitRes = await gitOps.stageAndCommit([res.targetFile], commitMsg);
                    if (commitRes.commitSha) {
                      milestone.commitSha = commitRes.commitSha;
                    }
                  } catch (cErr: unknown) {
                    console.warn(
                      `[supervisor] GitOps milestone commit warning:`,
                      cErr instanceof Error ? cErr.message : cErr
                    );
                  }
                }

                if (res.thinking) {
                  milestone.builderThinking = res.thinking;
                  task.builderThinking = res.thinking;
                  task.journal.push({
                    timestamp: new Date().toISOString(),
                    role: "builder",
                    message: `Builder reasoning: ${res.thinking}`,
                  });
                }

                task.journal.push({
                  timestamp: new Date().toISOString(),
                  role: "builder",
                  message: `Generated deliverable ${res.targetFile || milestone.title} (${res.deliverableContent?.length || 0} bytes).`,
                });
              }
            } else {
              throw new Error("No stepExecutor provided; refusing to fake completion.");
            }
          } catch (err: unknown) {
            const errName = err instanceof Error ? err.name : undefined;
            const errMsg = err instanceof Error ? err.message : String(err);
            const errStack = err instanceof Error ? err.stack : undefined;
            if (isPaused() || isAbortedOrCancelled() || errName === "AbortError") {
              if (isPaused()) {
                task.status = "paused";
                console.log(
                  `[supervisor] Task ${task.taskId} caught pause during milestone ${milestone.id}. Halting.`
                );
              } else {
                task.status = "cancelled";
                console.log(
                  `[supervisor] Task ${task.taskId} caught abort during milestone ${milestone.id}. Halting.`
                );
              }
              break;
            }
            console.error(
              `[supervisor] stepExecutor threw for milestone ${milestone.id}:`,
              errStack || err
            );
            if (errMsg && /no stepExecutor provided/i.test(errMsg)) {
              throw err;
            }
            // Worker crashed mid-milestone: record crash in journal and resume from checkpoint
            task.journal.push({
              timestamp: new Date().toISOString(),
              role: "supervisor",
              message: `Worker crash detected in milestone ${milestone.id} (attempt ${attempt}): ${errMsg}. Resuming from checkpoint...`,
            });

            // Reload state from checkpoint or re-arm milestone
            milestone.status = "pending";
            if (attempt >= 2) {
              // Self-healing retry with fresh checkpoint reload
              const reloaded = await this.resumeTaskFromCheckpoint(task.taskId);
              if (reloaded) {
                const currentJournal = task.journal;
                task = reloaded;
                task.journal = currentJournal;
              }
            }
          }
        }

        if (isPaused()) {
          task.status = "paused";
          console.log(`[supervisor] Task ${task.taskId} paused. Halting milestone loop.`);
          break;
        }

        if (isAbortedOrCancelled()) {
          task.status = "cancelled";
          console.log(
            `[supervisor] Task ${task.taskId} aborted/cancelled. Halting milestone loop.`
          );
          break;
        }

        if (milestoneCompleted) {
          roundsUsed += 1;
          writeMilestoneHandoff(handoffPath, {
            jobId: task.taskId,
            completedMilestones: task.milestones.slice(0, mIdx + 1).map((m) => m.id),
            nextMilestone: task.milestones[mIdx + 1]?.id ?? null,
            summary: milestone.title,
            updatedAt: milestone.completedAt || new Date().toISOString(),
          });
          task.currentMilestoneIndex = mIdx + 1;
          this.saveCheckpoint(task, milestone.commitSha);

          if (chunkBudget && task.currentMilestoneIndex < task.milestones.length) {
            const runlogPath = path.join(this.checkpointDirectory, `${task.taskId}-runlog.md`);
            const nextMilestone = task.milestones[task.currentMilestoneIndex];
            const chunkResult = await handleLiveTurnChunkBudget({
              roundsUsed,
              elapsedMs: Date.now() - runStartTime,
              budget: chunkBudget,
              jobId: task.taskId,
              workspaceRoot: effectiveRepoRoot,
              handoffPath,
              runlogPath,
              currentState: `Completed milestone ${milestone.id} (${milestone.title})`,
              nextStep: nextMilestone
                ? `Execute milestone ${nextMilestone.id}: ${nextMilestone.title}`
                : "Finish verification",
              openQuestions: [],
            });

            if (chunkResult.exceeded) {
              task.status = "paused";
              task.parkedReason = chunkResult.marker;
              task.journal.push({
                timestamp: new Date().toISOString(),
                role: "supervisor",
                action: "chunk-complete",
                message: `Paused at chunk boundary (${chunkResult.reason}) after ${roundsUsed} rounds. Banked handoff at ${handoffPath}.`,
              });
              this.saveCheckpoint(task, milestone.commitSha);
              console.log(
                `[task:${task.taskId}] phase=chunk-complete reason=${chunkResult.reason} rounds=${roundsUsed}`
              );

              const activeThreadId = (task as TaskManifest & { threadId?: string }).threadId;
              if (activeThreadId) {
                const port = process.env.PORT || "3000";
                try {
                  await fetch(`http://127.0.0.1:${port}/api/threads/${activeThreadId}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "resume" }),
                  });
                } catch (resumeErr: unknown) {
                  console.warn(
                    `[supervisor] Chunk auto-resume dispatch failed:`,
                    resumeErr instanceof Error ? resumeErr.message : resumeErr
                  );
                }
              }
              return task;
            }
          }
        } else {
          // Failed after retries: park task and flag ambiguity
          milestone.status = "failed";
          if (task.milestones[mIdx]) {
            task.milestones[mIdx].status = "failed";
          }
          task.status = "parked";
          task.parkedReason = `Milestone ${milestone.id} failed after 3 recovery attempts`;
          task.ambiguityFlags.push({
            id: `amb-${Date.now()}`,
            milestoneId: milestone.id,
            question: `Milestone ${milestone.title} encountered repeated unrecoverable failures.`,
            judgmentCall: "Parked task to preserve git integrity and avoid infinite loop.",
            reasoning: "Autonomy policy: Never spin forever on failing steps without human review.",
            revertAction: { type: "re_plan", target: milestone.id },
            reviewed: false,
          });
          this.saveCheckpoint(task);
          return task;
        }
      }

      if (isPaused()) {
        task.status = "paused";
        this.saveCheckpoint(task);
        return task;
      }

      if (isAbortedOrCancelled()) {
        task.status = "cancelled";
        this.saveCheckpoint(task);
        return task;
      }

      if (task.currentMilestoneIndex >= task.milestones.length) {
        console.log(`[task:${task.taskId}] phase=finish milestones=${task.milestones.length}`);
        const expectedArtifacts = task.milestones.flatMap(
          (m) => m.modifiedFiles || m.plannedFiles || []
        );
        const finishVerification = verifyJobCompletion({
          workspaceRoot: effectiveRepoRoot,
          expectedArtifacts,
          gatePassed: task.milestones.every((m) => m.status === "completed"),
        });
        if (!finishVerification.ok) {
          const finishMsg = `Finish verification gate blocked completion: ${finishVerification.reasons.join("; ")}`;
          task.status = "failed";
          task.errorSummary = finishMsg;
          task.parkedReason = finishMsg;
          task.completedAt = new Date().toISOString();
          task.journal.push({
            timestamp: new Date().toISOString(),
            role: "supervisor",
            action: "Finish verification gate blocked completion",
            message: finishMsg,
          });
          console.log(`[task:${task.taskId}] phase=terminal status=failed reason=${finishMsg}`);
        } else {
          let gateExitCode = 0;
          let gateOut = "";

          if (shouldRunGitOps) {
            console.log(
              `[supervisor] Running test:gate pre-merge verification for task ${task.taskId}`
            );
            task.journal.push({
              timestamp: new Date().toISOString(),
              role: "gitops",
              message: "Running pre-merge test:gate verification (<90s budget)...",
            });

            if (options?.gateRunner) {
              try {
                const gateRes = await options.gateRunner();
                gateExitCode = gateRes.exitCode;
                gateOut = gateRes.stdout || gateRes.stderr;
              } catch (gErr: unknown) {
                gateExitCode = 1;
                gateOut = gErr instanceof Error ? gErr.message : String(gErr);
              }
            } else {
              try {
                const gateRes = await gitOps.runGateTest();
                gateExitCode = gateRes.exitCode;
                gateOut = gateRes.stdout || gateRes.stderr;
              } catch (gateErr: unknown) {
                console.error(`[supervisor] test:gate run failed:`, gateErr);
                gateExitCode = 1;
                gateOut = gateErr instanceof Error ? gateErr.message : String(gateErr);
              }
            }

            task.gatePassed = gateExitCode === 0;
            task.gateOutput = gateOut;
          }

          const optsExt = options as
            | (typeof options & {
                verificationAdapters?: VerificationAdapters;
                completionClaims?: CompletionClaims;
              })
            | undefined;
          const adapters: VerificationAdapters =
            optsExt?.verificationAdapters || buildVerificationAdapters(effectiveRepoRoot);
          const milestoneCommits = task.milestones
            .map((m) => (m as Milestone & { commitSha?: string }).commitSha)
            .filter((sha): sha is string => Boolean(sha));
          const claims: CompletionClaims = optsExt?.completionClaims || {
            commits: milestoneCommits,
            files: expectedArtifacts,
            gatePassed: task.gatePassed,
          };
          const claimVerification = await verifyCompletionClaims(claims, adapters);
          const stamped = stampCompletion(task, claimVerification);
          task.completionStamp = stamped.completionStamp;
          task.verificationGaps = stamped.verificationGaps;

          if (task.gatePassed === false) {
            const gateFailMsg = `Pre-merge gate test:gate failed with exit code ${gateExitCode}.`;
            task.status = "failed";
            task.completionStamp = "completed-unverified";
            if (!task.verificationGaps.some((g) => g.kind === "gate")) {
              task.verificationGaps.push({
                kind: "gate",
                claim: "test:gate",
                checked: "persisted gate result",
                found: gateFailMsg,
              });
            }
            task.errorSummary = task.errorSummary || gateFailMsg;
            task.parkedReason = task.parkedReason || gateFailMsg;
            task.journal.push({
              timestamp: new Date().toISOString(),
              role: "gitops",
              message: gateFailMsg,
            });
            console.log(`[task:${task.taskId}] phase=terminal status=failed reason=${gateFailMsg}`);
          } else {
            task.status = "completed";
            console.log(`[task:${task.taskId}] phase=terminal status=completed`);
            if (claimVerification.status === "completed-unverified") {
              task.journal.push({
                timestamp: new Date().toISOString(),
                role: "supervisor",
                action: "Completion stamped completed-unverified",
                message: `Completion claims unverified: ${claimVerification.gaps.map((g) => `${g.claim} (${g.found})`).join("; ")}`,
              });
            }

            if (shouldRunGitOps && gateExitCode === 0) {
              task.journal.push({
                timestamp: new Date().toISOString(),
                role: "gitops",
                message: "Pre-merge gate test:gate passed. 1-Click Rollout ready.",
              });

              const prePr = evaluatePrePrGate({
                flowChecksPassed: task.milestones.every(
                  (m) => m.status === "completed" && (m.testsFailed ?? 0) === 0
                ),
                reviewerApproved: task.milestones.every((m) => m.criticVerdict !== "FAIL"),
                gatePassed: true,
              });
              if (!prePr.ready) {
                task.pushStatus = `blocked: ${prePr.reasons.join("; ")}`;
                task.journal.push({
                  timestamp: new Date().toISOString(),
                  role: "gitops",
                  message: `Pre-PR gate blocked push: ${prePr.reasons.join("; ")}`,
                });
              } else {
                // BUILD-1 Honesty Rule: wire pushBranch into terminal path
                const pushCheck = await gitOps.isPushConfigured();
                if (!pushCheck.configured) {
                  task.pushStatus = "completed — local only, push not configured";
                  task.journal.push({
                    timestamp: new Date().toISOString(),
                    role: "gitops",
                    message: "completed — local only, push not configured",
                  });
                  console.log(
                    `[supervisor] Push not configured: ${pushCheck.reason || "local bundle"}`
                  );
                } else {
                  try {
                    const pushRes = await gitOps.pushBranch(task.branchName);
                    if (pushRes && pushRes.success) {
                      task.pushStatus = "pushed";
                      task.journal.push({
                        timestamp: new Date().toISOString(),
                        role: "gitops",
                        message:
                          pushRes.eventMarkdown || `Pushed branch \`${task.branchName}\` to origin`,
                      });
                    } else {
                      task.pushStatus = "completed — local only, push failed";
                      task.journal.push({
                        timestamp: new Date().toISOString(),
                        role: "gitops",
                        message: "completed — local only, push failed",
                      });
                    }
                  } catch (pErr: unknown) {
                    const pErrMsg = pErr instanceof Error ? pErr.message : String(pErr);
                    task.pushStatus = `failed: ${pErrMsg}`;
                    task.journal.push({
                      timestamp: new Date().toISOString(),
                      role: "gitops",
                      message: `failed: ${pErrMsg}`,
                    });
                    console.warn(`[supervisor] pushBranch failed:`, pErrMsg);
                  }
                }
              }

              // Check if autoDeployOnGreen is enabled
              if (task.autoDeployOnGreen) {
                task.journal.push({
                  timestamp: new Date().toISOString(),
                  role: "deploy",
                  message:
                    "autoDeployOnGreen is active — triggering SelfDeployPipeline.executeDeploy rollout...",
                });

                try {
                  const pipeline = new SelfDeployPipeline();
                  const lastSha = task.milestones[task.milestones.length - 1]?.commitSha || "HEAD";
                  const deployRec = await pipeline.executeDeploy({
                    branchName: task.branchName,
                    previousSha: "develop",
                    newSha: lastSha,
                    skipPreRollout: true,
                  });
                  task.journal.push({
                    timestamp: new Date().toISOString(),
                    role: "deploy",
                    message: `Self-deploy finished with status: ${deployRec.status}`,
                  });
                } catch (dErr: unknown) {
                  console.error(`[supervisor] autoDeployOnGreen deploy failed:`, dErr);
                  task.journal.push({
                    timestamp: new Date().toISOString(),
                    role: "deploy",
                    message: `autoDeployOnGreen deploy error: ${dErr instanceof Error ? dErr.message : dErr}`,
                  });
                }
              }
            }
          }
        }
        task.completedAt = new Date().toISOString();

        // Defense-in-depth: revert any premature completion stamp if test:gate failed
        if (task.gatePassed === false) {
          if (task.status === "completed") {
            task.status = "failed";
          }
          if (task.completionStamp === "completed" || !task.completionStamp) {
            task.completionStamp = "completed-unverified";
          }
          if (!Array.isArray(task.verificationGaps)) {
            task.verificationGaps = [];
          }
          if (!task.verificationGaps.some((g) => g.kind === "gate")) {
            task.verificationGaps.push({
              kind: "gate",
              claim: "test:gate",
              checked: "persisted gate result",
              found: "gate did not pass",
            });
          }
        }

        if (task.gatePassed === false) {
          notify("task.failed", {
            title: `Task Failed: ${task.taskId}`,
            body: `Pre-merge gate test failed: ${task.goal?.slice(0, 100)}`,
          }).catch(() => {});
        } else {
          notify("task.completed", {
            title: `Task Completed: ${task.taskId}`,
            body: `All ${task.milestones.length} milestones completed: ${task.goal?.slice(0, 100)}`,
          }).catch(() => {});
        }

        if (jobRounds > 0 || jobPromptTokens > 0 || jobOutputTokens > 0) {
          const rollup = buildJobTokenRollup({
            rounds: jobRounds,
            promptTokens: jobPromptTokens,
            outputTokens: jobOutputTokens,
            compactions: 0,
          });
          const taskExt = task as TaskManifest & {
            tokenEconomics?: typeof rollup;
            threadId?: string;
          };
          taskExt.tokenEconomics = rollup;
          const activeThreadId = taskExt.threadId;
          if (activeThreadId) {
            try {
              const store = new ThreadStore();
              const existingThread = await store.getThread(activeThreadId);
              if (existingThread) {
                existingThread.messages = existingThread.messages || [];
                existingThread.messages.push({
                  id: `msg-${task.taskId}-usage`,
                  role: "assistant",
                  content: "",
                  taskId: task.taskId,
                  timestamp: new Date().toISOString(),
                  outputTokens: rollup.outputTokens,
                  roundPromptTokens: [...jobRoundPromptTokens],
                  tokenEconomics: rollup,
                });
                store.saveThread(existingThread);
              }
            } catch (uErr: unknown) {
              console.warn(
                `[supervisor] Could not persist token rollup to thread ${activeThreadId}:`,
                uErr instanceof Error ? uErr.message : uErr
              );
            }
          }
        }

        this.saveCheckpoint(task);
      }
      return task;
    } finally {
      this.deleteAbortController(task.taskId);
    }
  }

  /**
   * Stall detection: checks if no forward progress has been made for stallTimeoutMs.
   * If stalled, triggers one recovery attempt or parks task and flags ambiguity in morning report.
   */
  async checkStallAndReconcile(task: TaskManifest): Promise<TaskManifest> {
    const lastUpdate = new Date(task.updatedAt || task.startedAt).getTime();
    const elapsed = Date.now() - lastUpdate;

    if (elapsed > this.stallTimeoutMs) {
      // Stall detected
      const currentMilestone = task.milestones[task.currentMilestoneIndex] || task.milestones[0];

      // Check if one recovery was already attempted
      const lastCheckpoint = task.checkpoints[task.checkpoints.length - 1];
      if (lastCheckpoint && !lastCheckpoint.recoveryAttempted) {
        // Attempt one recovery: re-plan current milestone
        lastCheckpoint.recoveryAttempted = true;
        task.journal.push({
          timestamp: new Date().toISOString(),
          role: "supervisor",
          message: `Stall detected (${Math.round(elapsed / 1000)}s idle). Triggering recovery attempt for ${currentMilestone.id}...`,
        });
        task.updatedAt = new Date().toISOString();
        this.saveCheckpoint(task);
        return task;
      }

      // Already attempted recovery or exceeded tolerance -> park task
      task.status = "parked";
      task.parkedReason = `Stall detected: no progress for ${Math.round(elapsed / 1000)}s`;
      task.ambiguityFlags.push({
        id: `amb-stall-${Date.now()}`,
        milestoneId: currentMilestone ? currentMilestone.id : "GLOBAL",
        question: `Execution stalled with no forward progress on ${currentMilestone ? currentMilestone.title : "task"}.`,
        judgmentCall: "Parked task and recorded snapshot state for morning inspection.",
        reasoning: "Autonomy policy: never spin forever; snapshot state and await operator review.",
        revertAction: {
          type: "re_plan",
          target: currentMilestone ? currentMilestone.id : "all",
        },
        reviewed: false,
      });

      this.saveCheckpoint(task);
    }

    return task;
  }

  /**
   * Parks the task when user stops the run or halts execution.
   * Sets task status to "stopped", logs journal entry, and persists checkpoint to disk.
   */
  parkTask(task: TaskManifest, reason: string = "User stopped run"): TaskManifest {
    task.status = "stopped";
    task.parkedReason = reason;
    task.updatedAt = new Date().toISOString();
    task.journal.push({
      timestamp: new Date().toISOString(),
      role: "supervisor",
      message: `Task stopped: ${reason}. Workers halted, VRAM released.`,
    });
    this.saveCheckpoint(task);
    return task;
  }

  pauseTask(task: TaskManifest, reason: string = "User paused run"): TaskManifest {
    if (task.taskId) {
      globalSupervisorState.pausedTasks.add(task.taskId);
      const controller = globalSupervisorState.abortControllers.get(task.taskId);
      if (controller) {
        controller.abort();
      }
    }
    task.status = "paused";
    task.parkedReason = reason;
    task.updatedAt = new Date().toISOString();
    task.journal.push({
      timestamp: new Date().toISOString(),
      role: "supervisor",
      message: `Task paused at milestone ${task.currentMilestoneIndex + 1}: ${reason}. Checkpoint saved.`,
    });
    this.saveCheckpoint(task);
    return task;
  }

  restartTask(original: TaskManifest): TaskManifest {
    if (original.taskId) {
      globalSupervisorState.pausedTasks.delete(original.taskId);
    }
    const newTaskId = `task-${Date.now()}`;
    const nowIso = new Date().toISOString();
    const restarted: TaskManifest = {
      ...original,
      taskId: newTaskId,
      parentRunId: original.taskId,
      status: "active",
      currentMilestoneIndex: 0,
      startedAt: nowIso,
      updatedAt: nowIso,
      completedAt: undefined,
      parkedReason: undefined,
      errorSummary: undefined,
      checkpoints: [],
      ambiguityFlags: [],
      milestones: (original.milestones || []).map((m) => ({
        ...m,
        status: "pending",
        commitSha: undefined,
        diffSummary: undefined,
        completedAt: undefined,
        builderIterations: 0,
        criticRounds: 0,
      })),
      journal: [
        {
          timestamp: nowIso,
          role: "supervisor",
          message: `Restarted run from parent task ${original.taskId} with fresh milestone state.`,
        },
      ],
    };
    this.saveCheckpoint(restarted);
    return restarted;
  }
}
