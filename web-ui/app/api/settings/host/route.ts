import { NextResponse } from "next/server";
import { getHostSettings, setHostSettings, fetchRecentGitActivity } from "@/lib/hostSettings";
import { determineHostRunnerState } from "@/lib/hostMode";

export async function GET() {
  try {
    const settings = getHostSettings();
    const runnerStatus = await determineHostRunnerState(true);
    const recentActivity = await fetchRecentGitActivity(20);

    return NextResponse.json({
      allowUnattendedHostGit: settings.allowUnattendedHostGit,
      runnerAvailable: runnerStatus.runnerAvailable,
      recentActivity
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    if (typeof body.allowUnattendedHostGit === "boolean") {
      const next = setHostSettings({ allowUnattendedHostGit: body.allowUnattendedHostGit });
      return NextResponse.json({
        success: true,
        allowUnattendedHostGit: next.allowUnattendedHostGit
      });
    }

    return NextResponse.json({ error: "Invalid payload: allowUnattendedHostGit boolean required" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
