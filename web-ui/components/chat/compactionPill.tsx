"use client";

import React from "react";

// Human-readable labels for the CompactionAction union emitted by
// fitConversationToBudget (web-ui/lib/contextBudget.ts:816-820) and persisted on
// thread messages as compactionActions (web-ui/lib/threads/threadStore.ts:66).
export const COMPACTION_ACTION_LABELS: Record<string, string> = {
  compaction: "Compaction",
  elide_tool_outputs: "Elide tool outputs",
  drop_old_turns: "Drop old turns",
  truncate_oversize: "Truncate oversize",
};

export interface CompactionPillProps {
  tokensBeforeCompaction: number;
  tokensAfterCompaction: number;
  compactionActions?: string[];
}

export function CompactionPill({
  tokensBeforeCompaction,
  tokensAfterCompaction,
  compactionActions,
}: CompactionPillProps) {
  const CAP = 3;
  const shown = compactionActions ? compactionActions.slice(0, CAP) : [];
  const overflow = compactionActions ? compactionActions.length - shown.length : 0;

  return (
    <div className="flex flex-col gap-1 w-fit">
      <div
        data-testid="compaction-turn-note"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-800 text-[11px] font-mono text-slate-600 dark:text-zinc-400 w-fit"
      >
        <span>
          History compacted: {tokensBeforeCompaction.toLocaleString()} →{" "}
          {tokensAfterCompaction.toLocaleString()} tokens
        </span>
      </div>
      {/* COMPACTION ACTIONS (compaction-pill): the chat route stores the real
      CompactionAction[] from fitConversationToBudget (contextBudget.ts:816-820)
      on the thread record; render them as capped chips under the pill line. */}
      {compactionActions && compactionActions.length > 0 && (
        <div data-testid="compaction-action-chips" className="flex flex-wrap items-center gap-1.5">
          {shown.map((action, i) => (
            <span
              key={`${action}-${i}`}
              data-testid="compaction-action-chip"
              className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-50 dark:bg-zinc-800/60 border border-slate-200/70 dark:border-zinc-700 text-[10px] font-mono text-slate-500 dark:text-zinc-400"
            >
              {COMPACTION_ACTION_LABELS[action] ?? action}
            </span>
          ))}
          {overflow > 0 && (
            <span
              data-testid="compaction-action-overflow"
              className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-50 dark:bg-zinc-800/60 border border-slate-200/70 dark:border-zinc-700 text-[10px] font-mono text-slate-500 dark:text-zinc-400"
            >
              +{overflow} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}
