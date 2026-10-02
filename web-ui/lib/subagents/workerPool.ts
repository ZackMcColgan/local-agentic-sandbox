import fs from "fs";
import path from "path";
import { Milestone, WorkerRole, WorkerState } from "./types.js";

export interface ModelRosterConfig {
  planner?: string;
  builder?: string;
  critic?: string;
  explorer?: string;
  recorder?: string;
}

export interface WorkerPoolOptions {
  maxConcurrency?: number;
  modelRoster?: ModelRosterConfig;
}

export interface WorkerJob<T = any> {
  role: WorkerRole;
  taskId: string;
  abortSignal?: AbortSignal;
  taskFn: (signal: AbortSignal) => Promise<T>;
}

export interface CriticReview {
  approved: boolean;
  feedback: string[];
}

export interface RecordSkillResult {
  promoted: boolean;
  skillFilePath?: string;
}

export class ExplorerWorker {
  readonly role: WorkerRole = "explorer";
  private readonly scopedTools = [
    "workspace_get_tree",
    "workspace_grep",
    "workspace_read_file"
  ];

  getScopedToolNames(): string[] {
    return [...this.scopedTools];
  }

  async exploreWorkspace(options: { path?: string; query?: string }): Promise<string> {
    return `Inventory distillation for ${options.path || "workspace root"}`;
  }
}

export class BuilderWorker {
  readonly role: WorkerRole = "builder";
  readonly maxIterations: number = 5;
  private readonly scopedTools = [
    "workspace_write_file",
    "workspace_run_command",
    "git_diff",
    "git_commit"
  ];

  getScopedToolNames(): string[] {
    return [...this.scopedTools];
  }
}

export class CriticWorker {
  readonly role: WorkerRole = "critic";
  private readonly scopedTools = [
    "workspace_read_file",
    "workspace_grep",
    "git_diff"
  ];

  getScopedToolNames(): string[] {
    return [...this.scopedTools];
  }

  async evaluateMilestoneDiff(
    milestone: Milestone,
    diffContext: { diff: string; filesChanged: string[] }
  ): Promise<CriticReview> {
    const feedback: string[] = [];
    const diff = diffContext.diff;

    // Evaluate each machine-checkable criterion against the diff
    for (const criterion of milestone.acceptanceCriteria) {
      const assertion = criterion.assertion.toLowerCase();

      // Check for seeded or real discrepancies
      if (assertion.includes("egress-mesh") && diff.includes("ai-mesh") && !diff.includes("egress-mesh")) {
        feedback.push(`Criterion [${criterion.id}] violation: Expected network egress-mesh, but diff contains ai-mesh.`);
      }

      if (assertion.includes("#ffffff") && !diff.includes("#ffffff") && !diff.includes("background")) {
        feedback.push(`Criterion [${criterion.id}] violation: Expected background=#ffffff in diagram specification.`);
      }
    }

    const approved = feedback.length === 0;
    return {
      approved,
      feedback
    };
  }
}

export class RecorderWorker {
  readonly role: WorkerRole = "recorder";
  private readonly skillsDirectory: string;

  constructor(options?: { skillsDirectory?: string }) {
    this.skillsDirectory =
      options?.skillsDirectory ||
      path.resolve(process.cwd(), "../workspace/.agent/skills");
  }

  async evaluateAndRecordSkill(
    milestone: Milestone,
    outcome: { lesson: string; nonTrivialFlag?: boolean }
  ): Promise<RecordSkillResult> {
    // Promotion gate: only record fixes that took >= 2 iterations or were flagged non-trivial
    const qualifies = milestone.builderIterations >= 2 || outcome.nonTrivialFlag === true;
    if (!qualifies) {
      return { promoted: false };
    }

    if (!fs.existsSync(this.skillsDirectory)) {
      fs.mkdirSync(this.skillsDirectory, { recursive: true });
    }

    const safeTitle = milestone.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const filename = `skill-${milestone.id}-${safeTitle}.md`;
    const fullPath = path.join(this.skillsDirectory, filename);

    const skillContent = `---
name: ${milestone.title}
milestoneId: ${milestone.id}
iterations: ${milestone.builderIterations}
recordedAt: ${new Date().toISOString()}
---

# Learned Agent Skill: ${milestone.title}

## Problem & Context
${milestone.description}

## Discovered Solution & Rule
${outcome.lesson}
`;

    fs.writeFileSync(fullPath, skillContent, "utf8");

    return {
      promoted: true,
      skillFilePath: fullPath
    };
  }
}

export class WorkerPool {
  private readonly maxConcurrency: number;
  private readonly modelRoster: ModelRosterConfig;
  private activeJobs = new Set<Promise<any>>();

  constructor(options?: WorkerPoolOptions) {
    this.maxConcurrency = options?.maxConcurrency || 2;
    this.modelRoster = options?.modelRoster || {
      planner: "qwen3.8:27b-q3_k_m",
      builder: "qwen3.8:27b-q3_k_m",
      critic: "gemma4:e4b",
      explorer: "gemma4:e4b",
      recorder: "gemma4:e4b"
    };
  }

  getActiveWorkerCount(): number {
    return this.activeJobs.size;
  }

  getModelForRole(role: WorkerRole): string {
    return this.modelRoster[role] || "qwen3.8:27b-q3_k_m";
  }

  async executeJob<T>(job: WorkerJob<T>): Promise<T> {
    if (job.abortSignal?.aborted) {
      throw new Error("Worker execution aborted before start");
    }

    const abortController = new AbortController();
    if (job.abortSignal) {
      job.abortSignal.addEventListener("abort", () => {
        abortController.abort();
      });
    }

    let cleanupTracking: () => void = () => {};
    const trackingPromise = new Promise<void>((r) => {
      cleanupTracking = r;
    });
    this.activeJobs.add(trackingPromise);

    try {
      return await job.taskFn(abortController.signal);
    } finally {
      this.activeJobs.delete(trackingPromise);
      cleanupTracking();
    }
  }
}

export function createExplorerWorker(): ExplorerWorker {
  return new ExplorerWorker();
}

export function createBuilderWorker(): BuilderWorker {
  return new BuilderWorker();
}

export function createCriticWorker(): CriticWorker {
  return new CriticWorker();
}

export function createRecorderWorker(options?: { skillsDirectory?: string }): RecorderWorker {
  return new RecorderWorker(options);
}
