"use client";

import React, { useEffect, useState } from "react";
import { formatElapsedDuration } from "../lib/chatUtils";
import { freshnessFor } from "../lib/liveActivity";

interface LiveActivityHeaderProps {
  /** Wall-clock ms when the turn started. */
  startedAtMs: number;
  /** Wall-clock ms of the last observed stream/trace activity. */
  lastActivityAtMs: number;
  /** Current round, when known. Omitted from the meta when unknown. */
  round?: number;
  traceCount: number;
  /** Phase in words, e.g. "Writing code — host_run_file_write". */
  phaseLabel: string;
  /** Current micro-activity line; defaults to "Resolving…". */
  activityLabel?: string | null;
  isStreaming?: boolean;
  /** Test hook: pin the clock instead of ticking. */
  nowMs?: number;
}

/**
 * Live Activity Header (UI-017) — replaces the fake 0%/100% progress bar.
 * A turn's total rounds are not knowable in advance, so an honest
 * percent-complete does not exist: the hero readout is elapsed time, the
 * only progress visual is an indeterminate pulse track, and freshness is
 * stated in words (Live / last activity / STALLED).
 */
export function LiveActivityHeader({
  startedAtMs,
  lastActivityAtMs,
  round,
  traceCount,
  phaseLabel,
  activityLabel = null,
  isStreaming = true,
  nowMs
}: LiveActivityHeaderProps) {
  const [tickedNowMs, setTickedNowMs] = useState<number>(() => nowMs ?? Date.now());

  useEffect(() => {
    if (!isStreaming || nowMs !== undefined) return;
    const timer = setInterval(() => setTickedNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isStreaming, nowMs]);

  const currentNowMs = nowMs ?? tickedNowMs;
  const elapsedSeconds = Math.max(0, Math.floor((currentNowMs - startedAtMs) / 1000));
  const freshness = freshnessFor(lastActivityAtMs, currentNowMs);
  const isStalled = freshness.state === "stalled";

  const metaParts: string[] = [];
  if (round != null && round > 0) metaParts.push(`Round ${round}`);
  metaParts.push(`${traceCount} ${traceCount === 1 ? "trace" : "traces"}`);

  // Board phase line: the activity in words, the tool as a mono muted tail
  // ("Writing code — host_run_file_write").
  const phaseParts = phaseLabel.split(" — ");
  const phaseText = phaseParts[0];
  const phaseTool = phaseParts.length > 1 ? phaseParts.slice(1).join(" — ") : null;

  return (
    <div
      data-testid="live-activity-header"
      className="w-full max-w-2xl rounded-2xl bg-white/90 dark:bg-[#121215] border border-slate-200/80 dark:border-zinc-800 shadow-2xs px-4 py-3 space-y-2"
    >
      {/* Phase in words + freshness */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-800 dark:text-zinc-100 truncate">
          {phaseText}
          {phaseTool && (
            <span
              data-testid="live-activity-tool"
              className="font-mono font-normal text-xs text-slate-400 dark:text-zinc-500"
            >
              {" — "}
              {phaseTool}
            </span>
          )}
        </span>
        {freshness.state === "live" && (
          <span
            data-testid="live-activity-freshness"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400 shrink-0"
          >
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Live</span>
          </span>
        )}
        {freshness.state === "idle" && (
          <span
            data-testid="live-activity-freshness"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 shrink-0"
          >
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            <span>Last activity {freshness.secondsAgo}s ago</span>
          </span>
        )}
        {isStalled && (
          <span
            data-testid="live-activity-stalled"
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 shrink-0"
          >
            <span>{`◷ STALLED · No heartbeat for ${freshness.secondsAgo}s`}</span>
          </span>
        )}
      </div>

      {/* Hero readout: elapsed time only */}
      <div
        data-testid="live-activity-elapsed"
        className="font-mono tabular-nums text-[27px] sm:text-[34px] leading-none font-semibold tracking-wide text-slate-900 dark:text-zinc-50"
      >
        {formatElapsedDuration(elapsedSeconds)}
      </div>

      {/* Indeterminate pulse track — signals work continuing, never completion */}
      {!isStalled && (
        <div className="relative h-[2px] rounded-full bg-slate-200 dark:bg-zinc-800 overflow-hidden" aria-hidden="true">
          <div className="live-activity-pulse absolute top-0 h-full w-1/3 rounded-full bg-gradient-to-r from-emerald-600 via-emerald-500 to-emerald-400" />
        </div>
      )}

      {/* Current activity + mono meta */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-slate-500 dark:text-zinc-400 truncate">
          {activityLabel && activityLabel.trim() ? activityLabel.trim() : "Resolving…"}
        </span>
        <span
          data-testid="live-activity-meta"
          className="font-mono tabular-nums text-[11px] text-slate-500 dark:text-zinc-400 shrink-0"
        >
          {metaParts.join(" · ")}
        </span>
      </div>
    </div>
  );
}
