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
  onReasoningChange: (effort: "low" | "medium" | "xhigh") => void;
  installedModels?: string[];
}

export function ModelBottomSheet({
  isOpen,
  onClose,
  selectedModel,
  onModelChange,
  reasoningEffort,
  onReasoningChange,
  installedModels = []
}: ModelBottomSheetProps) {
  if (!isOpen) return null;

  const reasoningSupported = isReasoningEffortSupported(selectedModel);

  const effortDescriptions: Record<"low" | "medium" | "xhigh", string> = {
    low: "Fast — minimal latency, low reasoning.",
    medium: "Balanced — good default for most tasks.",
    xhigh: "Deep — maximum chain-of-thought exploration."
  };

  const modelsList = [
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

  // If there are other installed models, add them dynamically
  for (const m of installedModels) {
    if (!modelsList.some((item) => item.id === m || item.displayName === m)) {
      modelsList.push({
        id: m,
        displayName: m,
        subtext: "Installed Ollama model",
        icon: "cpu"
      });
    }
  }

  const isModelSelected = (id: string, displayName: string) => {
    return selectedModel === id || selectedModel === displayName;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl border border-slate-200 dark:border-zinc-800 animate-in slide-in-from-bottom duration-250 flex flex-col gap-5 max-h-[90vh] overflow-y-auto"
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

        {/* Model section */}
        <div className="space-y-2.5">
          <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400">
            Model
          </span>

          <div className="space-y-2">
            {modelsList.map((item) => {
              const selected = isModelSelected(item.id, item.displayName);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onModelChange(item.id)}
                  className={`w-full flex items-center justify-between p-3.5 rounded-2xl transition-all text-left ${
                    selected
                      ? "bg-[#f3efff] dark:bg-indigo-950/50 border-2 border-[#5b32e6]/50 dark:border-indigo-500/50 shadow-sm"
                      : "bg-slate-50 dark:bg-zinc-850 border border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`p-2.5 rounded-full flex items-center justify-center ${
                        selected
                          ? "bg-[#e5d9ff] dark:bg-indigo-900/60 text-[#5b32e6] dark:text-indigo-300"
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
                    <div className="h-6 w-6 rounded-full bg-[#5b32e6] text-white flex items-center justify-center shadow-sm">
                      <Check className="h-4 w-4 stroke-[3]" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Thinking effort section */}
        <div className="space-y-2.5">
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
              onClick={() => onReasoningChange("low")}
              className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold transition-all ${
                reasoningEffort === "low"
                  ? "bg-[#5b32e6] text-white shadow-sm"
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
              onClick={() => onReasoningChange("medium")}
              className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold transition-all ${
                reasoningEffort === "medium"
                  ? "bg-[#5b32e6] text-white shadow-sm"
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
              onClick={() => onReasoningChange("xhigh")}
              className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold transition-all ${
                reasoningEffort === "xhigh"
                  ? "bg-[#5b32e6] text-white shadow-sm"
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
        </div>

        {/* Done button */}
        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full py-3.5 px-6 rounded-full bg-[#5b32e6] hover:bg-[#4d28cc] text-white font-semibold text-sm shadow-md transition-all"
        >
          Done
        </button>
      </div>
    </div>
  );
}
