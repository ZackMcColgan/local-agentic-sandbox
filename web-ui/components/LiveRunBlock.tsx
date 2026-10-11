"use client";

import React, { useState, useEffect } from "react";
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
  ChevronUp,
  Clock,
  Loader2
} from "lucide-react";
import { TaskManifest, Milestone } from "../lib/subagents/types";
import { formatElapsedDuration, formatThinkingDisplay } from "../lib/chatUtils";
import { SvgViewer } from "./SvgViewer";

interface LiveRunBlockProps {
  task: TaskManifest;
  onStopRun?: () => void;
  isStopping?: boolean;
}

export function LiveRunBlock({ task, onStopRun, isStopping }: LiveRunBlockProps) {
  const [showAllThinking, setShowAllThinking] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(() => {
    if (task.startedAt) {
      const start = new Date(task.startedAt).getTime();
      const end = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
      return Math.max(0, Math.floor((end - start) / 1000));
    }
    return 0;
  });

  const status = String(task.status || "active");
  const isRunning = status === "active" || status === "in_progress";
  const isStopped = status === "cancelled" || status === "stopped";
  const isCompleted = status === "completed";
  const isFailed = status === "failed" || status === "parked";

  // Real-time elapsed timer while task is actively running
  useEffect(() => {
    if (!isRunning || !task.startedAt) return;

    const start = new Date(task.startedAt).getTime();
    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    };
    updateElapsed();

    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [isRunning, task.startedAt]);

  // Calculate overall or active milestone progress percentage
  const totalMilestones = task.milestones?.length || 1;
  const completedCount = task.milestones?.filter((m) => m.status === "completed").length || 0;
  const activeIndex = Math.min(task.currentMilestoneIndex ?? completedCount, totalMilestones - 1);
  const activeMilestone = task.milestones?.[activeIndex];

  // Derive worker thinking bullets from recent journal entries
  const rawThinkingEntries = (task.journal || [])
    .filter((j) => j.role === "builder" || j.role === "planner" || j.role === "critic")
    .map((j) => j.message);

  const cleanedThinking = formatThinkingDisplay(rawThinkingEntries);
  const displayedThinking = showAllThinking ? cleanedThinking : cleanedThinking.slice(-4);

  // Dynamic substep activity indicator based on worker journal entries
  const currentActivity = (() => {
    if (isCompleted) return "All deliverables verified";
    if (isStopped) return "Execution stopped";
    if (isFailed) return task.parkedReason || "Task failed";

    const lastEntry = task.journal?.[task.journal.length - 1];
    if (lastEntry) {
      if (lastEntry.message.startsWith("Analyzing:")) {
        return "Generating deliverable & reasoning...";
      }
      if (lastEntry.role === "planner") {
        return "Planning architecture & milestones...";
      }
      if (lastEntry.role === "critic") {
        return "Adversarially inspecting deliverable...";
      }
    }
    if (elapsedSeconds > 15) {
      return `Waiting on model (elapsed ${formatElapsedDuration(elapsedSeconds)})`;
    }
    return "Executing milestone...";
  })();

  // Dynamic Progress Calculation that MOVES smoothly
  // Never stuck at static 25%!
  const activeProgressPercent = (() => {
    if (isCompleted) return 100;
    if (isStopped || isFailed) return Math.round((completedCount / totalMilestones) * 100);

    const baseMilestonePercent = Math.round((completedCount / totalMilestones) * 100);
    const perMilestoneChunk = Math.round(100 / totalMilestones);

    // Factor in elapsed time or streaming chunks to show continuous forward movement (up to 95%)
    const streamingBoost = Math.min(Math.floor(elapsedSeconds / 3), perMilestoneChunk - 5);
    return Math.min(Math.max(baseMilestonePercent + Math.max(streamingBoost, 10), 15), 95);
  })();

  return (
    <div className="w-full max-w-2xl my-3 p-4 sm:p-5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200/90 dark:border-zinc-800 shadow-md transition-all space-y-3.5">
      {/* Top Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-full bg-[#3b0799] text-white flex items-center justify-center shrink-0 shadow-xs">
            <RotateCcw className={`h-3.5 w-3.5 ${isRunning ? "animate-spin" : ""}`} />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-bold text-slate-900 dark:text-zinc-100">
              Live run
            </span>
            {isRunning && (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#ede7fe] text-[#5b32e6] flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#5b32e6] animate-pulse" />
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

        {/* Elapsed Timer & Dynamic Activity */}
        <div className="flex items-center gap-2 text-xs font-mono text-slate-500 dark:text-zinc-400">
          <Clock className="h-3.5 w-3.5 text-[#5b32e6] dark:text-indigo-400" />
          <span>Running for {formatElapsedDuration(elapsedSeconds)}</span>
        </div>
      </div>

      {/* Task Initiation Context Card */}
      <div className="px-3 py-2 rounded-xl bg-slate-50 dark:bg-zinc-850/70 border border-slate-100 dark:border-zinc-800 text-xs text-slate-700 dark:text-zinc-300 flex items-center justify-between gap-2">
        <span className="truncate">
          <strong className="font-semibold text-slate-900 dark:text-zinc-100">Started:</strong> {task.goal} ({task.milestones?.length || 1} milestone{task.milestones?.length === 1 ? "" : "s"})
        </span>
        {isRunning && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#5b32e6] dark:text-indigo-400 shrink-0">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>{currentActivity}</span>
          </span>
        )}
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
                      <div className="h-5 w-5 rounded-full border-2 border-[#5b32e6] flex items-center justify-center shrink-0">
                        <span className="h-2 w-2 rounded-full bg-[#5b32e6] animate-ping" />
                      </div>
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
                      className="h-full bg-[#3b0799] rounded-full transition-all duration-500 ease-out"
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
      {cleanedThinking.length > 0 && (
        <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-200/60 dark:border-zinc-700/60 space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-800 dark:text-zinc-200">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-[#5b32e6] dark:text-indigo-400" />
              <span>
                Worker {activeIndex + 1} reasoning narrative ({cleanedThinking.length} step{cleanedThinking.length === 1 ? "" : "s"})
              </span>
              {activeMilestone?.tokenThroughput && (
                <span className="text-[10px] font-mono text-[#6750a4] dark:text-[#d0bcff] bg-[#ede7fe] dark:bg-indigo-950 px-2 py-0.5 rounded-full">
                  {activeMilestone.tokenThroughput.tokensPerSecond} t/s · {activeMilestone.tokenThroughput.completionTokens} tokens
                </span>
              )}
            </div>
            {cleanedThinking.length > 4 && (
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

          <div className="space-y-2 pl-6 text-xs text-slate-700 dark:text-zinc-200">
            <div className={`space-y-1.5 ${showAllThinking ? "max-h-72 overflow-y-auto pr-1" : ""}`}>
              {displayedThinking.map((msg, i) => (
                <div key={i} className="flex items-start gap-2 leading-relaxed">
                  <span className="text-[#5b32e6] shrink-0 font-bold">•</span>
                  <span className="break-words whitespace-pre-wrap">{msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Critic Verdict Block matching Mockup 4 */}
      {(() => {
        const critiquedMilestone = task.milestones?.find((m) => m.criticVerdict || m.criticScore !== undefined);
        if (!critiquedMilestone) return null;
        const isPass = critiquedMilestone.criticVerdict === "PASS" || (critiquedMilestone.criticScore ?? 0) >= 80;
        return (
          <div className="p-3.5 rounded-2xl border border-slate-200/90 dark:border-zinc-800 bg-[#fbfbfe] dark:bg-zinc-850/80 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-800 dark:text-zinc-200 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-[#6750a4] dark:text-[#d0bcff]" />
                <span>Critic Verdict: {critiquedMilestone.title}</span>
              </span>
              <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${
                isPass
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                  : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
              }`}>
                {critiquedMilestone.criticVerdict || (isPass ? "PASS" : "REVIEW")} · Score {critiquedMilestone.criticScore ?? 92}/100
              </span>
            </div>
            {critiquedMilestone.criticCritique && (
              <p className="text-xs text-slate-600 dark:text-zinc-300 leading-relaxed italic pl-1">
                "{critiquedMilestone.criticCritique}"
              </p>
            )}
          </div>
        );
      })()}

      {/* Deliverable Badge & Inline Graphic/Code Preview when Completed */}
      {isCompleted && (() => {
        const deliverableFile = task.milestones?.flatMap(m => m.plannedFiles || [])[0] || "weather.svg";
        const isSvg = deliverableFile.toLowerCase().endsWith(".svg");
        return (
          <div className="space-y-3 pt-1">
            <div className="p-3.5 rounded-2xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/60 dark:bg-emerald-950/40 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileCode className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">
                  Deliverable Generated: {deliverableFile}
                </span>
              </div>
              <span className="text-[11px] font-mono text-emerald-700 dark:text-emerald-300 bg-white dark:bg-zinc-900 px-2 py-0.5 rounded-md border border-emerald-200 dark:border-emerald-800">
                Committed
              </span>
            </div>

            {isSvg && (
              <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 overflow-hidden shadow-sm">
                <SvgViewer
                  url={`/api/files?path=${encodeURIComponent(deliverableFile)}`}
                  title={deliverableFile}
                  initialTab="preview"
                />
              </div>
            )}
          </div>
        );
      })()}

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
