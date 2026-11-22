"use client";

import React from "react";
import { deriveNowLineState, type NowLineInput } from "../lib/turnSpeed";

export function NowLineBar(props: NowLineInput) {
  const state = deriveNowLineState(props);
  if (!state.visible) return null;

  return (
    <div
      data-testid="header-now-line"
      className="w-full bg-black border-b border-zinc-900 px-3 py-1.5 flex items-center justify-between gap-3 text-[11px] font-mono shrink-0"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`h-1.5 w-1.5 rounded-full shrink-0 ${
            state.isStreaming ? "bg-emerald-500 animate-pulse" : "bg-emerald-500"
          }`}
        />
        <span
          data-testid="now-line-action"
          className={`truncate ${state.isStreaming ? "text-emerald-400" : "text-zinc-300"}`}
        >
          {state.actionLabel}
        </span>
      </div>

      <div className="flex items-center gap-2 shrink-0 text-zinc-400">
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
            <span data-testid="now-line-toks" className="text-emerald-400">
              {state.tokPerSecLabel}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
