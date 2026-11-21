"use client";

import React from "react";

export interface AboutZoneProps {
  appVersion: string;
}

export function AboutZone({ appVersion }: AboutZoneProps) {
  return (
    <>
      <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
        About
      </h2>
      <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
            Local Agentic Sandbox
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
            Local autonomous AI coding platform. Inference runs on this machine.
          </p>
        </div>
        <div
          className="text-[11px] font-mono font-semibold text-slate-800 dark:text-zinc-200 shrink-0"
          data-testid="settings-app-version"
        >
          v{appVersion}
        </div>
      </div>
    </>
  );
}
