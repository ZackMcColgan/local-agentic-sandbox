import { NextResponse } from "next/server";
import { getPublicNotificationStatus, setTelegramConfig, notify } from "@/lib/notifications";
import { parseJsonBody } from "@/lib/apiJson";

export async function GET() {
  try {
    const status = getPublicNotificationStatus();
    return NextResponse.json({
      ...status,
      telegram: status,
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
    const parsed = await parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    if (body.action === "toggle" || typeof body.enabled === "boolean") {
      setTelegramConfig({ enabled: Boolean(body.enabled) });
      const status = getPublicNotificationStatus();
      return NextResponse.json({
        success: true,
        ...status,
        telegram: status,
      });
    }

    if (body.action === "test") {
      const ok = await notify("test.ping", {
        title: "Local Agentic Sandbox Test Ping",
        body: "Outbound Telegram notifications are active and verified.",
      });
      const status = getPublicNotificationStatus();
      return NextResponse.json({
        success: ok,
        ...status,
        telegram: status,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
