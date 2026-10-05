import { NextRequest, NextResponse } from "next/server";
import {
  scheduleTask,
  cancelSchedule,
  listSchedules,
  calculateNextRun
} from "../../../lib/subagents/scheduler";

export async function GET(req: Request | NextRequest) {
  try {
    const workspaceDir = process.env.WORKSPACE_DIR;
    const schedules = await listSchedules(workspaceDir ? { workspaceDir } : undefined);
    return NextResponse.json({ schedules }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request | NextRequest) {
  try {
    const body = await req.json();
    const { cronExpression, taskDescription } = body || {};

    if (!cronExpression || typeof cronExpression !== "string") {
      return NextResponse.json({ error: "Missing required 'cronExpression'" }, { status: 400 });
    }

    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) {
      return NextResponse.json({ error: "Invalid cron expression: must contain exactly 5 fields" }, { status: 400 });
    }

    if (!taskDescription || typeof taskDescription !== "string" || !taskDescription.trim()) {
      return NextResponse.json({ error: "Missing required 'taskDescription'" }, { status: 400 });
    }

    let nextRun: string;
    try {
      nextRun = calculateNextRun(cronExpression).toISOString();
    } catch (err: any) {
      return NextResponse.json({ error: `Invalid cron expression: ${err.message}` }, { status: 400 });
    }

    const workspaceDir = process.env.WORKSPACE_DIR;
    const id = await scheduleTask(
      cronExpression,
      taskDescription.trim(),
      workspaceDir ? { workspaceDir } : undefined
    );
    return NextResponse.json({ id, nextRun }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request | NextRequest) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Missing required 'id' query parameter" }, { status: 400 });
    }

    const workspaceDir = process.env.WORKSPACE_DIR;
    await cancelSchedule(id, workspaceDir ? { workspaceDir } : undefined);
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
