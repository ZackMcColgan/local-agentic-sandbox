"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronRight, FileDiff } from "lucide-react";
import {
  buildActivityTimeline,
  type ThinkingSegment,
  type TimelineRow,
  type TimelineTraceInput,
  type TimelineWriteDiff,
} from "../lib/activityTimeline";
import { formatElapsedDuration } from "../lib/chatUtils";

export interface ThinkingPreviewInput {
  isStreaming: boolean;
  hasContent: boolean;
  thought?: string;
  durationMs?: number;
  userExpanded: boolean | null;
}

export interface ThinkingPreviewState {
  visible: boolean;
  isExpanded: boolean;
  summaryLabel: string;
}

/**
 * Pure state derivation for the turn's thinking preview block.
 * Streams expanded while active; folds to "Thought for Ns" once complete unless
 * the user explicitly toggled it.
 */
export function deriveThinkingPreviewState(input: ThinkingPreviewInput): ThinkingPreviewState {
  const hasThought = Boolean(input.thought && input.thought.trim());
  if (!hasThought && !input.isStreaming) {
    return { visible: false, isExpanded: false, summaryLabel: "" };
  }

  const activelyThinking = input.isStreaming && !input.hasContent;
  const isExpanded =
    input.userExpanded !== null ? input.userExpanded : Boolean(activelyThinking && hasThought);

  let summaryLabel = "Thought";
  if (activelyThinking) {
    summaryLabel = "Thinking…";
  } else if (typeof input.durationMs === "number" && input.durationMs > 0) {
    const seconds = Math.max(1, Math.round(input.durationMs / 1000));
    summaryLabel = `Thought for ${formatElapsedDuration(seconds)}`;
  }

  return { visible: true, isExpanded, summaryLabel };
}

export interface MiniDiffLine {
  kind: "add" | "del" | "hunk" | "ctx";
  text: string;
}

export function extractMiniDiffLines(
  diffText: string,
  maxLines = 6
): { lines: MiniDiffLine[]; truncated: boolean } {
  const rawLines = diffText.split("\n").filter((l) => !l.startsWith("+++") && !l.startsWith("---"));
  const sliced = rawLines.slice(0, maxLines);
  const lines: MiniDiffLine[] = sliced.map((text) => {
    if (text.startsWith("@@")) return { kind: "hunk", text };
    if (text.startsWith("+")) return { kind: "add", text };
    if (text.startsWith("-")) return { kind: "del", text };
    return { kind: "ctx", text };
  });
  return { lines, truncated: rawLines.length > maxLines };
}

function formatRowDuration(durationMs?: number): string | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export interface ThinkingPreviewBlockProps {
  thought?: string;
  isStreaming: boolean;
  hasContent: boolean;
  durationMs?: number;
}

export function ThinkingPreviewBlock({
  thought,
  isStreaming,
  hasContent,
  durationMs,
}: ThinkingPreviewBlockProps) {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const state = deriveThinkingPreviewState({
    isStreaming,
    hasContent,
    thought,
    durationMs,
    userExpanded,
  });

  if (!state.visible) return null;

  const trimmedThought = (thought || "").trim();

  return (
    <div
      data-testid="thinking-panel"
      className="rounded-xl border border-zinc-800 bg-black/90 text-xs"
    >
      <button
        type="button"
        data-testid="thinking-preview-toggle"
        aria-expanded={state.isExpanded}
        onClick={() => setUserExpanded(!state.isExpanded)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-zinc-300 hover:text-zinc-100 transition-colors cursor-pointer"
      >
        <span className="inline-flex items-center gap-2 min-w-0">
          {isStreaming && !hasContent ? (
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 shrink-0" />
          )}
          <span className="font-medium truncate">{state.summaryLabel}</span>
          <span className="text-[11px] text-zinc-400 shrink-0">Reasoning</span>
        </span>
        {trimmedThought &&
          (state.isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
          ))}
      </button>
      {state.isExpanded && trimmedThought && (
        <div
          data-testid="thinking-preview-body"
          className="px-3 pb-2.5 pt-1 border-t border-zinc-900 text-zinc-400 leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto font-mono text-[11px]"
        >
          {trimmedThought}
        </div>
      )}
    </div>
  );
}

export interface ActivityTimelineProps {
  traces: TimelineTraceInput[];
  thinkingSegments?: ThinkingSegment[];
  isStreaming?: boolean;
  hasContent?: boolean;
  onOpenCanvasDiff?: (diff: TimelineWriteDiff, allTurnDiffs: TimelineWriteDiff[]) => void;
}

