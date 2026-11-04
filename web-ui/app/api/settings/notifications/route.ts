import { NextResponse } from "next/server";
import {
  getPublicNotificationStatus,
  setTelegramConfig,
  notify
} from "@/lib/notifications";

export async function GET() {
  try {
    const status = getPublicNotificationStatus();
    return NextResponse.json({
      ...status,
      telegram: status
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    if (body.action === "toggle" || typeof body.enabled === "boolean") {
      setTelegramConfig({ enabled: Boolean(body.enabled) });
      const status = getPublicNotificationStatus();
      return NextResponse.json({
        success: true,
        ...status,
        telegram: status
      });
    }

    if (body.action === "test") {
      const ok = await notify("test.ping", {
        title: "Local Agentic Sandbox Test Ping",
        body: "Outbound Telegram notifications are active and verified."
      });
      const status = getPublicNotificationStatus();
      return NextResponse.json({
        success: ok,
        ...status,
        telegram: status
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
