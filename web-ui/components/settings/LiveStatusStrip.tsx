"use client";

import React from "react";

export interface LiveStatusStripProps {
  engineDotClass: string;
  engineStatusLabel: string;
  hostDotClass: string;
  hostStatusLabel: string;
  stripModel: string;
  latestDeployLabel: string;
}

export function LiveStatusStrip({
  engineDotClass,
  engineStatusLabel,
  hostDotClass,
  hostStatusLabel,
  stripModel,
  latestDeployLabel,
}: LiveStatusStripProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-zinc-400">
          Engine
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-xs font-semibold text-slate-800 dark:text-zinc-200">
          <span className={`h-2 w-2 rounded-full ${engineDotClass}`} />
          <span>{engineStatusLabel}</span>
        </div>
      </div>
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-zinc-400">
          Host
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-xs font-semibold text-slate-800 dark:text-zinc-200">
          <span className={`h-2 w-2 rounded-full ${hostDotClass}`} />
          <span>{hostStatusLabel}</span>
        </div>
      </div>
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-zinc-400">
          Model
        </div>
        <div
          className="mt-0.5 text-[11px] font-mono font-semibold text-slate-800 dark:text-zinc-200 truncate"
          title={stripModel}
        >
          {stripModel}
        </div>
      </div>
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-zinc-400">
          Last deploy
        </div>
        <div
          className="mt-0.5 text-[11px] font-mono font-semibold text-slate-800 dark:text-zinc-200 truncate"
          title={latestDeployLabel}
        >
          {latestDeployLabel}
        </div>
      </div>
    </div>
  );
}
