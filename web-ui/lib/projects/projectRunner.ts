import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ProjectRecord,
  ProjectTaskRecord,
  getProject,
  createProjectTask,
  completeProjectTask,
  failProjectTask,
  parkProjectTask,
  getProjectTask,
} from "./projectStore";
import { runGit } from "./projectGit";
import { DEFAULT_PRIMARY_MODEL } from "../../config/models";
import { generatePlanSpec } from "../subagents/planner";
import { OvernightSupervisor, createProductionStepExecutor } from "../subagents/supervisor";
import { calculateNextRun, scheduleTask } from "../subagents/scheduler";
import { ToolchainType, TaskManifest } from "../subagents/types";

let engineRunningCheckOverride: (() => Promise<boolean>) | null = null;

export function setEngineRunningCheckOverride(override: (() => Promise<boolean>) | null): void {
  engineRunningCheckOverride = override;
}

export async function isEngineRunning(): Promise<boolean> {
  if (engineRunningCheckOverride) {
    return engineRunningCheckOverride();
  }

  const supervisorUrl =
    process.env.LLM_SUPERVISOR_URL ||
    process.env.LLAMACPP_CONTROL_URL ||
    process.env.LLM_BASE_URL ||
    process.env.LLAMACPP_BASE_URL ||
    "http://127.0.0.1:11434";
  const token = process.env.LLM_SUPERVISOR_TOKEN || "local-sandbox-token-2026";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
      headers["X-Control-Token"] = token;
    }

    const res = await fetch(`${supervisorUrl}/control/status`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    return data.status === "running" || data.status === "ready" || data.status === "online";
  } catch {
    return false;
  }
}

type ProjectTaskExecutorOverride = (
  project: ProjectRecord,
  branch: string,
  task: ProjectTaskRecord,
  signal: AbortSignal
) => Promise<void>;

let projectTaskExecutorOverride: ProjectTaskExecutorOverride | null = null;

export function setProjectTaskExecutorOverride(override: ProjectTaskExecutorOverride | null): void {
  projectTaskExecutorOverride = override;
}

interface ActiveRunner {
  controller: AbortController;
  project: ProjectRecord;
  task: ProjectTaskRecord;
  completionPromise?: Promise<ProjectTaskRecord>;
}

const activeRunners = new Map<string, ActiveRunner>();
const runnerPromises = new Map<string, Promise<ProjectTaskRecord>>();

/**
 * Converts a UI scheduleTime string ("02:00", "14:30", or 5-field cron) into a validated cron expression.
 */
export function parseScheduleTimeToCron(scheduleTime?: string): string {
  if (!scheduleTime || !scheduleTime.trim()) {
    return "0 2 * * *";
  }

  const trimmed = scheduleTime.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length === 5) {
    try {
      calculateNextRun(trimmed);
      return trimmed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const badCronErr = new Error(msg) as Error & { statusCode?: number };
      badCronErr.statusCode = 400;
      throw badCronErr;
    }
  }

  const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!timeMatch) {
    const err = new Error(
      `Invalid scheduleTime '${scheduleTime}': expected HH:MM or 5-field cron expression`
    ) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }

  const hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    const err = new Error(
      `Invalid scheduleTime '${scheduleTime}': hour must be 0-23 and minute 0-59`
    ) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }

  return `${minute} ${hour} * * *`;
}

export interface ScheduleProjectTaskInput {
  projectId: string;
  prompt: string;
  scheduleTime?: string;
  workspaceDir?: string;
}

export interface ScheduleProjectTaskResult {
  scheduleId: string;
  cronExpression: string;
  nextRun: string;
  taskDescription: string;
}

/**
 * Registers an unattended cron schedule for a project without checking out a branch or locking active_task_id.
 */
export async function scheduleProjectTask(
  input: ScheduleProjectTaskInput
): Promise<ScheduleProjectTaskResult> {
  const project = getProject(input.projectId);
  if (!project) {
    const err = new Error(`Project not found: ${input.projectId}`) as Error & {
      statusCode?: number;
    };
    err.statusCode = 404;
    throw err;
  }

  if (project.allowlisted !== 1) {
    const err = new Error(`Project '${project.name}' is revoked. Execution forbidden.`) as Error & {
      statusCode?: number;
    };
    err.statusCode = 403;
    throw err;
  }

  const cronExpression = parseScheduleTimeToCron(input.scheduleTime);
  const nextRun = calculateNextRun(cronExpression).toISOString();
  const taskDescription = `[${project.name} (${project.project_id})] ${input.prompt.trim()}`;
  const workspaceDir = input.workspaceDir || process.env.WORKSPACE_DIR;
  const scheduleId = await scheduleTask(
    cronExpression,
    taskDescription,
    workspaceDir ? { workspaceDir } : undefined
  );

  return {
    scheduleId,
    cronExpression,
    nextRun,
    taskDescription,
  };
}

