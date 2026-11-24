"use client";

import React from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { coalesceTimelineWriteDiffs, type TimelineWriteDiff } from "../lib/activityTimeline";
import { resolveFileOpenUrl } from "../lib/chatUtils";

export interface DiffRenderedLine {
  kind: "hunk" | "add" | "del" | "ctx";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

/**
 * Parses a unified diff string into lines annotated with old/new line numbers.
 */
export function parseUnifiedDiffWithLineNumbers(diffText: string): DiffRenderedLine[] {
  const result: DiffRenderedLine[] = [];
  let oldNum = 1;
  let newNum = 1;

  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    const hunkMatch = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldNum = parseInt(hunkMatch[1], 10);
      newNum = parseInt(hunkMatch[2], 10);
      result.push({ kind: "hunk", oldLine: null, newLine: null, text: raw });
    } else if (raw.startsWith("+")) {
      result.push({ kind: "add", oldLine: null, newLine: newNum++, text: raw });
    } else if (raw.startsWith("-")) {
      result.push({ kind: "del", oldLine: oldNum++, newLine: null, text: raw });
    } else {
      result.push({ kind: "ctx", oldLine: oldNum++, newLine: newNum++, text: raw });
    }
  }

  return result;
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

export interface CanvasDiffSheetProps {
  currentDiff: TimelineWriteDiff;
  allDiffs: TimelineWriteDiff[];
  onSelectDiff: (diff: TimelineWriteDiff) => void;
  onClose: () => void;
}

export function CanvasDiffSheet({
  currentDiff,
  allDiffs,
  onSelectDiff,
  onClose,
}: CanvasDiffSheetProps) {
  const uniqueDiffs = coalesceTimelineWriteDiffs(allDiffs);
  const lines = currentDiff.diffText ? parseUnifiedDiffWithLineNumbers(currentDiff.diffText) : [];
  const openFileHref = resolveFileOpenUrl(currentDiff.filePath);

  return (
    <div
      data-testid="canvas-diff-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={`Diff for ${currentDiff.filePath}`}
      className="fixed inset-0 z-50 bg-white dark:bg-black flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-900 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            data-testid="canvas-diff-back"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-800 text-xs font-medium text-zinc-800 dark:text-zinc-200 hover:border-zinc-400 dark:hover:border-zinc-700 cursor-pointer shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back</span>
          </button>
          <span className="font-mono text-xs text-zinc-900 dark:text-zinc-200 truncate">
            {currentDiff.filePath}
          </span>
        </div>
        <div className="inline-flex items-center gap-2 font-mono text-xs shrink-0">
          {currentDiff.synthesized && (
            <span className="text-[11px] font-sans text-zinc-600 dark:text-zinc-400">
              content as written
            </span>
          )}
          <span className="text-emerald-700 dark:text-emerald-400">+{currentDiff.addedLines}</span>
          <span className="text-rose-700 dark:text-rose-400">−{currentDiff.removedLines}</span>
          {openFileHref && (
            <a
              href={openFileHref}
              target="_blank"
              rel="noreferrer"
              data-testid="canvas-diff-open-file"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-300 dark:border-zinc-800 text-[11px] font-sans text-zinc-700 dark:text-zinc-300 hover:text-emerald-700 dark:hover:text-emerald-400 hover:border-zinc-400 dark:hover:border-zinc-700"
              title="Open file"
            >
              <ExternalLink className="h-3 w-3" />
              <span>Open file</span>
            </a>
          )}
        </div>
      </div>

      {/* File switcher chips when multiple files changed in the same turn */}
      {uniqueDiffs.length > 1 && (
        <div
          data-testid="canvas-diff-file-chips"
          className="flex items-center gap-1.5 px-3 py-2 border-b border-zinc-200 dark:border-zinc-900 overflow-x-auto shrink-0"
        >
          {uniqueDiffs.map((d) => {
            const norm = (p: string) =>
              p.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
            const active = norm(d.filePath) === norm(currentDiff.filePath);
            return (
              <button
                key={norm(d.filePath)}
                type="button"
                onClick={() => onSelectDiff(d)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-mono border shrink-0 cursor-pointer transition-colors ${
                  active
                    ? "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500 text-emerald-700 dark:text-emerald-400"
                    : "bg-white dark:bg-black border-zinc-300 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200"
                }`}
              >
                {basename(d.filePath)}
              </button>
            );
          })}
        </div>
      )}

      {/* Unified diff body */}
      <div className="flex-1 overflow-auto overscroll-contain p-3 font-mono text-xs leading-relaxed">
        {lines.length > 0 ? (
          <div className="min-w-max">
            {lines.map((line, i) => (
              <div
                key={i}
                className={`flex items-start gap-3 px-2 py-0.5 ${
                  line.kind === "add"
                    ? "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-400"
                    : line.kind === "del"
                      ? "bg-rose-50 dark:bg-rose-950/30 text-rose-800 dark:text-rose-400"
                      : line.kind === "hunk"
                        ? "text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-900 my-1"
                        : "text-zinc-800 dark:text-zinc-300"
                }`}
              >
                <span className="w-8 text-right text-zinc-600 dark:text-zinc-400 select-none shrink-0">
                  {line.oldLine ?? ""}
                </span>
                <span className="w-8 text-right text-zinc-600 dark:text-zinc-400 select-none shrink-0">
                  {line.newLine ?? ""}
                </span>
                <span className="whitespace-pre">{line.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-zinc-600 dark:text-zinc-400 py-8 text-center">
            No unified diff body recorded for this write (+{currentDiff.addedLines} −
            {currentDiff.removedLines}).
          </div>
        )}
      </div>
    </div>
  );
}
