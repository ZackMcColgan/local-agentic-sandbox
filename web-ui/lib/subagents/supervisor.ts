import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { StateGraph, START, END, Annotation, MemorySaver } from "@langchain/langgraph";
import {
  TaskManifest,
  Milestone,
  CheckpointState,
  AmbiguityFlag,
  TaskStatus,
  ToolchainType,
  TaskJournalEntry
} from "./types";
import { generatePlanSpec } from "./planner";
import {
  WorkerPool,
  createExplorerWorker,
  createBuilderWorker,
  createCriticWorker,
  createRecorderWorker,
  getResolvedGitSha
} from "./workerPool";
import { TelemetryTracer, formatTraceparent } from "../telemetry";

/**
 * Resolves genuine Git commit SHA via getResolvedGitSha.
 * Per the Provenance rule, never synthesizes fake SHAs.
 */
export function getRealGitSha(repoRoot?: string): string {
  return getResolvedGitSha(repoRoot);
}



function packValue(obj: any): any {
  if (obj instanceof Uint8Array || Buffer.isBuffer(obj)) {
    return { __u8: Buffer.from(obj).toString("base64") };
  }
  if (Array.isArray(obj)) {
    return obj.map(packValue);
  }
  if (obj && typeof obj === "object") {
    const res: Record<string, any> = {};
    for (const k of Object.keys(obj)) {
      res[k] = packValue(obj[k]);
    }
    return res;
  }
  return obj;
}

function unpackValue(obj: any): any {
  if (obj && typeof obj === "object") {
    if (obj.__u8) {
      return new Uint8Array(Buffer.from(obj.__u8, "base64"));
    }
    if (Array.isArray(obj)) {
      return obj.map(unpackValue);
    }
    const res = Object.create(null);
    for (const k of Object.keys(obj)) {
      res[k] = unpackValue(obj[k]);
    }
    return res;
  }
  return obj;
}

/**
 * File-backed durable LangGraph Checkpointer
 * Extends MemorySaver with automatic thread serialization to `${threadId}-lg-checkpoint.json`
 */
export class FileCheckpointSaver extends MemorySaver {
  readonly checkpointDir: string;

  constructor(checkpointDir: string) {
    super();
    this.checkpointDir = checkpointDir;
    if (!fs.existsSync(this.checkpointDir)) {
      fs.mkdirSync(this.checkpointDir, { recursive: true });
    }
    this.loadFromDisk();
  }

  getFilePath(threadId: string): string {
    return path.join(this.checkpointDir, `${threadId}-lg-checkpoint.json`);
  }

  private loadFromDisk() {
    if (!fs.existsSync(this.checkpointDir)) return;
    try {
      const files = fs.readdirSync(this.checkpointDir);
      for (const file of files) {
        if (file.endsWith("-lg-checkpoint.json")) {
          const threadId = file.replace("-lg-checkpoint.json", "");
          const fullPath = path.join(this.checkpointDir, file);
          const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
          if (raw && raw.storage) {
            this.storage[threadId] = unpackValue(raw.storage);
          }
          if (raw && raw.writes) {
            for (const wk of Object.keys(raw.writes)) {
              this.writes[wk] = unpackValue(raw.writes[wk]);
            }
          }
        }
      }
    } catch {}
  }

  private persistThreadToDisk(threadId: string) {
    if (!this.storage[threadId]) return;
    const writesForThread: Record<string, any> = {};
    for (const wk of Object.keys(this.writes)) {
      if (wk.includes(threadId)) {
        writesForThread[wk] = this.writes[wk];
      }
    }
    const fullPath = this.getFilePath(threadId);
    fs.writeFileSync(
      fullPath,
      JSON.stringify(
        {
          storage: packValue(this.storage[threadId]),
          writes: packValue(writesForThread)
        },
        null,
        2
      ),
      "utf8"
    );
  }

  async put(config: any, checkpoint: any, metadata: any) {
    const res = await super.put(config, checkpoint, metadata);
    const threadId = config.configurable?.thread_id;
    if (threadId) {
      this.persistThreadToDisk(threadId);
    }
    return res;
  }

