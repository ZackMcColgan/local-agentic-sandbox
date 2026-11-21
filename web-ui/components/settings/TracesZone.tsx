"use client";

import React from "react";

export function TracesZone() {
  return (
    <>
      <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
        Traces &amp; Security
      </h2>
      <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
            OpenTelemetry Traces
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
            Inspect live spans and execution waterfalls in Jaeger.
          </p>
        </div>
        <a
          href="/jaeger/"
          target="_blank"
          rel="noreferrer"
          className="min-h-[44px] inline-flex items-center px-3.5 py-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-xs font-semibold hover:bg-emerald-500/20 transition-colors shrink-0"
        >
          Open Jaeger UI →
        </a>
      </div>
    </>
  );
}
