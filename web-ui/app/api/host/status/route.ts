import { NextResponse } from "next/server";
import { ThreadStore } from "@/lib/threads/threadStore";
import { determineHostRunnerState } from "@/lib/hostMode";

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

    const hostStatus = await determineHostRunnerState(hostAccess);

    return NextResponse.json({
      hostAccess,
      runnerState: hostStatus.runnerState,
      runnerAvailable: hostStatus.runnerState === "READY",
      reason: hostStatus.reason,
      expectedSha: hostStatus.expectedSha,
      actualSha: hostStatus.actualSha
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to get host status" }, { status: 500 });
  }
}
