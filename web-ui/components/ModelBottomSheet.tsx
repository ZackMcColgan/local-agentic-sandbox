"use client";

import React, { useState, useEffect } from "react";
import { Bot, Cpu, Check, Zap, Brain, X, Power } from "lucide-react";
import { isReasoningEffortSupported } from "@/config/models";

interface ModelBottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  reasoningEffort: "low" | "medium" | "xhigh";
  onReasoningChange?: (effort: "low" | "medium" | "xhigh") => void;
  onReasoningEffortChange?: (effort: "low" | "medium" | "xhigh") => void;
  installedModels?: string[];
}

export function ModelBottomSheet({
  isOpen,
  onClose,
  selectedModel,
  onModelChange,
  reasoningEffort,
  onReasoningChange,
  onReasoningEffortChange,
  installedModels = [],
}: ModelBottomSheetProps) {
  const [engineStatus, setEngineStatus] = useState<"running" | "stopped" | "starting" | "unknown">(
    "unknown"
  );
  const [engineVramMb, setEngineVramMb] = useState<number | null>(null);
  const [engineModel, setEngineModel] = useState<string | null>(null);
  const [engineLoading, setEngineLoading] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);

  useEffect(() => {
    setEngineError(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    let mounted = true;
    fetch("/api/engine", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!mounted || !d) return;
        if (d.status === "running" || d.status === "stopped" || d.status === "starting") {
          setEngineStatus(d.status);
        } else {
          setEngineStatus("unknown");
        }
        setEngineVramMb(typeof d.vram_mb === "number" ? d.vram_mb : null);
        setEngineModel(typeof d.model === "string" && d.model.trim() ? d.model : null);
      })
      .catch(() => {
        if (mounted) setEngineStatus("unknown");
      });

    return () => {
      mounted = false;
    };
  }, [isOpen]);

  const handleToggleEngine = async () => {
    const action = engineStatus === "running" ? "stop" : "start";
    setEngineLoading(true);
    setEngineError(null);
    try {
      const res = await fetch("/api/engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        setEngineError(data.error || "Engine stop not supported by current runner");
      } else if (data.status) {
        setEngineStatus(data.status);
      } else if (action === "start") {
        setEngineStatus("starting");
      }
    } catch {
      setEngineError("Engine stop not supported by current runner");
    } finally {
      setEngineLoading(false);
    }
  };

  if (!isOpen) return null;

  const handleReasoningChange = (effort: "low" | "medium" | "xhigh") => {
    if (onReasoningChange) onReasoningChange(effort);
    if (onReasoningEffortChange) onReasoningEffortChange(effort);
  };

  const reasoningSupported = isReasoningEffortSupported(selectedModel);

  const effortDescriptions: Record<"low" | "medium" | "xhigh", string> = {
    low: "Fast — minimal latency, low reasoning.",
    medium: "Balanced — good default for most tasks.",
    xhigh: "Deep — maximum chain-of-thought exploration.",
  };

  const modelsList = [
    {
      id: "qwen3.8-flash-next-gyro-gyro-s",
      displayName: "Flash-Next",
      subtext: "Gyro-S · default orchestrator & workers",
      icon: "bot",
    },
    {
      id: "Swift-1.5-Qwen3.8-27B-IQ3_XS",
      displayName: "Swift-1.5",
      subtext: "27B MTP · speculative decoding profile",
      icon: "bot",
    },
    {
      id: "qwen3.8:27b-q3_k_m",
      displayName: "qwen3.8",
      subtext: "27B · planner & critic",
      icon: "bot",
    },
    {
      id: "gemma4:e4b",
      displayName: "gemma4:e4b",
      subtext: "Builder worker",
      icon: "cpu",
    },
  ];

  // If there are other installed models, normalize by stripping :latest and deduplicate
  for (const raw of installedModels) {
    const m = raw.replace(/:latest$/, "");
    if (
      !modelsList.some(
        (item) =>
          item.id === m || item.id === raw || item.displayName === m || item.displayName === raw
      )
    ) {
      modelsList.push({
        id: m,
        displayName: m,
        subtext: "Installed LLM model",
        icon: "cpu",
      });
    }
  }

  const isModelSelected = (id: string, displayName: string) => {
    const normSelected = selectedModel.replace(/:latest$/, "");
    return (
      normSelected === id ||
      normSelected === displayName ||
      selectedModel === id ||
      selectedModel === displayName
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Model and thinking effort"
        className="w-full sm:max-w-md bg-stone-50 dark:bg-[#0e0e12] rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl border border-stone-200 dark:border-white/[0.11] animate-in slide-in-from-bottom duration-250 flex flex-col gap-4 max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="w-12 h-1.5 bg-stone-300 dark:bg-white/[0.18] rounded-full mx-auto" />

        {/* Title & Close */}
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold tracking-tight text-stone-900 dark:text-stone-50">
            Model &amp; thinking effort
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200 hover:bg-stone-200/70 dark:hover:bg-white/[0.08] transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Model section */}
        <div className="flex-1 min-h-0 space-y-2">
          <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-[0.1em] bg-stone-200/80 dark:bg-[#1f1f28] text-stone-600 dark:text-stone-400">
            Model
          </span>

          <div className="max-h-[42vh] overflow-y-auto space-y-2 pr-1">
            {modelsList.map((item) => {
              const selected = isModelSelected(item.id, item.displayName);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onModelChange(item.id)}
                  className={`w-full flex items-center justify-between p-3.5 rounded-2xl transition-all text-left ${
                    selected
                      ? "bg-emerald-50 dark:bg-emerald-500/15 border-2 border-emerald-500 shadow-sm"
                      : "bg-white dark:bg-[#15151b] border border-stone-200 dark:border-white/[0.09] hover:border-stone-300 dark:hover:border-white/[0.18]"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`p-2.5 rounded-full flex items-center justify-center ${
                        selected
                          ? "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300"
                          : "bg-stone-100 dark:bg-[#1f1f28] text-stone-600 dark:text-stone-400"
                      }`}
                    >
                      {item.icon === "bot" ? (
                        <Bot className="h-5 w-5" />
                      ) : (
                        <Cpu className="h-5 w-5" />
                      )}
                    </div>
                    <div>
                      <div className="text-sm font-bold text-stone-900 dark:text-stone-100">
                        {item.displayName}
                      </div>
                      <div className="text-xs text-zinc-600 dark:text-zinc-400">{item.subtext}</div>
                    </div>
                  </div>

                  {selected && (
                    <div className="h-6 w-6 rounded-full bg-emerald-600 dark:bg-emerald-500 text-white dark:text-black flex items-center justify-center shadow-sm">
                      <Check className="h-4 w-4 stroke-[3]" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Pinned Sticky Footer: Thinking effort & Done button */}
        <div className="pt-3 border-t border-stone-200/80 dark:border-white/[0.08] space-y-3 shrink-0">
          <div className="flex items-center justify-between">
            <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-[0.1em] bg-stone-200/80 dark:bg-[#1f1f28] text-stone-600 dark:text-stone-400">
              Thinking effort
            </span>
            {!reasoningSupported && (
              <span className="text-[10px] text-emerald-700 dark:text-emerald-400 font-mono">
                Not supported by model
              </span>
            )}
          </div>

          <div
            className={`grid grid-cols-3 gap-1 p-1 rounded-2xl bg-stone-200/70 dark:bg-[#15151b] border border-stone-200 dark:border-white/[0.09] ${
              !reasoningSupported ? "opacity-50 pointer-events-none" : ""
            }`}
          >
            {/* Fast */}
            <button
              type="button"
              disabled={!reasoningSupported}
              onClick={() => handleReasoningChange("low")}
              className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold transition-all ${
                reasoningEffort === "low"
                  ? "bg-emerald-600 dark:bg-emerald-500 text-white dark:text-black shadow-sm"
                  : "text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100"
              }`}
            >
              <Zap className="h-3.5 w-3.5" />
              <span>Fast</span>
            </button>

            {/* Balanced */}
            <button
              type="button"
              disabled={!reasoningSupported}
              onClick={() => handleReasoningChange("medium")}
              className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold transition-all ${
                reasoningEffort === "medium"
                  ? "bg-emerald-600 dark:bg-emerald-500 text-white dark:text-black shadow-sm"
                  : "text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100"
              }`}
            >
              {reasoningEffort === "medium" ? <Check className="h-3.5 w-3.5 stroke-[3]" /> : null}
              <span>Balanced</span>
            </button>

            {/* Deep */}
            <button
              type="button"
              disabled={!reasoningSupported}
              onClick={() => handleReasoningChange("xhigh")}
              className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold transition-all ${
                reasoningEffort === "xhigh"
                  ? "bg-emerald-600 dark:bg-emerald-500 text-white dark:text-black shadow-sm"
                  : "text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100"
              }`}
            >
              <Brain className="h-3.5 w-3.5" />
              <span>Deep</span>
            </button>
          </div>

          <p className="text-xs text-zinc-600 dark:text-zinc-400 pl-1">
            {effortDescriptions[reasoningEffort]}
          </p>

          {/* Engine Management Card */}
          <div className="p-3.5 rounded-2xl bg-white dark:bg-[#15151b] border border-stone-200 dark:border-white/[0.09] flex items-center justify-between">
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${engineStatus === "running" ? "bg-emerald-500 animate-pulse" : "bg-zinc-400"}`}
                />
                <span className="text-xs font-bold text-stone-900 dark:text-stone-100">
                  Inference Engine
                </span>
              </div>
              <span className="text-[11px] text-zinc-600 dark:text-zinc-400 mt-0.5">
                {engineStatus === "running"
                  ? `Running · ${
                      typeof engineVramMb === "number"
                        ? engineVramMb >= 1024
                          ? `${(engineVramMb / 1024).toFixed(1)} GB VRAM`
                          : `${engineVramMb} MB VRAM`
                        : "VRAM Unknown"
                    } · ${engineModel || selectedModel || "Unknown"}`
                  : engineStatus === "starting"
                    ? "Starting…"
                    : engineStatus === "stopped"
                      ? "Stopped · 0 MB VRAM"
                      : "Status Unknown"}
              </span>
            </div>
            {engineStatus !== "running" && (
              <button
                type="button"
                onClick={handleToggleEngine}
                disabled={engineLoading}
                className="min-h-[44px] px-3.5 py-1.5 rounded-xl text-xs font-bold text-white dark:text-black transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 active:scale-95"
              >
                <Power className="h-3.5 w-3.5" />
                <span>{engineLoading ? "Updating..." : "Start Engine"}</span>
              </button>
            )}
          </div>
          {engineError && (
            <p className="text-[11px] font-medium text-rose-600 dark:text-rose-400 px-1">
              {engineError}
            </p>
          )}

          {/* Done button */}
          <button
            type="button"
            onClick={onClose}
            className="w-full py-3.5 px-6 rounded-2xl bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-black font-semibold text-sm shadow-md transition-all active:scale-[0.99]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