  async putWrites(config: any, writes: any, taskId: any) {
    const res = await super.putWrites(config, writes, taskId);
    const threadId = config.configurable?.thread_id;
    if (threadId) {
      this.persistThreadToDisk(threadId);
    }
    return res;
  }
}

/**
 * LangGraph State Annotation for Overnight Builder Graph
 */
export const OvernightStateAnnotation = Annotation.Root({
  taskId: Annotation<string>(),
  goal: Annotation<string>(),
  status: Annotation<TaskStatus>({
    reducer: (curr, update) => update || curr,
    default: () => "queued"
  }),
  toolchain: Annotation<ToolchainType>({
    reducer: (curr, update) => update || curr,
    default: () => "node:22"
  }),
  currentMilestoneIndex: Annotation<number>({
    reducer: (curr, update) => (update !== undefined ? update : curr),
    default: () => 0
  }),
  milestones: Annotation<Milestone[]>({
    reducer: (curr, update) => update || curr,
    default: () => []
  }),
  checkpoints: Annotation<CheckpointState[]>({
    reducer: (curr, update) => (update ? [...curr, ...update] : curr),
    default: () => []
  }),
  ambiguityFlags: Annotation<AmbiguityFlag[]>({
    reducer: (curr, update) => (update ? [...curr, ...update] : curr),
    default: () => []
  }),
  journal: Annotation<TaskJournalEntry[]>({
    reducer: (curr, update) => (update ? [...curr, ...update] : curr),
    default: () => []
  }),
  currentDiff: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => ""
  }),
  currentGitSha: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => ""
  }),
  iterationCount: Annotation<number>({
    reducer: (curr, update) => update ?? curr,
    default: () => 1
  }),
  criticApproved: Annotation<boolean>({
    reducer: (curr, update) => update ?? curr,
    default: () => false
  }),
  criticFeedback: Annotation<string[]>({
    reducer: (curr, update) => update ?? curr,
    default: () => []
  }),
  nodeHistory: Annotation<string[]>({
    reducer: (curr, update) => (update ? [...curr, ...update] : curr),
    default: () => []
  }),
  traceId: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => ""
  }),
  supervisorSpanId: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => ""
  }),
  plannerSpanId: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => ""
  }),
  workerSpanId: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => ""
  }),
  criticSpanId: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => ""
  }),
  traceparent: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => ""
  })
});

export interface CreateGraphOptions {
  checkpointer?: FileCheckpointSaver | MemorySaver;
  workerPool?: WorkerPool;
  tracer?: TelemetryTracer;
}

/**
 * Builds the fully wired LangGraph StateGraph connecting:
 * Planner -> Explorer -> [Builder <-> Critic (retry cap 5)] -> Recorder -> (next milestone -> Builder | done -> END)
 */
