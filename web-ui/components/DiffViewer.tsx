"use client";

import React, { useState } from "react";
import {
  GitBranch,
  FileCode,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Eye,
  PanelRightOpen,
} from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { useCanvas } from "./CanvasContext";
import { displayRepoPath } from "../lib/chatUtils";

interface DiffViewerProps {
  branch?: string;
  diff?: string;
  modifiedFiles?: string[];
  diagramSvg?: string;
  className?: string;
  /**
   * UI-023: chat diff cards pass false so a message's diffs start collapsed
   * (header + counts only) instead of walling off the chat. Defaults to true
   * so ProjectsView and the workspace inspector keep opening expanded.
   */
  defaultOpen?: boolean;
}

export function DiffViewer({
  branch = "agent/autonomous-task",
  diff = "",
  modifiedFiles = [],
  diagramSvg,
  className = "",
  defaultOpen = true,
}: DiffViewerProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [showDiagram, setShowDiagram] = useState(false);
  const canvas = useCanvas();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!diff) return;
    const ok = await copyText(diff);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const lines = diff ? diff.split("\n") : [];
  const additions = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const deletions = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

  return (
    <div
      className={`max-w-full min-w-0 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm overflow-hidden ${className}`}
    >
      {/* Header Bar */}
      <div className="px-3.5 py-2.5 flex items-center justify-between gap-2 min-w-0 bg-slate-50/80 dark:bg-black/60 border-b border-slate-200 dark:border-zinc-800">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          className="flex items-center gap-2 text-left group min-w-0 flex-1"
        >
          {isOpen ? (
            <ChevronDown className="h-4 w-4 text-slate-400 dark:text-zinc-400 group-hover:text-slate-700 dark:group-hover:text-zinc-300 transition-colors" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-400 dark:text-zinc-400 group-hover:text-slate-700 dark:group-hover:text-zinc-300 transition-colors" />
          )}
          <GitBranch className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span className="font-mono text-xs font-semibold text-slate-800 dark:text-zinc-200 truncate min-w-0">
            {displayRepoPath(branch)}
          </span>
          <div className="flex items-center gap-1.5 text-[10px] font-mono ml-2 shrink-0">
            {additions > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                {`+${additions}`}
              </span>
            )}
            {deletions > 0 && (
              <span className="text-rose-600 dark:text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/20">
                {`-${deletions}`}
              </span>
            )}
          </div>
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
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

          {canvas?.enabled && diff && (
            <button
              type="button"
              onClick={() =>
                canvas.openCanvas({
                  kind: "file",
                  id: `diff-${branch}`,
                  filename: branch,
                  language: "diff",
                  code: diff,
                })
              }
              className="flex items-center justify-center gap-1 min-h-[44px] min-w-[44px] sm:min-h-[32px] sm:min-w-0 px-2.5 py-1 rounded text-[11px] font-mono text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 border border-emerald-300/70 dark:border-emerald-700/50 transition-colors"
              title="Open in Canvas"
              aria-label="Open in Canvas"
            >
              <PanelRightOpen className="h-3.5 w-3.5 shrink-0" />
              <span>Canvas</span>
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
              <span className="text-slate-400 dark:text-zinc-400">Files:</span>
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
                className="overflow-x-auto max-h-72 p-2 bg-white dark:bg-black rounded border border-slate-200 dark:border-zinc-800 flex items-center justify-center"
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
