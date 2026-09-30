"use client";

import React, { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Runtime Error Caught]:", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
      <div className="max-w-md w-full rounded-xl border border-rose-500/30 bg-slate-900/90 p-6 space-y-4 shadow-2xl">
        <div className="flex items-center gap-3 text-rose-400">
          <AlertTriangle className="h-6 w-6 shrink-0" />
          <h2 className="text-base font-semibold">Application Runtime Error</h2>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed font-mono bg-slate-950 p-3 rounded border border-white/5 break-words">
          {error.message || "An unexpected error occurred while rendering the portal."}
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          <span>Retry Portal Render</span>
        </button>
      </div>
    </div>
  );
}
