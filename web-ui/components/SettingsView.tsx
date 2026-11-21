"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Check,
  AlertTriangle,
  ShieldCheck,
  ShieldAlert,
  History,
  Cpu,
  Play,
  Square,
  RotateCw,
  Bell,
  Send,
  GitBranch,
  Terminal,
} from "lucide-react";
import { useTheme } from "../lib/hooks/useTheme";
import { formatModelDisplayLabel, formatMessageTimestamp } from "../lib/chatUtils";
import { version as APP_VERSION } from "../package.json";
const DEFAULT_PRIMARY_MODEL = "qwen3.8-flash-next-gyro-gyro-s";

export interface DeployHistoryItem {
  deployId: string;
  timestamp: string;
  branchName: string;
  previousSha: string;
  newSha: string;
  status: "deployed" | "rolled_back" | "failed";
  rollbackStatus: "none" | "rolled_back";
  healthCheckStatus?: number;
  errorMessage?: string;
}

export type HostCardRunnerState = "DISABLED" | "READY" | "UNAVAILABLE" | "MISMATCH";

export interface HostCardPresentation {
  stripLabel: string;
  badgeLabel: string;
  reasonText: string;
  dotClass: string;
  badgeClass: string;
}

export function getHostCardPresentation(settings: {
  hostAccessEnabled: boolean;
  runnerAvailable: boolean;
  runnerState?: HostCardRunnerState;
  runnerReason?: string;
}): HostCardPresentation {
  if (!settings.hostAccessEnabled) {
    return {
      stripLabel: "Off",
      badgeLabel: "Disabled",
      reasonText: "Host access is disabled. New chat threads will not offer host tools.",
      dotClass: "bg-slate-400 dark:bg-zinc-600",
      badgeClass:
        "border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-850 text-slate-600 dark:text-zinc-400",
    };
  }
  if (settings.runnerState === "MISMATCH") {
    return {
      stripLabel: "Runner mismatch",
      badgeLabel: "Version Mismatch",
      reasonText:
        settings.runnerReason ||
        "Host runner responded but does not match the expected build. Update the host runner to restore access.",
      dotClass: "bg-amber-500",
      badgeClass:
        "border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300",
    };
  }
  if (settings.runnerState === "READY" || settings.runnerAvailable) {
    return {
      stripLabel: "Connected",
      badgeLabel: "Active",
      reasonText:
        "Host tools (read, write, bash/powershell) are enabled across chat threads. Default is ON.",
      dotClass: "bg-emerald-500",
      badgeClass:
        "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400",
    };
  }
  return {
    stripLabel: "Runner offline",
    badgeLabel: "Runner Offline",
    reasonText:
      "Host tools (read, write, bash/powershell) are enabled across chat threads. Default is ON.",
    dotClass: "bg-zinc-500",
    badgeClass:
      "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 text-zinc-700 dark:text-zinc-400",
  };
}