function TimelineRowView({
  row,
  allTurnDiffs,
  onOpenCanvasDiff,
}: {
  row: TimelineRow;
  allTurnDiffs: TimelineWriteDiff[];
  onOpenCanvasDiff?: (diff: TimelineWriteDiff, allTurnDiffs: TimelineWriteDiff[]) => void;
}) {
  const [groupExpanded, setGroupExpanded] = useState(false);
  const durationLabel = formatRowDuration(row.durationMs);

  const dotClass =
    row.status === "error"
      ? "bg-rose-500"
      : row.status === "running"
        ? "bg-emerald-500 animate-pulse"
        : "bg-emerald-500/80";

  const miniDiff = row.writeDiff?.diffText ? extractMiniDiffLines(row.writeDiff.diffText, 6) : null;

  return (
    <div data-testid="timeline-row" data-row-status={row.status} className="relative pl-4">
      <span
        className={`absolute left-[-4.5px] top-[7px] h-2 w-2 rounded-full ring-2 ring-black ${dotClass}`}
      />
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2 text-xs">
          {row.isGroup && row.children ? (
            <button
              type="button"
              data-testid="timeline-group-toggle"
              aria-expanded={groupExpanded}
              onClick={() => setGroupExpanded((v) => !v)}
              className="inline-flex items-center gap-1.5 text-left text-zinc-300 hover:text-zinc-100 cursor-pointer min-w-0"
            >
              {groupExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              )}
              <span className="truncate font-medium">{row.label}</span>
            </button>
          ) : (
            <span
              className={`truncate ${
                row.status === "error"
                  ? "text-rose-400 font-medium"
                  : row.status === "running"
                    ? "text-emerald-400 font-medium"
                    : "text-zinc-200"
              }`}
            >
              {row.label}
            </span>
          )}

          <div className="inline-flex items-center gap-2 shrink-0 font-mono text-[11px]">
            {row.writeDiff && (
              <span className="inline-flex items-center gap-1">
                <span className="text-emerald-400">+{row.writeDiff.addedLines}</span>
                <span className="text-rose-400">−{row.writeDiff.removedLines}</span>
              </span>
            )}
            {durationLabel && <span className="text-zinc-400">{durationLabel}</span>}
          </div>
        </div>

        {row.status === "error" && row.errorSummary && (
          <div
            data-testid="timeline-row-error"
            className="text-[11px] font-mono text-rose-400 bg-rose-950/30 border border-rose-900/60 rounded-lg px-2.5 py-1.5 break-words"
          >
            {row.errorSummary}
          </div>
        )}

        {row.writeDiff && (
          <div className="rounded-lg border border-zinc-800 bg-black overflow-hidden">
            {miniDiff && miniDiff.lines.length > 0 && (
              <div className="px-2.5 py-1.5 font-mono text-[11px] leading-snug overflow-x-auto">
                {miniDiff.lines.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.kind === "add"
                        ? "text-emerald-400 bg-emerald-950/25 px-1"
                        : line.kind === "del"
                          ? "text-rose-400 bg-rose-950/25 px-1"
                          : line.kind === "hunk"
                            ? "text-zinc-400 px-1"
                            : "text-zinc-300 px-1"
                    }
                  >
                    {line.text}
                  </div>
                ))}
                {miniDiff.truncated && <div className="text-zinc-400 px-1 pt-0.5">…</div>}
              </div>
            )}
            {onOpenCanvasDiff && (
              <div className="flex items-center justify-end px-2.5 py-1 border-t border-zinc-900">
                <button
                  type="button"
                  data-testid="open-in-canvas-btn"
                  onClick={() => onOpenCanvasDiff(row.writeDiff!, allTurnDiffs)}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 hover:text-emerald-300 cursor-pointer"
                >
                  <FileDiff className="h-3 w-3" />
                  <span>Open</span>
                </button>
              </div>
            )}
          </div>
        )}

        {row.isGroup && groupExpanded && row.children && (
          <div className="mt-1 ml-2 pl-3 border-l border-zinc-800 space-y-1">
            {row.children.map((child) => (
              <div
                key={child.id}
                className="flex items-center justify-between gap-2 text-[11px] text-zinc-400"
              >
                <span className="truncate">{child.label}</span>
                {formatRowDuration(child.durationMs) && (
                  <span className="font-mono shrink-0">{formatRowDuration(child.durationMs)}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ActivityTimeline({
  traces,
  thinkingSegments,
  isStreaming = false,
  hasContent = false,
  onOpenCanvasDiff,
}: ActivityTimelineProps) {
  const rows = buildActivityTimeline(traces, undefined, { thinkingSegments, isStreaming });
  if (rows.length === 0) return null;

  const allTurnDiffs: TimelineWriteDiff[] = [];
  for (const r of rows) {
    if (r.writeDiff) allTurnDiffs.push(r.writeDiff);
  }

  return (
    <div
      data-testid="activity-timeline"
      className="ml-1.5 border-l border-zinc-800 space-y-2.5 py-1"
    >
      {rows.map((row) =>
        row.kind === "thinking" ? (
          <div key={row.id} className="pl-3">
            <ThinkingPreviewBlock
              thought={row.thinkingText}
              isStreaming={row.status === "running"}
              hasContent={row.status === "running" ? hasContent : true}
              durationMs={row.durationMs}
            />
          </div>
        ) : (
          <TimelineRowView
            key={row.id}
            row={row}
            allTurnDiffs={allTurnDiffs}
            onOpenCanvasDiff={onOpenCanvasDiff}
          />
        )
      )}
    </div>
  );
}
