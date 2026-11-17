import { NextResponse } from "next/server";
import { getProject, listProjectTasks } from "@/lib/projects/projectStore";
import { startProjectTask } from "@/lib/projects/projectRunner";

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

    const tasks = listProjectTasks(id);
    return NextResponse.json({ tasks });
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
        { error: `Project '${project.name}' is revoked. Execution forbidden.` },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { prompt, mode, scheduleTime } = body;

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return NextResponse.json({ error: "Task prompt is required." }, { status: 400 });
    }

    const task = await startProjectTask({
      projectId: id,
      prompt: prompt.trim(),
      mode: mode || "now",
      scheduleTime,
      executeInline: false
    });

    return NextResponse.json({ task }, { status: 201 });
  } catch (err: any) {
    const status = err.statusCode || (err.message && /active task/i.test(err.message) ? 409 : 500);
    return NextResponse.json({ error: err.message }, { status });
  }
}
