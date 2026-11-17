import { NextResponse } from "next/server";
import { ThreadStore } from "@/lib/threads/threadStore";
import { determineHostRunnerState } from "@/lib/hostMode";
import { getHostSettings } from "@/lib/hostSettings";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const threadId = url.searchParams.get("threadId");

    const hostSettings = getHostSettings();
    let hostAccess = hostSettings.hostAccessEnabled;
    if (threadId) {
      try {
        const threadStore = new ThreadStore();
        const thread = await threadStore.getThread(threadId);
        if (typeof thread?.hostAccess === "boolean") {
          hostAccess = thread.hostAccess;
        }
      } catch {
        hostAccess = hostSettings.hostAccessEnabled;
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
