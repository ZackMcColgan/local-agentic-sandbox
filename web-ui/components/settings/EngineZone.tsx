"use client";

import React from "react";
import { ChevronRight, Cpu, Play, Square, RotateCw } from "lucide-react";
import { formatModelDisplayLabel } from "../../lib/chatUtils";

export interface EngineStatusData {
  status: string;
  reachable: boolean;
  engine?: string | null;
  backend?: string | null;
  model?: string | null;
  vram_mb?: number | null;
  uptime_s?: number | null;
  error?: string;
}

export interface EngineZoneProps {
  engineData: EngineStatusData;
  engineLoading: boolean;
  engineMessage: string | null;
  activeModel: string;
  reasoningEffort: "low" | "medium" | "xhigh";
  onEngineAction: (action: "start" | "stop" | "restart") => void;
  onOpenModelSheet?: () => void;
}

function getReasoningLabel(effort: "low" | "medium" | "xhigh"): string {
  if (effort === "low") return "Fast";
  if (effort === "medium") return "Balanced";
  return "Deep";
}

export function EngineZone({
  engineData,
  engineLoading,
  engineMessage,
  activeModel,
  reasoningEffort,
  onEngineAction,
  onOpenModelSheet,
}: EngineZoneProps) {
  return (
    <>
      <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
        Engine Management
      </h2>

      <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
              <Cpu className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>
                {engineData.engine ||
                  (engineData.reachable ? "Inference Engine" : "Inference Engine")}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
              {engineData.backend
                ? engineData.backend
                : engineData.reachable
                  ? "Connected via local engine endpoint."
                  : "Waiting for engine status."}
            </p>
          </div>

          {/* Status Badge */}
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-850">
            {engineData.status === "running" ? (
              <>
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-emerald-700 dark:text-emerald-400">Running</span>
              </>
            ) : engineData.status === "starting" ? (
              <>
                <span className="h-2 w-2 rounded-full bg-zinc-500 animate-pulse" />
                <span className="text-zinc-700 dark:text-zinc-400">Starting...</span>
              </>
            ) : (
              <>
                <span className="h-2 w-2 rounded-full bg-slate-400 dark:bg-zinc-600" />
                <span className="text-slate-600 dark:text-zinc-400">Stopped</span>
              </>
            )}
          </div>
        </div>

        {/* Model & VRAM Specs */}
        <div className="grid grid-cols-2 gap-2 text-xs bg-slate-50 dark:bg-zinc-850 p-3 rounded-2xl border border-slate-100 dark:border-zinc-800">
          <div>
            <span className="text-slate-400 dark:text-zinc-400 block">Model</span>
            <span className="font-semibold text-slate-800 dark:text-zinc-200">
              {engineData.model || "Not reported by this engine"}
            </span>
          </div>
          <div>
            <span className="text-slate-400 dark:text-zinc-400 block">VRAM Usage</span>
            <span className="font-semibold text-slate-800 dark:text-zinc-200">
              {typeof engineData.vram_mb === "number"
                ? `${engineData.vram_mb.toLocaleString()} MB`
                : "Not reported by this engine"}
            </span>
          </div>
        </div>

        {/* Action Feedback Message */}
        {engineMessage && (
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 p-2.5 rounded-xl border border-emerald-200 dark:border-emerald-800">
            {engineMessage}
          </div>
        )}

        {/* Start / Stop / Restart Control Buttons */}
        <div className="grid grid-cols-3 gap-2 pt-1">
          <button
            type="button"
            disabled={engineLoading || engineData.status === "running"}
            onClick={() => onEngineAction("start")}
            className={`min-h-[44px] py-2 px-3 rounded-2xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
              engineData.status === "running"
                ? "cursor-not-allowed bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-300"
                : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs"
            }`}
            title="Start llama-server"
            aria-label="Start llama-server"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            <span>Start</span>
          </button>

          <button
            type="button"
            disabled={engineLoading || engineData.status === "stopped"}
            onClick={() => onEngineAction("stop")}
            className={`min-h-[44px] py-2 px-3 rounded-2xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
              engineData.status === "stopped"
                ? "cursor-not-allowed bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-300"
                : "bg-rose-50 hover:bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:hover:bg-rose-900/50 dark:text-rose-300 border border-rose-200 dark:border-rose-800"
            }`}
            title="Stop llama-server to reclaim VRAM"
            aria-label="Stop llama-server"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
            <span>Stop</span>
          </button>

          <button
            type="button"
            disabled={engineLoading}
            onClick={() => onEngineAction("restart")}
            className="min-h-[44px] py-2 px-3 rounded-2xl text-xs font-semibold flex items-center justify-center gap-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 transition-colors border border-slate-200 dark:border-zinc-700"
            title="Restart llama-server"
            aria-label="Restart llama-server"
          >
            <RotateCw className={`h-3.5 w-3.5 ${engineLoading ? "animate-spin" : ""}`} />
            <span>Restart</span>
          </button>
        </div>
      </div>
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-300 mb-2 px-1">
          Models
        </h3>

        <div
          onClick={onOpenModelSheet}
          className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 flex items-center justify-between cursor-pointer hover:bg-slate-50/80 dark:hover:bg-zinc-850/80 transition-colors"
        >
          <div className="space-y-1">
            <div className="text-base font-semibold text-slate-900 dark:text-zinc-100">
              Default model
            </div>
            <div className="text-xs text-slate-500 dark:text-zinc-400">
              {formatModelDisplayLabel(activeModel)} · {getReasoningLabel(reasoningEffort)}
            </div>
          </div>

          <ChevronRight className="h-5 w-5 text-slate-400 dark:text-zinc-400" />
        </div>
      </div>
    </>
  );
}
