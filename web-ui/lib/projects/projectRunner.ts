import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ProjectRecord,
  ProjectTaskRecord,
  getProject,
  createProjectTask,
  completeProjectTask,
  parkProjectTask,
  getProjectTask,
  setActiveProjectTaskIdsProvider,
} from "./projectStore";
import { runGit } from "./projectGit";
import { DEFAULT_PRIMARY_MODEL } from "../../config/models";
import { generatePlanSpec } from "../subagents/planner";
import { OvernightSupervisor, createProductionStepExecutor } from "../subagents/supervisor";
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

interface ActiveRunner {
  controller: AbortController;
  project: ProjectRecord;
  task: ProjectTaskRecord;
}

const activeRunners = new Map<string, ActiveRunner>();
setActiveProjectTaskIdsProvider(() => activeRunners.keys());

export interface StartProjectTaskInput {
  projectId: string;
  prompt: string;
  mode?: "now" | "schedule";
  scheduleTime?: string;
  executeInline?: boolean;
  milestonesExecutor?: (project: ProjectRecord, branch: string) => Promise<void>;
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
  activeRunners.set(task.task_id, {
    controller,
    project,
    task,
  });

  // If inline execution is requested (e.g. testing or immediate run)
  if (input.executeInline) {
    try {
      if (input.milestonesExecutor) {
        await input.milestonesExecutor(project, branch);
      } else {
        // Production loop: generatePlanSpec + createProductionStepExecutor
        const plan = await generatePlanSpec({
          taskId: task.task_id,
          goal: input.prompt,
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
            goal: input.prompt,
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

      const headSha = runGit(project, ["rev-parse", "HEAD"]);
      const completed = completeProjectTask(task.task_id, headSha);
      activeRunners.delete(task.task_id);
      return completed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted || /abort/i.test(msg)) {
        const parked = parkProjectTask(task.task_id, "Aborted mid-run");
        activeRunners.delete(task.task_id);
        return parked;
      }
      activeRunners.delete(task.task_id);
      throw err;
    }
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
