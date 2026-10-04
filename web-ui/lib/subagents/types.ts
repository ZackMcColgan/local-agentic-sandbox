/**
 * Core type definitions for Mode A: Overnight Builder & Subagents
 */

export type ToolchainType = "node:22" | "python:3.12" | "go" | "rust";

export type MilestoneStatus = "pending" | "in_progress" | "completed" | "failed" | "rejected";

export interface AcceptanceCriterion {
  id: string;
  assertion: string;
  command?: string;
  fileMatch?: string;
  expectedExitCode?: number;
}

export interface Milestone {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  status: MilestoneStatus;
  builderIterations: number;
  criticRounds: number;
  criticNotes?: string[];
  forcedFlaw?: boolean;
  commitSha?: string;
  diffSummary?: string;
  testsPassed?: number;
  testsFailed?: number;
  testFile?: string;
  plannedFiles?: string[];
  completedAt?: string;
  /**
   * Provenance: true when any output for this milestone came from the deterministic
   * FAST_GRAPH_TEST fallback instead of a real model. Never true in production.
   */
  synthetic?: boolean;
  /** Model that generated the builder output (absent when synthetic). */
  builderModel?: string;
}

export interface AmbiguityFlag {
  id: string;
  milestoneId: string;
  question: string;
  judgmentCall: string;
  reasoning: string;
  revertAction: {
    type: "git_revert" | "re_plan";
    target: string;
  };
  reviewed: boolean;
}

export interface CheckpointState {
  checkpointId: string;
  taskId: string;
  milestoneId: string;
  milestoneIndex: number;
  gitHeadSha: string;
  completedMilestones: string[];
  serializedGraphState?: any;
  timestamp: string;
  recoveryAttempted: boolean;
}

export type TaskStatus = "queued" | "active" | "completed" | "parked" | "cancelled";

export interface TaskJournalEntry {
  timestamp: string;
  role: string;
  message: string;
  data?: any;
}

export interface TaskManifest {
  taskId: string;
  goal: string;
  toolchain: ToolchainType;
  branchName: string;
  branch?: string;
  status: TaskStatus;
  milestones: Milestone[];
  currentMilestoneIndex: number;
  checkpoints: CheckpointState[];
  ambiguityFlags: AmbiguityFlag[];
  journal: TaskJournalEntry[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  parkedReason?: string;
}

export interface MorningReport {
  taskId: string;
  goal: string;
  status: TaskStatus;
  branchName: string;
  startedAt: string;
  completedAt?: string;
  durationMinutes: number;
  milestonesSummary: Array<{
    id: string;
    title: string;
    status: MilestoneStatus;
    iterations: number;
    criticRounds: number;
  }>;
  testResults: {
    total: number;
    passed: number;
    failed: number;
  };
  commits: Array<{
    sha: string;
    message: string;
    timestamp: string;
  }>;
  ambiguityFlags: AmbiguityFlag[];
  parkedItems: string[];
}

export type WorkerRole = "explorer" | "builder" | "critic" | "recorder";

export interface WorkerState {
  role: WorkerRole;
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  activeTool?: string;
  currentItem?: string;
  startedAt?: string;
  completedAt?: string;
}
