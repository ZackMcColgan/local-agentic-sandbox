"use client";

import React from "react";
import type { CompletionStamp, VerificationGap } from "@/lib/finishVerification";

export function CompletionVerificationBadge({
  stamp,
  gaps = [],
}: {
  stamp?: CompletionStamp;
  gaps?: VerificationGap[];
}) {
  if (!stamp) return null;

  if (stamp === "completed") {
    return (
      <span
        data-testid="completion-verified-badge"
        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <span>Completed</span>
      </span>
    );
  }

  return (
    <div
      data-testid="completion-unverified-badge"
      className="inline-flex flex-col gap-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-black px-3 py-1.5 text-xs text-zinc-600 dark:text-zinc-400"
    >
      <div className="flex items-center gap-1.5 font-medium text-zinc-900 dark:text-zinc-300">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 dark:bg-zinc-400" />
        <span>Completed (Unverified)</span>
      </div>
      {gaps.length > 0 && (
        <ul className="list-disc pl-4 space-y-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
          {gaps.map((g, idx) => (
            <li key={`${g.kind}-${idx}`}>
              {g.claim}: {g.found}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
