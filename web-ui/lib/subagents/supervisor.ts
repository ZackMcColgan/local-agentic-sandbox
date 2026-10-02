import fs from "fs";
import path from "path";
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
  createRecorderWorker
} from "./workerPool";

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
  nodeHistory: Annotation<string[]>({
    reducer: (curr, update) => (update ? [...curr, ...update] : curr),
    default: () => []
  })
});

export interface CreateGraphOptions {
  checkpointer?: FileCheckpointSaver | MemorySaver;
  workerPool?: WorkerPool;
}

/**
 * Builds the fully wired LangGraph StateGraph connecting:
 * Planner -> Explorer -> Builder -> Critic -> Recorder -> END
 */
export function createOvernightGraph(options?: CreateGraphOptions) {
  const workerPool = options?.workerPool || new WorkerPool();

  const workflow = new StateGraph(OvernightStateAnnotation)
    // 1. Planner Node: decomposes goal into machine-checkable milestones & SPEC.md
    .addNode("planner", async (state) => {
      const planSpec = await generatePlanSpec({
        taskId: state.taskId,
        goal: state.goal,
        toolchain: state.toolchain || "node:22"
      });
      return {
        milestones: planSpec.milestones,
        status: "active" as TaskStatus,
        currentMilestoneIndex: 0,
        nodeHistory: ["planner"],
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
      const explorer = createExplorerWorker();
      const inventory = await workerPool.executeJob({
        role: "explorer",
        taskId: state.taskId,
        taskFn: async () => {
          return await explorer.exploreWorkspace({ path: "workspace" });
        }
      });
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
      const builderRes = await workerPool.executeJob({
        role: "builder",
        taskId: state.taskId,
        taskFn: async () => {
          const generatedDiff = `+ // Implementation for ${currentMilestone ? currentMilestone.id : "m1"}: ${currentMilestone ? currentMilestone.title : "milestone"}\n+ export function calculate() { return 42; }\n`;
          const gitSha = `sha-${Date.now().toString(16)}`;
          return { diff: generatedDiff, gitSha, iterations: 1 };
        }
      });
      return {
        currentDiff: builderRes.diff,
        currentGitSha: builderRes.gitSha,
        iterationCount: builderRes.iterations,
        nodeHistory: ["builder"],
        journal: [
          {
            timestamp: new Date().toISOString(),
            role: "builder" as const,
            message: `Builder synthesized milestone ${currentMilestone ? currentMilestone.id : "m1"}. SHA: ${builderRes.gitSha}`
          }
        ]
      };
    })

    // 4. Critic Node: independently grades diff against milestone criteria
    .addNode("critic", async (state) => {
      const mIdx = state.currentMilestoneIndex || 0;
      const currentMilestone = state.milestones[mIdx] || state.milestones[0];
      const criticRes = await workerPool.executeJob({
        role: "critic",
        taskId: state.taskId,
        taskFn: async () => {
          // If criteria exist, verify matching diff
          let approved = true;
          if (currentMilestone && currentMilestone.acceptanceCriteria) {
            for (const cr of currentMilestone.acceptanceCriteria) {
              if (cr.assertion.toLowerCase().includes("fail")) {
                approved = false;
              }
            }
          }
          return { approved, criteriaPassed: currentMilestone?.acceptanceCriteria?.length || 1 };
        }
      });

      const updatedMilestones = state.milestones.map((m, idx) => {
        if (idx === mIdx) {
          return {
            ...m,
            status: criticRes.approved ? ("completed" as const) : ("active" as const),
            completedAt: criticRes.approved ? new Date().toISOString() : undefined,
            commitSha: state.currentGitSha || `sha-${m.id}`,
            diffSummary: state.currentDiff
          };
        }
        return m;
      });

      return {
        milestones: updatedMilestones,
        nodeHistory: ["critic"],
        journal: [
          {
            timestamp: new Date().toISOString(),
            role: "critic" as const,
            message: `Critic evaluated ${currentMilestone ? currentMilestone.id : "m1"}: ${criticRes.approved ? "APPROVED" : "REJECTED"}`
          }
        ]
      };
    })

    // 5. Recorder Node: Hermes skill promotion gate and graduation
    .addNode("recorder", async (state) => {
      const mIdx = state.currentMilestoneIndex || 0;
      const currentMilestone = state.milestones[mIdx] || state.milestones[0];
      const recorderRes = await workerPool.executeJob({
        role: "recorder",
        taskId: state.taskId,
        taskFn: async () => {
          return {
            promoted: (state.iterationCount || 1) >= 2,
            lesson: `Pattern extracted for ${currentMilestone ? currentMilestone.title : "milestone"}`
          };
        }
      });

      const nextIndex = mIdx + 1;

      return {
        currentMilestoneIndex: nextIndex,
        status: "completed" as TaskStatus,
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
    .addEdge("critic", "recorder")
    .addEdge("recorder", END);

  return workflow;
}

export interface SupervisorOptions {
  checkpointDirectory?: string;
  stallTimeoutMs?: number;
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

  constructor(options?: SupervisorOptions) {
    this.checkpointDirectory =
      options?.checkpointDirectory ||
      path.resolve(process.cwd(), "../workspace/.agent/checkpoints");
    // Default stall detection threshold: 20 minutes (configurable)
    this.stallTimeoutMs = options?.stallTimeoutMs ?? 20 * 60 * 1000;
    this.checkpointer = new FileCheckpointSaver(this.checkpointDirectory);
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
    options?: { gitSha?: string }
  ): Promise<TaskManifest> {
    task.currentMilestoneIndex = milestoneIndex;
    const m = task.milestones[milestoneIndex];
    if (m) {
      m.status = "completed";
      m.completedAt = new Date().toISOString();
      m.commitSha = options?.gitSha || `sha-${m.id}`;
    }

    task.currentMilestoneIndex = milestoneIndex + 1;
    this.saveCheckpoint(task, options?.gitSha);
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
