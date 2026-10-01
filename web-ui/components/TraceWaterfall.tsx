"use strict";
"use client";

import React, { useState, useEffect } from "react";
import { Activity, Clock, Cpu, ShieldCheck, Terminal, Layers, RefreshCw, ChevronDown, ChevronRight, CheckCircle2, AlertCircle } from "lucide-react";

export interface AgentSpan {
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  sessionId: string;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: "ok" | "error";
  attributes: Record<string, any>;
}

export interface TraceSession {
  sessionId: string;
  traceId: string;
  rootSpan?: AgentSpan;
  spans: AgentSpan[];
  startTime: number;
  endTime?: number;
  totalDurationMs?: number;
}

interface TraceWaterfallProps {
  sessionId?: string;
}

const SPAN_CONFIG: Record<string, { label: string; color: string; bgLight: string; bgDark: string; borderLight: string; borderDark: string }> = {
  "agent.turn": {
    label: "Root Agent Turn",
    color: "#059669",
    bgLight: "bg-emerald-50",
    bgDark: "bg-emerald-950/40",
    borderLight: "border-emerald-300",
    borderDark: "border-emerald-600/40"
  },
  "router.triage": {
    label: "Router Triage (Flash)",
    color: "#7c3aed",
    bgLight: "bg-purple-50",
    bgDark: "bg-purple-950/40",
    borderLight: "border-purple-300",
    borderDark: "border-purple-600/40"
  },
  "model.reasoning": {
    label: "Model Reasoning / Thought",
    color: "#d97706",
    bgLight: "bg-amber-50",
    bgDark: "bg-amber-950/40",
    borderLight: "border-amber-300",
    borderDark: "border-amber-600/40"
  },
  "mcp.tool_call": {
    label: "MCP Tool Call Dispatch",
    color: "#0284c7",
    bgLight: "bg-sky-50",
    bgDark: "bg-sky-950/40",
    borderLight: "border-sky-300",
    borderDark: "border-sky-600/40"
  },
  "sandbox.bash_exec": {
    label: "Sandbox Bash / Pytest Exec",
    color: "#e11d48",
    bgLight: "bg-rose-50",
    bgDark: "bg-rose-950/40",
    borderLight: "border-rose-300",
    borderDark: "border-rose-600/40"
  },
  "model.synthesis": {
    label: "Final Synthesis",
    color: "#0d9488",
    bgLight: "bg-teal-50",
    bgDark: "bg-teal-950/40",
    borderLight: "border-teal-300",
    borderDark: "border-teal-600/40"
  }
};

