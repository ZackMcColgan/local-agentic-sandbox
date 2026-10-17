"use client";

import React, { useEffect, useState } from "react";
import { MorningReportView } from "@/components/MorningReportView";
import { MorningReport, OvernightMorningReport } from "@/lib/subagents/morningReport";
import { ArrowLeft, RefreshCw, Sun } from "lucide-react";

export default function MorningReportPage() {
  const [overnightReport, setOvernightReport] = useState<OvernightMorningReport | null>(null);
  const [morningReport, setMorningReport] = useState<MorningReport | null>(null);
  const [loading, setLoading] = useState(true);

  const loadReport = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/morning-report");
      if (res.ok) {
        const data = await res.json();
        if (data.overnightReport) setOvernightReport(data.overnightReport);
        if (data.morningReport) setMorningReport(data.morningReport);
      }
    } catch (err) {
      console.warn("Failed to load morning report:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const queryTheme = urlParams.get("theme");
      const saved = queryTheme || localStorage.getItem("app-theme") || localStorage.getItem("theme");
      const isDark = saved
        ? saved === "dark"
        : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.classList.toggle("dark", isDark);
      document.documentElement.classList.toggle("light", !isDark);
      document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    } catch {}
    loadReport();
  }, []);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-white dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 antialiased font-sans">
      <header className="sticky top-0 z-20 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md border-b border-slate-200 dark:border-zinc-800 px-4 sm:px-6 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <a
              href="/"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white hover:bg-slate-50 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-slate-200 dark:border-zinc-800 text-xs font-semibold text-slate-700 dark:text-zinc-200 shadow-xs transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Sessions</span>
            </a>
            <div className="flex items-center gap-2">
              <Sun className="h-5 w-5 text-amber-500" />
              <h1 className="text-base sm:text-xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
                Morning Report
              </h1>
            </div>
          </div>

          <button
            type="button"
            onClick={loadReport}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white hover:bg-slate-50 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-slate-200 dark:border-zinc-800 text-xs font-semibold text-slate-700 dark:text-zinc-200 shadow-xs transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto p-4 sm:p-6">
        {loading && !overnightReport ? (
          <div className="p-8 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-center text-xs text-slate-500 dark:text-zinc-400">
            Loading overnight morning report...
          </div>
        ) : (
          <MorningReportView
            overnightReport={overnightReport}
            report={morningReport}
          />
        )}
      </main>
    </div>
  );
}
