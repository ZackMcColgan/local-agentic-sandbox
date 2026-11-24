"use client";

import React from "react";
import { ChevronDown, AlertTriangle, ShieldCheck, History } from "lucide-react";

export interface DeployHistoryItem {
  deployId: string;
  timestamp: string;
  branchName: string;
  previousSha: string;
  newSha: string;
  status: "deployed" | "rolled_back" | "failed";
  rollbackStatus: "none" | "rolled_back";
  healthCheckStatus?: number;
  errorMessage?: string;
}

export interface SelfDeployZoneProps {
  isSelfDeployActive: boolean;
  deployHistory: DeployHistoryItem[];
  deployHistoryExpanded: boolean;
  onToggleDeployHistoryExpanded: () => void;
}

export function SelfDeployZone({
  isSelfDeployActive,
  deployHistory,
  deployHistoryExpanded,
  onToggleDeployHistoryExpanded,
}: SelfDeployZoneProps) {
  const visibleDeployHistory = deployHistoryExpanded ? deployHistory : deployHistory.slice(0, 2);

  return (
    <>
      <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
        Self-Deploy Pipeline
      </h2>

      <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>Self-deploy status</span>
            </div>
            <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
              {isSelfDeployActive ? (
                <>
                  Self-deploy is ON. Its kill switch lives in the{" "}
                  <a
                    href="#settings-danger-zone"
                    className="underline hover:text-emerald-600 dark:hover:text-emerald-400"
                  >
                    Danger Zone
                  </a>
                  .
                </>
              ) : (
                <>
                  Self-deploy is OFF (kill switch engaged). Its kill switch lives in the{" "}
                  <a
                    href="#settings-danger-zone"
                    className="underline hover:text-emerald-600 dark:hover:text-emerald-400"
                  >
                    Danger Zone
                  </a>
                  .
                </>
              )}
            </p>
          </div>
          <div
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${isSelfDeployActive ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400" : "border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-850 text-slate-600 dark:text-zinc-400"}`}
          >
            <span
              className={`h-2 w-2 rounded-full ${isSelfDeployActive ? "bg-emerald-500" : "bg-slate-400 dark:bg-zinc-600"}`}
            />
            <span>{isSelfDeployActive ? "ON" : "OFF"}</span>
          </div>
        </div>

        {/* Deploy History with LOUD rollback alerts */}
        {deployHistory.length > 0 && (
          <div className="pt-3 border-t border-slate-100 dark:border-zinc-800 space-y-2.5">
            <div className="text-xs font-semibold text-slate-700 dark:text-zinc-300 flex items-center gap-1.5">
              <History className="h-3.5 w-3.5 text-slate-600 dark:text-zinc-400" />
              <span>Recent Self-Deploy History</span>
            </div>

            <div
              className={
                deployHistoryExpanded ? "space-y-2 max-h-[220px] overflow-y-auto pr-1" : "space-y-2"
              }
            >
              {visibleDeployHistory.map((item) => {
                const isRolledBack =
                  item.status === "rolled_back" || item.rollbackStatus === "rolled_back";
                return (
                  <div
                    key={item.deployId}
                    className={`p-3 rounded-2xl border text-xs space-y-1.5 ${
                      isRolledBack
                        ? "bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-900 text-rose-950 dark:text-rose-100 shadow-xs"
                        : "bg-slate-50 dark:bg-zinc-850/60 border-slate-200 dark:border-zinc-800 text-slate-800 dark:text-zinc-200"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{item.branchName}</span>
                      {isRolledBack ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold tracking-wider uppercase bg-rose-600 text-white flex items-center gap-1 animate-pulse">
                          <AlertTriangle className="h-3 w-3" />
                          <span>ROLLED BACK</span>
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300">
                          DEPLOYED
                        </span>
                      )}
                    </div>

                    <div className="font-mono text-[11px] opacity-80">
                      {item.previousSha?.slice(0, 7)} → {item.newSha?.slice(0, 7)}
                    </div>

                    {item.errorMessage && (
                      <div className="text-[11px] font-medium text-rose-700 dark:text-rose-300">
                        {item.errorMessage}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {deployHistory.length > 2 && (
              <button
                type="button"
                data-testid="deploy-history-expand-btn"
                onClick={onToggleDeployHistoryExpanded}
                className="flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-300 transition-colors"
              >
                <span>
                  {deployHistoryExpanded ? "Show less" : `Show all ${deployHistory.length}`}
                </span>
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${deployHistoryExpanded ? "rotate-180" : ""}`}
                />
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