export function createOvernightGraph(options?: CreateGraphOptions) {
  const workerPool = options?.workerPool || new WorkerPool();
  const tracer = options?.tracer;
  const repoRoot = fs.existsSync(path.join(process.cwd(), "deploy")) ? process.cwd() : path.resolve(process.cwd(), "..");

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
            goal: state.goal
          });
          supervisorSpanId = supSpan.spanId;
        }
        currentTraceId = tracer.getTraceId();
        const plannerSpan = tracer.startSpan("supervisor.planner", supervisorSpanId, {
          taskId: state.taskId,
          goal: state.goal
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
            toolchain: state.toolchain || "node:22"
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
            message: `Generated SPEC.md with ${planSpec.milestones.length} milestones.`
          }
        ]
      };
    })

    // 2. Explorer Node: inspects workspace tree and provides distilled inventory
    .addNode("explorer", async (state) => {
      let explorerSpan: any;
      if (tracer) {
        explorerSpan = tracer.startSpan("supervisor.explorer", state.plannerSpanId || state.supervisorSpanId, {
          taskId: state.taskId
        });
      }

      const explorer = createExplorerWorker();
      const inventory = await workerPool.executeJob({
        role: "explorer",
        taskId: state.taskId,
        taskFn: async () => {
          return await explorer.exploreWorkspace({ path: "workspace" });
        }
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
            message: `Explorer surveyed workspace: ${inventory}`
          }
        ]
      };
    })

    // 3. Builder Node: executes sandboxed toolchain iteration and generates git diff
    .addNode("builder", async (state) => {
      const mIdx = state.currentMilestoneIndex || 0;
      const currentMilestone = state.milestones[mIdx] || state.milestones[0];
      const isRetry = state.criticApproved === false && state.criticFeedback.length > 0;
      const currentIteration = isRetry ? (state.iterationCount || 1) + 1 : 1;

      let builderSpan: any;
      let workerSpanId = state.workerSpanId;
      if (tracer) {
        // Parent is plannerSpanId (supervisor -> planner -> worker)
        const parentSpan = state.plannerSpanId || state.supervisorSpanId;
        builderSpan = tracer.startSpan("supervisor.builder", parentSpan, {
          taskId: state.taskId,
          milestoneId: currentMilestone?.id,
          iteration: currentIteration
        });
        workerSpanId = builderSpan.spanId;
      }

      const builder = createBuilderWorker({ model: workerPool.getModelForRole("builder") });
      const builderRes = await workerPool.executeJob({
        role: "builder",
        taskId: state.taskId,
        taskFn: async () => {
          return await builder.executeMilestoneWork(currentMilestone, {
            repoRoot,
            previousDiff: state.currentDiff,
            criticFeedback: state.criticFeedback,
            iteration: currentIteration
          });
        }
      });

      if (builderSpan) {
        builderSpan.end("ok", {
          gitSha: builderRes.gitSha,
          diffLength: builderRes.diff.length,
          iterations: builderRes.iterations
        });
      }

      const updatedMilestones = state.milestones.map((m, idx) => {
        if (idx === mIdx) {
          return {
            ...m,
            status: "in_progress" as const,
            builderIterations: builderRes.iterations,
            commitSha: builderRes.gitSha,
            diffSummary: builderRes.diff
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
            message: `Builder iteration ${builderRes.iterations} for milestone ${currentMilestone ? currentMilestone.id : "m1"}. SHA: ${builderRes.gitSha}`
          }
        ]
      };
    })

    // 4. Critic Node: independently grades diff against milestone criteria
    .addNode("critic", async (state) => {
      const mIdx = state.currentMilestoneIndex || 0;
      const currentMilestone = state.milestones[mIdx] || state.milestones[0];
      const critic = createCriticWorker({ model: workerPool.getModelForRole("critic") });

      let criticSpan: any;
      let criticSpanId = state.criticSpanId;
      if (tracer) {
        // Parent is workerSpanId (supervisor -> planner -> worker -> critic)
        const parentSpan = state.workerSpanId || state.plannerSpanId || state.supervisorSpanId;
        criticSpan = tracer.startSpan("supervisor.critic", parentSpan, {
          taskId: state.taskId,
          milestoneId: currentMilestone?.id,
          iteration: state.iterationCount
        });
        criticSpanId = criticSpan.spanId;
      }

      const criticRes = await workerPool.executeJob({
        role: "critic",
        taskId: state.taskId,
        taskFn: async () => {
          return await critic.evaluateMilestoneDiff(currentMilestone, {
            diff: state.currentDiff
          });
        }
      });

      if (criticSpan) {
        criticSpan.end(criticRes.approved ? "ok" : "error", {
          approved: criticRes.approved,
          feedbackCount: criticRes.feedback.length,
          feedback: criticRes.feedback.join("; ")
        });
      }

      const criticRounds = (currentMilestone.criticRounds || 0) + 1;
      const updatedMilestones = state.milestones.map((m, idx) => {
        if (idx === mIdx) {
          return {
            ...m,
            criticRounds,
            criticNotes: criticRes.feedback
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
            message: `Critic round ${criticRounds} for ${currentMilestone ? currentMilestone.id : "m1"}: ${criticRes.approved ? "APPROVED" : "REJECTED (" + criticRes.feedback.join("; ") + ")"}`
          }
        ]
      };
    })

    // 5. Recorder Node: Hermes skill promotion gate and milestone graduation
    .addNode("recorder", async (state) => {
      const mIdx = state.currentMilestoneIndex || 0;
      const currentMilestone = state.milestones[mIdx] || state.milestones[0];
      const recorder = createRecorderWorker();

      let recorderSpan: any;
      if (tracer) {
        const parentSpan = state.criticSpanId || state.workerSpanId || state.supervisorSpanId;
        recorderSpan = tracer.startSpan("supervisor.recorder", parentSpan, {
          taskId: state.taskId,
          milestoneId: currentMilestone?.id
        });
      }

      const recorderRes = await workerPool.executeJob({
        role: "recorder",
        taskId: state.taskId,
        taskFn: async () => {
          return await recorder.evaluateAndRecordSkill(currentMilestone, {
            lesson: `Standardized solution pattern for ${currentMilestone ? currentMilestone.title : "milestone"}`,
            iterations: state.iterationCount
          });
        }
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
            commitSha: state.currentGitSha || getRealGitSha(repoRoot)
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
            message: `Recorder finalized milestone ${currentMilestone ? currentMilestone.id : "m1"}. Skill promoted: ${recorderRes.promoted}`
          }
        ]
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
        continue: "recorder"
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
        done: END
      }
    );

  return workflow;
}

export interface SupervisorOptions {
  checkpointDirectory?: string;
  stallTimeoutMs?: number;
  tracer?: TelemetryTracer;
}

export interface StepExecutorOptions {
  stepExecutor?: (
    milestone: Milestone,
    attempt: number
  ) => Promise<{ status: "completed" | "failed"; gitSha?: string; diff?: string }>;
}

/**
 * Overnight Supervisor / Watchdog
 * Reconciles desired task state against actual state, persists LangGraph checkpoints,
 * handles automatic crash recovery, and performs stall detection.
 */
export class OvernightSupervisor {
  readonly checkpointDirectory: string;
  readonly stallTimeoutMs: number;
  readonly checkpointer: FileCheckpointSaver;
  readonly tracer?: TelemetryTracer;

  constructor(options?: SupervisorOptions) {
    this.checkpointDirectory =
      options?.checkpointDirectory ||
      path.resolve(process.cwd(), "../workspace/.agent/checkpoints");
    // Default stall detection threshold: 20 minutes (configurable)
    this.stallTimeoutMs = options?.stallTimeoutMs ?? 20 * 60 * 1000;
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
    executor: (milestone: Milestone) => Promise<{ diff: string; gitSha: string; approved: boolean; feedback: string[] }>
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
      milestoneIndex
    });
    const supervisorSpanId = supSpan.spanId;

    // 2. Planner Span (Child of Supervisor)
    const plannerSpan = tracer.startSpan("supervisor.planner", supervisorSpanId, {
      taskId: task.taskId,
      milestoneId: task.milestones[milestoneIndex]?.id
    });
    const plannerSpanId = plannerSpan.spanId;
    plannerSpan.end("ok");

    // 3. Worker / Builder Span (Child of Planner)
    const workerSpan = tracer.startSpan("supervisor.worker", plannerSpanId, {
      taskId: task.taskId,
      milestoneId: task.milestones[milestoneIndex]?.id
    });
    const workerSpanId = workerSpan.spanId;

    const milestone = task.milestones[milestoneIndex];
    const execRes = await executor(milestone);
    workerSpan.end("ok", { gitSha: execRes.gitSha, diffLength: execRes.diff.length });

    // 4. Critic Span (Child of Worker)
    const criticSpan = tracer.startSpan("supervisor.critic", workerSpanId, {
      taskId: task.taskId,
      milestoneId: milestone?.id
    });
    const criticSpanId = criticSpan.spanId;
    criticSpan.end(execRes.approved ? "ok" : "error", {
      approved: execRes.approved,
      feedback: execRes.feedback.join("; ")
    });

    supSpan.end("ok");

    return {
      milestone,
      traceId,
      supervisorSpanId,
      plannerSpanId,
      workerSpanId,
      criticSpanId
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
    const completed = task.milestones
      .filter((m) => m.status === "completed")
      .map((m) => m.id);

    const checkpoint: CheckpointState = {
      checkpointId: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      taskId: task.taskId,
      milestoneId: currentMilestone ? currentMilestone.id : "END",
      milestoneIndex: task.currentMilestoneIndex,
      gitHeadSha: gitSha || "HEAD",
      completedMilestones: completed,
      timestamp: new Date().toISOString(),
      recoveryAttempted: false
    };

    task.checkpoints.push(checkpoint);
    task.updatedAt = new Date().toISOString();

    fs.writeFileSync(
      this.getCheckpointFilePath(task.taskId),
      JSON.stringify(task, null, 2),
      "utf8"
    );

    return checkpoint;
  }

  async resumeTaskFromCheckpoint(taskId: string): Promise<TaskManifest | null> {
    const file = this.getCheckpointFilePath(taskId);
    if (!fs.existsSync(file)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as TaskManifest;
      return data;
    } catch {
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
          } catch {}
        }
      }
      return tasks.sort(
        (a, b) =>
          new Date(b.updatedAt || b.startedAt).getTime() -
          new Date(a.updatedAt || a.startedAt).getTime()
      );
    } catch {
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
    const executor = options?.stepExecutor;

    while (task.currentMilestoneIndex < task.milestones.length) {
      const mIdx = task.currentMilestoneIndex;
      const milestone = task.milestones[mIdx];
      let attempt = 0;
      let milestoneCompleted = false;

      while (!milestoneCompleted && attempt < 3) {
        attempt++;
        try {
          if (executor) {
            const res = await executor(milestone, attempt);
            if (res.status === "completed") {
              milestone.status = "completed";
              milestone.commitSha = res.gitSha;
              milestoneCompleted = true;
            }
          } else {
            milestone.status = "completed";
            milestoneCompleted = true;
          }
        } catch (err: any) {
          // Worker crashed mid-milestone: record crash in journal and resume from checkpoint
          task.journal.push({
            timestamp: new Date().toISOString(),
            role: "supervisor",
            message: `Worker crash detected in milestone ${milestone.id} (attempt ${attempt}): ${err.message}. Resuming from checkpoint...`
          });

          // Reload state from checkpoint or re-arm milestone
          milestone.status = "pending";
          if (attempt >= 2) {
            // Self-healing retry with fresh checkpoint reload
            const reloaded = await this.resumeTaskFromCheckpoint(task.taskId);
            if (reloaded) {
              task = reloaded;
            }
          }
        }
      }

      if (milestoneCompleted) {
        task.currentMilestoneIndex = mIdx + 1;
        this.saveCheckpoint(task, milestone.commitSha);
      } else {
        // Failed after retries: park task and flag ambiguity
        task.status = "parked";
        task.parkedReason = `Milestone ${milestone.id} failed after 3 recovery attempts`;
        task.ambiguityFlags.push({
          id: `amb-${Date.now()}`,
          milestoneId: milestone.id,
          question: `Milestone ${milestone.title} encountered repeated unrecoverable failures.`,
          judgmentCall: "Parked task to preserve git integrity and avoid infinite loop.",
          reasoning: "Autonomy policy: Never spin forever on failing steps without human review.",
          revertAction: { type: "re_plan", target: milestone.id },
          reviewed: false
        });
        return task;
      }
    }

    task.status = "completed";
    task.completedAt = new Date().toISOString();
    this.saveCheckpoint(task);
    return task;
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
          message: `Stall detected (${Math.round(elapsed / 1000)}s idle). Triggering recovery attempt for ${currentMilestone.id}...`
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
        reasoning: "Autonomy policy: never spin forever; snapshot state and await Zack's review.",
        revertAction: {
          type: "re_plan",
          target: currentMilestone ? currentMilestone.id : "all"
        },
        reviewed: false
      });

      this.saveCheckpoint(task);
    }

    return task;
  }
}
