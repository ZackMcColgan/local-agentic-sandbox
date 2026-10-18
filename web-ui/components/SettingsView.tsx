"use client";

import React, { useState, useEffect } from "react";
import { ChevronLeft, ChevronRight, Check, AlertTriangle, ShieldCheck, ShieldAlert, History, Cpu, Play, Square, RotateCw } from "lucide-react";
import { useTheme, Theme } from "../lib/hooks/useTheme";

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
  selectedModel = "swift-15-27b-mtp",
  defaultModel,
  models,
  onDefaultModelChange,
  reasoningEffort = "medium",
  onReasoningEffortChange,
  onOpenModelSheet,
  theme: propsTheme,
  onThemeChange: propsOnThemeChange,
  selfDeployEnabled: propsSelfDeployEnabled,
  onToggleSelfDeploy: propsOnToggleSelfDeploy,
  deployHistory = []
}: SettingsViewProps) {
  const { theme, setTheme } = useTheme(propsTheme);
  const themeMode = theme;
  const [localSelfDeployEnabled, setLocalSelfDeployEnabled] = useState(propsSelfDeployEnabled ?? false);
  const [engineData, setEngineData] = useState<any>({
    status: "running",
    reachable: true,
    model: "swift-15-27b-mtp",
    vram_mb: 16384
  });
  const [engineLoading, setEngineLoading] = useState(false);
  const [engineMessage, setEngineMessage] = useState<string | null>(null);

  const fetchEngineStatus = async () => {
    try {
      const res = await fetch("/api/engine", { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        setEngineData(json);
      }
    } catch {
      setEngineData((prev: any) => ({ ...prev, status: "stopped", reachable: false }));
    }
  };

  useEffect(() => {
    fetchEngineStatus();
  }, []);

  const handleEngineAction = async (action: "start" | "stop" | "restart") => {
    setEngineLoading(true);
    setEngineMessage(null);
    try {
      const res = await fetch("/api/engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const json = await res.json().catch(() => ({}));
      if (json.message) {
        setEngineMessage(json.message);
      } else if (action === "stop") {
        setEngineMessage("Engine stopped. 16GB VRAM reclaimed.");
      } else if (action === "start") {
        setEngineMessage("Engine starting up...");
      }
    } catch (err: any) {
      setEngineMessage(`Failed: ${err.message}`);
    } finally {
      setEngineLoading(false);
      setTimeout(fetchEngineStatus, 1500);
    }
  };

  const activeModel = defaultModel || selectedModel;
  const isSelfDeployActive = propsSelfDeployEnabled !== undefined ? propsSelfDeployEnabled : localSelfDeployEnabled;
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

  const getShortModelName = (modelId: string) => {
    if (modelId.includes("qwen3.8")) return "qwen3.8";
    if (modelId.includes("gemma4")) return "gemma4";
    return modelId.split(":")[0];
  };

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
    <div className="flex-1 min-h-0 flex flex-col bg-white dark:bg-zinc-950 overflow-y-auto">
      <div className="max-w-xl mx-auto w-full p-4 sm:p-6 space-y-6">
        
        {/* Top Header Card: "< Settings" matching Mockup media_1791044464169.webp */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-4 shadow-sm border border-slate-100 dark:border-zinc-800 flex items-center gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="p-1 -ml-1 rounded-full text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            title="Back to previous screen"
          >
            <ChevronLeft className="h-7 w-7" />
          </button>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
            Settings
          </h1>
        </div>

        {/* Section 1: Appearance */}
        <div>
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

        {/* Section 2: Models */}
        <div>
          <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
            Models
          </h2>

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

            <ChevronRight className="h-5 w-5 text-slate-400 dark:text-zinc-500" />
          </div>
        </div>

        {/* Section 3: Engine Management */}
        <div>
          <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
            Engine Management
          </h2>

          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-base font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span>Standalone llama.cpp</span>
                </div>
                <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                  Vulkan backend on AMD Radeon RX 9070 XT. Stop engine to reclaim 16GB VRAM.
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
                    <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                    <span className="text-amber-700 dark:text-amber-400">Starting...</span>
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
                <span className="text-slate-400 dark:text-zinc-500 block">Model</span>
                <span className="font-semibold text-slate-800 dark:text-zinc-200">
                  {engineData.model || "swift-15-27b-mtp"}
                </span>
              </div>
              <div>
                <span className="text-slate-400 dark:text-zinc-500 block">VRAM Usage</span>
                <span className="font-semibold text-slate-800 dark:text-zinc-200">
                  {engineData.status === "running" ? "~16,384 MB (Allocated)" : "0 MB (Reclaimed)"}
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
                    ? "opacity-50 cursor-not-allowed bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-500"
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
                    ? "opacity-50 cursor-not-allowed bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-500"
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
        </div>

        {/* Section 4: Self-Deploy Pipeline (Sprint 12 Phase 10) */}
        <div>
          <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
            Self-Deploy Pipeline
          </h2>

          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span>Kill switch (SELF_DEPLOY_ENABLED)</span>
                </div>
                <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                  When OFF, self-deploy is completely disabled. Default is OFF.
                </p>
              </div>

              <button
                type="button"
                onClick={toggleSelfDeploy}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  isSelfDeployActive ? "bg-emerald-600 dark:bg-emerald-500" : "bg-slate-300 dark:bg-zinc-700"
                }`}
                title="Toggle self-deploy kill switch"
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    isSelfDeployActive ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            {/* Deploy History with LOUD rollback alerts */}
            {deployHistory.length > 0 && (
              <div className="pt-3 border-t border-slate-100 dark:border-zinc-800 space-y-2.5">
                <div className="text-xs font-semibold text-slate-700 dark:text-zinc-300 flex items-center gap-1.5">
                  <History className="h-3.5 w-3.5 text-slate-500" />
                  <span>Recent Self-Deploy History</span>
                </div>

                <div className="space-y-2">
                  {deployHistory.map((item) => {
                    const isRolledBack = item.status === "rolled_back" || item.rollbackStatus === "rolled_back";
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
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
