import { NextRequest, NextResponse } from "next/server";
import { triggerScheduleRun, listSchedules } from "../../../../../lib/subagents/scheduler";

export async function POST(
  req: Request | NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const rawParams = context?.params;
    const resolvedParams = rawParams instanceof Promise ? await rawParams : rawParams;
    const scheduleId = resolvedParams?.id;

    if (!scheduleId || typeof scheduleId !== "string") {
      return NextResponse.json({ error: "Missing required schedule ID parameter" }, { status: 400 });
    }

    const workspaceDir = process.env.WORKSPACE_DIR;
    const options = workspaceDir ? { workspaceDir } : undefined;
    const schedules = await listSchedules(options);
    const sched = schedules.find((s) => s.id === scheduleId);
    if (!sched || !sched.enabled) {
      return NextResponse.json({ error: "Schedule not found or disabled" }, { status: 404 });
    }

    const result = await triggerScheduleRun(scheduleId, options);
    if (!result) {
      return NextResponse.json({ error: "Schedule execution failed or not found" }, { status: 404 });
    }

    return NextResponse.json({ runId: result.runId, status: result.status }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
