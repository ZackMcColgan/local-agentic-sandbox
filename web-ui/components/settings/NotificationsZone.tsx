"use client";

import React from "react";
import { Bell, Send } from "lucide-react";
import { formatMessageTimestamp } from "../../lib/chatUtils";

export interface NotificationStatusData {
  configured: boolean;
  enabled: boolean;
  reason?: "missing_credentials" | "disabled";
  lastResult?: {
    event: string;
    ok: boolean;
    at: string;
    messageId?: number;
    errorSummary?: string;
  };
}

export interface NotificationsZoneProps {
  notifStatus: NotificationStatusData;
  notifTesting: boolean;
  notifTestMessage: string | null;
  onToggleNotifications: () => void;
  onTestNotification: () => void;
  onDismissError: () => void;
}

export function NotificationsZone({
  notifStatus,
  notifTesting,
  notifTestMessage,
  onToggleNotifications,
  onTestNotification,
  onDismissError,
}: NotificationsZoneProps) {
  return (
    <>
      <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
        Telegram
      </h2>

      <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
              <Bell className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>Telegram Notifications</span>
            </div>
            <p
              data-testid="notifications-status-reason"
              className="text-xs text-slate-500 dark:text-zinc-400 mt-1 max-w-sm"
            >
              {!notifStatus.configured
                ? "Missing Telegram credentials (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)."
                : !notifStatus.enabled
                  ? "Outbound Telegram notifications are currently disabled."
                  : "Outbound Telegram notifications active for completed/failed runs, morning reports, and host approvals."}
            </p>
          </div>

          {/* Status Badge */}
          <div
            data-testid="notifications-status-badge"
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${
              notifStatus.configured && notifStatus.enabled
                ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400"
                : notifStatus.configured && !notifStatus.enabled
                  ? "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 text-zinc-700 dark:text-zinc-400"
                  : "border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-850 text-slate-600 dark:text-zinc-400"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                notifStatus.configured && notifStatus.enabled
                  ? "bg-emerald-500"
                  : notifStatus.configured && !notifStatus.enabled
                    ? "bg-zinc-500"
                    : "bg-slate-400 dark:bg-zinc-600"
              }`}
            />
            <span>
              {notifStatus.configured && notifStatus.enabled
                ? "Connected"
                : notifStatus.configured && !notifStatus.enabled
                  ? "Disabled"
                  : "Not configured"}
            </span>
          </div>
        </div>

        {/* Toggle Switch */}
        <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-zinc-800">
          <span className="text-xs font-semibold text-slate-700 dark:text-zinc-300">
            Enable Notifications
          </span>
          <button
            type="button"
            role="switch"
            data-testid="notifications-toggle-btn"
            aria-checked={notifStatus.enabled}
            onClick={onToggleNotifications}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              notifStatus.enabled
                ? "bg-emerald-600 dark:bg-emerald-500"
                : "bg-slate-300 dark:bg-zinc-700"
            }`}
            title="Toggle notifications"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                notifStatus.enabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Test Button & Result */}
        <div className="pt-2 border-t border-slate-100 dark:border-zinc-800 space-y-3">
          <div className="flex items-center justify-between">
            <button
              type="button"
              data-testid="notifications-test-btn"
              disabled={notifTesting || !notifStatus.configured || !notifStatus.enabled}
              onClick={onTestNotification}
              className={`min-h-[40px] px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 ${
                notifTesting || !notifStatus.configured || !notifStatus.enabled
                  ? "opacity-50 cursor-not-allowed bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-400"
                  : "bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer active:scale-95"
              }`}
            >
              <Send className="h-3.5 w-3.5" />
              <span>{notifTesting ? "Sending..." : "Send test notification"}</span>
            </button>

            {notifTestMessage && (
              <span className="text-xs text-slate-500 dark:text-zinc-400">{notifTestMessage}</span>
            )}
          </div>

          {notifStatus.lastResult &&
            (notifStatus.lastResult.ok ||
              `${notifStatus.lastResult.at}|${notifStatus.lastResult.errorSummary || ""}` !==
                (typeof window !== "undefined"
                  ? window.localStorage?.getItem("telegram_last_error_dismissed_v1")
                  : null)) && (
              <div
                data-testid="notifications-last-result"
                className="flex items-center justify-between gap-2 text-xs text-slate-600 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-850 p-2.5 rounded-xl border border-slate-100 dark:border-zinc-800"
              >
                <div>
                  <span className="font-semibold text-slate-800 dark:text-zinc-200">
                    {notifStatus.lastResult.ok ? "Sent" : "Last notification failed"}
                  </span>{" "}
                  · {formatMessageTimestamp(notifStatus.lastResult.at)}
                  {notifStatus.lastResult.messageId !== undefined && (
                    <span> (msg #{notifStatus.lastResult.messageId})</span>
                  )}
                  {!notifStatus.lastResult.ok && notifStatus.lastResult.errorSummary && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[11px] text-zinc-400 hover:text-zinc-200">
                        Details
                      </summary>
                      <div className="mt-1 font-mono text-[10.5px] text-zinc-400 break-all">
                        {notifStatus.lastResult.event}: {notifStatus.lastResult.errorSummary}
                      </div>
                    </details>
                  )}
                </div>
                {!notifStatus.lastResult.ok && (
                  <button
                    type="button"
                    data-testid="dismiss-telegram-error-btn"
                    onClick={onDismissError}
                    className="shrink-0 min-h-[44px] px-3 py-1 rounded-lg text-[11px] font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-200 dark:hover:bg-zinc-800 transition-colors"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            )}
        </div>
      </div>
    </>
  );
}
