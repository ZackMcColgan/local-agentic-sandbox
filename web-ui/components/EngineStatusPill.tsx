"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Play, RotateCw, Square } from "lucide-react";

export interface EngineStatusData {
  status: "running" | "stopped" | "starting" | "unknown";
  reachable?: boolean;
  pid?: number | null;
  uptime_s?: number;
  model?: string;
  vram_mb?: number;
  error?: string;
}

export interface EngineStatusPillProps {
  initialStatus?: EngineStatusData;
  onOpenSettings?: () => void;
  className?: string;
}

export function EngineStatusPill({
  initialStatus,
  onOpenSettings,
  className = ""
}: EngineStatusPillProps) {
  const [data, setData] = useState<EngineStatusData>(
    initialStatus || { status: "unknown", reachable: true }
  );
  const [loading, setLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/engine", { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch {
      // offline / unreachable
      setData((prev) => ({ ...prev, status: "stopped", reachable: false }));
    }
  }, []);

  useEffect(() => {
    if (!initialStatus) {
      fetchStatus();
      const interval = setInterval(fetchStatus, 8000);
      return () => clearInterval(interval);
    }
  }, [initialStatus, fetchStatus]);

  const handleStart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    setData((prev) => ({ ...prev, status: "starting" }));
    try {
      const res = await fetch("/api/engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" })
      });
      const json = await res.json().catch(() => ({}));
      if (json.status) {
        setData((prev) => ({ ...prev, status: json.status }));
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setTimeout(fetchStatus, 1500);
    }
  };

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    setData((prev) => ({ ...prev, status: "stopped" }));
    try {
      const res = await fetch("/api/engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" })
      });
      const json = await res.json().catch(() => ({}));
      if (json.status) {
        setData((prev) => ({ ...prev, status: json.status }));
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setTimeout(fetchStatus, 1500);
    }
  };

  const status = loading ? "starting" : data.status;

  if (status === "running") {
    return (
      <div
        onClick={onOpenSettings}
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-emerald-300/80 dark:border-emerald-800/80 bg-emerald-50/90 dark:bg-emerald-950/60 text-xs font-semibold text-emerald-900 dark:text-emerald-200 shadow-2xs min-h-[44px] sm:min-h-[32px] ${className}`}
        title={`LLM Engine: Running (PID ${data.pid || "active"}, ${data.model || "swift-15-27b-mtp"}) · Click Stop to turn off`}
        role="status"
        aria-label="Engine running"
      >
        <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0 animate-pulse" />
        <span className="hidden sm:inline text-[11px] font-bold text-emerald-800 dark:text-emerald-300">Engine</span>
        <button
          type="button"
          onClick={handleStop}
          className="min-h-[28px] sm:min-h-[24px] px-2 py-0.5 rounded-full bg-rose-600 hover:bg-rose-500 text-white text-[10.5px] font-bold flex items-center gap-1 transition-all shadow-xs cursor-pointer"
          title="Turn off LLM Engine (free 16GB VRAM)"
          aria-label="Turn off LLM Engine"
        >
          <Square className="h-2.5 w-2.5 fill-current" />
          <span>Stop</span>
        </button>
      </div>
    );
  }

  if (status === "starting") {
    return (
      <div
        onClick={onOpenSettings}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/60 text-xs font-semibold text-amber-800 dark:text-amber-300 shadow-2xs cursor-pointer min-h-[36px] sm:min-h-[32px] ${className}`}
        title="LLM Engine: Starting..."
        role="status"
        aria-label="Engine starting"
      >
        <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
        <span className="text-xs">Starting...</span>
      </div>
    );
  }

  // Stopped or Unknown
  return (
    <div
      onClick={onOpenSettings}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-slate-300 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-850 text-xs font-semibold text-slate-600 dark:text-zinc-400 shadow-2xs min-h-[36px] sm:min-h-[32px] ${className}`}
      title="LLM Engine: Stopped. Tap Start to spin up llama-server."
      role="status"
      aria-label="Engine stopped"
    >
      <span className="h-2 w-2 rounded-full bg-slate-400 dark:bg-zinc-600 shrink-0" />
      <span className="hidden sm:inline text-slate-600 dark:text-zinc-400 text-[11px]">Engine Stopped</span>
      <button
        type="button"
        onClick={handleStart}
        className="min-h-[28px] sm:min-h-[24px] px-2.5 py-0.5 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white text-[10.5px] font-bold flex items-center gap-1 transition-colors shadow-xs cursor-pointer"
        title="Start LLM Engine"
        aria-label="Start LLM Engine"
      >
        <Play className="h-2.5 w-2.5 fill-current" />
        <span>Start</span>
      </button>
    </div>
  );
}
