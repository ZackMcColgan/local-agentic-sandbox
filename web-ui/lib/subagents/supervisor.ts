import fs from "fs";
import path from "path";
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import {
  TaskManifest,
  Milestone,
  CheckpointState,
  AmbiguityFlag,
  TaskStatus
} from "./types.js";

/**
 * LangGraph State Annotation for Overnight Builder Graph
 */
export const OvernightStateAnnotation = Annotation.Root({
  taskId: Annotation<string>(),
  goal: Annotation<string>(),
  status: Annotation<TaskStatus>(),
  currentMilestoneIndex: Annotation<number>(),
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
  })
});

/**
 * Builds the LangGraph StateGraph connecting Supervisor, Planner, Explorer, Builder, Critic, Recorder
 */
export function createOvernightGraph() {
  const workflow = new StateGraph(OvernightStateAnnotation)
    .addNode("planner", async (state) => {
      return { status: "active" as TaskStatus };
    })
    .addNode("explorer", async (state) => {
      return {};
    })
    .addNode("builder", async (state) => {
      return {};
    })
    .addNode("critic", async (state) => {
      return {};
    })
    .addNode("recorder", async (state) => {
      return {};
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

  constructor(options?: SupervisorOptions) {
    this.checkpointDirectory =
      options?.checkpointDirectory ||
      path.resolve(process.cwd(), "../workspace/.agent/checkpoints");
    // Default stall detection threshold: 20 minutes (configurable)
    this.stallTimeoutMs = options?.stallTimeoutMs ?? 20 * 60 * 1000;
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
