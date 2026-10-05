import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export interface DaemonHealthReport {
  status: "healthy" | "degraded" | "not-running";
  daemon: {
    active: boolean;
    pid: number;
    lastTick: string;
    stale: boolean;
  } | null;
  scheduler: {
    active: boolean;
    scheduleId: string;
    lastHeartbeat: string;
  } | null;
  schedules: {
    total: number;
    enabled: number;
    nextRun: string | null;
  };
}

export async function GET(req?: Request | NextRequest) {
  try {
    const workspaceDir = process.env.WORKSPACE_DIR || path.resolve(process.cwd(), "workspace");
    const daemonHbPath = path.join(workspaceDir, ".scheduler-daemon-heartbeat");
    const schedulerHbPath = path.join(workspaceDir, ".scheduler-heartbeat");
    const schedulesPath = path.join(workspaceDir, "schedules.json");

    // 1. Read daemon heartbeat
    let daemonData: { active: boolean; pid: number; lastTick: string; stale: boolean } | null = null;
    let isDaemonValid = false;

    if (fs.existsSync(daemonHbPath)) {
      try {
        const raw = fs.readFileSync(daemonHbPath, "utf8");
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.active === "boolean" &&
          typeof parsed.lastTick === "string"
        ) {
          const lastTickMs = new Date(parsed.lastTick).getTime();
          const isStale = isNaN(lastTickMs) || Date.now() - lastTickMs > 5 * 60 * 1000;
          daemonData = {
            active: parsed.active,
            pid: Number(parsed.pid) || 0,
            lastTick: parsed.lastTick,
            stale: isStale
          };
          isDaemonValid = true;
        }
      } catch {
        // Malformed JSON: daemonData remains null, isDaemonValid false
      }
    }

    // 2. Determine overall status
    let status: "healthy" | "degraded" | "not-running";
    if (!isDaemonValid || !daemonData) {
      status = "not-running";
    } else if (daemonData.stale || !daemonData.active) {
      status = "degraded";
    } else {
      status = "healthy";
    }

    // 3. Read scheduler run heartbeat
    let schedulerData: { active: boolean; scheduleId: string; lastHeartbeat: string } | null = null;
    if (fs.existsSync(schedulerHbPath)) {
      try {
        const raw = fs.readFileSync(schedulerHbPath, "utf8");
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.active === "boolean"
        ) {
          schedulerData = {
            active: parsed.active,
            scheduleId: parsed.scheduleId || "",
            lastHeartbeat: parsed.lastHeartbeat || ""
          };
        }
      } catch {
        // Ignore malformed scheduler heartbeat
      }
    }

    // 4. Read schedules
    let total = 0;
    let enabled = 0;
    let nextRun: string | null = null;

    if (fs.existsSync(schedulesPath)) {
      try {
        const raw = fs.readFileSync(schedulesPath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          total = parsed.length;
          const enabledSchedules = parsed.filter((s: any) => s && s.enabled);
          enabled = enabledSchedules.length;

          // Find earliest nextRun among enabled schedules
          const validNextRuns = enabledSchedules
            .map((s: any) => s.nextRun)
            .filter((nr: any) => typeof nr === "string" && !isNaN(new Date(nr).getTime()))
            .sort((a: string, b: string) => new Date(a).getTime() - new Date(b).getTime());

          if (validNextRuns.length > 0) {
            nextRun = validNextRuns[0];
          }
        }
      } catch {
        // Ignore malformed schedules.json
      }
    }

    const report: DaemonHealthReport = {
      status,
      daemon: daemonData,
      scheduler: schedulerData,
      schedules: {
        total,
        enabled,
        nextRun
      }
    };

    return NextResponse.json(report, { status: 200 });
  } catch {
    return NextResponse.json(
      {
        status: "not-running",
        daemon: null,
        scheduler: null,
        schedules: { total: 0, enabled: 0, nextRun: null }
      },
      { status: 200 }
    );
  }
}
