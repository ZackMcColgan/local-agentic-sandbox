import { NextResponse } from "next/server";
import {
  resolveHermesTelegramConfig,
  setTelegramConfig,
  notify
} from "@/lib/notifications";

export async function GET() {
  try {
    const cfg = resolveHermesTelegramConfig();
    return NextResponse.json({
      telegram: {
        configured: Boolean(cfg.botToken && cfg.chatId),
        enabled: cfg.enabled,
        chatIdMasked: cfg.chatId ? `${cfg.chatId.slice(0, 3)}***${cfg.chatId.slice(-2)}` : null
      }
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    if (body.action === "toggle") {
      const updated = setTelegramConfig({ enabled: Boolean(body.enabled) });
      return NextResponse.json({
        success: true,
        telegram: {
          configured: Boolean(updated.botToken && updated.chatId),
          enabled: updated.enabled,
          chatIdMasked: updated.chatId ? `${updated.chatId.slice(0, 3)}***${updated.chatId.slice(-2)}` : null
        }
      });
    }

    if (body.action === "test") {
      const ok = await notify("test.ping", {
        title: "Local Agentic Sandbox Test Ping",
        body: "Outbound Telegram notifications are active and verified."
      });
      return NextResponse.json({ success: ok });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
