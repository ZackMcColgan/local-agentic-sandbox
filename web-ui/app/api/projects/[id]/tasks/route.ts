import { NextResponse } from "next/server";
import { getProject, listProjectTasks } from "@/lib/projects/projectStore";
import { startProjectTask, scheduleProjectTask } from "@/lib/projects/projectRunner";

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
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
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

    const effectiveMode = mode === undefined ? "now" : mode;

    if (effectiveMode === "schedule") {
      const scheduled = await scheduleProjectTask({
        projectId: id,
        prompt: prompt.trim(),
        scheduleTime,
      });
      return NextResponse.json({ scheduled: true, ...scheduled }, { status: 201 });
    }

    if (effectiveMode !== "now") {
      return NextResponse.json({ error: `Unsupported task mode: ${String(mode)}` }, { status: 400 });
    }

    const task = await startProjectTask({
      projectId: id,
      prompt: prompt.trim(),
      mode: "now",
      executeBackground: true,
    });

    return NextResponse.json({ task }, { status: 201 });
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string };
    const message = e.message ?? String(err);
    const status = e.statusCode || (/active task/i.test(message) ? 409 : 500);
    return NextResponse.json({ error: message }, { status });
  }
}
