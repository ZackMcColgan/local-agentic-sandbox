"use client";

import React, { useState } from "react";
import { Terminal, ShieldCheck, Clock, ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, Copy, Check } from "lucide-react";

export interface ExecutionTraceItem {
  tool: string;
  args: Record<string, any>;
  result: any;
  durationMs: number;
  timestamp: string;
  model?: string;
  tier?: "sandbox" | "browser";
}

interface ExecutionTraceProps {
  traces: ExecutionTraceItem[];
}

export function ExecutionTrace({ traces }: ExecutionTraceProps) {
  const [openIndexes, setOpenIndexes] = useState<Record<number, boolean>>({ 0: true });
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const toggleIndex = (index: number) => {
    setOpenIndexes((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  if (!traces || traces.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 text-center shadow-sm">
        <Terminal className="h-8 w-8 text-slate-400 dark:text-zinc-600 mx-auto mb-2 opacity-50" />
        <h4 className="text-sm font-medium text-slate-700 dark:text-zinc-300">No Tool Executions Yet</h4>
        <p className="text-xs text-slate-500 dark:text-zinc-400 mt-1 max-w-sm mx-auto">
          When the autonomous agent invokes tools inside the sandboxed container, execution logs and security boundary proofs will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <h3 className="text-sm font-medium text-slate-800 dark:text-zinc-200">
            Agent Execution Trace ({traces.length})
          </h3>
        </div>
        <span className="text-[11px] font-mono text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-950/60 border border-emerald-300 dark:border-emerald-500/20 px-2 py-0.5 rounded font-medium">
          Sandboxed Boundary Active
        </span>
      </div>

      <div className="space-y-2">
        {traces.map((trace, idx) => {
          const isOpen = !!openIndexes[idx];
          const isSuccess = !trace.result?.isError && (!trace.result?.content?.[0]?.text?.includes("EXECUTION_ERROR"));

          // Parse result text if it's formatted as stringified JSON
          let parsedResult: any = trace.result;
          try {
            if (trace.result?.content?.[0]?.text) {
              parsedResult = JSON.parse(trace.result.content[0].text);
            }
          } catch {
            // Keep as-is
          }

          return (
            <div
              key={idx}
              className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-sm transition-all duration-200"
            >
              {/* Accordion Header */}
              <button
                type="button"
                onClick={() => toggleIndex(idx)}
                className="w-full px-3.5 py-2.5 flex items-center justify-between text-left hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 text-slate-400 dark:text-zinc-500" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-slate-400 dark:text-zinc-500" />
                  )}
                  {isSuccess ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 dark:text-emerald-400 shrink-0" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-rose-500 dark:text-rose-400 shrink-0" />
                  )}
                  <span className="font-mono text-xs font-semibold text-slate-800 dark:text-zinc-200">
                    {trace.tool}
                  </span>
                </div>

                <div className="flex items-center gap-2.5 text-[11px] font-mono text-slate-500 dark:text-zinc-400">
                  {trace.model && (
                    <span className="hidden sm:inline-block px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/20 text-[10px]">
                      {trace.model}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {trace.durationMs}ms
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-200 dark:border-zinc-700">
                    Step #{idx + 1}
                  </span>
                </div>
              </button>

              {/* Accordion Body */}
              {isOpen && (
                <div className="p-3.5 pt-0 border-t border-slate-100 dark:border-zinc-800/80 space-y-3 bg-slate-50/50 dark:bg-zinc-950/40">
                  
                  {/* Tool Arguments / Code */}
                  <div>
                    <div className="text-[11px] font-mono text-slate-500 dark:text-zinc-400 mb-1 flex items-center justify-between">
                      <span>Payload Arguments:</span>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(JSON.stringify(trace.args, null, 2), idx)}
                        className="text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-white flex items-center gap-1 text-[10px]"
                      >
                        {copiedIndex === idx ? (
                          <>
                            <Check className="h-3 w-3 text-emerald-500" />
                            <span className="text-emerald-500">Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" />
                            <span>Copy Payload</span>
                          </>
                        )}
                      </button>
                    </div>
                    <pre className="text-xs font-mono bg-slate-900 dark:bg-black p-2.5 rounded-lg border border-slate-800 dark:border-zinc-800 text-cyan-300 overflow-x-auto max-h-48">
                      {JSON.stringify(trace.args, null, 2)}
                    </pre>
                  </div>

                  {/* Execution Output */}
                  <div>
                    <div className="text-[11px] font-mono text-slate-500 dark:text-zinc-400 mb-1">
                      Execution Result & Sandbox Attestation:
                    </div>
                    <pre className="text-xs font-mono bg-slate-900 dark:bg-black p-2.5 rounded-lg border border-slate-800 dark:border-zinc-800 text-emerald-300 overflow-x-auto max-h-56">
                      {typeof parsedResult === "object"
                        ? JSON.stringify(parsedResult, null, 2)
                        : String(parsedResult)}
                    </pre>
                  </div>

                  {/* Dynamic Security Boundary Badges */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    {trace.tier === "browser" ? (
                      <>
                        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-100 dark:bg-cyan-950/60 text-cyan-700 dark:text-cyan-400 border border-cyan-300 dark:border-cyan-500/30">
                          <ShieldCheck className="h-3 w-3" />
                          Egress: PERMITTED (Isolated Scraper)
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-200 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-300 dark:border-zinc-700">
                          UID: 10002
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-200 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-300 dark:border-zinc-700">
                          SSRF Guard: ACTIVE
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-200 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-300 dark:border-zinc-700">
                          Network: egress-mesh
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-500/30">
                          <ShieldCheck className="h-3 w-3" />
                          Egress: BLOCKED (Air-Gapped)
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-200 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-300 dark:border-zinc-700">
                          UID: 10001
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-200 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-300 dark:border-zinc-700">
                          RootFS: READ_ONLY
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-200 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-300 dark:border-zinc-700">
                          cap_drop: ALL
                        </span>
                      </>
                    )}
                  </div>

                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
