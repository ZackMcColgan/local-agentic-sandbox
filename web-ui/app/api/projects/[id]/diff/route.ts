import { NextResponse } from "next/server";
import { getProject, getProjectTask, listProjectTasks } from "@/lib/projects/projectStore";
import {
  getProjectDiffSummary,
  acceptProjectFile,
  revertProjectFile,
  finalizeProjectReview
} from "@/lib/projects/projectGit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const project = getProject(id);
    if (!project) {
      return NextResponse.json({ error: `Project not found: ${id}` }, { status: 404 });
    }

    if (project.allowlisted !== 1) {
      return NextResponse.json(
        { error: `Project '${project.name}' is revoked. Diff inspection forbidden.` },
        { status: 403 }
      );
    }

    const url = new URL(req.url);
    let taskId = url.searchParams.get("taskId") || project.active_task_id;

    if (!taskId) {
      const tasks = listProjectTasks(id);
      if (tasks.length > 0) {
        taskId = tasks[0].task_id;
      }
    }

    if (!taskId) {
      return NextResponse.json({ files: [], taskId: null, baseSha: null });
    }

    const task = getProjectTask(taskId);
    const baseSha = task ? task.base_sha : undefined;

    const summary = getProjectDiffSummary(project, taskId, baseSha);
    return NextResponse.json(summary);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const project = getProject(id);
    if (!project) {
      return NextResponse.json({ error: `Project not found: ${id}` }, { status: 404 });
    }

    if (project.allowlisted !== 1) {
      return NextResponse.json(
        { error: `Project '${project.name}' is revoked. File review forbidden.` },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { action, taskId, filePath } = body;
    let baseSha = body.baseSha;

    if (!action || !taskId) {
      return NextResponse.json({ error: "action and taskId are required." }, { status: 400 });
    }

    if (!baseSha) {
      const task = getProjectTask(taskId);
      if (task) {
        baseSha = task.base_sha;
      }
    }

    if (action === "accept") {
      if (!filePath) {
        return NextResponse.json({ error: "filePath is required to accept file" }, { status: 400 });
      }
      const review = acceptProjectFile(project, taskId, filePath);
      return NextResponse.json({ review });
    }

    if (action === "revert") {
      if (!filePath) {
        return NextResponse.json({ error: "filePath is required to revert file" }, { status: 400 });
      }
      if (!baseSha) {
        return NextResponse.json({ error: "baseSha is required to revert file" }, { status: 400 });
      }
      const review = revertProjectFile(project, taskId, filePath, baseSha);
      return NextResponse.json({ review });
    }

    if (action === "finalize") {
      const result = finalizeProjectReview(project, taskId);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
