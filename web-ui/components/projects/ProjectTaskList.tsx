"use client";

import React from "react";
import { Play, Calendar } from "lucide-react";

export interface ProjectTaskListProps {
  projectName: string;
  baseBranch: string;
  activeTaskId?: string | null;
  taskError?: string | null;
  taskSuccess?: string | null;
  onSubmitTask: (prompt: string, mode: "now" | "schedule") => Promise<void>;
}

export function ProjectTaskList({
  projectName,
  baseBranch,
  activeTaskId,
  taskError,
  taskSuccess,
  onSubmitTask,
}: ProjectTaskListProps) {
  const handleAction = async (mode: "now" | "schedule") => {
    const el = document.getElementById("project-task-prompt-input") as HTMLTextAreaElement | null;
    const prompt = el?.value || "";
    if (!prompt.trim()) return;
    try {
      await onSubmitTask(prompt, mode);
      if (el) el.value = "";
    } catch {
      // Error surfaced via taskError state in parent
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      {taskError && (
        <div
          role="alert"
          className="p-3 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300 text-xs"
        >
          {taskError}
        </div>
      )}
      {taskSuccess && (
        <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 text-xs">
          {taskSuccess}
        </div>
      )}
      {/* Active Task Banner if running */}
      {activeTaskId && (
        <div className="p-4 rounded-3xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
              <span className="text-xs font-bold text-emerald-800 dark:text-emerald-300 uppercase tracking-wider">
                Active Overnight Task Running
              </span>
            </div>
            <span className="text-xs font-mono text-emerald-700 dark:text-emerald-400">
              {activeTaskId}
            </span>
          </div>
          <p className="text-xs text-slate-700 dark:text-zinc-300">
            Task execution in progress on branch{" "}
            <code className="font-mono bg-emerald-100 dark:bg-emerald-900/60 px-1 py-0.5 rounded">
              feat/task...
            </code>
          </p>
        </div>
      )}

      {/* Task Composer Form */}
      <div className="bg-slate-50/50 dark:bg-zinc-800/40 rounded-3xl p-5 border border-slate-100 dark:border-zinc-800 space-y-4">
        <div className="flex items-center gap-2">
          <Play className="h-5 w-5 text-emerald-600" />
          <h3 className="text-sm font-bold text-slate-900 dark:text-zinc-100">
            Compose Autonomous Task for {projectName}
          </h3>
        </div>

        <textarea
          rows={3}
          placeholder="Describe what you want the autonomous agent to build overnight (e.g. Implement authentication routes, write tests, refactor database models)..."
          className="w-full px-4 py-3 rounded-2xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-900 dark:text-zinc-100 text-xs sm:text-sm focus:outline-emerald-500 resize-none"
          id="project-task-prompt-input"
        />

        <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
          <div className="text-[11px] text-slate-600 dark:text-zinc-400">
            Target branch: <code className="font-mono">{baseBranch}</code> · Engine:{" "}
            <code className="font-mono">Flash-Next</code>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleAction("schedule")}
              className="min-h-[44px] px-3.5 py-2 rounded-2xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 font-semibold text-xs flex items-center gap-1.5 transition-colors"
            >
              <Calendar className="h-3.5 w-3.5 text-slate-600 dark:text-zinc-400" />
              <span>Schedule 2:00 AM</span>
            </button>

            <button
              type="button"
              onClick={() => handleAction("now")}
              className="min-h-[44px] px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs flex items-center gap-1.5 shadow-xs transition-colors"
            >
              <Play className="h-3.5 w-3.5" />
              <span>Run Overnight Now</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
