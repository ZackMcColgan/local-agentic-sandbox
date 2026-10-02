"use client";

import React, { useState } from "react";
import { GitCommit, GitBranch, FileCode, ChevronDown, ChevronRight, Copy, Check, Eye } from "lucide-react";

interface DiffViewerProps {
  branch?: string;
  diff?: string;
  modifiedFiles?: string[];
  diagramSvg?: string;
  className?: string;
}

export function DiffViewer({
  branch = "agent/autonomous-task",
  diff = "",
  modifiedFiles = [],
  diagramSvg,
  className = ""
}: DiffViewerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showDiagram, setShowDiagram] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!diff) return;
    navigator.clipboard.writeText(diff);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = diff ? diff.split("\n") : [];
  const additions = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const deletions = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

  return (
    <div className={`rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm overflow-hidden ${className}`}>
      {/* Header Bar */}
      <div className="px-3.5 py-2.5 flex items-center justify-between bg-slate-50/80 dark:bg-zinc-950/60 border-b border-slate-200 dark:border-zinc-800">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 text-left group"
        >
          {isOpen ? (
            <ChevronDown className="h-4 w-4 text-slate-400 dark:text-zinc-500 group-hover:text-slate-700 dark:group-hover:text-zinc-300 transition-colors" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-400 dark:text-zinc-500 group-hover:text-slate-700 dark:group-hover:text-zinc-300 transition-colors" />
          )}
          <GitBranch className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span className="font-mono text-xs font-semibold text-slate-800 dark:text-zinc-200">
            {branch}
          </span>
          <div className="flex items-center gap-1.5 text-[10px] font-mono ml-2">
            {additions > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                +{additions}
              </span>
            )}
            {deletions > 0 && (
              <span className="text-rose-600 dark:text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/20">
                -{deletions}
              </span>
            )}
          </div>
        </button>

        <div className="flex items-center gap-1.5">
          {diagramSvg && (
            <button
              type="button"
              onClick={() => setShowDiagram(!showDiagram)}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono text-cyan-600 dark:text-cyan-400 hover:bg-cyan-50 dark:hover:bg-cyan-950/50 border border-cyan-300 dark:border-cyan-500/30 transition-colors"
            >
              <Eye className="h-3 w-3" />
              <span>Diagram</span>
            </button>
          )}

          {diff && (
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono text-slate-500 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
              title="Copy unified diff"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3 text-emerald-500" />
                  <span className="text-emerald-500">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  <span>Copy Diff</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Collapsible Content */}
      {isOpen && (
        <div className="p-3 space-y-3">
          {/* Modified Files Pills */}
          {modifiedFiles.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono">
              <span className="text-slate-400 dark:text-zinc-500">Files:</span>
              {modifiedFiles.map((file, idx) => (
                <span
                  key={idx}
                  className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-200 dark:border-zinc-700"
                >
                  {file}
                </span>
              ))}
            </div>
          )}

          {/* Inline Diagram Preview */}
          {showDiagram && diagramSvg && (
            <div className="p-3 rounded-lg border border-cyan-200 dark:border-cyan-900 bg-cyan-50/30 dark:bg-cyan-950/20">
              <div className="text-[11px] font-semibold text-cyan-800 dark:text-cyan-300 mb-2 flex items-center gap-1.5">
                <FileCode className="h-3.5 w-3.5" />
                <span>Architecture Diagram Preview (.drawio.svg)</span>
              </div>
              <div
                className="overflow-x-auto max-h-72 p-2 bg-white dark:bg-zinc-950 rounded border border-slate-200 dark:border-zinc-800 flex items-center justify-center"
                dangerouslySetInnerHTML={{ __html: diagramSvg }}
              />
            </div>
          )}

          {/* Unified Diff Box */}
          {diff ? (
            <div className="rounded-lg bg-slate-950 dark:bg-black p-3 font-mono text-[11px] leading-relaxed overflow-x-auto max-h-96 border border-slate-800">
              {lines.map((line, idx) => {
                let colorClass = "text-slate-400";
                let bgClass = "";

                if (line.startsWith("+") && !line.startsWith("+++")) {
                  colorClass = "text-emerald-400 font-medium";
                  bgClass = "bg-emerald-950/40 px-1 rounded-xs";
                } else if (line.startsWith("-") && !line.startsWith("---")) {
                  colorClass = "text-rose-400 font-medium";
                  bgClass = "bg-rose-950/40 px-1 rounded-xs";
                } else if (line.startsWith("@@")) {
                  colorClass = "text-cyan-400 font-semibold";
                } else if (line.startsWith("diff --git") || line.startsWith("index ")) {
                  colorClass = "text-purple-400 font-bold";
                }

                return (
                  <div key={idx} className={`${bgClass} whitespace-pre`}>
                    <span className={colorClass}>{line}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-4 text-xs text-slate-500 dark:text-zinc-400 font-mono">
              Working tree clean. No uncommitted modifications.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
