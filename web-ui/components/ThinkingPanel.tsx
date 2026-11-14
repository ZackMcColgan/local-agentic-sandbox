"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  ChevronDown,
  ChevronUp,
  Map,
  Cog,
  CheckCircle2,
  Loader2
} from "lucide-react";

import { resolveTurnStatusPhase } from "../lib/chatStatus";
import { formatElapsedDuration } from "../lib/chatUtils";
import { formatThoughtLabel } from "../lib/liveActivity";

export type ThinkingPhaseKey = "planning" | "building" | "validating";

export interface ThinkingPhaseCardData {
  phase: ThinkingPhaseKey;
  title: string;
  timestamp: string;
  timeAgo?: string;
  narrative: string;
  status: "complete" | "in_progress" | "pending";
  /** Legacy field kept for data compatibility; never rendered (UI-017). */
  progressPercent?: number;
}

interface ThinkingPanelProps {
  phases?: ThinkingPhaseCardData[];
  rawThought?: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  onToggleExpand?: () => void;
  className?: string;
  streamStatus?: string | null;
  activeTool?: string | null;
  hasContent?: boolean;
  durationMs?: number;
}

export function ThinkingPanel({
  phases = [],
  rawThought = "",
  isStreaming = false,
  defaultExpanded = true,
  className = "",
  streamStatus = null,
  activeTool = null,
  hasContent = false,
  durationMs
}: ThinkingPanelProps) {
  const [isExpanded, setIsExpanded] = useState<boolean>(Boolean(isStreaming && defaultExpanded));
  const prevStreamingRef = useRef(isStreaming);
  const userToggledRef = useRef(false);

  // Thinking duration: measured from the first streaming render to the
  // moment the stream ends, so the collapsed row can honestly read
  // "Thought for …". Panels mounted after the fact have no measured
  // duration and never fabricate one.
  const streamStartRef = useRef<number | null>(null);
  const [thoughtDurationMs, setThoughtDurationMs] = useState<number | null>(durationMs ?? null);
  const [headerNowMs, setHeaderNowMs] = useState<number>(() => Date.now());
  if (isStreaming && streamStartRef.current === null) {
    streamStartRef.current = Date.now();
  }

  useEffect(() => {
    if (durationMs != null) {
      setThoughtDurationMs(durationMs);
    }
  }, [durationMs]);

  useEffect(() => {
    if (!isStreaming) return;
    const timer = setInterval(() => setHeaderNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isStreaming]);

  // Auto-collapse when generation finishes unless the user manually toggled it
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      if (streamStartRef.current !== null) {
        setThoughtDurationMs(Date.now() - streamStartRef.current);
        streamStartRef.current = null;
      }
      if (!userToggledRef.current) {
        setIsExpanded(false);
      }
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const handleToggle = () => {
    userToggledRef.current = true;
    setIsExpanded((prev) => !prev);
  };

  const formattedTime = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const effectivePhases: ThinkingPhaseCardData[] = (() => {
    if (phases && phases.length > 0) return phases;

    if (rawThought && rawThought.trim()) {
      return [
        {
          phase: "planning",
          title: isStreaming ? "Reasoning in progress" : "Reasoning summary",
          timestamp: formattedTime,
          timeAgo: "Now",
          narrative: rawThought.trim(),
          status: isStreaming ? "in_progress" : "complete"
        }
      ];
    }

    return [];
  })();

  const activeStepsCount = effectivePhases.length;

  const turnPhaseLabel = resolveTurnStatusPhase({
    isStreaming,
    streamStatus,
    activeTool,
    hasThought: Boolean(rawThought && rawThought.trim()),
    hasContent
  });

  const streamStartMs = streamStartRef.current;
  const effectiveDurationMs = thoughtDurationMs ?? durationMs ?? null;
  const headerTitle = isStreaming
    ? "Thinking"
    : effectiveDurationMs != null && effectiveDurationMs > 0
      ? `Thought for ${formatElapsedDuration(Math.max(1, Math.floor(effectiveDurationMs / 1000)))}`
      : "Thought";

  return (
    <div
      data-testid="thinking-panel"
      className={`w-full max-w-2xl rounded-2xl bg-slate-50/90 dark:bg-zinc-900/90 border border-slate-200/80 dark:border-zinc-800 text-slate-800 dark:text-zinc-200 shadow-2xs overflow-hidden transition-all duration-200 ${className}`}
    >
      {/* Compact 1-Line Header Bar */}
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center justify-between px-3.5 py-2.5 sm:px-4 sm:py-3 text-left group transition-colors hover:bg-slate-100/70 dark:hover:bg-zinc-855/60 focus:outline-none"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full shrink-0 ${
              isStreaming
                ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)] animate-pulse"
                : "bg-emerald-500"
            }`}
          />
          <span className="text-[13px] font-bold text-slate-800 dark:text-zinc-100 truncate">
            {headerTitle}
          </span>
          {isStreaming && streamStartMs !== null && (
            <span className="font-mono tabular-nums text-[11px] text-slate-500 dark:text-zinc-400 shrink-0">
              {formatElapsedDuration(Math.max(0, Math.floor((headerNowMs - streamStartMs) / 1000)))}
            </span>
          )}
          <span
            data-testid="streaming-badge"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800/50 text-emerald-800 dark:text-emerald-300 shrink-0"
          >
            {isStreaming && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
            <span>
              {isStreaming ? (
                <>
                  <span className="hidden sm:inline">Streaming · </span>
                  {activeStepsCount} {activeStepsCount === 1 ? "step" : "steps"}
                </>
              ) : (
                <>
                  <span>Thought process · </span>
                  {activeStepsCount} {activeStepsCount === 1 ? "step" : "steps"}
                </>
              )}
            </span>
          </span>

          {isStreaming && turnPhaseLabel && (
            <span
              data-testid="turn-status-slot"
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800/50 text-emerald-800 dark:text-emerald-300 shrink-0"
            >
              <Loader2 className="h-3 w-3 animate-spin text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span className="truncate">{turnPhaseLabel}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-zinc-400 group-hover:text-slate-800 dark:group-hover:text-zinc-200 shrink-0 ml-2">
          <span>{isExpanded ? "Hide" : "Show"}</span>
          {isExpanded ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </div>
      </button>

      {/* Expanded Body */}
      {isExpanded && (
        <div className="p-3 sm:p-3.5 space-y-2.5 border-t border-slate-200/60 dark:border-zinc-800/80 bg-white/60 dark:bg-black/40">
          {effectivePhases.map((phaseItem) => {
            const isPlanning = phaseItem.phase === "planning";
            const isBuilding = phaseItem.phase === "building";
            const isValidating = phaseItem.phase === "validating";

            const Icon = isPlanning ? Map : isBuilding ? Cog : CheckCircle2;
            const isInProgress = phaseItem.status === "in_progress";

            return (
              <div
                key={phaseItem.phase}
                data-testid={`phase-card-${phaseItem.phase}`}
                className="p-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200/70 dark:border-zinc-800/80 space-y-2 shadow-2xs"
              >
                {/* Card Title & Meta */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200/50 dark:border-emerald-800/40 flex items-center justify-center shrink-0">
                      <Icon className="h-3.5 w-3.5 stroke-[2.2]" />
                    </div>
                    <h4 className="text-xs font-semibold text-slate-800 dark:text-zinc-100 truncate">
                      {phaseItem.title}
                    </h4>
                  </div>

                  <div className="text-right text-[10px] font-mono text-slate-400 dark:text-zinc-500 shrink-0">
                    <span>{phaseItem.timestamp}</span>
                    {phaseItem.timeAgo && <span> • {phaseItem.timeAgo}</span>}
                  </div>
                </div>

                {/* Narrative Text — full reasoning, bottom fade while streaming.
                    No progress bar: a turn's total length is unknowable, so a
                    percent-complete would be fabricated (UI-017). */}
                <div className="relative">
                  <div className="text-[13px] text-slate-600 dark:text-zinc-100 leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto pr-1">
                    {phaseItem.narrative}
                  </div>
                  {isInProgress && (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-white dark:from-zinc-900 to-transparent"
                    />
                  )}
                </div>
              </div>
            );
          })}


        </div>
      )}
    </div>
  );
}
