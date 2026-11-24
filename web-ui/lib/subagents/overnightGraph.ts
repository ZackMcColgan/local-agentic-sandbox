import fs from "fs";
import path from "path";
import { StateGraph, START, END, Annotation, MemorySaver } from "@langchain/langgraph";
import type { FileCheckpointSaver } from "./checkpointSaver";
import type {
  Milestone,
  CheckpointState,
  AmbiguityFlag,
  TaskStatus,
  ToolchainType,
  TaskJournalEntry,
  TaskScope,
} from "./types";
import { generatePlanSpec } from "./planner";
import {
  WorkerPool,
  createExplorerWorker,
  createBuilderWorker,
  createCriticWorker,
  createRecorderWorker,
  getResolvedGitSha,
  recordTestBaseline,
  compareAndRevertIfWorse,
} from "./workerPool";
import type { TelemetryTracer } from "../telemetry";
import { runSycophancyProbe } from "./probes";

/**
 * LangGraph State Annotation for Overnight Builder Graph
 */
export const OvernightStateAnnotation = Annotation.Root({
  taskId: Annotation<string>(),
  goal: Annotation<string>(),
  status: Annotation<TaskStatus>({
    reducer: (curr, update) => update || curr,
    default: () => "queued",
  }),
  toolchain: Annotation<ToolchainType>({
    reducer: (curr, update) => update || curr,
    default: () => "node:22",
  }),
  scope: Annotation<TaskScope | undefined>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => undefined,
  }),
  currentMilestoneIndex: Annotation<number>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => 0,
  }),
  milestones: Annotation<Milestone[]>({
    reducer: (curr, update) => update || curr,
    default: () => [],
  }),
  checkpoints: Annotation<CheckpointState[]>({
    reducer: (curr, update) => (update ? [...curr, ...update] : curr),
    default: () => [],
  }),
  ambiguityFlags: Annotation<AmbiguityFlag[]>({
    reducer: (curr, update) => (update ? [...curr, ...update] : curr),
    default: () => [],
  }),
  journal: Annotation<TaskJournalEntry[]>({
    reducer: (curr, update) => (update ? [...curr, ...update] : curr),
    default: () => [],
  }),
  currentDiff: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => "",
  }),
  currentGitSha: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => "",
  }),
  iterationCount: Annotation<number>({
    reducer: (curr, update) => update ?? curr,
    default: () => 1,
  }),
  criticApproved: Annotation<boolean>({
    reducer: (curr, update) => update ?? curr,
    default: () => false,
  }),
  criticFeedback: Annotation<string[]>({
    reducer: (curr, update) => update ?? curr,
    default: () => [],
  }),
  nodeHistory: Annotation<string[]>({
    reducer: (curr, update) => (update ? [...curr, ...update] : curr),
    default: () => [],
  }),
  traceId: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => "",
  }),
  supervisorSpanId: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => "",
  }),
  plannerSpanId: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => "",
  }),
  workerSpanId: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => "",
  }),
  criticSpanId: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => "",
  }),
  traceparent: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => "",
  }),
});

export interface CreateGraphOptions {
  checkpointer?: FileCheckpointSaver | MemorySaver;
  workerPool?: WorkerPool;
  tracer?: TelemetryTracer;
  /** Optional isolated repo root (used by tests to avoid mutating the working repo). */
  repoRoot?: string;
}

/**
 * Builds the fully wired LangGraph StateGraph connecting:
 * Planner -> Explorer -> [Builder <-> Critic (retry cap 5)] -> Recorder -> (next milestone -> Builder | done -> END)
 */
