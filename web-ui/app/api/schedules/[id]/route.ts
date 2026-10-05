import { NextRequest, NextResponse } from "next/server";
import { cancelSchedule } from "../../../../lib/subagents/scheduler";

export async function DELETE(
  req: Request | NextRequest,
  context: { params: Promise<{ id: string }> | { id: string } }
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
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
