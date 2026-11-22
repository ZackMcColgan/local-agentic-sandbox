"use client";

import React from "react";
import { Zap, GitPullRequest } from "lucide-react";
import {
  deriveStintMetrics,
  formatStintDuration,
  type StintRecordInput,
} from "../lib/stintDerivation";
import { formatTokenCount } from "../lib/turnSpeed";

export function StintCard(props: StintRecordInput) {
  const metrics = deriveStintMetrics(props);
  if (!metrics) return null;

  const timeLabel =
    metrics.durationMs !== undefined ? formatStintDuration(metrics.durationMs) : null;
  const tokensLabel = formatTokenCount(metrics.outputTokens);

  return (
    <div
      data-testid="stint-card"
      className="mt-3 rounded-xl border border-zinc-300 dark:border-zinc-800 bg-zinc-50 dark:bg-black px-3 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] font-mono"
    >
      {metrics.rounds !== undefined && (
        <div data-testid="stint-rounds" className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
            Rounds
          </span>
          <span className="text-zinc-800 dark:text-zinc-200 font-semibold">{metrics.rounds}</span>
        </div>
      )}

      {timeLabel && (
        <div data-testid="stint-time" className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
            Time
          </span>
          <span className="text-zinc-800 dark:text-zinc-200 font-semibold">{timeLabel}</span>
        </div>
      )}

      {tokensLabel && (
        <div data-testid="stint-tokens" className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
            Tokens
          </span>
          <span className="text-zinc-800 dark:text-zinc-200 font-semibold">{tokensLabel}</span>
        </div>
      )}

      {metrics.avgTokPerSec !== undefined && (
        <div data-testid="stint-avg-speed" className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-zinc-600 dark:text-zinc-400 inline-flex items-center gap-0.5">
            <Zap className="h-2.5 w-2.5 text-emerald-700 dark:text-emerald-400" />
            <span>Avg speed</span>
          </span>
          <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
            {metrics.avgTokPerSec.toFixed(1)} tok/s
          </span>
        </div>
      )}

      {metrics.files && (
        <div data-testid="stint-files" className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
            Files
          </span>
          <span className="inline-flex items-center gap-1.5 text-zinc-800 dark:text-zinc-200 font-semibold">
            <span>{metrics.files.count}</span>
            <span className="text-emerald-700 dark:text-emerald-400">
              +{metrics.files.addedLines}
            </span>
            <span className="text-rose-700 dark:text-rose-400">−{metrics.files.removedLines}</span>
          </span>
        </div>
      )}

      {metrics.tests && (
        <div data-testid="stint-tests" className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
            Tests
          </span>
          <span className="inline-flex items-center gap-1 font-semibold">
            <span className="text-emerald-700 dark:text-emerald-400">
              {metrics.tests.passed} passed
            </span>
            {metrics.tests.failed > 0 && (
              <span className="text-rose-700 dark:text-rose-400">
                / {metrics.tests.failed} failed
              </span>
            )}
          </span>
        </div>
      )}

      {metrics.pr && (
        <a
          data-testid="stint-pr-chip"
          href={metrics.pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-50 border border-emerald-300 text-emerald-700 hover:border-emerald-500 dark:bg-emerald-950/40 dark:border-emerald-500/60 dark:text-emerald-400 dark:hover:border-emerald-400 font-semibold"
        >
          <GitPullRequest className="h-3 w-3" />
          <span>PR #{metrics.pr.number}</span>
        </a>
      )}
    </div>
  );
}
