"use client";

import React from "react";
import { deriveSupervisorBadgeState, type SupervisorBadgeInput } from "./supervisorBadgeState";

export interface SupervisorStatusBadgeProps {
  thread: SupervisorBadgeInput;
}

/**
 * Mobile-first status badge for stalled turns, bounded auto-resume activity,
 * and needs-attention states. Uses pure #000000 canvas, #10b981 emerald accent,
 * and zinc-400 text floor (zinc-500 is never used).
 */
export function SupervisorStatusBadge({ thread }: SupervisorStatusBadgeProps) {
  const state = deriveSupervisorBadgeState(thread);
  if (!state) return null;

  if (state.kind === "needs_attention") {
    return (
      <span
        data-testid="supervisor-needs-attention"
        title={state.detail}
        className="inline-flex items-center gap-1.5 rounded-full border border-[#10b981] bg-[#000000] px-2.5 py-0.5 text-xs font-semibold text-white"
      >
        <span className="h-2 w-2 rounded-full bg-[#10b981]" aria-hidden="true" />
        <span>{state.label}</span>
      </span>
    );
  }

  if (state.kind === "stalled") {
    return (
      <span
        data-testid="supervisor-stalled"
        title={state.detail}
        className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-[#000000] px-2.5 py-0.5 text-xs font-medium text-zinc-400"
      >
        <span className="h-2 w-2 rounded-full bg-zinc-400" aria-hidden="true" />
        <span>{state.label}</span>
      </span>
    );
  }

  return (
    <span
      data-testid="supervisor-auto-resumed"
      className="inline-flex items-center gap-1.5 rounded-full border border-[#10b981]/50 bg-[#000000] px-2.5 py-0.5 text-xs font-medium text-[#10b981]"
    >
      <span className="h-2 w-2 rounded-full bg-[#10b981]" aria-hidden="true" />
      <span>{state.label}</span>
    </span>
  );
}
