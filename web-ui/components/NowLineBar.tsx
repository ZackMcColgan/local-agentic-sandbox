"use client";

import React, { useEffect, useState } from "react";
import { deriveNowLineState, type NowLineInput } from "../lib/turnSpeed";

export type NowLineBarProps = Omit<NowLineInput, "nowMs"> & {
  nowMs?: number;
};

export function NowLineBar(props: NowLineBarProps) {
  const [tickedNowMs, setTickedNowMs] = useState<number>(() => props.nowMs ?? Date.now());

  useEffect(() => {
    if (!props.isStreaming || props.nowMs !== undefined) return;
    const timer = setInterval(() => setTickedNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [props.isStreaming, props.nowMs]);

  const effectiveNowMs = props.nowMs ?? tickedNowMs;
  const state = deriveNowLineState({ ...props, nowMs: effectiveNowMs });
  if (!state.visible) return null;

  const dotClass = state.stallLabel
    ? "bg-rose-500"
    : state.isStreaming
      ? "bg-emerald-500 animate-pulse"
      : state.outcomeTone === "error"
        ? "bg-rose-500"
        : state.outcomeTone === "stopped" || state.outcomeTone === "incomplete"
          ? "bg-zinc-400"
          : "bg-emerald-500";

  const labelClass = state.isStreaming
    ? "text-emerald-700 dark:text-emerald-400"
    : state.outcomeTone === "error"
      ? "text-rose-700 dark:text-rose-400"
      : "text-zinc-700 dark:text-zinc-300";

  return (
    <div
      data-testid="header-now-line"
      className="w-full bg-zinc-50 dark:bg-black border-b border-zinc-200 dark:border-zinc-900 px-3 py-1.5 flex items-center justify-between gap-3 text-[11px] font-mono shrink-0"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dotClass}`} />
        <span data-testid="now-line-action" className={`truncate ${labelClass}`}>
          {state.actionLabel}
        </span>
        {state.stallLabel && (
          <>
            <span className="text-zinc-600 dark:text-zinc-400 shrink-0">·</span>
            <span
              data-testid="now-line-stalled"
              className="text-rose-700 dark:text-rose-400 font-semibold shrink-0"
            >
              {state.stallLabel}
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0 text-zinc-600 dark:text-zinc-400">
        {state.elapsedLabel && <span data-testid="now-line-elapsed">{state.elapsedLabel}</span>}
        {state.tokensLabel && (
          <>
            <span>·</span>
            <span data-testid="now-line-tokens">{state.tokensLabel}</span>
          </>
        )}
        {state.tokPerSecLabel && (
          <>
            <span>·</span>
            <span data-testid="now-line-toks" className="text-emerald-700 dark:text-emerald-400">
              {state.tokPerSecLabel}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