export interface StartProjectTaskInput {
  projectId: string;
  prompt: string;
  mode?: "now" | "schedule";
  scheduleTime?: string;
  executeInline?: boolean;
  executeBackground?: boolean;
  milestonesExecutor?: (project: ProjectRecord, branch: string) => Promise<void>;
}

async function runTaskMilestones(params: {
  task: ProjectTaskRecord;
  project: ProjectRecord;
  branch: string;
  baseSha: string;
  prompt: string;
  controller: AbortController;
  milestonesExecutor?: (project: ProjectRecord, branch: string) => Promise<void>;
  rethrowOnError: boolean;
}): Promise<ProjectTaskRecord> {
  const { task, project, branch, baseSha, prompt, controller, milestonesExecutor, rethrowOnError } =
    params;

  try {
    if (milestonesExecutor) {
      await milestonesExecutor(project, branch);
    } else if (projectTaskExecutorOverride) {
      await projectTaskExecutorOverride(project, branch, task, controller.signal);
    } else {
      const plan = await generatePlanSpec({
        taskId: task.task_id,
        goal: prompt,
        toolchain: project.toolchain as ToolchainType,
        scope: "PROJECT",
        model: DEFAULT_PRIMARY_MODEL,
      });

      const supervisor = new OvernightSupervisor();
      const stepExecutor = createProductionStepExecutor({
        repoRoot: project.root_path,
        model: DEFAULT_PRIMARY_MODEL,
        signal: controller.signal,
      });

      for (let i = 0; i < plan.milestones.length; i++) {
        if (controller.signal.aborted) {
          throw new Error("Task aborted by supervisor signal");
        }
        const taskManifest: TaskManifest = {
          taskId: task.task_id,
          goal: prompt,
          status: "active",
          startedAt: task.created_at,
          updatedAt: task.updated_at,
          toolchain: project.toolchain as ToolchainType,
          milestones: plan.milestones,
          branchName: branch,
          scope: "PROJECT",
          projectId: project.project_id,
          projectName: project.name,
          projectRoot: project.root_path,
          reviewUrl: `/projects?projectId=${project.project_id}&tab=diffs`,
          currentMilestoneIndex: i,
          checkpoints: [],
          ambiguityFlags: [],
          journal: [],
        };

        await supervisor.executeMilestoneWithTelemetry(taskManifest, i, async (m) => {
          const res = await stepExecutor(m, 1);
          return {
            diff: res.diff || "",
            gitSha: res.gitSha || baseSha,
            approved: res.status === "completed",
            feedback: res.reason ? [res.reason] : [],
          };
        });
      }
    }

    if (controller.signal.aborted) {
      const current = getProjectTask(task.task_id);
      if (current && current.status === "running") {
        return parkProjectTask(task.task_id, "Aborted mid-run");
      }
      return current || task;
    }

    const headSha = runGit(project, ["rev-parse", "HEAD"]);
    return completeProjectTask(task.task_id, headSha);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted || /abort/i.test(msg)) {
      const current = getProjectTask(task.task_id);
      if (current && current.status === "running") {
        return parkProjectTask(task.task_id, "Aborted mid-run");
      }
      return current || task;
    }
    try {
      const current = getProjectTask(task.task_id);
      if (current && current.status === "running") {
        failProjectTask(task.task_id, msg);
      }
    } catch {}
    if (rethrowOnError) {
      throw err;
    }
    return getProjectTask(task.task_id) || task;
  } finally {
    activeRunners.delete(task.task_id);
    runnerPromises.delete(task.task_id);
  }
}

export async function waitForProjectTask(taskId: string): Promise<ProjectTaskRecord | null> {
  const pending = runnerPromises.get(taskId);
  if (pending) {
    await pending;
  }
  return getProjectTask(taskId);
}

