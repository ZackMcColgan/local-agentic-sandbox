import { TaskManifest } from "../subagents/types";

export type SimulationScenarioKey =
  | "chat-fast"
  | "chat-slow"
  | "chat-tools"
  | "build-run"
  | "build-retry"
  | "engine-stop"
  | "project-task"
  | "backend-down";

export interface SimulationEvent {
  timeMs: number;
  type: "meta" | "status" | "thought" | "token" | "trace" | "task_update" | "done" | "error";
  model?: string;
  status?: string;
  thought?: string;
  content?: string;
  trace?: any;
  task?: TaskManifest;
  error?: string;
  durationMs?: number;
}

export interface SimulationScenario {
  key: SimulationScenarioKey;
  title: string;
  description: string;
  mode: "chat" | "build";
  defaultDurationMs: number;
  events: SimulationEvent[];
  initialPrompt: string;
  initialTask?: TaskManifest;
}

export interface SimulationState {
  isActive: boolean;
  scenarioKey: SimulationScenarioKey | null;
  speed: number;
  startedAt: number | null;
  progressPercent: number;
  statusMessage: string | null;
  isCompleted: boolean;
  error: string | null;
}
