"use client";

import React from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import type { UiHostApproval } from "../ChatStream";

export interface HostApprovalsPanelProps {
  approvals: UiHostApproval[];
  onDecision: (id: string, decision: "approved" | "rejected") => void;
}

export function HostApprovalsPanel({ approvals, onDecision }: HostApprovalsPanelProps) {
  if (approvals.length === 0) return null;

  return (
    <div className="w-full max-w-[840px] space-y-3">
      {approvals.map((approval) => {
        const isPending =
          approval.status === "pending" && (!approval.expiresAt || approval.expiresAt > Date.now());

        if (isPending) {
          return (
            <div
              key={approval.id}
              data-testid="host-approval-card"
              className="w-full rounded-2xl border border-zinc-500/40 bg-white dark:bg-zinc-900 shadow-md p-4 sm:p-5 space-y-3"
            >
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 dark:border-zinc-800 pb-2.5">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-zinc-600 dark:text-zinc-400 shrink-0" />
                  <span className="text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-400">
                    Security Approval Required
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-[11px] font-mono font-medium text-slate-700 dark:text-zinc-300">
                    {approval.tool}
                  </span>
                </div>
                {approval.expiresAt && (
                  <span className="text-[11px] text-slate-500 dark:text-zinc-400 font-mono">
                    Expires:{" "}
                    {new Date(approval.expiresAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                )}
              </div>

              <div className="text-xs text-slate-700 dark:text-zinc-300 font-medium">
                {approval.riskReason}
              </div>

              {(approval.args?.command || approval.args?.path) && (
                <div className="rounded-xl bg-slate-950 p-3 overflow-x-auto text-xs text-zinc-200 font-mono">
                  <pre className="whitespace-pre-wrap break-all">
                    <code>{approval.args?.command || approval.args?.path}</code>
                  </pre>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                {approval.args?.cwd && (
                  <span className="text-slate-500 dark:text-zinc-400 font-mono">
                    cwd: <span className="text-slate-700 dark:text-zinc-200">{approval.args.cwd}</span>
                  </span>
                )}
                {approval.args?.recursive && (
                  <span className="px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20 font-mono font-semibold">
                    recursive: true
                  </span>
                )}
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-1">
                <button
                  type="button"
                  data-testid="host-deny-btn"
                  disabled={approval.isSubmitting}
                  onClick={() => onDecision(approval.id, "rejected")}
                  className="min-h-[38px] px-4 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-700 text-xs font-semibold transition-colors disabled:opacity-50"
                >
                  {approval.isSubmitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" />
                  ) : null}
                  Deny
                </button>
                <button
                  type="button"
                  data-testid="host-approve-btn"
                  disabled={approval.isSubmitting}
                  onClick={() => onDecision(approval.id, "approved")}
                  className="min-h-[38px] px-4 py-1.5 rounded-xl border border-emerald-600 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-sm transition-colors disabled:opacity-50"
                >
                  {approval.isSubmitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" />
                  ) : null}
                  Approve
                </button>
              </div>
            </div>
          );
        }

        return (
          <div
            key={approval.id}
            data-testid="host-approval-receipt"
            className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-900/60 p-3 sm:p-4 text-xs space-y-1.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={`px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider ${
                    approval.status === "executed"
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20"
                      : approval.status === "denied"
                        ? "bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20"
                        : approval.status === "expired"
                          ? "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400 border border-zinc-500/20"
                          : "bg-red-500/10 text-red-700 dark:text-red-400 border border-red-500/20"
                  }`}
                >
                  {approval.status === "executed"
                    ? "Executed"
                    : approval.status === "denied"
                      ? "Denied"
                      : approval.status === "expired"
                        ? "Expired"
                        : "Error"}
                </span>
                <span className="font-mono text-slate-700 dark:text-zinc-300 font-semibold">
                  {approval.tool}
                </span>
              </div>
            </div>

            <div className="text-slate-600 dark:text-zinc-400 font-mono text-[11px] truncate">
              {approval.args?.command || approval.args?.path}
            </div>

            {approval.error && (
              <div className="text-rose-600 dark:text-rose-400 text-[11px]">{approval.error}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
