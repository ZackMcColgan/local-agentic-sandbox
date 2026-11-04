import { NextResponse } from "next/server";
import { ThreadStore } from "@/lib/threads/threadStore";
import { checkHostRunnerHealth } from "@/lib/hostMode";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const threadId = url.searchParams.get("threadId");

    let hostAccess = false;
    if (threadId) {
      try {
        const threadStore = new ThreadStore();
        const thread = await threadStore.getThread(threadId);
        hostAccess = Boolean(thread?.hostAccess);
      } catch {
        hostAccess = false;
      }
    }

    const runnerAvailable = await checkHostRunnerHealth();

    return NextResponse.json({ hostAccess, runnerAvailable });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to get host status" }, { status: 500 });
  }
}
