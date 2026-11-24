import { NextRequest, NextResponse } from "next/server";
import {
  cancelSchedule,
  updateSchedule,
  calculateNextRun,
} from "../../../../lib/subagents/scheduler";

export async function PATCH(
  req: Request | NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const rawParams = context?.params;
    const resolvedParams = rawParams instanceof Promise ? await rawParams : rawParams;
    const id = resolvedParams?.id;
    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Missing required 'id' parameter" }, { status: 400 });
    }

    let body: { enabled?: boolean; cronExpression?: string; taskDescription?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (body.cronExpression !== undefined) {
      if (
        typeof body.cronExpression !== "string" ||
        body.cronExpression.trim().split(/\s+/).length !== 5
      ) {
        return NextResponse.json(
          { error: "Invalid cron expression: must contain exactly 5 fields" },
          { status: 400 }
        );
      }
      try {
        calculateNextRun(body.cronExpression);
      } catch (err: unknown) {
        return NextResponse.json(
          { error: `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}` },
          { status: 400 }
        );
      }
    }

    if (
      body.taskDescription !== undefined &&
      (typeof body.taskDescription !== "string" || !body.taskDescription.trim())
    ) {
      return NextResponse.json({ error: "Invalid 'taskDescription'" }, { status: 400 });
    }

    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "Invalid 'enabled' flag" }, { status: 400 });
    }

    const workspaceDir = process.env.WORKSPACE_DIR;
    const updated = await updateSchedule(
      id,
      {
        enabled: body.enabled,
        cronExpression: body.cronExpression,
        taskDescription: body.taskDescription,
      },
      workspaceDir ? { workspaceDir } : undefined
    );
    if (!updated) {
      return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    }
    return NextResponse.json({ schedule: updated }, { status: 200 });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: Request | NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const rawParams = context?.params;
    const resolvedParams = rawParams instanceof Promise ? await rawParams : rawParams;
    const id = resolvedParams?.id;
    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Missing required 'id' parameter" }, { status: 400 });
    }
    const workspaceDir = process.env.WORKSPACE_DIR;
    await cancelSchedule(id, workspaceDir ? { workspaceDir } : undefined);
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
