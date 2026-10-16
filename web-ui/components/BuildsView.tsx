"use client";

import React, { useState } from "react";
import { Menu, Rocket, CheckCircle2, AlertCircle, StopCircle, Hammer, Cpu, ArrowRight } from "lucide-react";
import { TaskManifest } from "@/lib/subagents/types";
import { LiveRunBlock } from "./LiveRunBlock";

interface BuildsViewProps {
  onOpenDrawer: () => void;
  activeTask: TaskManifest | null;
  onStopTask?: () => Promise<void> | void;
  onSelectThread: (threadId: string) => void;
}

export function BuildsView({
  onOpenDrawer,
  activeTask,
  onStopTask,
  onSelectThread
}: BuildsViewProps) {
  const toolchains = [
    { name: "Node.js 22", tag: "node:22", status: "Active", desc: "TypeScript & Web UI toolchain" },
    { name: "Python 3.11", tag: "python:3.11", status: "Ready", desc: "Scientific & LangGraph engine" },
    { name: "Go 1.22", tag: "golang:1.22", status: "Ready", desc: "Systems & microservice sandbox" },
    { name: "Rust 1.77", tag: "rust:1.77", status: "Ready", desc: "Zero-overhead native sandbox" }
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-white dark:bg-zinc-950 overflow-y-auto">
      <div className="max-w-3xl mx-auto w-full p-4 sm:p-6 space-y-6">
        
        {/* Top Header matching M3 */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-4 shadow-sm border border-slate-100 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onOpenDrawer}
              className="p-1.5 rounded-full text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
              title="Open menu"
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
              Build Tier Ready
            </span>
          </div>
        </div>

        {/* Active Build Run Section */}
        {activeTask ? (
          <div>
            <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
              Active Build
            </h2>
            <LiveRunBlock
              task={activeTask}
              onStopRun={onStopTask}
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
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>test:gate Green</span>
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-zinc-400 mt-1">
                Branch <code className="font-mono bg-slate-100 dark:bg-zinc-800 px-1 py-0.5 rounded text-slate-700 dark:text-zinc-300">{activeTask?.branchName || "feat/task-autonomy-a1"}</code> passed gate · Ready for 1-Click Merge to <code className="font-mono bg-slate-100 dark:bg-zinc-800 px-1 py-0.5 rounded text-slate-700 dark:text-zinc-300">develop</code> &amp; Rollout
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <button
                type="button"
                className="py-1.5 px-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-300 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors"
              >
                Rollback (v1.0.0)
              </button>
              <button
                type="button"
                className="py-1.5 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-xs transition-colors"
              >
                Merge to `develop` & Deploy
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2 border-t border-slate-100 dark:border-zinc-800 text-center">
            <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-850/80 border border-slate-100 dark:border-zinc-800/80">
              <div className="text-xs font-semibold text-slate-800 dark:text-zinc-200">1. Isolated Branch</div>
              <div className="text-[11px] font-mono text-slate-500 dark:text-zinc-400 truncate mt-0.5">{activeTask?.branchName || "feat/task-autonomy-a1"}</div>
            </div>
            <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-850/80 border border-slate-100 dark:border-zinc-800/80">
              <div className="text-xs font-semibold text-slate-800 dark:text-zinc-200">2. Pre-Deploy Gate</div>
              <div className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400 mt-0.5">test:gate Passed</div>
            </div>
            <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-850/80 border border-slate-100 dark:border-zinc-800/80">
              <div className="text-xs font-semibold text-slate-800 dark:text-zinc-200">3. 1-Click Approval</div>
              <div className="text-[11px] font-mono text-slate-500 dark:text-zinc-400 mt-0.5">CEO Sign-off / Auto</div>
            </div>
            <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-850/80 border border-slate-100 dark:border-zinc-800/80">
              <div className="text-xs font-semibold text-slate-800 dark:text-zinc-200">4. K8s Health Check</div>
              <div className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400 mt-0.5">HTTP 200 Verified</div>
            </div>
          </div>
        </div>

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
