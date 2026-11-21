"use client";

import React, { useState, useEffect, useRef } from "react";
import { ChevronLeft, ShieldAlert } from "lucide-react";
import { useTheme } from "../lib/hooks/useTheme";
import { version as APP_VERSION } from "../package.json";
import { LiveStatusStrip } from "./settings/LiveStatusStrip";
import { AppearanceZone } from "./settings/AppearanceZone";
import { EngineZone } from "./settings/EngineZone";
import {
  getHostCardPresentation,
  formatEngineActionMessage,
  type HostCardRunnerState,
  type HostCardPresentation,
} from "./settings/hostCard";
import { SelfDeployZone, type DeployHistoryItem } from "./settings/SelfDeployZone";
import { HostZone, type HostSettingsData } from "./settings/HostZone";
import { NotificationsZone, type NotificationStatusData } from "./settings/NotificationsZone";
import { MemoryZone } from "./settings/MemoryZone";

export {
  getHostCardPresentation,
  formatEngineActionMessage,
  type HostCardRunnerState,
  type HostCardPresentation,
  type DeployHistoryItem,
};

const DEFAULT_PRIMARY_MODEL = "qwen3.8-flash-next-gyro-gyro-s";

export interface SettingsViewProps {
  onBack?: () => void;
  onClose?: () => void;
  selectedModel?: string;
  defaultModel?: string;
  models?: string[];
  onDefaultModelChange?: (model: string) => void;
  reasoningEffort?: "low" | "medium" | "xhigh";
  onReasoningEffortChange?: (effort: "low" | "medium" | "xhigh") => void;
  onOpenModelSheet?: () => void;
  theme?: "light" | "dark" | "system";
  onThemeChange?: (theme: "light" | "dark" | "system") => void;
  selfDeployEnabled?: boolean;
  onToggleSelfDeploy?: () => void;
  deployHistory?: DeployHistoryItem[];
}

