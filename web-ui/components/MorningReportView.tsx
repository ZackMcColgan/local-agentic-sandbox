"use client";

import React, { useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RotateCcw,
  GitCommit,
  Clock,
  GitBranch,
  ShieldAlert,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  SlidersHorizontal,
  FileCode2,
  Eye,
  Sparkles
} from "lucide-react";
import {
  MorningReport,
  OvernightMorningReport,
  MorningReportArtifact
} from "@/lib/subagents/morningReport";
import { AmbiguityFlag } from "@/lib/subagents/types";

interface MorningReportViewProps {
  report?: MorningReport | null;
  overnightReport?: OvernightMorningReport | null;
  onRevertFlag?: (flagId: string) => Promise<void> | void;
  onAdjustFlag?: (flagId: string, newInstruction: string) => Promise<void> | void;
}

export function MorningReportView({
  report,
  overnightReport: propOvernightReport,
  onRevertFlag,
  onAdjustFlag
}: MorningReportViewProps) {
  const [flags, setFlags] = useState<AmbiguityFlag[]>(report?.ambiguityFlags || []);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [expandedFlagId, setExpandedFlagId] = useState<string | null>(null);
  const [expandedTaskDetails, setExpandedTaskDetails] = useState<Record<string, boolean>>({});
  const [adjustInputs, setAdjustInputs] = useState<Record<string, string>>({});
  const [previewArtifact, setPreviewArtifact] = useState<MorningReportArtifact | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const overnight = React.useMemo<OvernightMorningReport | null>(() => {
    if (propOvernightReport) return propOvernightReport;
    if (report?.overnightSummary) return report.overnightSummary;
    if (report) {
      const artList: MorningReportArtifact[] = [];
      const seen = new Set<string>();
      for (const m of report.milestones || []) {
        if (m.diffSummary) {
          const match = m.diffSummary.match(/File:\s*([^\r\n]+)/i);
          if (match && match[1]) {
            const p = match[1].trim();
            if (!seen.has(p)) {
              seen.add(p);
              artList.push({
                name: p.split("/").pop() || p,
                path: p,
                previewUrl: `/api/files?path=${encodeURIComponent(p)}`,
                taskId: report.taskId
              });
            }
          }
        }
      }
      return {
        reportId: `rep-${report.taskId}`,
        generatedAt: report.startedAt || new Date().toISOString(),
        windowLabel: "Autonomous Run",
        totalTasks: 1,
        completedCount: report.status === "completed" ? 1 : 0,
        parkedCount: report.status === "parked" ? 1 : 0,
        failedCount: report.status === "failed" ? 1 : 0,
        totalDurationSeconds: 0,
        totalDurationFormatted: report.durationFormatted || "0s",
        tasks: [
          {
            taskId: report.taskId,
            goal: report.goal,
            status: (report.status === "active" ? "active" : report.status) as any,
            durationSeconds: 0,
            durationFormatted: report.durationFormatted || "0s",
            branch: report.branch,
            milestones: report.milestones,
            artifacts: artList,
            parkedReason: report.parkedItems?.[0]
          }
        ],
        artifactsProduced: artList,
        attentionItems:
          report.status === "parked" || report.status === "failed"
            ? [
                {
                  taskId: report.taskId,
                  goal: report.goal,
                  status: report.status as any,
                  reason: report.parkedItems?.[0] || "Task requires attention"
                }
              ]
            : [],
        summaryMarkdown: report.summaryMarkdown || ""
      };
    }
    return null;
  }, [propOvernightReport, report]);

  const uniqueArtifacts = React.useMemo(() => {
    const seen = new Set<string>();
    const list: MorningReportArtifact[] = [];
    for (const art of overnight?.artifactsProduced || []) {
      const norm = art.path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
      if (!seen.has(norm)) {
        seen.add(norm);
        list.push({ ...art, path: norm });
      }
    }
    return list;
  }, [overnight?.artifactsProduced]);

  const uniqueTasks = React.useMemo(() => {
    const seen = new Set<string>();
    const list: OvernightTaskEntry[] = [];
    for (const t of overnight?.tasks || []) {
      if (!seen.has(t.taskId)) {
        seen.add(t.taskId);
        list.push(t);
      }
    }
    return list;
  }, [overnight?.tasks]);

  const handlePreviewArtifact = async (art: MorningReportArtifact) => {
    if (previewArtifact?.path === art.path) {
      setPreviewArtifact(null);
      setPreviewContent(null);
      return;
    }
    setPreviewArtifact(art);
    setPreviewLoading(true);
    try {
      const res = await fetch(art.previewUrl);
      if (res.ok) {
        const text = await res.text();
        setPreviewContent(text);
      } else {
        setPreviewContent(`Unable to load preview (${res.status}). Open link directly: ${art.previewUrl}`);
      }
    } catch (err: any) {
      setPreviewContent(`Preview error: ${err?.message || "Failed to fetch artifact"}`);
    } finally {
      setPreviewLoading(false);
    }
  };

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

  return (
    <div className="space-y-5 sm:space-y-6 animate-in fade-in duration-200">
      {/* OVERNIGHT MULTI-TASK SUMMARY SECTION */}
      {overnight && (
        <div className="space-y-5">
          {/* Summary KPI Banner */}
          <div className="p-4 sm:p-5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-slate-100 dark:border-zinc-800">
              <div>
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                    {overnight.windowLabel}
                  </span>
                </div>
                <h2 className="mt-1 text-base sm:text-lg font-bold text-slate-900 dark:text-zinc-100">
                  Overnight Autonomous Summary
                </h2>
              </div>
              <div className="flex items-center gap-2 text-xs font-mono text-slate-600 dark:text-zinc-400">
                <Clock className="h-3.5 w-3.5 text-emerald-500" />
                <span>Total Time Spent: <strong className="text-slate-900 dark:text-zinc-100">{overnight.totalDurationFormatted}</strong></span>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800">
                <div className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">Total Tasks</div>
                <div className="mt-0.5 text-xl font-bold text-slate-900 dark:text-zinc-100">{overnight.totalTasks}</div>
              </div>
              <div className="p-3 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/60">
                <div className="text-[11px] font-medium text-emerald-800 dark:text-emerald-300">Completed</div>
                <div className="mt-0.5 text-xl font-bold text-emerald-700 dark:text-emerald-400">{overnight.completedCount}</div>
              </div>
              <div className="p-3 rounded-xl bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60">
                <div className="text-[11px] font-medium text-amber-800 dark:text-amber-300">Parked</div>
                <div className="mt-0.5 text-xl font-bold text-amber-700 dark:text-amber-400">{overnight.parkedCount}</div>
              </div>
              <div className="p-3 rounded-xl bg-rose-50/70 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/60">
                <div className="text-[11px] font-medium text-rose-800 dark:text-rose-300">Failed</div>
                <div className="mt-0.5 text-xl font-bold text-rose-700 dark:text-rose-400">{overnight.failedCount}</div>
              </div>
            </div>
          </div>

          {/* 1. What Needs Attention (Parked & Failed Tasks) */}
          <div className="p-4 sm:p-5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <span>What Needs Attention</span>
              </h3>
              <span className="text-xs font-mono text-slate-500 dark:text-zinc-400">
                {overnight.attentionItems.length} item{overnight.attentionItems.length === 1 ? "" : "s"}
              </span>
            </div>

            {overnight.attentionItems.length === 0 ? (
              <div className="p-3.5 rounded-xl bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200/80 dark:border-emerald-900/50 text-xs text-emerald-900 dark:text-emerald-200 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span>All overnight runs completed cleanly without parked tasks or failures.</span>
              </div>
            ) : (
              <div className="space-y-2.5">
                {overnight.attentionItems.map((item) => (
                  <div
                    key={item.taskId}
                    className={`p-3.5 rounded-xl border ${
                      item.status === "parked"
                        ? "bg-amber-50/70 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/60 text-amber-950 dark:text-amber-200"
                        : "bg-rose-50/70 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900/60 text-rose-950 dark:text-rose-200"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            item.status === "parked"
                              ? "bg-amber-200/80 dark:bg-amber-900 text-amber-900 dark:text-amber-200"
                              : "bg-rose-200/80 dark:bg-rose-900 text-rose-900 dark:text-rose-200"
                          }`}
                        >
                          {item.status}
                        </span>
                        <span className="text-xs font-bold">{item.goal}</span>
                        <span className="text-[11px] font-mono opacity-75">({item.taskId})</span>
                      </div>
                      {item.threadUrl && (
                        <a
                          href={item.threadUrl}
                          className="inline-flex items-center gap-1 text-xs font-semibold underline hover:opacity-80"
                        >
                          <span>Open Session</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <p className="mt-1.5 text-xs font-mono leading-relaxed break-words">
                      {item.reason}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

            {/* 2. What Was Produced (Artifacts with Preview Links) */}
            <div className="p-4 sm:p-5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                  <FileCode2 className="h-4 w-4 text-indigo-500" />
                  <span>What Was Produced</span>
                </h3>
                <span className="text-xs font-mono text-slate-500 dark:text-zinc-400">
                  {uniqueArtifacts.length} artifact{uniqueArtifacts.length === 1 ? "" : "s"}
                </span>
              </div>

              {uniqueArtifacts.length === 0 ? (
                <div className="p-3.5 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 text-xs text-slate-500 dark:text-zinc-400">
                  No file artifacts recorded yet in this window.
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {uniqueArtifacts.map((art) => (
                      <div
                        key={art.path}
                        data-testid="artifact-card"
                        className="p-3 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-900 dark:text-zinc-100 truncate">
                            {art.name}
                          </div>
                          <div className="text-[11px] font-mono text-slate-500 dark:text-zinc-400 truncate">
                            {art.path}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handlePreviewArtifact(art)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/70 dark:hover:bg-indigo-900 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 text-[11px] font-semibold transition-colors"
                          >
                            <Eye className="h-3 w-3" />
                            <span>{previewArtifact?.path === art.path ? "Hide" : "Preview"}</span>
                          </button>
                          <a
                            href={art.previewUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white hover:bg-slate-50 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-200 dark:border-zinc-700 text-[11px] font-medium transition-colors"
                            title="Open raw file preview"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>

                  {previewArtifact && (
                    <div className="mt-3 p-3.5 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800">
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-100 dark:border-zinc-800 text-xs font-mono">
                        <span className="font-bold text-slate-900 dark:text-zinc-100">{previewArtifact.path}</span>
                        <a
                          href={previewArtifact.previewUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1"
                        >
                          <span>Open raw</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                      {previewLoading ? (
                        <div className="text-xs text-slate-500 dark:text-zinc-400 py-4 text-center">
                          Loading artifact preview...
                        </div>
                      ) : (
                        <pre className="text-xs font-mono text-slate-800 dark:text-zinc-200 overflow-x-auto max-h-[320px] overflow-y-auto whitespace-pre-wrap leading-relaxed">
                          {previewContent}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 3. What Ran (Overnight Task Log) */}
            <div className="p-4 sm:p-5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900 dark:text-zinc-100">
                  What Ran (Overnight Task Log)
                </h3>
                <span className="text-xs font-mono text-slate-500 dark:text-zinc-400">
                  {uniqueTasks.length} task{uniqueTasks.length === 1 ? "" : "s"}
                </span>
              </div>

              {uniqueTasks.length === 0 ? (
                <div className="p-4 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 text-xs text-slate-500 dark:text-zinc-400 text-center">
                  No tasks have executed in this window yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {uniqueTasks.map((t) => {
                    const isComp = t.status === "completed";
                    const isPark = t.status === "parked";
                    const isFail = t.status === "failed";
                    const isExpanded = !!expandedTaskDetails[t.taskId];

                    return (
                      <div
                        key={t.taskId}
                        data-testid="task-row"
                        className="p-3.5 sm:p-4 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 space-y-2.5"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold uppercase ${
                                isComp
                                  ? "bg-emerald-50 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                                  : isPark
                                  ? "bg-amber-50 dark:bg-amber-950/80 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
                                  : isFail
                                  ? "bg-rose-50 dark:bg-rose-950/80 text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800"
                                  : "bg-blue-50 dark:bg-blue-950/80 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
                              }`}
                            >
                              {isComp ? (
                                <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                              ) : isPark ? (
                                <AlertTriangle className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                              ) : isFail ? (
                                <XCircle className="h-3 w-3 text-rose-600 dark:text-rose-400" />
                              ) : null}
                              <span>{t.status}</span>
                            </span>
                            <span className="text-xs sm:text-sm font-bold text-slate-900 dark:text-zinc-100 break-words">
                              {t.goal}
                            </span>
                            <span className="text-[11px] font-mono text-slate-500 dark:text-zinc-400">
                              ({t.taskId})
                            </span>
                          </div>

                          <div className="flex items-center gap-3 text-xs font-mono text-slate-600 dark:text-zinc-400 shrink-0">
                            <span className="inline-flex items-center gap-1">
                              <Clock className="h-3.5 w-3.5 text-emerald-500" />
                              {t.durationFormatted}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <GitBranch className="h-3.5 w-3.5 text-indigo-500" />
                              {t.branch}
                            </span>
                            {t.milestones && t.milestones.length > 0 && (
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedTaskDetails((prev) => ({
                                    ...prev,
                                    [t.taskId]: !prev[t.taskId]
                                  }))
                                }
                                className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200 underline cursor-pointer"
                              >
                                <span>{isExpanded ? "Hide Details" : "Details"}</span>
                                {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                              </button>
                            )}
                          </div>
                        </div>

                        {(t.parkedReason || t.errorSummary) && (
                          <div
                            className={`p-2.5 rounded-lg text-xs font-mono ${
                              isPark
                                ? "bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 border border-amber-200 dark:border-amber-900/50"
                                : "bg-rose-50 dark:bg-rose-950/40 text-rose-900 dark:text-rose-200 border border-rose-200 dark:border-rose-900/50"
                            }`}
                          >
                            {t.parkedReason || t.errorSummary}
                          </div>
                        )}

                        {isExpanded && t.milestones && t.milestones.length > 0 && (
                          <div className="pt-2 border-t border-slate-100 dark:border-zinc-800 space-y-1.5 animate-in fade-in duration-150">
                            <div className="text-[11px] font-semibold text-slate-500 dark:text-zinc-400">
                              Milestones ({t.milestones.length}):
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {t.milestones.map((m) => (
                                <div
                                  key={m.id}
                                  className="p-2 rounded-lg bg-slate-50 dark:bg-zinc-900/60 border border-slate-200/60 dark:border-zinc-800 text-xs flex items-center justify-between"
                                >
                                  <div className="min-w-0 pr-2">
                                    <span className="font-mono font-semibold text-[10px] text-indigo-600 dark:text-indigo-400 mr-1.5">
                                      {m.id}
                                    </span>
                                    <span className="text-slate-800 dark:text-zinc-200 truncate">{m.title}</span>
                                  </div>
                                  {m.commitSha && (
                                    <span className="font-mono text-[10px] text-slate-500 dark:text-zinc-400 shrink-0">
                                      {m.commitSha.substring(0, 7)}
                                    </span>
                                  )}
                                </div>
                              ))}
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
        )}

        {/* Ambiguity Flags & One-Tap Actions (Promoted as standalone section, no duplicate task card) */}
        {flags.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-900 dark:text-zinc-100 tracking-tight flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-indigo-500" />
                <span>Ambiguity Flags &amp; Judgment Calls</span>
              </h2>
              <span className="text-xs font-mono text-slate-500 dark:text-zinc-400">
                {flags.length} logged
              </span>
            </div>

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
                          <span className="font-semibold text-slate-900 dark:text-zinc-100">
                            Judgment Call:{" "}
                          </span>
                          {flag.judgmentCall}
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-500 dark:text-zinc-400">
                          <span className="font-semibold">Reasoning: </span>
                          {flag.reasoning}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleRevert(flag)}
                          disabled={revertingId === flag.id}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900/80 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 text-[11px] font-medium transition-all shadow-sm disabled:opacity-50"
                          title="Revert the judgment call commit immediately"
                        >
                          <RotateCcw
                            className={`h-3 w-3 ${revertingId === flag.id ? "animate-spin" : ""}`}
                          />
                          <span>Revert</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setExpandedFlagId(isExpanded ? null : flag.id)}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-50 dark:bg-zinc-800 dark:hover:bg-zinc-700 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 text-[11px] font-medium transition-all shadow-sm"
                        >
                          <SlidersHorizontal className="h-3 w-3" />
                          <span>Adjust</span>
                          {isExpanded ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </div>

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
          </div>
        )}
    </div>
  );
}