export function formatEngineActionMessage(
  action: "start" | "stop" | "restart",
  ok: boolean,
  status: number,
  json: { success?: boolean; message?: string; error?: string; vramReleased?: boolean }
): string {
  if (!ok || json.success === false) {
    if (status === 404 || status === 405 || status === 501) {
      return "VRAM unload / engine control is not applicable to this engine.";
    }
    return json.error || `Engine ${action} failed (HTTP ${status}).`;
  }
  if (json.message) {
    return json.message;
  }
  if (action === "stop") {
    return json.vramReleased ? "Engine stopped and VRAM released." : "Engine stopped.";
  }
  if (action === "start") {
    return "Engine starting up...";
  }
  return "Engine restarted.";
}

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
  const [notifStatus, setNotifStatus] = useState<{
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
  }>({
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

  const [hostSettings, setHostSettingsState] = useState<{
    hostAccessEnabled: boolean;
    allowUnattendedHostGit: boolean;
    jobChunkingEnabled: boolean;
    runnerAvailable: boolean;
    runnerState?: HostCardRunnerState;
    runnerReason?: string;
    recentActivity: Array<{
      timestamp: string;
      verb: string;
      repo: string;
      branch: string;
      result: string;
      error?: string;
      prNumber?: number;
      prUrl?: string;
      mergeSha?: string;
    }>;
  }>({
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
  const visibleDeployHistory = deployHistoryExpanded ? deployHistory : deployHistory.slice(0, 2);
  const gitActivityNewestFirst = [...(hostSettings.recentActivity || [])].slice(-8).reverse();
  const visibleGitActivity = gitActivityExpanded
    ? gitActivityNewestFirst
    : gitActivityNewestFirst.slice(0, 2);
  const isSelfDeployActive =
    propsSelfDeployEnabled !== undefined ? propsSelfDeployEnabled : localSelfDeployEnabled;
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

  const getShortModelName = (modelId: string) => formatModelDisplayLabel(modelId);

  const getReasoningLabel = (effort: "low" | "medium" | "xhigh") => {
    if (effort === "low") return "Fast";
    if (effort === "medium") return "Balanced";
    return "Deep";
  };

  const getThemeDescription = () => {
    if (themeMode === "light") return "Light — easy on the eyes during the day.";
    if (themeMode === "dark") return "Dark — low light comfort with high contrast.";
    return "System — matches your operating system preference.";
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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-zinc-400">
                Engine
              </div>
              <div className="flex items-center gap-1.5 mt-0.5 text-xs font-semibold text-slate-800 dark:text-zinc-200">
                <span className={`h-2 w-2 rounded-full ${engineDotClass}`} />
                <span>{engineStatusLabel}</span>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-zinc-400">
                Host
              </div>
              <div className="flex items-center gap-1.5 mt-0.5 text-xs font-semibold text-slate-800 dark:text-zinc-200">
                <span className={`h-2 w-2 rounded-full ${hostDotClass}`} />
                <span>{hostStatusLabel}</span>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-zinc-400">
                Model
              </div>
              <div
                className="mt-0.5 text-[11px] font-mono font-semibold text-slate-800 dark:text-zinc-200 truncate"
                title={stripModel}
              >
                {stripModel}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-zinc-400">
                Last deploy
              </div>
              <div
                className="mt-0.5 text-[11px] font-mono font-semibold text-slate-800 dark:text-zinc-200 truncate"
                title={latestDeployLabel}
              >
                {latestDeployLabel}
              </div>
            </div>
          </div>
        </div>

        {/* Section 1: Appearance */}
        <div data-testid="settings-zone-appearance">
          <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
            Appearance
          </h2>

          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
            <label className="block text-sm font-semibold text-slate-900 dark:text-zinc-100">
              Theme
            </label>

            {/* Segmented Button: Light | Dark | System */}
            <div className="grid grid-cols-3 gap-1 bg-slate-100 dark:bg-zinc-800 p-1 rounded-full">
              <button
                type="button"
                onClick={() => handleThemeChange("light")}
                className={`py-2 px-3 rounded-full text-sm font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  themeMode === "light"
                    ? "bg-emerald-600 dark:bg-emerald-500 text-white shadow-sm"
                    : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                }`}
              >
                {themeMode === "light" && <Check className="h-4 w-4 stroke-[2.5]" />}
                <span>Light</span>
              </button>

              <button
                type="button"
                onClick={() => handleThemeChange("dark")}
                className={`py-2 px-3 rounded-full text-sm font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  themeMode === "dark"
                    ? "bg-emerald-600 dark:bg-emerald-500 text-white shadow-sm"
                    : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                }`}
              >
                {themeMode === "dark" && <Check className="h-4 w-4 stroke-[2.5]" />}
                <span>Dark</span>
              </button>

              <button
                type="button"
                onClick={() => handleThemeChange("system")}
                className={`py-2 px-3 rounded-full text-sm font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  themeMode === "system"
                    ? "bg-emerald-600 dark:bg-emerald-500 text-white shadow-sm"
                    : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                }`}
              >
                {themeMode === "system" && <Check className="h-4 w-4 stroke-[2.5]" />}
                <span>System</span>
              </button>
            </div>

            <p className="text-xs text-slate-500 dark:text-zinc-400 px-1">
              {getThemeDescription()}
            </p>
          </div>
        </div>

        {/* Section 3: Engine Management */}
        <div data-testid="settings-zone-engine">
          <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
            Engine Management
          </h2>

          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-base font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span>
                    {engineData.engine ||
                      (engineData.reachable ? "Inference Engine" : "Inference Engine")}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                  {engineData.backend
                    ? engineData.backend
                    : engineData.reachable
                      ? "Connected via local engine endpoint."
                      : "Waiting for engine status."}
                </p>
              </div>

              {/* Status Badge */}
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-850">
                {engineData.status === "running" ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span className="text-emerald-700 dark:text-emerald-400">Running</span>
                  </>
                ) : engineData.status === "starting" ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-zinc-500 animate-pulse" />
                    <span className="text-zinc-700 dark:text-zinc-400">Starting...</span>
                  </>
                ) : (
                  <>
                    <span className="h-2 w-2 rounded-full bg-slate-400 dark:bg-zinc-600" />
                    <span className="text-slate-600 dark:text-zinc-400">Stopped</span>
                  </>
                )}
              </div>
            </div>

            {/* Model & VRAM Specs */}
            <div className="grid grid-cols-2 gap-2 text-xs bg-slate-50 dark:bg-zinc-850 p-3 rounded-2xl border border-slate-100 dark:border-zinc-800">
              <div>
                <span className="text-slate-400 dark:text-zinc-400 block">Model</span>
                <span className="font-semibold text-slate-800 dark:text-zinc-200">
                  {engineData.model || "Not reported by this engine"}
                </span>
              </div>
              <div>
                <span className="text-slate-400 dark:text-zinc-400 block">VRAM Usage</span>
                <span className="font-semibold text-slate-800 dark:text-zinc-200">
                  {typeof engineData.vram_mb === "number"
                    ? `${engineData.vram_mb.toLocaleString()} MB`
                    : "Not reported by this engine"}
                </span>
              </div>
            </div>

            {/* Action Feedback Message */}
            {engineMessage && (
              <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 p-2.5 rounded-xl border border-emerald-200 dark:border-emerald-800">
                {engineMessage}
              </div>
            )}

            {/* Start / Stop / Restart Control Buttons */}
            <div className="grid grid-cols-3 gap-2 pt-1">
              <button
                type="button"
                disabled={engineLoading || engineData.status === "running"}
                onClick={() => handleEngineAction("start")}
                className={`min-h-[44px] py-2 px-3 rounded-2xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  engineData.status === "running"
                    ? "opacity-50 cursor-not-allowed bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-400"
                    : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs"
                }`}
                title="Start llama-server"
                aria-label="Start llama-server"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                <span>Start</span>
              </button>

              <button
                type="button"
                disabled={engineLoading || engineData.status === "stopped"}
                onClick={() => handleEngineAction("stop")}
                className={`min-h-[44px] py-2 px-3 rounded-2xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  engineData.status === "stopped"
                    ? "opacity-50 cursor-not-allowed bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-400"
                    : "bg-rose-50 hover:bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:hover:bg-rose-900/50 dark:text-rose-300 border border-rose-200 dark:border-rose-800"
                }`}
                title="Stop llama-server to reclaim VRAM"
                aria-label="Stop llama-server"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                <span>Stop</span>
              </button>

              <button
                type="button"
                disabled={engineLoading}
                onClick={() => handleEngineAction("restart")}
                className="min-h-[44px] py-2 px-3 rounded-2xl text-xs font-semibold flex items-center justify-center gap-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 transition-colors border border-slate-200 dark:border-zinc-700"
                title="Restart llama-server"
                aria-label="Restart llama-server"
              >
                <RotateCw className={`h-3.5 w-3.5 ${engineLoading ? "animate-spin" : ""}`} />
                <span>Restart</span>
              </button>
            </div>
          </div>
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-300 mb-2 px-1">
              Models
            </h3>

            <div
              onClick={onOpenModelSheet}
              className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 flex items-center justify-between cursor-pointer hover:bg-slate-50/80 dark:hover:bg-zinc-850/80 transition-colors"
            >
              <div className="space-y-1">
                <div className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                  Default model
                </div>
                <div className="text-xs text-slate-500 dark:text-zinc-400">
                  {getShortModelName(activeModel)} · {getReasoningLabel(reasoningEffort)}
                </div>
              </div>

              <ChevronRight className="h-5 w-5 text-slate-400 dark:text-zinc-400" />
            </div>
          </div>
        </div>
        {/* Section 4: Self-Deploy Pipeline (Sprint 12 Phase 10) */}
        <div data-testid="settings-zone-self-deploy">
          <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
            Self-Deploy Pipeline
          </h2>

          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span>Self-deploy status</span>
                </div>
                <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                  {isSelfDeployActive ? (
                    <>
                      Self-deploy is ON. Its kill switch lives in the{" "}
                      <a
                        href="#settings-danger-zone"
                        className="underline hover:text-emerald-600 dark:hover:text-emerald-400"
                      >
                        Danger Zone
                      </a>
                      .
                    </>
                  ) : (
                    <>
                      Self-deploy is OFF (kill switch engaged). Its kill switch lives in the{" "}
                      <a
                        href="#settings-danger-zone"
                        className="underline hover:text-emerald-600 dark:hover:text-emerald-400"
                      >
                        Danger Zone
                      </a>
                      .
                    </>
                  )}
                </p>
              </div>
              <div
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${isSelfDeployActive ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400" : "border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-850 text-slate-600 dark:text-zinc-400"}`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${isSelfDeployActive ? "bg-emerald-500" : "bg-slate-400 dark:bg-zinc-600"}`}
                />
                <span>{isSelfDeployActive ? "ON" : "OFF"}</span>
              </div>
            </div>

            {/* Deploy History with LOUD rollback alerts */}
            {deployHistory.length > 0 && (
              <div className="pt-3 border-t border-slate-100 dark:border-zinc-800 space-y-2.5">
                <div className="text-xs font-semibold text-slate-700 dark:text-zinc-300 flex items-center gap-1.5">
                  <History className="h-3.5 w-3.5 text-slate-500" />
                  <span>Recent Self-Deploy History</span>
                </div>

                <div
                  className={
                    deployHistoryExpanded
                      ? "space-y-2 max-h-[220px] overflow-y-auto pr-1"
                      : "space-y-2"
                  }
                >
                  {visibleDeployHistory.map((item) => {
                    const isRolledBack =
                      item.status === "rolled_back" || item.rollbackStatus === "rolled_back";
                    return (
                      <div
                        key={item.deployId}
                        className={`p-3 rounded-2xl border text-xs space-y-1.5 ${
                          isRolledBack
                            ? "bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-900 text-rose-950 dark:text-rose-100 shadow-xs"
                            : "bg-slate-50 dark:bg-zinc-850/60 border-slate-200 dark:border-zinc-800 text-slate-800 dark:text-zinc-200"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold">{item.branchName}</span>
                          {isRolledBack ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold tracking-wider uppercase bg-rose-600 text-white flex items-center gap-1 animate-pulse">
                              <AlertTriangle className="h-3 w-3" />
                              <span>ROLLED BACK</span>
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300">
                              DEPLOYED
                            </span>
                          )}
                        </div>

                        <div className="font-mono text-[11px] opacity-80">
                          {item.previousSha?.slice(0, 7)} → {item.newSha?.slice(0, 7)}
                        </div>

                        {item.errorMessage && (
                          <div className="text-[11px] font-medium text-rose-700 dark:text-rose-300">
                            {item.errorMessage}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {deployHistory.length > 2 && (
                  <button
                    type="button"
                    data-testid="deploy-history-expand-btn"
                    onClick={() => setDeployHistoryExpanded(!deployHistoryExpanded)}
                    className="flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-300 transition-colors"
                  >
                    <span>
                      {deployHistoryExpanded ? "Show less" : `Show all ${deployHistory.length}`}
                    </span>
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${deployHistoryExpanded ? "rotate-180" : ""}`}
                    />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Section 6: Host & Unattended Git (Graduation Surface) */}
        <div data-testid="settings-host-git-card">
          <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
            Host &amp; Unattended Git
          </h2>

          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
            {/* Primary Global Host Switch */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-base font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                  <Terminal className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span>Host Access</span>
                </div>
                <p
                  data-testid="host-access-status-reason"
                  className="text-xs text-slate-500 dark:text-zinc-400 mt-1 max-w-sm"
                >
                  {hostPresentation.reasonText}
                </p>
              </div>

              {/* Status Badge */}
              <div
                data-testid="host-access-status-badge"
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${hostPresentation.badgeClass}`}
              >
                <span className={`h-2 w-2 rounded-full ${hostPresentation.dotClass}`} />
                <span>{hostPresentation.badgeLabel}</span>
              </div>
            </div>

            {/* Toggle Switch */}
            <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-zinc-800">
              <span className="text-xs font-semibold text-slate-700 dark:text-zinc-300">
                Enable Host Access
              </span>
              <button
                type="button"
                role="switch"
                data-testid="host-access-toggle-btn"
                aria-checked={hostSettings.hostAccessEnabled}
                onClick={handleToggleHostAccess}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  hostSettings.hostAccessEnabled
                    ? "bg-emerald-600 dark:bg-emerald-500"
                    : "bg-slate-300 dark:bg-zinc-700"
                }`}
                title="Toggle host access switch"
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    hostSettings.hostAccessEnabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            {/* Job Chunking Toggle */}
            <div className="flex items-center justify-between gap-4 pt-3 border-t border-slate-100 dark:border-zinc-800">
              <div>
                <div className="text-xs font-semibold text-slate-700 dark:text-zinc-300">
                  Job chunking
                </div>
                <p className="text-xs text-slate-600 dark:text-zinc-400 mt-0.5">
                  When off, long jobs run in a single turn without banking checkpoints.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                data-testid="job-chunking-toggle-btn"
                aria-checked={hostSettings.jobChunkingEnabled}
                onClick={handleToggleJobChunking}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  hostSettings.jobChunkingEnabled
                    ? "bg-emerald-600 dark:bg-emerald-500"
                    : "bg-slate-300 dark:bg-zinc-700"
                }`}
                title="Toggle job chunking switch"
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    hostSettings.jobChunkingEnabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-zinc-800" />

            {/* Sub-item: Unattended Host Git */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-base font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                  <GitBranch className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span>Allow unattended host git</span>
                </div>
                <p
                  data-testid="host-git-status-reason"
                  className="text-xs text-slate-500 dark:text-zinc-400 mt-1 max-w-sm"
                >
                  {hostSettings.allowUnattendedHostGit
                    ? "Permits explicitly-granted unattended and scheduled chat jobs to perform railed Git operations in the host checkout."
                    : "Unattended host Git operations are currently disabled. Default is OFF."}
                </p>
              </div>

              {/* Status Badge */}
              <div
                data-testid="host-git-status-badge"
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${
                  hostSettings.allowUnattendedHostGit && hostSettings.runnerAvailable
                    ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400"
                    : hostSettings.allowUnattendedHostGit && !hostSettings.runnerAvailable
                      ? "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 text-zinc-700 dark:text-zinc-400"
                      : "border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-850 text-slate-600 dark:text-zinc-400"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    hostSettings.allowUnattendedHostGit && hostSettings.runnerAvailable
                      ? "bg-emerald-500"
                      : hostSettings.allowUnattendedHostGit && !hostSettings.runnerAvailable
                        ? "bg-zinc-500"
                        : "bg-slate-400 dark:bg-zinc-600"
                  }`}
                />
                <span>
                  {hostSettings.allowUnattendedHostGit
                    ? hostSettings.runnerAvailable
                      ? "Active"
                      : "Runner Offline"
                    : "Disabled"}
                </span>
              </div>
            </div>

            {/* Toggle Switch */}
            <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-zinc-800">
              <span className="text-xs font-semibold text-slate-700 dark:text-zinc-300">
                Allow unattended host git
              </span>
              <button
                type="button"
                role="switch"
                data-testid="host-git-toggle-btn"
                aria-checked={hostSettings.allowUnattendedHostGit}
                onClick={handleToggleUnattendedGit}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  hostSettings.allowUnattendedHostGit
                    ? "bg-emerald-600 dark:bg-emerald-500"
                    : "bg-slate-300 dark:bg-zinc-700"
                }`}
                title="Toggle unattended host git switch"
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    hostSettings.allowUnattendedHostGit ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            {/* Recent Unattended Git Activity (Audit Source: bridge git-ops log) */}
            <div className="pt-3 border-t border-slate-100 dark:border-zinc-800 space-y-2.5">
              <div className="text-xs font-semibold text-slate-700 dark:text-zinc-300 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Terminal className="h-3.5 w-3.5 text-slate-500" />
                  <span>Recent Unattended Git Activity</span>
                </div>
                <span className="text-[11px] text-slate-400 dark:text-zinc-400 font-normal">
                  {hostSettings.runnerAvailable
                    ? "Audit log"
                    : "Historical log (runner currently offline)"}
                </span>
              </div>

              {hostSettings.recentActivity && hostSettings.recentActivity.length > 0 ? (
                <div
                  data-testid="host-git-activity-list"
                  className="space-y-2 max-h-60 overflow-y-auto pr-1"
                >
                  {visibleGitActivity.map((item, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 rounded-2xl border border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-850/60 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-semibold text-slate-900 dark:text-zinc-100">
                          {item.verb}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            item.result === "success"
                              ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300"
                              : "bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300"
                          }`}
                        >
                          {item.result.toUpperCase()}
                        </span>
                      </div>

                      <div className="text-[11px] text-slate-500 dark:text-zinc-400 flex items-center gap-2">
                        <span>{item.repo || "local-agentic-sandbox"}</span>
                        <span>·</span>
                        <span className="font-mono text-[10px]">{item.branch}</span>
                        {item.timestamp && (
                          <>
                            <span>·</span>
                            <span>
                              {new Date(item.timestamp).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </>
                        )}
                      </div>

                      {item.prUrl && (
                        <div className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
                          PR #{item.prNumber}: {item.prUrl}
                        </div>
                      )}
                      {item.mergeSha && (
                        <div className="text-[10px] font-mono text-slate-600 dark:text-zinc-400">
                          Merge commit: {item.mergeSha.slice(0, 7)}
                        </div>
                      )}
                      {item.error && (
                        <div className="text-[11px] text-rose-600 dark:text-rose-400 font-medium">
                          {item.error}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  data-testid="host-git-empty-activity"
                  className="text-xs text-slate-400 dark:text-zinc-400 italic p-3 text-center bg-slate-50 dark:bg-zinc-850/40 rounded-2xl border border-dashed border-slate-200 dark:border-zinc-800"
                >
                  No unattended git operations recorded yet.
                </div>
              )}
              {gitActivityNewestFirst.length > 2 && (
                <button
                  type="button"
                  data-testid="host-git-activity-expand-btn"
                  onClick={() => setGitActivityExpanded(!gitActivityExpanded)}
                  className="flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-300 transition-colors"
                >
                  <span>
                    {gitActivityExpanded
                      ? "Show less"
                      : `Show all ${gitActivityNewestFirst.length}`}
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${gitActivityExpanded ? "rotate-180" : ""}`}
                  />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Section 5: Notifications */}
        <div data-testid="settings-notifications-card">
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
                onClick={handleToggleNotifications}
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
                  onClick={handleTestNotification}
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
                  <span className="text-xs text-slate-500 dark:text-zinc-400">
                    {notifTestMessage}
                  </span>
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
                        onClick={() => {
                          const key = `${notifStatus.lastResult!.at}|${notifStatus.lastResult!.errorSummary || ""}`;
                          try {
                            window.localStorage?.setItem("telegram_last_error_dismissed_v1", key);
                          } catch {
                            // ignore storage errors
                          }
                          setNotifStatus((prev) => (prev ? { ...prev } : prev));
                        }}
                        className="shrink-0 min-h-[44px] px-3 py-1 rounded-lg text-[11px] font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-200 dark:hover:bg-zinc-800 transition-colors"
                      >
                        Dismiss
                      </button>
                    )}
                  </div>
                )}
            </div>
          </div>
        </div>

        {/* Section: Memory (owner standing facts) */}
        <div data-testid="settings-memory-card">
          <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
            Memory
          </h2>

          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
            <div>
              <div className="text-base font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                <History className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span>What the assistant should always know</span>
              </div>
              <p className="text-xs text-slate-500 dark:text-zinc-400 mt-1">
                Stored on this machine only. Never committed to the repository.
              </p>
            </div>

            <textarea
              data-testid="settings-memory-textarea"
              ref={memoryTextareaRef}
              value={memoryText}
              onChange={(e) => setMemoryText(e.target.value)}
              rows={6}
              className="w-full rounded-2xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 px-3 py-2 text-sm text-slate-900 dark:text-zinc-100 font-mono resize-y"
              placeholder="Standing facts the assistant should trust without rediscovering..."
            />

            <div className="flex items-center justify-between">
              <div
                data-testid="settings-memory-counter"
                className={
                  memoryText.length > 2000
                    ? "text-xs font-mono text-rose-600 dark:text-rose-400"
                    : "text-xs font-mono text-slate-500 dark:text-zinc-400"
                }
              >
                {memoryText.length} / 2000
              </div>
              <button
                data-testid="settings-memory-save-btn"
                onClick={handleSaveMemory}
                disabled={memorySaving || memoryText.length > 2000}
                className="rounded-xl px-4 py-2 text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {memorySaving ? "Saving..." : "Save"}
              </button>
            </div>

            {memoryMessage && (
              <div
                data-testid="settings-memory-message"
                className="text-xs text-slate-600 dark:text-zinc-400"
              >
                {memoryMessage}
              </div>
            )}
          </div>
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
