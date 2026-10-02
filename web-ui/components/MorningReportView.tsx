"use client";

import React, { useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  GitCommit,
  Clock,
  GitBranch,
  ShieldAlert,
  ArrowUpRight,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  SlidersHorizontal
} from "lucide-react";
import { MorningReport } from "@/lib/subagents/morningReport";
import { AmbiguityFlag } from "@/lib/subagents/types";

interface MorningReportViewProps {
  report: MorningReport;
  onRevertFlag?: (flagId: string) => Promise<void> | void;
  onAdjustFlag?: (flagId: string, newInstruction: string) => Promise<void> | void;
}

export function MorningReportView({
  report,
  onRevertFlag,
  onAdjustFlag
}: MorningReportViewProps) {
  const [flags, setFlags] = useState<AmbiguityFlag[]>(report.ambiguityFlags || []);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [expandedFlagId, setExpandedFlagId] = useState<string | null>(null);
  const [adjustInputs, setAdjustInputs] = useState<Record<string, string>>({});

  const handleRevert = async (flag: AmbiguityFlag) => {
    setRevertingId(flag.id);
    try {
      if (onRevertFlag) {
        await onRevertFlag(flag.id);
      }
      setFlags((prev) =>
        prev.map((f) => (f.id === flag.id ? { ...f, reviewed: true } : f))
      );
    } finally {
      setRevertingId(null);
    }
  };

  const handleAdjustSubmit = async (flagId: string) => {
    const text = adjustInputs[flagId];
    if (!text?.trim()) return;

    if (onAdjustFlag) {
      await onAdjustFlag(flagId, text.trim());
    }
    setFlags((prev) =>
      prev.map((f) => (f.id === flagId ? { ...f, reviewed: true } : f))
    );
    setExpandedFlagId(null);
  };

  const isCompleted = report.status === "completed";
  const isParked = report.status === "parked";

  return (
    <div className="space-y-4 sm:space-y-6 animate-in fade-in duration-200">
      
      {/* 1. Header Card */}
      <div className="p-4 sm:p-5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm transition-colors">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold ${
                  isCompleted
                    ? "bg-emerald-50 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                    : isParked
                    ? "bg-amber-50 dark:bg-amber-950/80 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
                    : "bg-slate-100 dark:bg-zinc-800 text-slate-800 dark:text-zinc-300 border border-slate-200 dark:border-zinc-700"
                }`}
              >
                {isCompleted ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                )}
                <span>{report.status.toUpperCase()}</span>
              </span>

              <span className="text-xs font-mono text-slate-500 dark:text-zinc-400">
                {report.taskId}
              </span>
            </div>

            <h1 className="mt-2 text-base sm:text-lg font-bold text-slate-900 dark:text-zinc-100 tracking-tight">
              {report.goal}
            </h1>
          </div>

          <div className="flex flex-wrap sm:flex-col items-start sm:items-end gap-2 text-xs font-mono text-slate-600 dark:text-zinc-400 shrink-0">
            <div className="flex items-center gap-1.5">
              <GitBranch className="h-3.5 w-3.5 text-indigo-500" />
              <span>{report.branch}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <GitCommit className="h-3.5 w-3.5 text-slate-500" />
              <span>HEAD: {report.gitHeadSha.substring(0, 7)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-emerald-500" />
              <span>{report.durationFormatted}</span>
            </div>
          </div>
        </div>

        {/* Test Summary Highlight Banner */}
        <div className="mt-4 pt-3 border-t border-slate-100 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-4">
            <div>
              <span className="text-slate-500 dark:text-zinc-400">Tests Passed: </span>
              <span className="font-bold text-emerald-600 dark:text-emerald-400">
                {report.totalTestsPassed}
              </span>
            </div>
            <div>
              <span className="text-slate-500 dark:text-zinc-400">Tests Failed: </span>
              <span className={`font-bold ${report.totalTestsFailed > 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-700 dark:text-zinc-300"}`}>
                {report.totalTestsFailed}
              </span>
            </div>
          </div>

          <div className="text-slate-500 dark:text-zinc-400 font-mono text-[11px]">
            Started: {new Date(report.startedAt).toLocaleTimeString()}
          </div>
        </div>
      </div>

      {/* 2. Parked Items Banner (If Any) */}
      {report.parkedItems && report.parkedItems.length > 0 && (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-900 dark:text-amber-200">
          <div className="flex items-center gap-2 font-semibold text-xs tracking-tight">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <span>Parked Items Requiring Zack's Attention</span>
          </div>
          <ul className="mt-2 space-y-1 text-xs">
            {report.parkedItems.map((item, idx) => (
              <li key={idx} className="flex items-start gap-1.5 font-mono text-[11px]">
                <span className="text-amber-600 dark:text-amber-400">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 3. Milestones & Test Verification */}
      <div className="space-y-3">
        <h2 className="text-sm font-bold text-slate-900 dark:text-zinc-100 tracking-tight flex items-center justify-between">
          <span>Milestones & Git Commit Trail</span>
          <span className="text-xs font-normal text-slate-500 dark:text-zinc-400 font-mono">
            {report.milestones.length} milestones
          </span>
        </h2>

        <div className="space-y-2">
          {report.milestones.map((m) => (
            <div
              key={m.id}
              className="p-3.5 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 transition-colors"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-xs font-mono text-slate-900 dark:text-zinc-100">
                    [{m.id}]
                  </span>
                  <span className="text-xs font-medium text-slate-800 dark:text-zinc-200 truncate">
                    {m.title}
                  </span>
                </div>

                {m.diffSummary && (
                  <p className="mt-1 text-[11px] text-slate-600 dark:text-zinc-400 font-mono truncate">
                    {m.diffSummary}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-3 shrink-0 text-xs font-mono">
                {m.commitSha && (
                  <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-200 dark:border-zinc-700 text-[11px]">
                    commit {m.commitSha.substring(0, 7)}
                  </span>
                )}

                <span className="text-emerald-600 dark:text-emerald-400 font-semibold text-[11px]">
                  {m.testsPassed ?? 0} passed
                </span>

                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300">
                  {m.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 4. Ambiguity Flags & One-Tap Actions */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900 dark:text-zinc-100 tracking-tight flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-indigo-500" />
            <span>Ambiguity Flags & Judgment Calls</span>
          </h2>
          <span className="text-xs font-mono text-slate-500 dark:text-zinc-400">
            {flags.length} logged
          </span>
        </div>

        {flags.length === 0 ? (
          <div className="p-4 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-xs text-slate-500 dark:text-zinc-400 text-center">
            Zero ambiguities flagged. The run executed strictly within specification boundaries.
          </div>
        ) : (
          <div className="space-y-3">
            {flags.map((flag) => {
              const isExpanded = expandedFlagId === flag.id;

              return (
                <div
                  key={flag.id}
                  className={`p-3.5 sm:p-4 rounded-xl border bg-white dark:bg-zinc-900 transition-all ${
                    flag.reviewed
                      ? "border-slate-200 dark:border-zinc-800 opacity-80"
                      : "border-indigo-200 dark:border-indigo-900/60 shadow-sm"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 font-semibold">
                          {flag.id} • {flag.milestoneId}
                        </span>
                        {flag.reviewed && (
                          <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                            ✓ Reviewed
                          </span>
                        )}
                      </div>

                      <h3 className="mt-1.5 text-xs font-bold text-slate-900 dark:text-zinc-100">
                        {flag.question}
                      </h3>
                      <p className="mt-1 text-xs text-slate-700 dark:text-zinc-300">
                        <span className="font-semibold text-slate-900 dark:text-zinc-100">Judgment Call: </span>
                        {flag.judgmentCall}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-500 dark:text-zinc-400">
                        <span className="font-semibold">Reasoning: </span>
                        {flag.reasoning}
                      </p>
                    </div>

                    {/* Action Buttons: One-Tap Revert & Adjust */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleRevert(flag)}
                        disabled={revertingId === flag.id}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900/80 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 text-[11px] font-medium transition-all shadow-sm disabled:opacity-50"
                        title="Revert the judgment call commit immediately"
                      >
                        <RotateCcw className={`h-3 w-3 ${revertingId === flag.id ? "animate-spin" : ""}`} />
                        <span>Revert</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setExpandedFlagId(isExpanded ? null : flag.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 text-[11px] font-medium transition-all shadow-sm"
                      >
                        <SlidersHorizontal className="h-3 w-3" />
                        <span>Adjust</span>
                        {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      </button>
                    </div>
                  </div>

                  {/* Inline Adjustment Input Form */}
                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t border-slate-100 dark:border-zinc-800 animate-in fade-in duration-150">
                      <label className="block text-[11px] font-medium text-slate-700 dark:text-zinc-300 mb-1">
                        Provide Morning Guidance / Override:
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={adjustInputs[flag.id] || ""}
                          onChange={(e) =>
                            setAdjustInputs((prev) => ({
                              ...prev,
                              [flag.id]: e.target.value
                            }))
                          }
                          placeholder="e.g. Change diagram canvas to transparent or adjust port mapping..."
                          className="flex-1 px-3 py-1.5 rounded-lg bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 text-xs text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                        <button
                          type="button"
                          onClick={() => handleAdjustSubmit(flag.id)}
                          className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors shadow-sm"
                        >
                          Submit
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