export function SettingsView({
  onBack,
  onClose,
  selectedModel = DEFAULT_PRIMARY_MODEL,
  defaultModel,
  reasoningEffort = "low",
  onOpenModelSheet,
  theme: propsTheme,
  onThemeChange: propsOnThemeChange,
  selfDeployEnabled: propsSelfDeployEnabled,
  onToggleSelfDeploy: propsOnToggleSelfDeploy,
  deployHistory = [],
}: SettingsViewProps) {
  const { theme, setTheme } = useTheme(propsTheme);
  const themeMode = theme;
  const [localSelfDeployEnabled, setLocalSelfDeployEnabled] = useState(
    propsSelfDeployEnabled ?? false
  );
  const [engineData, setEngineData] = useState<{
    status: string;
    reachable: boolean;
    engine?: string | null;
    backend?: string | null;
    model?: string | null;
    vram_mb?: number | null;
    uptime_s?: number | null;
    error?: string;
  }>({
    status: "unknown",
    reachable: false,
    engine: null,
    backend: null,
    model: null,
    vram_mb: null,
  });
  const [engineLoading, setEngineLoading] = useState(false);
  const [engineMessage, setEngineMessage] = useState<string | null>(null);
  const [notifStatus, setNotifStatus] = useState<NotificationStatusData>({
    configured: false,
    enabled: true,
  });
  const [notifTesting, setNotifTesting] = useState(false);
  const [notifTestMessage, setNotifTestMessage] = useState<string | null>(null);
  const [memoryText, setMemoryText] = useState("");
  const [memoryMessage, setMemoryMessage] = useState<string | null>(null);
  const [memorySaving, setMemorySaving] = useState(false);
  const [deployHistoryExpanded, setDeployHistoryExpanded] = useState(false);
  const [gitActivityExpanded, setGitActivityExpanded] = useState(false);
  const memoryTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [hostSettings, setHostSettingsState] = useState<HostSettingsData>({
    hostAccessEnabled: true,
    allowUnattendedHostGit: false,
    jobChunkingEnabled: true,
    runnerAvailable: false,
    recentActivity: [],
  });

  const fetchHostSettings = async () => {
    try {
      const res = await fetch("/api/settings/host", { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        setHostSettingsState(json);
      }
    } catch {}
  };

  const fetchMemory = async () => {
    try {
      const res = await fetch("/api/settings/memory", { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        setMemoryText(typeof json.text === "string" ? json.text : "");
      }
    } catch {}
  };

  const handleSaveMemory = async () => {
    if (memoryText.length > 2000) {
      setMemoryMessage(
        `Memory text exceeds the 2000-character cap (${memoryText.length} characters). Shorten it before saving.`
      );
      return;
    }
    setMemorySaving(true);
    setMemoryMessage(null);
    try {
      const res = await fetch("/api/settings/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: memoryText }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setMemoryMessage("Saved.");
      } else {
        setMemoryMessage(json.error || "Save failed.");
      }
    } catch {
      setMemoryMessage("Save failed.");
    } finally {
      setMemorySaving(false);
    }
  };

  const handleToggleHostAccess = async () => {
    const nextState = !hostSettings.hostAccessEnabled;
    setHostSettingsState((prev) => ({ ...prev, hostAccessEnabled: nextState }));
    try {
      const res = await fetch("/api/settings/host", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostAccessEnabled: nextState }),
      });
      if (res.ok) {
        const json = await res.json();
        setHostSettingsState((prev) => ({ ...prev, hostAccessEnabled: json.hostAccessEnabled }));
      }
    } catch {
      fetchHostSettings();
    }
  };

  const handleToggleJobChunking = async () => {
    const nextState = !hostSettings.jobChunkingEnabled;
    setHostSettingsState((prev) => ({ ...prev, jobChunkingEnabled: nextState }));
    try {
      const res = await fetch("/api/settings/host", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobChunkingEnabled: nextState }),
      });
      if (res.ok) {
        const json = await res.json();
        setHostSettingsState((prev) => ({ ...prev, jobChunkingEnabled: json.jobChunkingEnabled }));
      }
    } catch {
      fetchHostSettings();
    }
  };

  const handleToggleUnattendedGit = async () => {
    const nextState = !hostSettings.allowUnattendedHostGit;
    setHostSettingsState((prev) => ({ ...prev, allowUnattendedHostGit: nextState }));
    try {
      const res = await fetch("/api/settings/host", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowUnattendedHostGit: nextState }),
      });
      if (res.ok) {
        const json = await res.json();
        setHostSettingsState((prev) => ({
          ...prev,
          allowUnattendedHostGit: json.allowUnattendedHostGit,
        }));
      }
    } catch {
      fetchHostSettings();
    }
  };

  const fetchNotificationStatus = async () => {
    try {
      const res = await fetch("/api/settings/notifications", { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        setNotifStatus(json);
      }
    } catch {}
  };

  const handleToggleNotifications = async () => {
    const nextState = !notifStatus.enabled;
    setNotifStatus((prev) => ({
      ...prev,
      enabled: nextState,
      reason: !prev.configured ? "missing_credentials" : !nextState ? "disabled" : undefined,
    }));
    try {
      const res = await fetch("/api/settings/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle", enabled: nextState }),
      });
      if (res.ok) {
        const json = await res.json();
        setNotifStatus(json);
      }
    } catch {
      fetchNotificationStatus();
    }
  };

  const handleTestNotification = async () => {
    setNotifTesting(true);
    setNotifTestMessage(null);
    try {
      const res = await fetch("/api/settings/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.lastResult) {
        setNotifStatus((prev) => ({ ...prev, lastResult: data.lastResult }));
      } else {
        fetchNotificationStatus();
      }
      if (data.success) {
        setNotifTestMessage("Test sent!");
      } else {
        setNotifTestMessage("Send failed");
      }
    } catch {
      setNotifTestMessage("Send failed");
    } finally {
      setNotifTesting(false);
    }
  };

  const fetchEngineStatus = async () => {
    try {
      const res = await fetch("/api/engine", { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        setEngineData(json);
      }
    } catch {
      setEngineData((prev) => ({ ...prev, status: "stopped", reachable: false }));
    }
  };

  useEffect(() => {
    const el = memoryTextareaRef.current;
    if (!el) return;
    const handler = () => setMemoryText(el.value);
    el.addEventListener("input", handler);
    return () => el.removeEventListener("input", handler);
  }, []);
  useEffect(() => {
    fetchEngineStatus();
    fetchNotificationStatus();
    fetchHostSettings();
    fetchMemory();
  }, []);

  const handleEngineAction = async (action: "start" | "stop" | "restart") => {
    setEngineLoading(true);
    setEngineMessage(null);
    try {
      const res = await fetch("/api/engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json().catch(() => ({}));
      setEngineMessage(formatEngineActionMessage(action, res.ok, res.status, json));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setEngineMessage(`Failed: ${message}`);
    } finally {
      setEngineLoading(false);
      setTimeout(fetchEngineStatus, 1500);
    }
  };

  const activeModel = defaultModel || selectedModel;
  const engineStatusLabel =
    engineData.status === "running"
      ? "Running"
      : engineData.status === "starting"
        ? "Starting"
        : "Stopped";
  const engineDotClass =
    engineData.status === "running"
      ? "bg-emerald-500"
      : engineData.status === "starting"
        ? "bg-zinc-500 animate-pulse"
        : "bg-slate-400 dark:bg-zinc-600";
  const hostPresentation = getHostCardPresentation(hostSettings);
  const hostStatusLabel = hostPresentation.stripLabel;
  const hostDotClass = hostPresentation.dotClass;
  const stripModel = engineData.model || activeModel;
  const latestDeploy =
    deployHistory.length > 0
      ? [...deployHistory].sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )[0]
      : undefined;
  const latestDeployLabel = latestDeploy
    ? `${latestDeploy.newSha.slice(0, 7)} · ${latestDeploy.status === "rolled_back" || latestDeploy.rollbackStatus === "rolled_back" ? "Rolled back" : latestDeploy.status === "failed" ? "Failed" : "Deployed"}`
    : "No deploys yet";
  const isSelfDeployActive =
    propsSelfDeployEnabled !== undefined ? propsSelfDeployEnabled : localSelfDeployEnabled;

  const handleDismissTelegramError = () => {
    if (!notifStatus.lastResult) return;
    const key = `${notifStatus.lastResult.at}|${notifStatus.lastResult.errorSummary || ""}`;
    try {
      window.localStorage?.setItem("telegram_last_error_dismissed_v1", key);
    } catch {
      // ignore storage errors
    }
    setNotifStatus((prev) => (prev ? { ...prev } : prev));
  };
  const handleClose = onBack || onClose || (() => {});

  const handleThemeChange = (mode: "light" | "dark" | "system") => {
    setTheme(mode);
    if (propsOnThemeChange) {
      propsOnThemeChange(mode);
    }
  };

  const toggleSelfDeploy = () => {
    if (propsOnToggleSelfDeploy) {
      propsOnToggleSelfDeploy();
    } else {
      setLocalSelfDeployEnabled(!localSelfDeployEnabled);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-stone-50 dark:bg-black overflow-y-auto">
      <div className="max-w-4xl mx-auto w-full p-4 sm:p-6 space-y-6">
        {/* Top Header Card */}
        <div className="bg-white dark:bg-[#0e0e12] rounded-3xl p-4 surface-card border border-stone-200/90 dark:border-white/[0.10] flex items-center gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 -ml-1 rounded-full text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-white/[0.08] transition-colors"
            title="Back to previous screen"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-stone-900 dark:text-stone-50">
              Settings
            </h1>
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-600 dark:text-zinc-400">
              System &amp; Runtime
            </p>
          </div>
        </div>

        {/* Live Status Strip: pinned engine / host / model / prod summary */}
        <div
          className="bg-white dark:bg-[#0e0e12] rounded-3xl px-4 py-3 surface-card border border-stone-200/90 dark:border-white/[0.10]"
          data-testid="settings-live-status-strip"
        >
          <LiveStatusStrip
            engineDotClass={engineDotClass}
            engineStatusLabel={engineStatusLabel}
            hostDotClass={hostDotClass}
            hostStatusLabel={hostStatusLabel}
            stripModel={stripModel}
            latestDeployLabel={latestDeployLabel}
          />
        </div>

        {/* Section 1: Appearance */}
        <div data-testid="settings-zone-appearance">
          <AppearanceZone themeMode={themeMode} onThemeChange={handleThemeChange} />
        </div>

        {/* Section 3: Engine Management */}
        <div data-testid="settings-zone-engine">
          <EngineZone
            engineData={engineData}
            engineLoading={engineLoading}
            engineMessage={engineMessage}
            activeModel={activeModel}
            reasoningEffort={reasoningEffort}
            onEngineAction={handleEngineAction}
            onOpenModelSheet={onOpenModelSheet}
          />
        </div>
        {/* Section 4: Self-Deploy Pipeline (Sprint 12 Phase 10) */}
        <div data-testid="settings-zone-self-deploy">
          <SelfDeployZone
            isSelfDeployActive={isSelfDeployActive}
            deployHistory={deployHistory}
            deployHistoryExpanded={deployHistoryExpanded}
            onToggleDeployHistoryExpanded={() => setDeployHistoryExpanded(!deployHistoryExpanded)}
          />
        </div>

        {/* Section 6: Host & Unattended Git — delegates data-testid="host-access-toggle-btn" */}
        <div data-testid="settings-host-git-card">
          <HostZone
            hostSettings={hostSettings}
            hostPresentation={hostPresentation}
            gitActivityExpanded={gitActivityExpanded}
            onToggleHostAccess={handleToggleHostAccess}
            onToggleJobChunking={handleToggleJobChunking}
            onToggleUnattendedGit={handleToggleUnattendedGit}
            onToggleGitActivityExpanded={() => setGitActivityExpanded(!gitActivityExpanded)}
          />
        </div>

        {/* Section 5: Notifications — delegates data-testid="notifications-test-btn" */}
        <div data-testid="settings-notifications-card">
          <NotificationsZone
            notifStatus={notifStatus}
            notifTesting={notifTesting}
            notifTestMessage={notifTestMessage}
            onToggleNotifications={handleToggleNotifications}
            onTestNotification={handleTestNotification}
            onDismissError={handleDismissTelegramError}
          />
        </div>

        {/* Section: Memory — delegates data-testid="settings-memory-textarea" */}
        <div data-testid="settings-memory-card">
          <MemoryZone
            memoryText={memoryText}
            memoryMessage={memoryMessage}
            memorySaving={memorySaving}
            memoryTextareaRef={memoryTextareaRef}
            onMemoryTextChange={setMemoryText}
            onSaveMemory={handleSaveMemory}
          />
        </div>

        {/* About: product identity + version (single source: web-ui package.json) */}
        <div id="settings-about" data-testid="settings-zone-about">
          <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
            About
          </h2>
          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                Local Agentic Sandbox
              </div>
              <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                Local autonomous AI coding platform. Inference runs on this machine.
              </p>
            </div>
            <div
              className="text-[11px] font-mono font-semibold text-slate-800 dark:text-zinc-200 shrink-0"
              data-testid="settings-app-version"
            >
              v{APP_VERSION}
            </div>
          </div>
        </div>

        {/* Danger Zone: destructive controls only, separated at the bottom */}
        {/* Traces & Security Door (UI-080) */}
        <div id="settings-traces-security" data-testid="settings-zone-traces">
          <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
            Traces &amp; Security
          </h2>
          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                OpenTelemetry Traces
              </div>
              <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                Inspect live spans and execution waterfalls in Jaeger.
              </p>
            </div>
            <a
              href="/jaeger/"
              target="_blank"
              rel="noreferrer"
              className="min-h-[44px] inline-flex items-center px-3.5 py-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-xs font-semibold hover:bg-emerald-500/20 transition-colors shrink-0"
            >
              Open Jaeger UI →
            </a>
          </div>
        </div>

        <div id="settings-danger-zone" data-testid="settings-zone-danger">
          <h2 className="text-lg font-semibold text-rose-700 dark:text-rose-400 mb-3 px-1">
            Danger Zone
          </h2>

          <div className="bg-rose-50 dark:bg-rose-950/30 rounded-3xl p-5 shadow-sm border border-rose-300 dark:border-rose-900 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
                  <ShieldAlert className="h-4 w-4 text-rose-600 dark:text-rose-400" />
                  <span>Enable self-deploy</span>
                </div>
                <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                  When OFF, self-deploy is completely disabled. Default is OFF.
                </p>
              </div>

              <button
                type="button"
                onClick={toggleSelfDeploy}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  isSelfDeployActive
                    ? "bg-emerald-600 dark:bg-emerald-500"
                    : "bg-slate-300 dark:bg-zinc-700"
                }`}
                role="switch"
                aria-checked={isSelfDeployActive}
                data-testid="self-deploy-kill-switch-btn"
                title="Toggle self-deploy kill switch"
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    isSelfDeployActive ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
