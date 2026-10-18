"use client";

import React from "react";
import { Bot, Cpu, Check, Zap, Brain, X } from "lucide-react";
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
  installedModels = []
}: ModelBottomSheetProps) {
  if (!isOpen) return null;

  const handleReasoningChange = (effort: "low" | "medium" | "xhigh") => {
    if (onReasoningChange) onReasoningChange(effort);
    if (onReasoningEffortChange) onReasoningEffortChange(effort);
  };

  const reasoningSupported = isReasoningEffortSupported(selectedModel);

  const effortDescriptions: Record<"low" | "medium" | "xhigh", string> = {
    low: "Fast — minimal latency, low reasoning.",
    medium: "Balanced — good default for most tasks.",
    xhigh: "Deep — maximum chain-of-thought exploration."
  };

  const modelsList = [
    {
      id: "swift-15-27b-mtp",
      displayName: "swift-1.5",
      subtext: "27B MTP · default orchestrator & workers",
      icon: "bot"
    },
    {
      id: "qwen3.8:27b-q3_k_m",
      displayName: "qwen3.8",
      subtext: "27B · planner & critic",
      icon: "bot"
    },
    {
      id: "gemma4:e4b",
      displayName: "gemma4:e4b",
      subtext: "Builder worker",
      icon: "cpu"
    }
  ];

  // If there are other installed models, normalize by stripping :latest and deduplicate
  for (const raw of installedModels) {
    const m = raw.replace(/:latest$/, "");
    if (!modelsList.some((item) => item.id === m || item.id === raw || item.displayName === m || item.displayName === raw)) {
      modelsList.push({
        id: m,
        displayName: m,
        subtext: "Installed Ollama model",
        icon: "cpu"
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
        className="w-full sm:max-w-md bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl border border-slate-200 dark:border-zinc-800 animate-in slide-in-from-bottom duration-250 flex flex-col gap-4 max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="w-12 h-1.5 bg-slate-300 dark:bg-zinc-700 rounded-full mx-auto" />

        {/* Title & Close */}
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-900 dark:text-zinc-100">
            Model &amp; thinking effort
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Model section */}
        <div className="flex-1 min-h-0 space-y-2">
          <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400">
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
                      ? "bg-emerald-50 dark:bg-emerald-950/30 border-2 border-emerald-500 shadow-sm"
                      : "bg-slate-50 dark:bg-zinc-850 border border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`p-2.5 rounded-full flex items-center justify-center ${
                        selected
                          ? "bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300"
                          : "bg-slate-200 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400"
                      }`}
                    >
                      {item.icon === "bot" ? <Bot className="h-5 w-5" /> : <Cpu className="h-5 w-5" />}
                    </div>
                    <div>
                      <div className="text-sm font-bold text-slate-900 dark:text-zinc-100">
                        {item.displayName}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-zinc-400">
                        {item.subtext}
                      </div>
                    </div>
                  </div>

                  {selected && (
                    <div className="h-6 w-6 rounded-full bg-emerald-600 text-white flex items-center justify-center shadow-sm">
                      <Check className="h-4 w-4 stroke-[3]" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Pinned Sticky Footer: Thinking effort & Done button */}
        <div className="pt-3 border-t border-slate-100 dark:border-zinc-800 space-y-3 shrink-0">
          <div className="flex items-center justify-between">
            <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400">
              Thinking effort
            </span>
            {!reasoningSupported && (
              <span className="text-[10px] text-amber-600 dark:text-amber-400 font-mono">
                Not supported by model
              </span>
            )}
          </div>

          <div
            className={`grid grid-cols-3 gap-1 p-1 rounded-2xl bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 ${
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
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "text-slate-600 dark:text-zinc-300 hover:text-slate-900"
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
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "text-slate-600 dark:text-zinc-300 hover:text-slate-900"
              }`}
            >
              {reasoningEffort === "medium" ? (
                <Check className="h-3.5 w-3.5 stroke-[3]" />
              ) : null}
              <span>Balanced</span>
            </button>

            {/* Deep */}
            <button
              type="button"
              disabled={!reasoningSupported}
              onClick={() => handleReasoningChange("xhigh")}
              className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold transition-all ${
                reasoningEffort === "xhigh"
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "text-slate-600 dark:text-zinc-300 hover:text-slate-900"
              }`}
            >
              <Brain className="h-3.5 w-3.5" />
              <span>Deep</span>
            </button>
          </div>

          <p className="text-xs text-slate-500 dark:text-zinc-400 pl-1">
            {effortDescriptions[reasoningEffort]}
          </p>

          {/* Done button */}
          <button
            type="button"
            onClick={onClose}
            className="w-full py-3.5 px-6 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm shadow-md transition-all"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