export async function startProjectTask(input: StartProjectTaskInput): Promise<ProjectTaskRecord> {
  const project = getProject(input.projectId);
  if (!project) {
    const err = new Error(`Project not found: ${input.projectId}`) as Error & {
      statusCode?: number;
    };
    err.statusCode = 404;
    throw err;
  }

  if (project.allowlisted !== 1) {
    const err = new Error(`Project '${project.name}' is revoked. Execution forbidden.`) as Error & {
      statusCode?: number;
    };
    err.statusCode = 403;
    throw err;
  }

  const engineUp = await isEngineRunning();
  if (!engineUp) {
    const err = new Error(
      "Agent engine is stopped. Start engine to run overnight tasks."
    ) as Error & { statusCode?: number };
    err.statusCode = 503;
    throw err;
  }

  if (project.active_task_id) {
    const err = new Error(
      `Project already has an active task running: ${project.active_task_id}`
    ) as Error & { statusCode?: number };
    err.statusCode = 409;
    throw err;
  }

  // 1. Record baseSha from current HEAD of project base branch
  let baseSha = "";
  try {
    baseSha = runGit(project, ["rev-parse", "HEAD"]);
  } catch (err: unknown) {
    // If fresh repo with 0 commits, auto-initialize initial base commit so HEAD exists
    try {
      const readmePath = path.join(project.root_path, "README.md");
      if (!fs.existsSync(readmePath)) {
        fs.writeFileSync(readmePath, `# ${project.name}\n\nInitial repository commit.\n`, "utf8");
      }
      runGit(project, ["config", "user.name", "Local Agent"]);
      runGit(project, ["config", "user.email", "agent@local-sandbox.internal"]);
      runGit(project, ["add", "."]);
      runGit(project, ["commit", "-m", "Initial base commit"]);
      baseSha = runGit(project, ["rev-parse", "HEAD"]);
    } catch {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to determine baseSha from repository: ${msg}`);
    }
  }

  // 2. Generate branch: feat/task-<shortId>
  const shortId = randomUUID().replace(/-/g, "").slice(0, 8);
  const branch = `feat/task-${shortId}`;

  // 3. Create and switch to worker branch
  try {
    runGit(project, ["checkout", "-B", branch]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create task branch ${branch}: ${msg}`);
  }

  // 4. Create task in project_tasks table and assign active_task_id
  let task: ProjectTaskRecord;
  try {
    task = createProjectTask({
      projectId: project.project_id,
      prompt: input.prompt,
      baseSha,
      branch,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg && /active task/i.test(msg)) {
      const conflictErr = new Error(msg) as Error & { statusCode?: number };
      conflictErr.statusCode = 409;
      throw conflictErr;
    }
    throw err;
  }

  // 5. Setup runner AbortController
  const controller = new AbortController();
  const runnerEntry: ActiveRunner = {
    controller,
    project,
    task,
  };
  activeRunners.set(task.task_id, runnerEntry);

  // If inline execution is requested (e.g. testing or immediate run)
  if (input.executeInline === true) {
    return await runTaskMilestones({
      task,
      project,
      branch,
      baseSha,
      prompt: input.prompt,
      controller,
      milestonesExecutor: input.milestonesExecutor,
      rethrowOnError: true,
    });
  }

  // Launch asynchronous background execution unless explicitly disabled (executeInline: false)
  const shouldRunBackground = input.executeBackground ?? input.executeInline === undefined;
  if (shouldRunBackground) {
    const completionPromise = Promise.resolve().then(() =>
      runTaskMilestones({
        task,
        project,
        branch,
        baseSha,
        prompt: input.prompt,
        controller,
        milestonesExecutor: input.milestonesExecutor,
        rethrowOnError: false,
      })
    );
    runnerEntry.completionPromise = completionPromise;
    runnerPromises.set(task.task_id, completionPromise);
  }

  return task;
}

export function cancelActiveProjectTasks(reason = "Engine stopped"): void {
  for (const [taskId, runner] of activeRunners.entries()) {
    try {
      runner.controller.abort();
    } catch {}
    try {
      parkProjectTask(taskId, reason);
    } catch {}
    activeRunners.delete(taskId);
  }
}

export function cancelProjectTaskRunner(taskId: string, reason = "Cancelled by user"): boolean {
  const runner = activeRunners.get(taskId);
  if (runner) {
    try {
      runner.controller.abort();
    } catch {}
    try {
      parkProjectTask(taskId, reason);
    } catch {}
    activeRunners.delete(taskId);
    return true;
  }

  const task = getProjectTask(taskId);
  if (task && task.status === "running") {
    parkProjectTask(taskId, reason);
    return true;
  }

  return false;
}

export const runProjectOvernightTask = startProjectTask;
