import fs from "fs";
import path from "path";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

let cachedConfig: TelegramConfig | null = null;

export function resolveHermesTelegramConfig(): TelegramConfig {
  if (cachedConfig) return cachedConfig;

  let botToken = process.env.TELEGRAM_BOT_TOKEN || "";
  let chatId = process.env.TELEGRAM_CHAT_ID || "";
  let enabled = process.env.TELEGRAM_NOTIFICATIONS_ENABLED !== "false";

  // If not explicitly set in process.env, inspect Hermes AppData location
  if (!botToken || !chatId) {
    const candidates = [
      path.resolve(process.env.USERPROFILE || "C:\\Users\\zackm", "AppData/Local/hermes/.env"),
      path.resolve("/workspace/.agent/hermes.env"),
      path.resolve("/workspace/hermes.env")
    ];

    for (const envPath of candidates) {
      if (fs.existsSync(envPath)) {
        try {
          const content = fs.readFileSync(envPath, "utf8");
          const lines = content.split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
            const [k, ...rest] = trimmed.split("=");
            const val = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
            if (k === "TELEGRAM_BOT_TOKEN" && !botToken) {
              botToken = val;
            }
            if ((k === "TELEGRAM_HOME_CHANNEL" || k === "TELEGRAM_CHAT_ID") && !chatId) {
              chatId = val;
            }
          }
          if (botToken && chatId) break;
        } catch {}
      }
    }
  }

  // Also check Hermes config.yaml for chat_id if not found
  if (botToken && !chatId) {
    const configYamlPath = path.resolve(
      process.env.USERPROFILE || "C:\\Users\\zackm",
      "AppData/Local/hermes/config.yaml"
    );
    if (fs.existsSync(configYamlPath)) {
      try {
        const content = fs.readFileSync(configYamlPath, "utf8");
        const match = content.match(/chat_id:\s*['"]?([0-9]+)['"]?/);
        if (match) {
          chatId = match[1];
        }
      } catch {}
    }
  }

  cachedConfig = {
    botToken,
    chatId,
    enabled: Boolean(botToken && chatId && enabled)
  };

  return cachedConfig;
}

export function setTelegramConfig(config: Partial<TelegramConfig>): TelegramConfig {
  const current = resolveHermesTelegramConfig();
  cachedConfig = {
    ...current,
    ...config
  };
  return cachedConfig;
}

export type NotificationEvent =
  | "task.completed"
  | "task.failed"
  | "morning_report.ready"
  | "test.ping"
  | "host.approval_pending";

export interface NotificationPayload {
  title: string;
  body: string;
  url?: string;
}

/**
 * Dispatches an outbound notification to Telegram.
 * Guaranteed fire-and-forget, never throws or halts calling flows.
 */
export async function notify(
  event: NotificationEvent,
  payload: NotificationPayload
): Promise<boolean> {
  const cfg = resolveHermesTelegramConfig();
  if (!cfg.enabled || !cfg.botToken || !cfg.chatId) {
    return false;
  }

  const emoji =
    event === "task.completed"
      ? "✅"
      : event === "task.failed"
      ? "❌"
      : event === "morning_report.ready"
      ? "☀️"
      : event === "host.approval_pending"
      ? "⚠️"
      : "🔔";

  let message = `${emoji} *${escapeMarkdown(payload.title)}*\n\n${escapeMarkdown(payload.body)}`;
  if (payload.url) {
    message += `\n\n[Open Dashboard](${payload.url})`;
  }

  try {
    const endpoint = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: message,
        parse_mode: "Markdown"
      }),
      signal: AbortSignal.timeout(6000)
    });

    if (!res.ok) {
      console.warn(`[TelegramNotification] Failed to send: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`[TelegramNotification] Network or timeout error: ${err.message}`);
    return false;
  }
}

function escapeMarkdown(text: string): string {
  // Minimal Markdown escaping for standard Markdown parse_mode
  return text.replace(/([_*`\[\]])/g, "\\$1");
}
