"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  ChevronDown,
  ChevronUp,
  Map,
  Cog,
  CheckCircle2,
  Sparkles
} from "lucide-react";

export type ThinkingPhaseKey = "planning" | "building" | "validating";

export interface ThinkingPhaseCardData {
  phase: ThinkingPhaseKey;
  title: string;
  timestamp: string;
  timeAgo?: string;
  narrative: string;
  status: "complete" | "in_progress" | "pending";
  progressPercent: number;
}

interface ThinkingPanelProps {
  phases?: ThinkingPhaseCardData[];
  rawThought?: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  onToggleExpand?: () => void;
  className?: string;
}

export function ThinkingPanel({
  phases = [],
  rawThought = "",
  isStreaming = false,
  defaultExpanded = true,
  className = ""
}: ThinkingPanelProps) {
  const [isExpanded, setIsExpanded] = useState<boolean>(defaultExpanded);
  const prevStreamingRef = useRef(isStreaming);
  const userToggledRef = useRef(false);

  // Auto-collapse when generation finishes unless the user manually toggled it
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      if (!userToggledRef.current) {
        setIsExpanded(false);
      }
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const handleToggle = () => {
    userToggledRef.current = true;
    setIsExpanded((prev) => !prev);
  };

  const formattedTime = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const effectivePhases: ThinkingPhaseCardData[] = (() => {
    if (phases && phases.length > 0) return phases;

    if (rawThought && rawThought.trim()) {
      return [
        {
          phase: "planning",
          title: isStreaming ? "Reasoning in progress" : "Reasoning summary",
          timestamp: formattedTime,
          timeAgo: "Now",
          narrative: rawThought.trim(),
          status: isStreaming ? "in_progress" : "complete",
          progressPercent: isStreaming ? 85 : 100
        }
      ];
    }

    // Default 3-phase fallback when neither explicit phases nor raw thought are provided
    return [
      {
        phase: "planning",
        title: "Planning",
        timestamp: formattedTime,
        timeAgo: "Just now",
        narrative: "Broke the task into milestones. Scope evaluated. No unnecessary scaffolding.",
        status: isStreaming ? "in_progress" : "complete",
        progressPercent: isStreaming ? 85 : 100
      },
      {
        phase: "building",
        title: "Building",
        timestamp: formattedTime,
        timeAgo: "Now",
        narrative: "Generating clean deliverable markup and implementation code.",
        status: isStreaming ? "in_progress" : "complete",
        progressPercent: isStreaming ? 75 : 100
      },
      {
        phase: "validating",
        title: "Validating",
        timestamp: formattedTime,
        timeAgo: "Now",
        narrative: "Checking output compiles, adheres to constraints, and passes validation.",
        status: isStreaming ? "in_progress" : "complete",
        progressPercent: isStreaming ? 85 : 100
      }
    ];
  })();

  const activeStepsCount = effectivePhases.length;

  return (
    <div
      data-testid="thinking-panel"
      className={`w-full max-w-2xl rounded-2xl bg-slate-50/90 dark:bg-zinc-900/90 border border-slate-200/80 dark:border-zinc-800 text-slate-800 dark:text-zinc-200 shadow-2xs overflow-hidden transition-all duration-200 ${className}`}
    >
      {/* Compact 1-Line Header Bar */}
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center justify-between px-3.5 py-2.5 text-left group transition-colors hover:bg-slate-100/70 dark:hover:bg-zinc-850/60 focus:outline-none"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="h-3.5 w-3.5 text-[#6750a4] dark:text-[#d0bcff] shrink-0" />
          <span className="text-xs font-semibold text-slate-700 dark:text-zinc-200 truncate">
            Worker reasoning
          </span>
          <span
            data-testid="streaming-badge"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-100/80 dark:bg-purple-950/60 border border-purple-200 dark:border-purple-800/50 text-[#5b32e6] dark:text-indigo-300 shrink-0"
          >
            {isStreaming && <span className="h-1.5 w-1.5 rounded-full bg-[#5b32e6] dark:bg-purple-400 animate-pulse" />}
            <span>
              {isStreaming ? "Streaming" : "Thought process"}
              {" · "}
              {activeStepsCount} {activeStepsCount === 1 ? "step" : "steps"}
            </span>
          </span>
        </div>

        <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-zinc-400 group-hover:text-slate-800 dark:group-hover:text-zinc-200 shrink-0 ml-2">
          <span>{isExpanded ? "Hide" : "Show"}</span>
          {isExpanded ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </div>
      </button>

      {/* Expanded Body */}
      {isExpanded && (
        <div className="p-3 sm:p-3.5 space-y-2.5 border-t border-slate-200/60 dark:border-zinc-800/80 bg-white/60 dark:bg-zinc-950/40">
          {effectivePhases.map((phaseItem) => {
            const isPlanning = phaseItem.phase === "planning";
            const isBuilding = phaseItem.phase === "building";
            const isValidating = phaseItem.phase === "validating";

            const Icon = isPlanning ? Map : isBuilding ? Cog : CheckCircle2;
            const isCompleted = phaseItem.status === "complete";
            const isInProgress = phaseItem.status === "in_progress";

            return (
              <div
                key={phaseItem.phase}
                data-testid={`phase-card-${phaseItem.phase}`}
                className="p-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200/70 dark:border-zinc-800/80 space-y-2 shadow-2xs"
              >
                {/* Card Title & Meta */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-lg bg-purple-50 dark:bg-purple-950/50 text-[#6750a4] dark:text-[#d0bcff] border border-purple-200/50 dark:border-purple-800/40 flex items-center justify-center shrink-0">
                      <Icon className="h-3.5 w-3.5 stroke-[2.2]" />
                    </div>
                    <h4 className="text-xs font-semibold text-slate-800 dark:text-zinc-100 truncate">
                      {phaseItem.title}
                    </h4>
                  </div>

                  <div className="text-right text-[10px] font-mono text-slate-400 dark:text-zinc-500 shrink-0">
                    <span>{phaseItem.timestamp}</span>
                    {phaseItem.timeAgo && <span> • {phaseItem.timeAgo}</span>}
                  </div>
                </div>

                {/* Narrative Text */}
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-zinc-950 border border-slate-100 dark:border-zinc-850/80 text-xs text-slate-600 dark:text-zinc-300 leading-relaxed font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {phaseItem.narrative}
                </div>

                {/* Progress bar */}
                <div className="space-y-1 pt-0.5">
                  <div className="w-full h-1 bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        isCompleted
                          ? "bg-gradient-to-r from-[#6750a4] to-indigo-500"
                          : "bg-[#6750a4]"
                      }`}
                      style={{ width: `${Math.min(Math.max(phaseItem.progressPercent, 5), 100)}%` }}
                    />
                  </div>

                  <div className="flex justify-end text-[10px] font-medium text-slate-400 dark:text-zinc-500">
                    {isCompleted ? (
                      <span className="text-[#6750a4] dark:text-[#d0bcff]">Complete</span>
                    ) : isInProgress ? (
                      <span className="text-[#6750a4] dark:text-[#d0bcff] font-semibold">
                        In progress · {phaseItem.progressPercent}%
                      </span>
                    ) : (
                      <span>Pending</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Footer Status Pill only while isStreaming === true */}
          {isStreaming && (
            <div className="pt-1 flex items-center gap-1.5 text-xs text-[#6750a4] dark:text-[#d0bcff] font-medium">
              <Sparkles className="h-3.5 w-3.5 animate-spin" />
              <span>Reasoning in progress. Formulating structured execution...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
