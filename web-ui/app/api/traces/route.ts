import { NextRequest, NextResponse } from "next/server";
import { getTraceSession, getAllTraceSessions } from "@/lib/telemetry";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");

  if (sessionId) {
    const session = getTraceSession(sessionId);
    if (!session) {
      return NextResponse.json({
        error: "Trace session not found",
        sessionId
      }, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      session
    });
  }

  const allSessions = getAllTraceSessions();
  const latest = allSessions[0] || null;

  return NextResponse.json({
    success: true,
    total_sessions: allSessions.length,
    latest_session: latest,
    sessions: allSessions.slice(0, 10)
  });
}
