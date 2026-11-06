import { NextRequest, NextResponse } from "next/server";
import { ThreadStore, resolveThreadsDir } from "@/lib/threads/threadStore";

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
    const pendingCount = store.appendSteer(id, text);

    return NextResponse.json({ success: true, pendingCount }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to append steer" }, { status: 500 });
  }
}
