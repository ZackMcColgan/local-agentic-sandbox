import { NextRequest, NextResponse } from "next/server";
import { ThreadStore, resolveThreadsDir, getActiveTurn, activeExecutionSet } from "@/lib/threads/threadStore";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: "Missing thread ID" }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) {
      return NextResponse.json({ error: "Steer text is required" }, { status: 400 });
    }

    const store = new ThreadStore(resolveThreadsDir());
    const existingThread = await store.getThread(id);
    if (!existingThread && !getActiveTurn(id) && !activeExecutionSet.has(id)) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    const pendingCount = store.appendSteer(id, text);

    return NextResponse.json({ success: true, pendingCount }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to append steer" }, { status: 500 });
  }
}