export function createOvernightGraph(options?: CreateGraphOptions) {
  const workerPool = options?.workerPool || new WorkerPool();
  const tracer = options?.tracer;
  const repoRoot =
    options?.repoRoot ||
    (fs.existsSync(path.join(process.cwd(), "deploy"))
      ? process.cwd()
      : path.resolve(process.cwd(), ".."));

  const workflow = new StateGraph(OvernightStateAnnotation)
    // 1. Planner Node: decomposes goal into machine-checkable milestones & SPEC.md
    .addNode("planner", async (state) => {
      let supervisorSpanId = state.supervisorSpanId;
      let plannerSpanId = state.plannerSpanId;
      let currentTraceId = state.traceId;
      let currentTraceparent = state.traceparent;

      if (tracer) {
        if (!supervisorSpanId) {
          const supSpan = tracer.startSpan("supervisor.task", undefined, {
            taskId: state.taskId,
            goal: state.goal,
          });
          supervisorSpanId = supSpan.spanId;
        }
        currentTraceId = tracer.getTraceId();
        const plannerSpan = tracer.startSpan("supervisor.planner", supervisorSpanId, {
          taskId: state.taskId,
          goal: state.goal,
        });
        plannerSpanId = plannerSpan.spanId;
        currentTraceparent = tracer.getTraceparent(plannerSpanId);
      }

      const existingMilestones = state.milestones && state.milestones.length > 0;
      const planSpec = existingMilestones
        ? { milestones: state.milestones }
        : await generatePlanSpec({
            taskId: state.taskId,
            goal: state.goal,
            toolchain: state.toolchain || "node:22",
            scope: state.scope,
          });

      return {
        milestones: planSpec.milestones,
        status: "active" as TaskStatus,
        currentMilestoneIndex: 0,
        iterationCount: 1,
        criticApproved: false,
        criticFeedback: [],
        nodeHistory: ["planner"],
        traceId: currentTraceId,
        supervisorSpanId,
        plannerSpanId,
        traceparent: currentTraceparent,
        journal: [
          {
            timestamp: new Date().toISOString(),
            role: "planner" as const,
            message: `Generated SPEC.md with ${planSpec.milestones.length} milestones.`,
          },
        ],
      };
    })

    // 2. Explorer Node: inspects workspace tree and provides distilled inventory
    .addNode("explorer", async (state) => {
      let explorerSpan: ReturnType<TelemetryTracer["startSpan"]> | undefined;
      if (tracer) {
        explorerSpan = tracer.startSpan(
          "supervisor.explorer",
          state.plannerSpanId || state.supervisorSpanId,
          {
            taskId: state.taskId,
          }
        );
      }

      const explorer = createExplorerWorker();
      const inventory = await workerPool.executeJob({
        role: "explorer",
        taskId: state.taskId,
        taskFn: async () => {
          return await explorer.exploreWorkspace({ path: "workspace" });
        },
      });

      if (explorerSpan) {
        explorerSpan.end("ok", { inventoryLength: inventory.length });
      }

      return {
        nodeHistory: ["explorer"],
        journal: [
          {
            timestamp: new Date().toISOString(),
            role: "explorer" as const,
            message: `Explorer surveyed workspace: ${inventory}`,
          },
        ],
      };
    })

    // 3. Builder Node: executes sandboxed toolchain iteration and generates git diff
    .addNode("builder", async (state) => {
      const mIdx = state.currentMilestoneIndex || 0;
      const currentMilestone = state.milestones[mIdx] || state.milestones[0];
      const isRetry = state.criticApproved === false && state.criticFeedback.length > 0;
      const currentIteration = isRetry ? (state.iterationCount || 1) + 1 : 1;

      let builderSpan: ReturnType<TelemetryTracer["startSpan"]> | undefined;
      let workerSpanId = state.workerSpanId;
      if (tracer) {
        // Parent is plannerSpanId (supervisor -> planner -> worker)
        const parentSpan = state.plannerSpanId || state.supervisorSpanId;
        builderSpan = tracer.startSpan("supervisor.builder", parentSpan, {
          taskId: state.taskId,
          milestoneId: currentMilestone?.id,
          iteration: currentIteration,
        });
        workerSpanId = builderSpan.spanId;
      }

      const builder = createBuilderWorker({ model: workerPool.getModelForRole("builder") });

      // Guardrail 2 (Item 2): Record test baseline before builder attempt
      const baseline = await recordTestBaseline(repoRoot).catch(() => ({
        passCount: 0,
        failCount: 0,
        failingTests: [],
        timestamp: new Date().toISOString(),
      }));

      const builderRes = await workerPool.executeJob({
        role: "builder",
        taskId: state.taskId,
        taskFn: async () => {
          return await builder.executeMilestoneWork(currentMilestone, {
            repoRoot,
            previousDiff: state.currentDiff,
            criticFeedback: state.criticFeedback,
            iteration: currentIteration,
          });
        },
      });

      // Guardrail 2 (Item 2): If fix degraded tests, revert uncommitted changes immediately
      if (!builderRes.stuck && builderRes.targetFile) {
        const revertResult = await compareAndRevertIfWorse(baseline, repoRoot, undefined, [
          builderRes.targetFile,
        ]).catch(() => ({
          reverted: false,
          filesReverted: [],
          before: { passed: 0, failed: 0 },
          after: { passed: 0, failed: 0 },
        }));
        if (revertResult.reverted) {
          builderRes.diff = "";
          currentMilestone.diffSummary =
            "no changes needed because fix attempt degraded test suite and was automatically reverted";
        }
      }

      if (builderSpan) {
        builderSpan.end(builderRes.stuck ? "error" : "ok", {
          gitSha: builderRes.gitSha,
          diffLength: builderRes.diff.length,
          iterations: builderRes.iterations,
          stuck: builderRes.stuck,
        });
      }

      // Guardrail 5: If builder is stuck, park the task
      if (builderRes.stuck) {
        const stuckInfo = builderRes as typeof builderRes & {
          feedback?: string[];
          errorSignature?: string;
        };
        return {
          milestones: state.milestones.map((m, idx) =>
            idx === mIdx ? { ...m, status: "failed" as const } : m
          ),
          currentDiff: "",
          currentGitSha: builderRes.gitSha,
          iterationCount: builderRes.iterations,
          workerSpanId,
          criticApproved: false,
          criticFeedback: stuckInfo.feedback || ["Builder stuck"],
          nodeHistory: ["builder"],
          status: "parked" as TaskStatus,
          parkedReason: `Builder stuck: ${stuckInfo.errorSignature}`,
          journal: [
            {
              timestamp: new Date().toISOString(),
              role: "builder" as const,
              message: "Builder halted: stuck",
            },
          ],
        };
      }

      const updatedMilestones = state.milestones.map((m, idx) => {
        if (idx === mIdx) {
          return {
            ...m,
            status: "in_progress" as const,
            builderIterations: builderRes.iterations,
            commitSha: builderRes.gitSha,
            diffSummary: builderRes.diff,
          };
        }
        return m;
      });

      return {
        milestones: updatedMilestones,
        currentDiff: builderRes.diff,
        currentGitSha: builderRes.gitSha,
        iterationCount: builderRes.iterations,
        workerSpanId,
        criticApproved: false,
        criticFeedback: [],
        nodeHistory: ["builder"],
        journal: [
          {
            timestamp: new Date().toISOString(),
            role: "builder" as const,
            message: `Builder iteration ${builderRes.iterations} for milestone ${currentMilestone ? currentMilestone.id : "m1"}. SHA: ${builderRes.gitSha}`,
          },
        ],
      };
    })

    // 4. Critic Node: independently grades diff against milestone criteria
    .addNode("critic", async (state) => {
      const mIdx = state.currentMilestoneIndex || 0;
      const currentMilestone = state.milestones[mIdx] || state.milestones[0];
      const critic = createCriticWorker({ model: workerPool.getModelForRole("critic") });

      let criticSpan: ReturnType<TelemetryTracer["startSpan"]> | undefined;
      let criticSpanId = state.criticSpanId;
      if (tracer) {
        // Parent is workerSpanId (supervisor -> planner -> worker -> critic)
        const parentSpan = state.workerSpanId || state.plannerSpanId || state.supervisorSpanId;
        criticSpan = tracer.startSpan("supervisor.critic", parentSpan, {
          taskId: state.taskId,
          milestoneId: currentMilestone?.id,
          iteration: state.iterationCount,
        });
        criticSpanId = criticSpan.spanId;
      }

      const criticRes = await workerPool.executeJob({
        role: "critic",
        taskId: state.taskId,
        taskFn: async () => {
          // Guardrail 4: Run sycophancy probe once at startup
          runSycophancyProbe(workerPool.generate, workerPool.getModelForRole("critic")).catch(
            () => {}
          );

          return await critic.evaluateMilestoneDiff(currentMilestone, {
            diff: state.currentDiff,
            testExitCode: currentMilestone.testsFailed && currentMilestone.testsFailed > 0 ? 1 : 0,
            noChangeReason: currentMilestone.diffSummary,
          });
        },
      });

      if (criticSpan) {
        criticSpan.end(criticRes.approved ? "ok" : "error", {
          approved: criticRes.approved,
          feedbackCount: criticRes.feedback.length,
          feedback: criticRes.feedback.join("; "),
        });
      }

      const criticRounds = (currentMilestone.criticRounds || 0) + 1;
      const updatedMilestones = state.milestones.map((m, idx) => {
        if (idx === mIdx) {
          return {
            ...m,
            criticRounds,
            criticNotes: criticRes.feedback,
          };
        }
        return m;
      });

      return {
        milestones: updatedMilestones,
        criticApproved: criticRes.approved,
        criticFeedback: criticRes.feedback,
        criticSpanId,
        nodeHistory: ["critic"],
        journal: [
          {
            timestamp: new Date().toISOString(),
            role: "critic" as const,
            message: `Critic round ${criticRounds} for ${currentMilestone ? currentMilestone.id : "m1"}: ${criticRes.approved ? "APPROVED" : "REJECTED (" + criticRes.feedback.join("; ") + ")"}${criticRes.evidence && criticRes.evidence.length > 0 ? " [Evidence: " + criticRes.evidence.length + " items]" : ""}`,
          },
        ],
      };
    })

    // 5. Recorder Node: Hermes skill promotion gate and milestone graduation
    .addNode("recorder", async (state) => {
      const mIdx = state.currentMilestoneIndex || 0;
      const currentMilestone = state.milestones[mIdx] || state.milestones[0];
      const recorder = createRecorderWorker();

      let recorderSpan: ReturnType<TelemetryTracer["startSpan"]> | undefined;
      if (tracer) {
        const parentSpan = state.criticSpanId || state.workerSpanId || state.supervisorSpanId;
        recorderSpan = tracer.startSpan("supervisor.recorder", parentSpan, {
          taskId: state.taskId,
          milestoneId: currentMilestone?.id,
        });
      }

      const recorderRes = await workerPool.executeJob({
        role: "recorder",
        taskId: state.taskId,
        taskFn: async () => {
          return await recorder.evaluateAndRecordSkill(currentMilestone, {
            lesson: `Standardized solution pattern for ${currentMilestone ? currentMilestone.title : "milestone"}`,
            iterations: state.iterationCount,
          });
        },
      });

      if (recorderSpan) {
        recorderSpan.end("ok", { promoted: recorderRes.promoted });
      }

      const updatedMilestones = state.milestones.map((m, idx) => {
        if (idx === mIdx) {
          return {
            ...m,
            status: state.criticApproved ? ("completed" as const) : ("failed" as const),
            completedAt: new Date().toISOString(),
            commitSha: state.currentGitSha || getResolvedGitSha(repoRoot),
          };
        }
        return m;
      });

      const nextIndex = mIdx + 1;
      const isTaskDone = nextIndex >= state.milestones.length;

      return {
        milestones: updatedMilestones,
        currentMilestoneIndex: nextIndex,
        iterationCount: 1,
        criticApproved: false,
        criticFeedback: [],
        status: isTaskDone ? ("completed" as TaskStatus) : ("active" as TaskStatus),
        nodeHistory: ["recorder"],
        journal: [
          {
            timestamp: new Date().toISOString(),
            role: "recorder" as const,
            message: `Recorder finalized milestone ${currentMilestone ? currentMilestone.id : "m1"}. Skill promoted: ${recorderRes.promoted}`,
          },
        ],
      };
    })
    .addEdge(START, "planner")
    .addEdge("planner", "explorer")
    .addEdge("explorer", "builder")
    .addEdge("builder", "critic")
    // Conditional retry edge from critic: if rejected and iterations < 5 -> retry builder
    .addConditionalEdges(
      "critic",
      (state) => {
        if (!state.criticApproved && (state.iterationCount || 1) < 5) {
          return "retry";
        }
        return "continue";
      },
      {
        retry: "builder",
        continue: "recorder",
      }
    )
    // Conditional milestone progression edge from recorder: if more milestones -> builder
    .addConditionalEdges(
      "recorder",
      (state) => {
        if (state.currentMilestoneIndex < state.milestones.length) {
          return "next_milestone";
        }
        return "done";
      },
      {
        next_milestone: "builder",
        done: END,
      }
    );

  return workflow;
}
