import fs from "fs";
import path from "path";
import { resolveThreadsDir } from "./threads/threadStore";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
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

export interface NotificationLastResult {
  event: NotificationEvent;
  ok: boolean;
  at: string;
  messageId?: number;
  errorSummary?: string;
}

export interface PersistedNotificationSettings {
  enabled: boolean;
  lastResult?: NotificationLastResult;
}

export interface PublicNotificationStatus {
  configured: boolean;
  enabled: boolean;
  reason?: "missing_credentials" | "disabled";
  lastResult?: NotificationLastResult;
}

let configOverride: Partial<TelegramConfig> | null = null;

export function resetTelegramConfigOverride(): void {
  configOverride = null;
}

export function resolveSettingsDir(): string {
  return process.env.SETTINGS_DIR
    ? path.resolve(process.env.SETTINGS_DIR)
    : path.resolve(resolveThreadsDir(), "..", "settings");
}

export function getNotificationSettingsFilePath(): string {
  return path.join(resolveSettingsDir(), "notifications.json");
}

export function loadPersistedNotificationSettings(): PersistedNotificationSettings {
  const filePath = getNotificationSettingsFilePath();
  const defaultEnabled = process.env.TELEGRAM_NOTIFICATIONS_ENABLED !== "false";
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(content);
      return {
        enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : defaultEnabled,
        ...(parsed?.lastResult ? { lastResult: parsed.lastResult } : {})
      };
    } catch {
      // Fallback on corrupt file
    }
  }
  return { enabled: defaultEnabled };
}

export function savePersistedNotificationSettings(
  patch: Partial<PersistedNotificationSettings>
): PersistedNotificationSettings {
  const current = loadPersistedNotificationSettings();
  const updated: PersistedNotificationSettings = {
    ...current,
    ...patch
  };

  const dir = resolveSettingsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const targetFile = getNotificationSettingsFilePath();
    const tmpFile = path.join(
      dir,
      `.notifications.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
    );
    const content = JSON.stringify(updated, null, 2);
    try {
      fs.writeFileSync(tmpFile, content, "utf8");
      fs.renameSync(tmpFile, targetFile);
    } catch {
      fs.writeFileSync(targetFile, content, "utf8");
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {}
    }
  } catch {
    // Non-fatal persistence error fallback
  }

  return updated;
}

export function resolveHermesTelegramConfig(): TelegramConfig {
  const envBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
  const envChatId = process.env.TELEGRAM_CHAT_ID || "";
  const persisted = loadPersistedNotificationSettings();

  const botToken =
    configOverride?.botToken !== undefined ? configOverride.botToken : envBotToken;
  const chatId =
    configOverride?.chatId !== undefined ? configOverride.chatId : envChatId;
  const enabled =
    configOverride?.enabled !== undefined ? configOverride.enabled : persisted.enabled;

  return {
    botToken,
    chatId,
    enabled: Boolean(botToken && chatId && enabled)
  };
}

export function setTelegramConfig(config: Partial<TelegramConfig>): TelegramConfig {
  if (typeof config.enabled === "boolean") {
    savePersistedNotificationSettings({ enabled: config.enabled });
  }
  configOverride = {
    ...(configOverride || {}),
    ...config
  };
  return resolveHermesTelegramConfig();
}

export function getPublicNotificationStatus(): PublicNotificationStatus {
  const cfg = resolveHermesTelegramConfig();
  const persisted = loadPersistedNotificationSettings();
  const configured = Boolean(cfg.botToken && cfg.chatId);
  const enabled =
    configOverride?.enabled !== undefined ? configOverride.enabled : persisted.enabled;

  let reason: "missing_credentials" | "disabled" | undefined;
  if (!configured) {
    reason = "missing_credentials";
  } else if (!enabled) {
    reason = "disabled";
  }

  return {
    configured,
    enabled,
    ...(reason ? { reason } : {}),
    ...(persisted.lastResult ? { lastResult: persisted.lastResult } : {})
  };
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
  const persisted = loadPersistedNotificationSettings();

  const enabled =
    configOverride?.enabled !== undefined ? configOverride.enabled : persisted.enabled;

  if (!enabled || !cfg.botToken || !cfg.chatId) {
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

  let message = `${emoji} ${payload.title}\n\n${payload.body}`;
  if (payload.url) {
    message += `\n\n${payload.url}`;
  }

  try {
    const endpoint = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: message
      }),
      signal: AbortSignal.timeout(6000)
    });

    if (!res.ok) {
      savePersistedNotificationSettings({
        lastResult: {
          event,
          ok: false,
          at: new Date().toISOString(),
          errorSummary: `HTTP ${res.status}`
        }
      });
      return false;
    }

    const data = await res.json().catch(() => ({}));
    const messageId =
      typeof data?.result?.message_id === "number" ? data.result.message_id : undefined;

    savePersistedNotificationSettings({
      lastResult: {
        event,
        ok: true,
        at: new Date().toISOString(),
        ...(messageId !== undefined ? { messageId } : {})
      }
    });

    return true;
  } catch (err: any) {
    let safeErr = String(err?.message || "Network error");
    if (cfg.botToken) {
      safeErr = safeErr.split(cfg.botToken).join("[REDACTED]");
    }
    savePersistedNotificationSettings({
      lastResult: {
        event,
        ok: false,
        at: new Date().toISOString(),
        errorSummary: safeErr
      }
    });
    return false;
  }
}
