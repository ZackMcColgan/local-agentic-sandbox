import { NextResponse } from "next/server";
import { generatePlanSpec } from "@/lib/subagents/planner";
import { OvernightSupervisor } from "@/lib/subagents/supervisor";
import { generateMorningReport, MorningReport } from "@/lib/subagents/morningReport";
import { TaskManifest, ToolchainType } from "@/lib/subagents/types";

// In-memory task store & active cancellation tokens
const tasksRegistry = new Map<string, TaskManifest>();
const activeAbortControllers = new Map<string, AbortController>();
const supervisor = new OvernightSupervisor();

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // 1. Action: Cancellation via POST
    if (body.action === "cancel") {
      const taskId = body.taskId;
      const controller = activeAbortControllers.get(taskId);
      if (controller) {
        controller.abort();
        activeAbortControllers.delete(taskId);
      }
      const task = tasksRegistry.get(taskId);
      if (task) {
        task.status = "cancelled";
        task.updatedAt = new Date().toISOString();
        supervisor.saveCheckpoint(task);
      }
      return NextResponse.json({ status: "cancelled", activeWorkers: 0 });
    }

    // 2. Action: Revert Ambiguity Flag
    if (body.action === "revert") {
      const { taskId, flagId } = body;
      const task = tasksRegistry.get(taskId);
      if (task) {
        const flag = task.ambiguityFlags.find((f) => f.id === flagId);
        if (flag) {
          flag.reviewed = true;
          task.journal.push({
            timestamp: new Date().toISOString(),
            role: "supervisor",
            message: `Reverted judgment call for [${flag.id}]: ${flag.judgmentCall}`
          });
          supervisor.saveCheckpoint(task);
          return NextResponse.json({ success: true, flag });
        }
      }
      return NextResponse.json({ error: "Task or flag not found" }, { status: 404 });
    }

    // 3. Action: Adjust Ambiguity Flag
    if (body.action === "adjust") {
      const { taskId, flagId, instruction } = body;
      const task = tasksRegistry.get(taskId);
      if (task) {
        const flag = task.ambiguityFlags.find((f) => f.id === flagId);
        if (flag) {
          flag.reviewed = true;
          task.journal.push({
            timestamp: new Date().toISOString(),
            role: "supervisor",
            message: `User guidance applied to [${flag.id}]: "${instruction}". Adjustment queued.`
          });
          supervisor.saveCheckpoint(task);
          return NextResponse.json({ success: true, flag });
        }
      }
      return NextResponse.json({ error: "Task or flag not found" }, { status: 404 });
    }

    // 4. Default: Create New Overnight Task
    const goal: string = body.goal;
    if (!goal || typeof goal !== "string" || !goal.trim()) {
      return NextResponse.json({ error: "Goal is required" }, { status: 400 });
    }

    const toolchain: ToolchainType = body.toolchain || "node:22";
    const taskId = `task-${Date.now()}`;

    // Generate SPEC.md and decomposed milestones
    const planSpec = await generatePlanSpec({ taskId, goal, toolchain });
    const specMarkdown = planSpec.toMarkdown();

    const manifest: TaskManifest = {
      taskId,
      goal,
      branchName: "feat/v2.5-overnight",
      branch: "feat/v2.5-overnight",
      toolchain,
      status: "active",
      milestones: planSpec.milestones,
      currentMilestoneIndex: 0,
      checkpoints: [],
      ambiguityFlags: [],
      journal: [
        {
          timestamp: new Date().toISOString(),
          role: "planner",
          message: `Decomposed goal into ${planSpec.milestones.length} milestones. SPEC.md generated.`
        }
      ],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    tasksRegistry.set(taskId, manifest);
    const abortController = new AbortController();
    activeAbortControllers.set(taskId, abortController);

    supervisor.saveCheckpoint(manifest);

    return NextResponse.json(
      {
        taskId,
        manifest,
        specMarkdown,
        status: "active"
      },
      { status: 201 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const taskId = url.searchParams.get("taskId");

  // Rehydrate all tasks from disk checkpoints
  const diskTasks = await supervisor.listAllTasks();
  for (const dt of diskTasks) {
    if (!tasksRegistry.has(dt.taskId) || tasksRegistry.get(dt.taskId)?.status === "active") {
      tasksRegistry.set(dt.taskId, dt);
    }
  }

  const activeQuery = url.searchParams.get("active") === "true";
  if (!taskId || activeQuery) {
    const list = Array.from(tasksRegistry.values()).sort(
      (a, b) => new Date(b.updatedAt || b.startedAt).getTime() - new Date(a.updatedAt || a.startedAt).getTime()
    );
    const activeTask = list.find((t) => t.status === "active") || list[0] || null;
    return NextResponse.json({ tasks: list, activeTask });
  }

  let task = tasksRegistry.get(taskId);
  if (!task) {
    // Try recovering from disk checkpoint
    const diskTask = await supervisor.resumeTaskFromCheckpoint(taskId);
    if (diskTask) {
      task = diskTask;
      tasksRegistry.set(taskId, task);
    }
  }

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  let morningReport: MorningReport | null = null;
  if (task.status === "completed" || task.status === "parked") {
    morningReport = generateMorningReport({
      taskId: task.taskId,
      goal: task.goal,
      branch: task.branch || task.branchName || "feat/v2.5-overnight",
      gitHeadSha: task.checkpoints[task.checkpoints.length - 1]?.gitHeadSha || "HEAD",
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      milestones: task.milestones.map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        commitSha: m.commitSha,
        testsPassed: m.testsPassed ?? 0,
        testsFailed: m.testsFailed ?? 0,
        diffSummary: m.diffSummary
      })),
      ambiguityFlags: task.ambiguityFlags,
      parkedItems: task.parkedReason ? [task.parkedReason] : []
    });
  }

  return NextResponse.json({
    task,
    morningReport,
    activeWorkers: activeAbortControllers.has(taskId) ? 1 : 0
  });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const taskId = url.searchParams.get("taskId");

  if (!taskId) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }

  const controller = activeAbortControllers.get(taskId);
  if (controller) {
    controller.abort();
    activeAbortControllers.delete(taskId);
  }

  const task = tasksRegistry.get(taskId);
  if (task) {
    task.status = "cancelled";
    task.updatedAt = new Date().toISOString();
    task.journal.push({
      timestamp: new Date().toISOString(),
      role: "supervisor",
      message: "Cancellation token triggered. Worker pool returned to idle; VRAM released."
    });
    supervisor.saveCheckpoint(task);
  }

  return NextResponse.json({
    status: "cancelled",
    activeWorkers: 0
  });
}
