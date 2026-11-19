"use client";

import React, { useEffect, useState } from "react";
import { formatElapsedDuration } from "../lib/chatUtils";
import { freshnessFor } from "../lib/liveActivity";
import type { ExecutionTraceItem } from "./ExecutionTrace";

interface LiveActivityHeaderProps {
  /** Wall-clock ms when the turn started. */
  startedAtMs: number;
  /** Wall-clock ms of the last observed stream/trace activity. */
  lastActivityAtMs: number;
  /** Current round, when known. Omitted from the meta when unknown. */
  round?: number;
  traceCount: number;
  /** Live tool traces for the active turn. */
  traces?: ExecutionTraceItem[];
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
  traces = [],
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
  if (traceCount > 0) metaParts.push(`${traceCount} ${traceCount === 1 ? "trace" : "traces"}`);

  // Board phase line: the activity in words, the tool as a mono muted tail
  // ("Writing code — host_run_file_write").
  const phaseParts = phaseLabel.split(" — ");
  const phaseText = phaseParts[0];
  const phaseTool = phaseParts.length > 1 ? phaseParts.slice(1).join(" — ") : null;

  return (
    <div
      data-testid="live-activity-header"
      className="w-full max-w-2xl rounded-2xl bg-white/95 dark:bg-[#0e0e12] border border-stone-200/90 dark:border-white/[0.11] surface-card px-4 py-3 space-y-2"
    >
      {/* Phase in words + freshness */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-stone-900 dark:text-stone-100 truncate">
          {phaseText}
          {phaseTool && (
            <span
              data-testid="live-activity-tool"
              className="font-mono font-normal text-xs text-zinc-600 dark:text-zinc-400"
            >
              {" — "}
              {phaseTool}
            </span>
          )}
        </span>
        {freshness.state === "live" && (
          <span
            data-testid="live-activity-freshness"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-cyan-700 dark:text-cyan-300 shrink-0"
          >
            <span className="h-2 w-2 rounded-full bg-cyan-500 dark:bg-cyan-400 animate-pulse" />
            <span>Live</span>
          </span>
        )}
        {freshness.state === "idle" && (
          <span
            data-testid="live-activity-freshness"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 shrink-0"
          >
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span>Last activity {freshness.secondsAgo}s ago</span>
          </span>
        )}
        {isStalled && (
          <span
            data-testid="live-activity-stalled"
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-300 shrink-0"
          >
            <span>{`◷ STALLED · No heartbeat for ${freshness.secondsAgo}s`}</span>
          </span>
        )}
      </div>

      {/* Hero readout: elapsed time only */}
      <div
        data-testid="live-activity-elapsed"
        className="font-mono tabular-nums text-[27px] sm:text-[34px] leading-none font-semibold tracking-tight text-stone-900 dark:text-stone-50"
      >
        {formatElapsedDuration(elapsedSeconds)}
      </div>

      {/* Indeterminate pulse track — signals work continuing, never completion */}
      {!isStalled && (
        <div className="relative h-[3px] rounded-full bg-emerald-500/20 dark:bg-emerald-500/20 overflow-hidden" aria-hidden="true">
          <div className="live-activity-pulse absolute top-0 h-full w-1/3 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400" />
        </div>
      )}

      {/* Meta line */}
      {(metaParts.length > 0 || activityLabel) && (
        <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-zinc-600 dark:text-zinc-400">
          <span className="truncate">{activityLabel || metaParts.join(" · ")}</span>
          {activityLabel && metaParts.length > 0 && (
            <span className="shrink-0 tabular-nums">{metaParts.join(" · ")}</span>
          )}
        </div>
      )}

      {/* Live trace rows */}
      {traces.length > 0 && (
        <div className="pt-1.5 space-y-1 border-t border-stone-200/80 dark:border-white/[0.08]">
          {traces.map((trace, idx) => {
            const tr = trace as ExecutionTraceItem & {
              id?: string;
              status?: string;
              durationMs?: number;
              args?: Record<string, unknown>;
              error?: string;
            };
            const isFailed = tr.status === "error" || tr.status === "failed" || Boolean(tr.error);
            const isInFlight =
              !isFailed &&
              (tr.status === "running" ||
                (isStreaming && idx === traces.length - 1 && tr.durationMs == null && tr.status !== "completed"));
            const target =
              (typeof tr.args?.path === "string" && tr.args.path) ||
              (typeof tr.args?.file === "string" && tr.args.file) ||
              (typeof tr.args?.command === "string" && tr.args.command) ||
              null;
            return (
              <div
                key={tr.id || `${tr.tool}-${idx}`}
                data-testid="live-trace-row"
                data-in-flight={isInFlight ? "true" : "false"}
                className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl text-xs font-mono ${
                  isFailed
                    ? "bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/30"
                    : isInFlight
                    ? "bg-cyan-500/10 text-cyan-800 dark:text-cyan-300 border border-cyan-500/30"
                    : "text-stone-700 dark:text-stone-300"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isFailed ? (
                    <span className="text-rose-500 dark:text-rose-400 shrink-0">✕</span>
                  ) : isInFlight ? (
                    <span className="h-2 w-2 rounded-full bg-cyan-500 dark:bg-cyan-400 animate-pulse shrink-0" />
                  ) : (
                    <span className="text-emerald-600 dark:text-emerald-400 shrink-0">✓</span>
                  )}
                  <span className="font-semibold truncate">{tr.tool}</span>
                  {target && <span className="text-zinc-600 dark:text-zinc-400 truncate">{target}</span>}
                </div>
                <span className="text-[11px] text-zinc-600 dark:text-zinc-400 tabular-nums shrink-0">
                  {tr.durationMs != null
                    ? `${tr.durationMs}ms`
                    : isInFlight
                    ? formatElapsedDuration(elapsedSeconds)
                    : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
