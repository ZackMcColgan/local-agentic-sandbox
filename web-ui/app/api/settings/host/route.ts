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
      jobChunkingEnabled: settings.jobChunkingEnabled,
      fileRestrictionEnabled: settings.fileRestrictionEnabled,
      allowedHostPaths: settings.allowedHostPaths,
      runnerAvailable: runnerStatus.runnerAvailable,
      runnerState: runnerStatus.runnerState,
      runnerReason: runnerStatus.reason,
      recentActivity,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const updates: {
      hostAccessEnabled?: boolean;
      allowUnattendedHostGit?: boolean;
      jobChunkingEnabled?: boolean;
      fileRestrictionEnabled?: boolean;
      allowedHostPaths?: string[];
    } = {};

    if (typeof body.hostAccessEnabled === "boolean") {
      updates.hostAccessEnabled = body.hostAccessEnabled;
    }
    if (typeof body.allowUnattendedHostGit === "boolean") {
      updates.allowUnattendedHostGit = body.allowUnattendedHostGit;
    }
    if (typeof body.jobChunkingEnabled === "boolean") {
      updates.jobChunkingEnabled = body.jobChunkingEnabled;
    }
    if (typeof body.fileRestrictionEnabled === "boolean") {
      updates.fileRestrictionEnabled = body.fileRestrictionEnabled;
    }
    if (Array.isArray(body.allowedHostPaths)) {
      updates.allowedHostPaths = body.allowedHostPaths.filter(
        (p: unknown): p is string => typeof p === "string"
      );
    }

    if (Object.keys(updates).length > 0) {
      const next = setHostSettings(updates);
      return NextResponse.json({
        success: true,
        hostAccessEnabled: next.hostAccessEnabled,
        allowUnattendedHostGit: next.allowUnattendedHostGit,
        jobChunkingEnabled: next.jobChunkingEnabled,
        fileRestrictionEnabled: next.fileRestrictionEnabled,
        allowedHostPaths: next.allowedHostPaths,
      });
    }

    return NextResponse.json(
      {
        error:
          "Invalid payload: hostAccessEnabled, allowUnattendedHostGit, jobChunkingEnabled, fileRestrictionEnabled boolean, or allowedHostPaths array required",
      },
      { status: 400 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
