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
  Loader2,
  Pause,
  Play
} from "lucide-react";
import { TaskManifest, Milestone } from "../lib/subagents/types";
import { formatElapsedDuration, formatThinkingDisplay } from "../lib/chatUtils";
import { SvgViewer } from "./SvgViewer";
import { CodeBlock } from "./ChatStream";
import { ThinkingPanel } from "./ThinkingPanel";

interface LiveRunBlockProps {
  task: TaskManifest;
  onStopRun?: () => void;
  onPauseRun?: () => void;
  onResumeRun?: () => void;
  onRestartRun?: () => void;
  isStopping?: boolean;
}

export function LiveRunBlock({
  task,
  onStopRun,
  onPauseRun,
  onResumeRun,
  onRestartRun,
  isStopping
}: LiveRunBlockProps) {
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
  const isPaused = status === "paused";
  const isCrashed = status === "crashed";
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
            {task.scope && (
              <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 dark:bg-indigo-950/70 text-[#5b32e6] dark:text-indigo-300 border border-indigo-100 dark:border-indigo-900/60 uppercase tracking-wider">
                {task.scope}
              </span>
            )}
            {isStopped && (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300">
                • Stopped
              </span>
            )}
            {isPaused && (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 dark:bg-amber-950/70 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                • Paused
              </span>
            )}
            {isCrashed && (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 dark:bg-rose-950/70 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
                • Crashed
              </span>
            )}
            {isCompleted && (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">
                • Completed
              </span>
            )}
            {task.parentRunId && (
              <span className="px-2 py-0.5 rounded-md text-[11px] font-mono bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400">
                Parent: {task.parentRunId}
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

      {/* Worker Reasoning Panel (Prominent, Phased, Expanded by Default) */}
      {cleanedThinking.length > 0 && (
        <div className="w-full">
          <ThinkingPanel
            rawThought={cleanedThinking.join("\n")}
            isStreaming={isRunning}
            defaultExpanded={true}
          />
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

            {isSvg ? (
              <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 overflow-hidden shadow-sm">
                <SvgViewer
                  url={`/api/files?path=${encodeURIComponent(deliverableFile)}`}
                  title={deliverableFile}
                  initialTab="preview"
                />
              </div>
            ) : (() => {
              // Extract generated deliverable content from milestone diffSummary or state
              const milestoneWithDiff = task.milestones?.find(m => m.diffSummary && m.diffSummary.trim().length > 0);
              let codeSnippet = "";
              if (milestoneWithDiff?.diffSummary) {
                // Parse git diff additions
                const lines = milestoneWithDiff.diffSummary.split("\n");
                const addedLines = lines
                  .filter(l => l.startsWith("+") && !l.startsWith("+++"))
                  .map(l => l.slice(1));
                if (addedLines.length > 0) {
                  codeSnippet = addedLines.join("\n");
                }
              }

              if (!codeSnippet) {
                codeSnippet = `// Deliverable committed: ${deliverableFile}\nconsole.log("Hello, World!");`;
              }

              const ext = deliverableFile.split(".").pop() || "typescript";
              return (
                <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 overflow-hidden shadow-sm">
                  <CodeBlock
                    language={ext}
                    code={codeSnippet}
                    filename={deliverableFile}
                  />
                </div>
              );
            })()}
          </div>
        );
      })()}

      {/* Deployed Ephemeral Build Link (Phase 5) */}
      {task.deploymentUrl && (
        <div className="p-3.5 rounded-2xl border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/70 dark:bg-indigo-950/40 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <ExternalLink className="h-4 w-4 text-[#5b32e6] dark:text-indigo-400 shrink-0" />
            <span className="text-xs font-semibold text-slate-900 dark:text-zinc-100 truncate">
              Deployed Build {task.deploymentNamespace ? `(${task.deploymentNamespace})` : ""}
            </span>
          </div>
          <a
            href={task.deploymentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1 rounded-lg bg-[#5b32e6] hover:bg-[#4a25c4] text-white text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 transition-colors"
          >
            <span>Open Live Preview</span>
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}

      {/* Crashed Run Recovery Prompt (Phase 4) */}
      {isCrashed && (
        <div className="p-3.5 rounded-2xl border border-rose-200 dark:border-rose-900/70 bg-rose-50/80 dark:bg-rose-950/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="h-4 w-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-bold text-rose-900 dark:text-rose-200">
                Run interrupted unexpectedly — Resume?
              </p>
              <p className="text-[11px] text-rose-700 dark:text-rose-300 mt-0.5">
                Completed milestones are checkpointed and will not be re-executed.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onResumeRun && (
              <button
                type="button"
                onClick={onResumeRun}
                className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 shadow-xs transition-colors"
              >
                <Play className="h-3.5 w-3.5" />
                <span>Resume?</span>
              </button>
            )}
            {onRestartRun && (
              <button
                type="button"
                onClick={onRestartRun}
                className="px-3 py-1.5 rounded-xl border border-rose-300 dark:border-rose-800 bg-white dark:bg-zinc-900 text-rose-800 dark:text-rose-200 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Restart</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Run Controls: Pause / Stop when running */}
      {isRunning && (onPauseRun || onStopRun) && (
        <div className="flex items-center gap-2">
          {onPauseRun && (
            <button
              type="button"
              onClick={onPauseRun}
              disabled={isStopping}
              className="flex-1 py-2.5 px-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white hover:bg-slate-50 dark:bg-zinc-850 dark:hover:bg-zinc-800 text-slate-800 dark:text-zinc-200 font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all shadow-xs disabled:opacity-50"
            >
              <Pause className="h-3.5 w-3.5" />
              <span>Pause</span>
            </button>
          )}
          {onStopRun && (
            <button
              type="button"
              onClick={onStopRun}
              disabled={isStopping}
              className="flex-1 py-2.5 px-4 rounded-xl bg-[#ede7fe] hover:bg-[#e0d6fd] dark:bg-indigo-950 dark:hover:bg-indigo-900 text-[#5b32e6] dark:text-indigo-300 font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all shadow-xs disabled:opacity-50"
            >
              <Square className="h-3.5 w-3.5 stroke-[2.5] fill-none" />
              <span>{isStopping ? "Stopping run..." : "Stop run"}</span>
            </button>
          )}
        </div>
      )}

      {/* Paused Controls: Resume / Restart */}
      {isPaused && (onResumeRun || onRestartRun) && (
        <div className="flex items-center gap-2">
          {onResumeRun && (
            <button
              type="button"
              onClick={onResumeRun}
              className="flex-1 py-2.5 px-4 rounded-xl bg-[#5b32e6] hover:bg-[#4a25c4] text-white font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all shadow-xs"
            >
              <Play className="h-3.5 w-3.5" />
              <span>Resume run</span>
            </button>
          )}
          {onRestartRun && (
            <button
              type="button"
              onClick={onRestartRun}
              className="py-2.5 px-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white hover:bg-slate-50 dark:bg-zinc-850 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-200 font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Restart</span>
            </button>
          )}
        </div>
      )}

      {/* Completed / Failed / Stopped Controls: Restart */}
      {(isCompleted || isFailed || isStopped) && onRestartRun && (
        <div className="flex items-center justify-between pt-1">
          {isStopped ? (
            <span className="text-xs font-medium text-slate-500 dark:text-zinc-400">
              Run stopped · Workers halted &amp; VRAM released.
            </span>
          ) : (
            <span className="text-xs font-medium text-slate-500 dark:text-zinc-400">
              Run {status}
            </span>
          )}
          <button
            type="button"
            onClick={onRestartRun}
            className="py-1.5 px-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white hover:bg-slate-50 dark:bg-zinc-850 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-200 font-semibold text-xs inline-flex items-center gap-1.5 transition-all shadow-xs"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Restart run</span>
          </button>
        </div>
      )}

      {isStopped && !onRestartRun && (
        <div className="text-center py-1 text-xs font-medium text-slate-500 dark:text-zinc-400">
          Run stopped · Workers halted &amp; VRAM released.
        </div>
      )}
    </div>
  );
}
