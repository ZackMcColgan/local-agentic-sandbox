"use client";

import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, FileDiff } from "lucide-react";
import {
  buildActivityTimeline,
  coalesceTimelineWriteDiffs,
  type RoundNarrationSegment,
  type ThinkingSegment,
  type TimelineRow,
  type TimelineTraceInput,
  type TimelineWriteDiff,
} from "../lib/activityTimeline";
import { formatElapsedDuration, resolveFileOpenUrl } from "../lib/chatUtils";

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
 * Streams expanded while active; folds to "Thought for Ns" when generation
 * duration is recorded, or "Thought" when no generation timing exists.
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
      className="rounded-xl border border-zinc-300 dark:border-zinc-800 border-l-2 border-l-emerald-500 bg-zinc-50 dark:bg-black/90 text-xs overflow-hidden"
    >
      <button
        type="button"
        data-testid="thinking-preview-toggle"
        aria-expanded={state.isExpanded}
        onClick={() => setUserExpanded(!state.isExpanded)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors cursor-pointer"
      >
        <span className="inline-flex items-center gap-2 min-w-0">
          {isStreaming && !hasContent ? (
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/80 shrink-0" />
          )}
          <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 shrink-0">
            Reasoning
          </span>
          <span className="font-medium text-zinc-800 dark:text-zinc-200 truncate">
            {state.summaryLabel}
          </span>
        </span>
        {trimmedThought &&
          (state.isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400 shrink-0" />
          ))}
      </button>
      {state.isExpanded && trimmedThought && (
        <div
          data-testid="thinking-preview-body"
          className="px-3 pb-2.5 pt-2 border-t border-zinc-200 dark:border-zinc-900 text-zinc-700 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap max-h-56 overflow-y-auto text-xs"
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
  roundNarrations?: RoundNarrationSegment[];
  roundGenerationMs?: number[];
  isStreaming?: boolean;
  hasContent?: boolean;
  onOpenCanvasDiff?: (diff: TimelineWriteDiff, allTurnDiffs: TimelineWriteDiff[]) => void;
}

function CollapsibleErrorOutput({ errorSummary }: { errorSummary: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-testid="timeline-error-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="w-fit inline-flex items-center gap-1 text-[11px] font-mono text-rose-700 dark:text-rose-400 hover:underline cursor-pointer"
      >
        <span>{expanded ? "▾ hide output" : "› show output"}</span>
      </button>
      {expanded && (
        <div
          data-testid="timeline-row-error"
          className="text-[11px] font-mono text-rose-700 bg-rose-50 border border-rose-300 dark:text-rose-400 dark:bg-rose-950/30 dark:border-rose-900/60 rounded-lg px-2.5 py-1.5 break-words"
        >
          {errorSummary}
        </div>
      )}
    </div>
  );
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
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const durationLabel = formatRowDuration(row.durationMs);

  const dotClass =
    row.status === "error"
      ? "bg-rose-500"
      : row.status === "running"
        ? "bg-emerald-500 animate-pulse"
        : "bg-emerald-500/80";

  const miniDiff = row.writeDiff?.diffText ? extractMiniDiffLines(row.writeDiff.diffText, 6) : null;
  const openFileHref = row.writeDiff?.filePath ? resolveFileOpenUrl(row.writeDiff.filePath) : "";

  if (row.kind === "narration" && row.narrationText) {
    return (
      <div data-testid="timeline-round-narration" data-round={row.round} className="relative pl-4">
        <span className="absolute left-[-4.5px] top-[7px] h-2 w-2 rounded-full ring-2 ring-white dark:ring-black bg-zinc-400 dark:bg-zinc-600" />
        <div className="text-xs leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap max-w-[68ch]">
          {row.narrationText}
        </div>
      </div>
    );
  }

  if (row.isGroup && row.children) {
    const isErrorGroup = row.status === "error";
    return (
      <div data-testid="timeline-row" data-row-status={row.status} className="relative pl-4">
        <span
          className={`absolute left-[-4.5px] top-[12px] h-2 w-2 rounded-full ring-2 ring-white dark:ring-black ${dotClass}`}
        />
        <div
          data-testid="timeline-group-card"
          className={`rounded-xl border overflow-hidden ${
            isErrorGroup
              ? "border-rose-300 bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/30"
              : "border-zinc-300 bg-zinc-50 dark:border-zinc-800 dark:bg-black/90"
          }`}
        >
          <button
            type="button"
            data-testid="timeline-group-toggle"
            aria-expanded={groupExpanded}
            onClick={() => setGroupExpanded((v) => !v)}
            className="w-full px-3 py-2 flex items-center justify-between gap-3 text-left cursor-pointer"
          >
            <div className="min-w-0 flex flex-col gap-0.5">
              <span
                className={`text-xs font-semibold truncate ${
                  isErrorGroup
                    ? "text-rose-700 dark:text-rose-400"
                    : "text-zinc-800 dark:text-zinc-200"
                }`}
              >
                {row.label}
              </span>
              {row.subline && (
                <span
                  data-testid="timeline-group-subline"
                  className={`text-[11px] font-mono truncate ${
                    isErrorGroup
                      ? "text-rose-700 dark:text-rose-300"
                      : "text-zinc-600 dark:text-zinc-400"
                  }`}
                >
                  {row.subline}
                </span>
              )}
            </div>
            <span
              className={`text-[11px] font-mono shrink-0 ${
                isErrorGroup
                  ? "text-rose-700 dark:text-rose-400"
                  : "text-zinc-600 dark:text-zinc-400"
              }`}
            >
              {groupExpanded ? "▾ collapse" : "› expand"}
            </span>
          </button>

          {groupExpanded && (
            <div
              className={`px-3 py-2 border-t space-y-1.5 ${
                isErrorGroup
                  ? "border-rose-200 dark:border-rose-900/50"
                  : "border-zinc-200 dark:border-zinc-800"
              }`}
            >
              {row.children.map((child) => (
                <div key={child.id} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span
                      className={`truncate ${
                        child.status === "error"
                          ? "text-rose-700 dark:text-rose-400 font-medium"
                          : "text-zinc-700 dark:text-zinc-300"
                      }`}
                    >
                      {child.label}
                    </span>
                    {formatRowDuration(child.durationMs) && (
                      <span className="font-mono text-zinc-600 dark:text-zinc-400 shrink-0">
                        {formatRowDuration(child.durationMs)}
                      </span>
                    )}
                  </div>
                  {child.status === "error" && child.errorSummary && (
                    <CollapsibleErrorOutput errorSummary={child.errorSummary} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="timeline-row" data-row-status={row.status} className="relative pl-4">
      <span
        className={`absolute left-[-4.5px] top-[7px] h-2 w-2 rounded-full ring-2 ring-white dark:ring-black ${dotClass}`}
      />
      <div className="flex flex-col gap-1">
        <button
          type="button"
          aria-label={row.toolName ? `Tool: ${row.toolName}` : row.label}
          aria-expanded={row.traceArgs ? detailsExpanded : undefined}
          onClick={() => {
            if (row.traceArgs) setDetailsExpanded((v) => !v);
          }}
          className="w-full flex items-center justify-between gap-2 text-xs text-left cursor-pointer group"
        >
          <span
            className={`truncate ${
              row.status === "error"
                ? "text-rose-700 dark:text-rose-400 font-medium"
                : row.status === "running"
                  ? "text-emerald-700 dark:text-emerald-400 font-medium"
                  : "text-zinc-800 dark:text-zinc-200"
            }`}
          >
            {row.label}
          </span>

          <div className="inline-flex items-center gap-2 shrink-0 font-mono text-[11px]">
            {row.writeDiff && (
              <span className="inline-flex items-center gap-1">
                <span className="text-emerald-700 dark:text-emerald-400">
                  +{row.writeDiff.addedLines}
                </span>
                <span className="text-rose-700 dark:text-rose-400">
                  −{row.writeDiff.removedLines}
                </span>
              </span>
            )}
            {durationLabel && (
              <span className="text-zinc-600 dark:text-zinc-400">{durationLabel}</span>
            )}
          </div>
        </button>

        {detailsExpanded && row.traceArgs && (
          <pre
            data-testid="timeline-row-details"
            className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black p-2 font-mono text-[11px] text-zinc-700 dark:text-zinc-300 overflow-x-auto whitespace-pre-wrap"
          >
            {JSON.stringify(row.traceArgs, null, 2)}
          </pre>
        )}

        {row.status === "error" && row.errorSummary && (
          <CollapsibleErrorOutput errorSummary={row.errorSummary} />
        )}

        {row.writeDiff && (
          <div className="rounded-lg border border-zinc-300 dark:border-zinc-800 bg-zinc-50 dark:bg-black overflow-hidden">
            {miniDiff && miniDiff.lines.length > 0 && (
              <div className="px-2.5 py-1.5 font-mono text-[11px] leading-snug overflow-x-auto">
                {miniDiff.lines.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.kind === "add"
                        ? "text-emerald-700 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-950/25 px-1"
                        : line.kind === "del"
                          ? "text-rose-700 bg-rose-50 dark:text-rose-400 dark:bg-rose-950/25 px-1"
                          : line.kind === "hunk"
                            ? "text-zinc-600 dark:text-zinc-400 px-1"
                            : "text-zinc-700 dark:text-zinc-300 px-1"
                    }
                  >
                    {line.text}
                  </div>
                ))}
                {miniDiff.truncated && (
                  <div className="text-zinc-600 dark:text-zinc-400 px-1 pt-0.5">…</div>
                )}
              </div>
            )}
            {(onOpenCanvasDiff || openFileHref) && (
              <div className="flex items-center justify-end gap-3 px-2.5 py-1 border-t border-zinc-200 dark:border-zinc-900">
                {openFileHref && (
                  <a
                    href={openFileHref}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="timeline-open-file-link"
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                    title="Open file"
                  >
                    <ExternalLink className="h-3 w-3" />
                    <span>Open file</span>
                  </a>
                )}
                {onOpenCanvasDiff && (
                  <button
                    type="button"
                    data-testid="open-in-canvas-btn"
                    onClick={() => onOpenCanvasDiff(row.writeDiff!, allTurnDiffs)}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300 cursor-pointer"
                  >
                    <FileDiff className="h-3 w-3" />
                    <span>Open</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const ActivityTimeline = React.memo(function ActivityTimeline({
  traces,
  thinkingSegments,
  roundNarrations,
  roundGenerationMs,
  isStreaming = false,
  hasContent = false,
  onOpenCanvasDiff,
}: ActivityTimelineProps) {
  const rows = useMemo(
    () =>
      buildActivityTimeline(traces, undefined, {
        thinkingSegments,
        roundNarrations,
        roundGenerationMs,
        isStreaming,
      }),
    [traces, thinkingSegments, roundNarrations, roundGenerationMs, isStreaming]
  );
  const allTurnDiffs = useMemo(() => {
    const rawTurnDiffs: TimelineWriteDiff[] = [];
    for (const r of rows) {
      if (r.writeDiff) rawTurnDiffs.push(r.writeDiff);
    }
    return coalesceTimelineWriteDiffs(rawTurnDiffs);
  }, [rows]);

  if (rows.length === 0) return null;

  return (
    <div
      data-testid="activity-timeline"
      className="ml-1.5 border-l border-zinc-300 dark:border-zinc-800 space-y-2.5 py-1"
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
});
