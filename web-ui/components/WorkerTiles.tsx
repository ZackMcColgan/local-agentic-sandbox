"use client";

import React from "react";
import { Compass, Hammer, ShieldAlert, BookOpen, CheckCircle, Loader2 } from "lucide-react";

export type WorkerRole = "Explorer" | "Builder" | "Critic" | "Recorder";
export type WorkerStatus = "active" | "idle" | "completed" | "error";

export interface WorkerTileItem {
  role: WorkerRole;
  status: WorkerStatus;
  detail?: string;
  iteration?: number;
  maxIterations?: number;
}

interface WorkerTilesProps {
  workers: WorkerTileItem[];
}

const ROLE_CONFIG: Record<
  WorkerRole,
  {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    lightBorder: string;
    lightBg: string;
    lightText: string;
    darkBorder: string;
    darkBg: string;
    darkText: string;
    dotColor: string;
  }
> = {
  Explorer: {
    icon: Compass,
    label: "Explorer",
    lightBorder: "border-amber-200",
    lightBg: "bg-white",
    lightText: "text-amber-900",
    darkBorder: "border-amber-500/30",
    darkBg: "bg-zinc-900",
    darkText: "text-amber-300",
    dotColor: "bg-amber-400"
  },
  Builder: {
    icon: Hammer,
    label: "Builder",
    lightBorder: "border-emerald-200",
    lightBg: "bg-white",
    lightText: "text-emerald-900",
    darkBorder: "border-emerald-500/30",
    darkBg: "bg-zinc-900",
    darkText: "text-emerald-300",
    dotColor: "bg-emerald-500"
  },
  Critic: {
    icon: ShieldAlert,
    label: "Critic",
    lightBorder: "border-purple-200",
    lightBg: "bg-white",
    lightText: "text-purple-900",
    darkBorder: "border-purple-500/30",
    darkBg: "bg-zinc-900",
    darkText: "text-purple-300",
    dotColor: "bg-purple-500"
  },
  Recorder: {
    icon: BookOpen,
    label: "Recorder",
    lightBorder: "border-sky-200",
    lightBg: "bg-white",
    lightText: "text-sky-900",
    darkBorder: "border-sky-500/30",
    darkBg: "bg-zinc-900",
    darkText: "text-sky-300",
    dotColor: "bg-sky-500"
  }
};

export function WorkerTiles({ workers }: WorkerTilesProps) {
  // Auto-collapse when all workers are idle or empty
  const activeWorkers = workers.filter((w) => w.status === "active" || w.status === "error");
  if (activeWorkers.length === 0) {
    return null;
  }

  return (
    <div className="w-full mb-2 animate-in fade-in duration-150">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {activeWorkers.map((worker) => {
          const cfg = ROLE_CONFIG[worker.role] || ROLE_CONFIG.Explorer;
          const Icon = cfg.icon;
          const isError = worker.status === "error";

          return (
            <div
              key={worker.role}
              className={`p-2.5 rounded-xl border ${
                isError
                  ? "border-rose-300 dark:border-rose-800 bg-white dark:bg-zinc-900 text-rose-900 dark:text-rose-200"
                  : `${cfg.lightBorder} dark:${cfg.darkBorder} ${cfg.lightBg} dark:${cfg.darkBg} ${cfg.lightText} dark:${cfg.darkText}`
              } shadow-sm transition-all`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`h-2 w-2 rounded-full ${cfg.dotColor} shrink-0 animate-ping`} />
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="font-semibold text-xs tracking-tight">[{cfg.label}]</span>
                  {worker.iteration !== undefined && (
                    <span className="text-[10px] font-mono text-slate-500 dark:text-zinc-400">
                      iter {worker.iteration}/{worker.maxIterations ?? 5}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {worker.status === "active" ? (
                    <Loader2 className="h-3 w-3 animate-spin text-slate-400 dark:text-zinc-500" />
                  ) : (
                    <CheckCircle className="h-3 w-3 text-emerald-500" />
                  )}
                </div>
              </div>

              {worker.detail && (
                <p className="mt-1 text-[11px] text-slate-600 dark:text-zinc-400 truncate font-mono">
                  {worker.detail}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
