"use client";

import React, { useState, useEffect } from "react";
import { Menu, Rocket, CheckCircle2, AlertCircle, StopCircle, Hammer, Cpu, ArrowRight, FolderGit2, GitBranch, Clock, Loader2 } from "lucide-react";
import { TaskManifest } from "@/lib/subagents/types";
import { LiveRunBlock } from "./LiveRunBlock";

interface BuildsViewProps {
  onOpenDrawer: () => void;
  activeTask: TaskManifest | null;
  tasks?: TaskManifest[];
  onStopTask?: () => Promise<void> | void;
  onSelectThread: (threadId: string) => void;
  onDeployRun?: (taskId: string) => Promise<void> | void;
  onNavigateToProjects?: () => void;
}

export function BuildsView({
  onOpenDrawer,
  activeTask,
  tasks,
  onStopTask,
  onSelectThread,
  onDeployRun,
  onNavigateToProjects
}: BuildsViewProps) {
  const [internalTasks, setInternalTasks] = useState<TaskManifest[]>([]);

  useEffect(() => {
    if (tasks && tasks.length > 0) {
      setInternalTasks(tasks);
      return;
    }
    let mounted = true;
    fetch("/api/tasks")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (mounted && data?.tasks) {
          setInternalTasks(data.tasks);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [tasks]);

  const displayedTasks = tasks && tasks.length > 0 ? tasks : internalTasks;
  const pipelineTask = activeTask || displayedTasks[0] || null;
  const toolchains = [
    { name: "Node.js 22", tag: "node:22", status: "Active", desc: "TypeScript & Web UI toolchain" },
    { name: "Python 3.11", tag: "python:3.11", status: "Ready", desc: "Scientific & LangGraph engine" },
    { name: "Go 1.22", tag: "golang:1.22", status: "Ready", desc: "Systems & microservice sandbox" },
    { name: "Rust 1.77", tag: "rust:1.77", status: "Ready", desc: "Zero-overhead native sandbox" }
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-white dark:bg-black overflow-y-auto">
      <div className="max-w-3xl mx-auto w-full p-4 sm:p-6 space-y-6">
        
        {/* Top Header matching M3 */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-4 shadow-sm border border-slate-100 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              data-testid="builds-menu-btn"
              type="button"
              onClick={onOpenDrawer}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-full text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
              title="Open menu"
              aria-label="Open navigation menu"
            >
              <Menu className="h-6 w-6" />
            </button>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
              Builds
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="hidden sm:inline">Build Tier </span>Ready
            </span>
          </div>
        </div>

        {/* Sub-Navigation: Builds Pipeline vs Projects & Folders */}
        {onNavigateToProjects && (
          <div className="flex items-center gap-2 px-1">
            <span className="text-xs font-bold text-emerald-800 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950/80 px-3 py-1.5 rounded-xl border border-emerald-300/60 dark:border-emerald-800">
              Builds Pipeline
            </span>
            <button
              type="button"
              onClick={onNavigateToProjects}
              className="min-h-[44px] text-xs font-semibold text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100 hover:bg-slate-100 dark:hover:bg-zinc-800 px-3 py-1.5 rounded-xl transition-colors flex items-center gap-1.5"
            >
              <FolderGit2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>Projects &amp; Folders</span>
            </button>
          </div>
        )}

        {/* Active Build Run Section */}
        {activeTask ? (
          <div>
            <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
              Active Build
            </h2>
            <LiveRunBlock
              task={activeTask}
              onStopRun={onStopTask}
              onDeployRun={onDeployRun}
            />
          </div>
        ) : (
          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-sm border border-slate-100 dark:border-zinc-800 text-center space-y-2">
            <div className="h-12 w-12 rounded-2xl bg-slate-100 dark:bg-zinc-800 flex items-center justify-center mx-auto text-slate-400">
              <Rocket className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
              No builds currently running
            </h3>
            <p className="text-xs text-slate-500 dark:text-zinc-400 max-w-sm mx-auto">
              Start an engineering task or request a multi-milestone builder run from any session.
            </p>
          </div>
        )}

        {/* Self-Deploy Pipeline Section matching Mockup 04 */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 sm:p-6 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-base sm:text-lg text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                  <Rocket className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                  <span>Self-Deploy Pipeline (SelfDeployPipeline)</span>
                </span>
                {pipelineTask?.testSummary ? (
                  <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                    pipelineTask.testSummary.failed === 0
                      ? "bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                      : "bg-rose-100 dark:bg-rose-950/60 text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800"
                  }`}>
                    {pipelineTask.testSummary.failed === 0 ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                    <span>{pipelineTask.testSummary.failed === 0 ? "Gate Passed" : "Gate Failed"}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700">
                    <span>Gate Pending</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-zinc-400 mt-1">
                {pipelineTask ? (
                  <span>
                    Branch <code className="font-mono bg-slate-100 dark:bg-zinc-800 px-1 py-0.5 rounded text-slate-700 dark:text-zinc-300">{pipelineTask.branchName || "feat/task"}</code> ({pipelineTask.status}) · Ready for 1-Click Merge &amp; Rollout
                  </span>
                ) : (
                  <span>No active branch undergoing deployment.</span>
                )}
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <button
                type="button"
                className="py-1.5 px-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-300 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors"
              >
                Rollback (Previous)
              </button>
              <button
                type="button"
                data-testid="merge-deploy-btn"
                disabled={!activeTask || !onDeployRun}
                onClick={() => onDeployRun && activeTask && onDeployRun(activeTask.taskId)}
                className="py-1.5 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold shadow-xs transition-colors"
              >
                Merge to develop & Deploy
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2 border-t border-slate-100 dark:border-zinc-800 text-center">
            <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-850/80 border border-slate-100 dark:border-zinc-800/80">
              <div className="text-xs font-semibold text-slate-800 dark:text-zinc-200">1. Isolated Branch</div>
              <div className="text-[11px] font-mono text-slate-500 dark:text-zinc-400 truncate mt-0.5">{activeTask?.branchName || "None"}</div>
            </div>
            <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-850/80 border border-slate-100 dark:border-zinc-800/80">
              <div className="text-xs font-semibold text-slate-800 dark:text-zinc-200">2. Pre-Deploy Gate</div>
              <div className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400 mt-0.5">
                {activeTask?.testSummary ? `${activeTask.testSummary.passed} passed` : "Pending"}
              </div>
            </div>
            <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-850/80 border border-slate-100 dark:border-zinc-800/80">
              <div className="text-xs font-semibold text-slate-800 dark:text-zinc-200">3. 1-Click Approval</div>
              <div className="text-[11px] font-mono text-slate-500 dark:text-zinc-400 mt-0.5">
                {activeTask?.status === "completed" ? "Ready" : "CEO Sign-off"}
              </div>
            </div>
            <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-850/80 border border-slate-100 dark:border-zinc-800/80">
              <div className="text-xs font-semibold text-slate-800 dark:text-zinc-200">4. K8s Health Check</div>
              <div className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400 mt-0.5">
                {activeTask?.deploymentUrl ? "Verified" : "Not deployed"}
              </div>
            </div>
          </div>
        </div>

        {/* All Builds & Pipeline History Section */}
        {displayedTasks && displayedTasks.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-zinc-100 mb-3 px-1">
              All Builds &amp; Pipeline History
            </h2>
            <div className="space-y-3">
              {displayedTasks.map((t) => {
                const isPlanning = t.status === "planning";
                const isActive = t.status === "active";
                const isCompleted = t.status === "completed";
                const isFailed = t.status === "failed";
                const isParked = t.status === "parked";

                return (
                  <div
                    key={t.taskId}
                    data-testid={`task-row-${t.taskId}`}
                    className="bg-white dark:bg-zinc-900 rounded-3xl p-4 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-2 hover:border-slate-200 dark:hover:border-zinc-700 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                            isPlanning
                              ? "bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
                              : isActive
                              ? "bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                              : isCompleted
                              ? "bg-blue-100 dark:bg-blue-950/60 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
                              : isFailed
                              ? "bg-rose-100 dark:bg-rose-950/60 text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800"
                              : "bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-200 dark:border-zinc-700"
                          }`}
                        >
                          {isPlanning && <Loader2 className="h-3 w-3 animate-spin" />}
                          {isActive && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
                          {isCompleted && <CheckCircle2 className="h-3 w-3" />}
                          {isFailed && <AlertCircle className="h-3 w-3" />}
                          {isParked && <StopCircle className="h-3 w-3" />}
                          <span className="capitalize">{t.status}</span>
                        </span>
                        <span className="text-xs font-mono text-slate-500 dark:text-zinc-400">
                          {t.taskId}
                        </span>
                      </div>

                      {t.threadId && (
                        <button
                          type="button"
                          onClick={() => onSelectThread(t.threadId!)}
                          className="min-h-[44px] text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors"
                        >
                          <span>Open Thread</span>
                          <ArrowRight className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>

                    <p className="text-sm font-medium text-slate-900 dark:text-zinc-100 line-clamp-2">
                      {t.goal}
                    </p>

                    <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-zinc-400 flex-wrap pt-1 border-t border-slate-50 dark:border-zinc-800/60">
                      <div className="flex items-center gap-1">
                        <GitBranch className="h-3.5 w-3.5 text-slate-400" />
                        <span className="font-mono">{t.branchName || t.branch || "feat/task"}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5 text-slate-400" />
                        <span>{new Date(t.updatedAt || t.startedAt).toLocaleTimeString()}</span>
                      </div>
                      {t.milestones && t.milestones.length > 0 && (
                        <div className="flex items-center gap-1">
                          <Hammer className="h-3.5 w-3.5 text-slate-400" />
                          <span>
                            {t.milestones.filter((m) => m.status === "completed").length}/{t.milestones.length} milestones
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Pre-baked Toolchains Section */}
        <div>
          <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
            Sandbox Toolchains
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {toolchains.map((tc) => (
              <div
                key={tc.tag}
                className="bg-white dark:bg-zinc-900 rounded-3xl p-4 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-slate-900 dark:text-zinc-100 text-sm">
                    {tc.name}
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300">
                    {tc.tag}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  {tc.desc}
                </p>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
