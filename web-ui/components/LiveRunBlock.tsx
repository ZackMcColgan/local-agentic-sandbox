"use client";

import React, { useState } from "react";
import {
  RotateCcw,
  Check,
  Circle,
  Square,
  Sparkles,
  Bot,
  FileCode,
  AlertCircle,
  ExternalLink,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import { TaskManifest, Milestone } from "@/lib/subagents/types";

interface LiveRunBlockProps {
  task: TaskManifest;
  onStopRun?: () => void;
  isStopping?: boolean;
}

export function LiveRunBlock({ task, onStopRun, isStopping }: LiveRunBlockProps) {
  const [showAllThinking, setShowAllThinking] = useState(false);
  const status = String(task.status || "active");
  const isRunning = status === "active" || status === "in_progress";
  const isStopped = status === "cancelled" || status === "stopped";
  const isCompleted = status === "completed";
  const isFailed = status === "failed" || status === "parked";

  // Calculate overall or active milestone progress percentage
  const totalMilestones = task.milestones?.length || 1;
  const completedCount = task.milestones?.filter((m) => m.status === "completed").length || 0;
  const activeIndex = Math.min(task.currentMilestoneIndex ?? completedCount, totalMilestones - 1);
  const activeMilestone = task.milestones?.[activeIndex];

  // Derive percent: (completed / total) * 100 or smooth progress
  const basePercent = Math.round((completedCount / totalMilestones) * 100);
  const activeProgressPercent = isCompleted ? 100 : (isRunning ? Math.min(Math.max(basePercent + 20, 25), 90) : basePercent);

  // Derive worker thinking bullets from recent journal entries
  const thinkingEntries = (task.journal || [])
    .filter((j) => j.role === "builder" || j.role === "planner" || j.role === "critic")
    .map((j) => j.message);

  const displayedThinking = showAllThinking ? thinkingEntries : thinkingEntries.slice(-4);

  return (
    <div className="w-full max-w-2xl my-3 p-4 sm:p-5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200/90 dark:border-zinc-800 shadow-md transition-all space-y-3.5">
      {/* Top Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-full bg-[#3b0799] text-white flex items-center justify-center shrink-0 shadow-xs">
            <RotateCcw className={`h-3.5 w-3.5 ${isRunning ? "animate-spin" : ""}`} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-base font-bold text-slate-900 dark:text-zinc-100">
              Live run
            </span>
            {isRunning && (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#ede7fe] text-[#5b32e6] flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#5b32e6]" />
                <span>Running</span>
              </span>
            )}
            {isStopped && (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300">
                • Stopped
              </span>
            )}
            {isCompleted && (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">
                • Completed
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Milestone Checklist */}
      <div className="space-y-2.5">
        <div className="inline-block px-2 py-0.5 rounded bg-[#f3f4f8] dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 font-semibold text-xs">
          Milestone checklist
        </div>

        <div className="space-y-3">
          {task.milestones?.map((m: Milestone, idx: number) => {
            const isMilestoneCompleted = (m.status as string) === "completed";
            const isMilestoneActive = isRunning && ((m.status as string) === "in_progress" || (m.status as string) === "active" || idx === activeIndex);
            const isMilestonePending = !isMilestoneCompleted && !isMilestoneActive;

            return (
              <div key={m.id || idx} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    {isMilestoneCompleted ? (
                      <div className="h-5 w-5 rounded-full bg-[#3b0799] text-white flex items-center justify-center shrink-0 shadow-xs">
                        <Check className="h-3.5 w-3.5 stroke-[3]" />
                      </div>
                    ) : isMilestoneActive ? (
                      <div className="h-5 w-5 rounded-full border-2 border-[#5b32e6] shrink-0" />
                    ) : (
                      <div className="h-5 w-5 rounded-full border-2 border-slate-300 dark:border-zinc-700 shrink-0" />
                    )}

                    <span
                      className={`text-xs sm:text-sm truncate ${
                        isMilestoneCompleted
                          ? "font-medium text-slate-800 dark:text-zinc-200"
                          : isMilestoneActive
                          ? "font-semibold text-slate-900 dark:text-zinc-100"
                          : "text-slate-600 dark:text-zinc-400"
                      }`}
                    >
                      {m.title}
                    </span>
                  </div>

                  {isMilestoneActive && (
                    <span className="text-xs font-semibold text-[#5b32e6] dark:text-indigo-400 shrink-0">
                      {activeProgressPercent}%
                    </span>
                  )}
                </div>

                {isMilestoneActive && (
                  <div className="w-full h-1.5 bg-[#e9ecf4] dark:bg-zinc-800 rounded-full overflow-hidden ml-7.5">
                    <div
                      className="h-full bg-[#3b0799] rounded-full transition-all duration-300"
                      style={{ width: `${activeProgressPercent}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Worker Thinking Section */}
      {thinkingEntries.length > 0 && (
        <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-200/60 dark:border-zinc-700/60 space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-800 dark:text-zinc-200">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-[#5b32e6] dark:text-indigo-400" />
              <span>
                Worker {activeIndex + 1} thinking
              </span>
            </div>
            {thinkingEntries.length > 4 && (
              <button
                type="button"
                onClick={() => setShowAllThinking(!showAllThinking)}
                className="text-[11px] text-[#5b32e6] dark:text-indigo-400 hover:underline flex items-center gap-0.5"
              >
                <span>{showAllThinking ? "Less" : "All"}</span>
                {showAllThinking ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
            )}
          </div>

          <div className="space-y-1.5 pl-6 text-xs text-slate-600 dark:text-zinc-300">
            {displayedThinking.map((msg, i) => (
              <div key={i} className="flex items-start gap-1.5 leading-relaxed">
                <span className="text-[#5b32e6] shrink-0">•</span>
                <span>{msg}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stop Run Button (Prominent Filled-Tonal M3 Button) */}
      {isRunning && onStopRun && (
        <button
          type="button"
          onClick={onStopRun}
          disabled={isStopping}
          className="w-full py-2.5 px-4 rounded-xl bg-[#ede7fe] hover:bg-[#e0d6fd] dark:bg-indigo-950 dark:hover:bg-indigo-900 text-[#5b32e6] dark:text-indigo-300 font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all shadow-xs disabled:opacity-50"
        >
          <Square className="h-3.5 w-3.5 stroke-[2.5] fill-none" />
          <span>{isStopping ? "Stopping run..." : "Stop run"}</span>
        </button>
      )}

      {isStopped && (
        <div className="text-center py-1 text-xs font-medium text-slate-500 dark:text-zinc-400">
          Run stopped · Workers halted &amp; VRAM released.
        </div>
      )}
    </div>
  );
}
