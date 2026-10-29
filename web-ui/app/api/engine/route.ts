import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function getSupervisorUrl(): string {
  return (
    process.env.LLM_SUPERVISOR_URL ||
    process.env.LLAMACPP_CONTROL_URL ||
    process.env.LLM_BASE_URL ||
    process.env.LLAMACPP_BASE_URL ||
    "http://127.0.0.1:11434"
  );
}

function getSupervisorToken(): string {
  return process.env.LLM_SUPERVISOR_TOKEN || "local-sandbox-token-2026";
}

export async function GET() {
  const supervisorUrl = getSupervisorUrl();
  const token = getSupervisorToken();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const headers: Record<string, string> = {
      Accept: "application/json"
    };
    if (token) {
      headers["X-Control-Token"] = token;
    }

    const res = await fetch(`${supervisorUrl}/control/status`, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      return NextResponse.json(
        {
          status: "unknown",
          reachable: true,
          error: `Supervisor returned ${res.status}: ${errorText}`
        },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json({
      reachable: true,
      ...data
    });
  } catch (err: any) {
    return NextResponse.json({
      status: "stopped",
      reachable: false,
      error: `Supervisor offline: ${err.message}`,
      model: "swift-15-27b-mtp",
      vram_mb: 16384,
      uptime_s: 0
    });
  }
}

export async function POST(req: NextRequest) {
  const supervisorUrl = getSupervisorUrl();
  const token = getSupervisorToken();

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { action } = body;
  if (!action || !["start", "stop", "restart"].includes(action)) {
    return NextResponse.json(
      { error: "Invalid action. Must be 'start', 'stop', or 'restart'." },
      { status: 400 }
    );
  }

  const headers: Record<string, string> = {
    Accept: "application/json"
  };
  if (token) {
    headers["X-Control-Token"] = token;
  }

  try {
    if (action === "restart") {
      // 1. Stop child
      await fetch(`${supervisorUrl}/control/stop`, {
        method: "POST",
        headers
      }).catch(() => {});

      // 2. Short pause for port/process release
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 3. Start child
      const startRes = await fetch(`${supervisorUrl}/control/start`, {
        method: "POST",
        headers
      });
      const data = await startRes.json().catch(() => ({}));
      return NextResponse.json({
        success: true,
        action: "restart",
        status: data.status || "starting",
        message: "Engine restarted successfully."
      });
    }

    if (action === "stop") {
      try {
        const { cancelActiveProjectTasks } = await import("@/lib/projects/projectRunner");
        cancelActiveProjectTasks("Engine stopped");
      } catch {}
    }

    const endpoint = action === "start" ? "/control/start" : "/control/stop";
    const res = await fetch(`${supervisorUrl}${endpoint}`, {
      method: "POST",
      headers
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      return NextResponse.json(
        {
          success: false,
          error: `Supervisor command failed (${res.status}): ${errorText}`
        },
        { status: res.status }
      );
    }

    const data = await res.json().catch(() => ({}));
    return NextResponse.json({
      success: true,
      action,
      status: data.status || (action === "start" ? "starting" : "stopped")
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: `Could not reach supervisor at ${supervisorUrl}: ${err.message}`
      },
      { status: 502 }
    );
  }
}
