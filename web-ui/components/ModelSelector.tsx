"use client";

import React from "react";
import { Sparkles, Zap, Brain } from "lucide-react";
import { AgentMode } from "@/config/models";

interface ModelSelectorProps {
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  className?: string;
}

export function ModelSelector({ mode, onModeChange, className = "" }: ModelSelectorProps) {
  return (
    <div
      className={`flex items-center bg-slate-100 dark:bg-zinc-900 p-0.5 sm:p-1 rounded-xl border border-slate-200 dark:border-zinc-800 shadow-inner ${className}`}
      role="radiogroup"
      aria-label="Agent Execution Mode"
    >
      {/* Auto Mode: Hierarchical Triage (~80 tok/s Flash -> Pro Escalation) */}
      <button
        type="button"
        role="radio"
        aria-checked={mode === "auto"}
        onClick={() => onModeChange("auto")}
        className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 sm:py-1.5 rounded-lg text-xs font-medium transition-all ${
          mode === "auto"
            ? "bg-gradient-to-r from-purple-500/15 to-indigo-500/15 dark:from-purple-500/25 dark:to-indigo-500/25 text-purple-700 dark:text-purple-300 border border-purple-300 dark:border-purple-500/40 shadow-xs"
            : "text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100"
        }`}
        title="Auto Mode: Fast Flash triage & execution with auto-escalation to Pro on complex tasks or test failures"
      >
        <Sparkles className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-purple-500 shrink-0" />
        <span className="font-semibold">Auto</span>
      </button>

      {/* Flash Mode: Gemma 4 (~80 tok/s natively multimodal) */}
      <button
        type="button"
        role="radio"
        aria-checked={mode === "flash"}
        onClick={() => onModeChange("flash")}
        className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 sm:py-1.5 rounded-lg text-xs font-medium transition-all ${
          mode === "flash"
            ? "bg-amber-50 dark:bg-amber-950/70 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-500/40 shadow-xs"
            : "text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100"
        }`}
        title="Flash Mode: Ultra-fast execution via Gemma 4 E4B (~80 tok/s) with multimodal diagram ingestion"
      >
        <Zap className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-amber-500 shrink-0" />
        <span className="font-semibold">Flash</span>
        <span className="hidden md:inline text-[9px] text-amber-600 dark:text-amber-400 font-mono">~80 t/s</span>
      </button>

      {/* Pro Mode: Deep reasoning (Qwen 3.8 27B / Hermes 3 70B) */}
      <button
        type="button"
        role="radio"
        aria-checked={mode === "pro"}
        onClick={() => onModeChange("pro")}
        className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 sm:py-1.5 rounded-lg text-xs font-medium transition-all ${
          mode === "pro"
            ? "bg-sky-50 dark:bg-sky-950/70 text-sky-700 dark:text-sky-300 border border-sky-300 dark:border-sky-500/40 shadow-xs"
            : "text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100"
        }`}
        title="Pro Mode: Deep reasoning and full multi-file architectural synthesis via Qwen 3.8 27B"
      >
        <Brain className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-sky-500 shrink-0" />
        <span className="font-semibold">Pro</span>
      </button>
    </div>
  );
}
