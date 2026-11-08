import { NextResponse } from "next/server";
import { getHostSettings, setHostSettings, fetchRecentGitActivity } from "@/lib/hostSettings";
import { determineHostRunnerState } from "@/lib/hostMode";

export async function GET() {
  try {
    const settings = getHostSettings();
    const runnerStatus = await determineHostRunnerState(true);
    const recentActivity = await fetchRecentGitActivity(20);

    return NextResponse.json({
      hostAccessEnabled: settings.hostAccessEnabled,
      allowUnattendedHostGit: settings.allowUnattendedHostGit,
      runnerAvailable: runnerStatus.runnerAvailable,
      runnerState: runnerStatus.runnerState,
      runnerReason: runnerStatus.reason,
      recentActivity
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const updates: any = {};

    if (typeof body.hostAccessEnabled === "boolean") {
      updates.hostAccessEnabled = body.hostAccessEnabled;
    }
    if (typeof body.allowUnattendedHostGit === "boolean") {
      updates.allowUnattendedHostGit = body.allowUnattendedHostGit;
    }

    if (Object.keys(updates).length > 0) {
      const next = setHostSettings(updates);
      return NextResponse.json({
        success: true,
        hostAccessEnabled: next.hostAccessEnabled,
        allowUnattendedHostGit: next.allowUnattendedHostGit
      });
    }

    return NextResponse.json({ error: "Invalid payload: hostAccessEnabled or allowUnattendedHostGit boolean required" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