export const TraceWaterfall: React.FC<TraceWaterfallProps> = ({ sessionId }) => {
  const [session, setSession] = useState<TraceSession | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [expandedSpanId, setExpandedSpanId] = useState<string | null>(null);

  const fetchTraceData = async () => {
    setIsLoading(true);
    try {
      const url = sessionId ? `/api/traces?sessionId=${encodeURIComponent(sessionId)}` : `/api/traces`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.session) {
          setSession(data.session);
        } else if (data.latest_session) {
          setSession(data.latest_session);
        }
      }
    } catch (err) {
      console.warn("[TraceWaterfall] Error fetching traces:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTraceData();
  }, [sessionId]);

  // Compute timing offsets and spans
  const spans = session?.spans || [];
  const sessionStart = session?.startTime || (spans[0]?.startTime ?? 0);
  const totalDuration = Math.max(
    session?.totalDurationMs || 0,
    spans.reduce((max, s) => {
      const spanEnd = s.endTime || (s.startTime + (s.durationMs || 10));
      return Math.max(max, spanEnd - sessionStart);
    }, 100),
    50
  );

  return (
    <div className="flex flex-col gap-4 w-full">
      {/* Header bar */}
      <div className="flex items-center justify-between flex-wrap gap-2 px-1">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-zinc-100">
            OpenTelemetry Distributed Tracing Waterfall
          </h2>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/70 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800">
            OTLP 4318 Active
          </span>
        </div>

        <button
          onClick={fetchTraceData}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Overview Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="flex flex-col p-3 rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm">
          <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">Total Duration</span>
          <span className="text-lg font-bold text-slate-900 dark:text-zinc-100 font-mono">
            {totalDuration.toLocaleString()} ms
          </span>
        </div>

        <div className="flex flex-col p-3 rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm">
          <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">Active Spans</span>
          <span className="text-lg font-bold text-slate-900 dark:text-zinc-100 font-mono">
            {spans.length}
          </span>
        </div>

        <div className="flex flex-col p-3 rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm">
          <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">Security Boundary</span>
          <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1 mt-1 font-mono">
            <ShieldCheck className="w-3.5 h-3.5" />
            UID 10001 Sandboxed
          </span>
        </div>

        <div className="flex flex-col p-3 rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm">
          <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">Trace ID</span>
          <span className="text-[11px] font-mono text-slate-700 dark:text-zinc-300 truncate mt-1" title={session?.traceId || "No active trace"}>
            {session?.traceId ? `${session.traceId.slice(0, 12)}...` : "idle"}
          </span>
        </div>
      </div>

      {/* Waterfall Visualizer Gantt Chart */}
      <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-sm">
        {/* Waterfall Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-zinc-950/60 border-b border-slate-200 dark:border-zinc-800 text-[11px] font-medium text-slate-500 dark:text-zinc-400">
          <div className="w-1/3 min-w-[120px]">Span Operation</div>
          <div className="flex-1 flex justify-between px-2 font-mono">
            <span>0 ms</span>
            <span>{Math.round(totalDuration / 2)} ms</span>
            <span>{Math.round(totalDuration)} ms</span>
          </div>
          <div className="w-20 text-right">Duration</div>
        </div>

        {/* Spans List */}
        <div className="divide-y divide-slate-100 dark:divide-zinc-800/60">
          {spans.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400 dark:text-zinc-500">
              No OpenTelemetry spans recorded yet. Trigger a query or command in chat to stream live distributed spans.
            </div>
          ) : (
            spans.map((span) => {
              const cfg = SPAN_CONFIG[span.name] || {
                label: span.name,
                color: "#64748b",
                bgLight: "bg-slate-100",
                bgDark: "bg-zinc-800",
                borderLight: "border-slate-300",
                borderDark: "border-zinc-700"
              };

              const offsetMs = Math.max(0, span.startTime - sessionStart);
              const durationMs = span.durationMs || (span.endTime ? Math.max(1, span.endTime - span.startTime) : 10);
              const leftPercent = Math.min(95, Math.max(0, (offsetMs / totalDuration) * 100));
              const widthPercent = Math.min(100 - leftPercent, Math.max(3, (durationMs / totalDuration) * 100));
              const isExpanded = expandedSpanId === span.spanId;

              return (
                <div key={span.spanId} className="flex flex-col hover:bg-slate-50/70 dark:hover:bg-zinc-800/40 transition-colors">
                  <div
                    onClick={() => setExpandedSpanId(isExpanded ? null : span.spanId)}
                    className="flex items-center px-3 py-2 text-xs cursor-pointer select-none"
                  >
                    {/* Span Title & Chevron */}
                    <div className="w-1/3 min-w-[120px] flex items-center gap-1.5 pr-2 truncate">
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 text-slate-400" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 text-slate-400" />
                      )}
                      {span.status === "ok" ? (
                        <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 text-emerald-500" />
                      ) : (
                        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 text-rose-500" />
                      )}
                      <span className="font-mono text-[11px] font-semibold text-slate-800 dark:text-zinc-200 truncate">
                        {span.name}
                      </span>
                    </div>

                    {/* Gantt Bar Lane */}
                    <div className="flex-1 relative h-5 bg-slate-100/60 dark:bg-zinc-950/40 rounded mx-2 overflow-hidden flex items-center">
                      <div
                        style={{
                          left: `${leftPercent}%`,
                          width: `${widthPercent}%`,
                          backgroundColor: cfg.color
                        }}
                        className="absolute h-3.5 rounded shadow-sm opacity-90 transition-all duration-300"
                        title={`${span.name}: ${durationMs}ms (+${offsetMs}ms)`}
                      />
                    </div>

                    {/* Duration Label */}
                    <div className="w-20 text-right font-mono text-[11px] font-medium text-slate-600 dark:text-zinc-400">
                      {durationMs} ms
                    </div>
                  </div>

                  {/* Expanded Detail View */}
                  {isExpanded && (
                    <div className="px-6 py-3 bg-slate-50/90 dark:bg-zinc-950/80 border-t border-slate-100 dark:border-zinc-800/70 text-[11px] flex flex-col gap-2">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-slate-600 dark:text-zinc-400">
                        <div>
                          <span className="font-semibold block text-slate-700 dark:text-zinc-300">Span ID:</span>
                          <span className="font-mono text-[10px]">{span.spanId}</span>
                        </div>
                        <div>
                          <span className="font-semibold block text-slate-700 dark:text-zinc-300">Parent ID:</span>
                          <span className="font-mono text-[10px]">{span.parentSpanId || "root"}</span>
                        </div>
                        <div>
                          <span className="font-semibold block text-slate-700 dark:text-zinc-300">Offset:</span>
                          <span className="font-mono">+{offsetMs} ms</span>
                        </div>
                        <div>
                          <span className="font-semibold block text-slate-700 dark:text-zinc-300">Status:</span>
                          <span className={`font-semibold ${span.status === "ok" ? "text-emerald-600" : "text-rose-600"}`}>
                            {span.status.toUpperCase()}
                          </span>
                        </div>
                      </div>

                      {Object.keys(span.attributes).length > 0 && (
                        <div>
                          <span className="font-semibold block text-slate-700 dark:text-zinc-300 mb-1">Attributes:</span>
                          <pre className="p-2 rounded bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 font-mono text-[10px] overflow-x-auto text-slate-800 dark:text-zinc-200">
                            {JSON.stringify(span.attributes, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
