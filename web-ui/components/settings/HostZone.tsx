"use client";

import React from "react";
import { ChevronDown, GitBranch, Terminal } from "lucide-react";
import type { HostCardPresentation, HostCardRunnerState } from "./hostCard";

export interface HostGitActivityItem {
  timestamp: string;
  verb: string;
  repo: string;
  branch: string;
  result: string;
  error?: string;
  prNumber?: number;
  prUrl?: string;
  mergeSha?: string;
}

export interface HostSettingsData {
  hostAccessEnabled: boolean;
  allowUnattendedHostGit: boolean;
  jobChunkingEnabled: boolean;
  runnerAvailable: boolean;
  runnerState?: HostCardRunnerState;
  runnerReason?: string;
  recentActivity: HostGitActivityItem[];
}

export interface HostZoneProps {
  hostSettings: HostSettingsData;
  hostPresentation: HostCardPresentation;
  gitActivityExpanded: boolean;
  onToggleHostAccess: () => void;
  onToggleJobChunking: () => void;
  onToggleUnattendedGit: () => void;
  onToggleGitActivityExpanded: () => void;
}

export function HostZone({
  hostSettings,
  hostPresentation,
  gitActivityExpanded,
  onToggleHostAccess,
  onToggleJobChunking,
  onToggleUnattendedGit,
  onToggleGitActivityExpanded,
}: HostZoneProps) {
  const gitActivityNewestFirst = [...(hostSettings.recentActivity || [])].slice(-8).reverse();
  const visibleGitActivity = gitActivityExpanded
    ? gitActivityNewestFirst
    : gitActivityNewestFirst.slice(0, 2);

  return (
    <>
      <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
        Host &amp; Unattended Git
      </h2>

      <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
        {/* Primary Global Host Switch */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
              <Terminal className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>Host Access</span>
            </div>
            <p
              data-testid="host-access-status-reason"
              className="text-xs text-slate-500 dark:text-zinc-400 mt-1 max-w-sm"
            >
              {hostPresentation.reasonText}
            </p>
          </div>

          {/* Status Badge */}
          <div
            data-testid="host-access-status-badge"
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${hostPresentation.badgeClass}`}
          >
            <span className={`h-2 w-2 rounded-full ${hostPresentation.dotClass}`} />
            <span>{hostPresentation.badgeLabel}</span>
          </div>
        </div>

        {/* Toggle Switch */}
        <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-zinc-800">
          <span className="text-xs font-semibold text-slate-700 dark:text-zinc-300">
            Enable Host Access
          </span>
          <button
            type="button"
            role="switch"
            data-testid="host-access-toggle-btn"
            aria-checked={hostSettings.hostAccessEnabled}
            onClick={onToggleHostAccess}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              hostSettings.hostAccessEnabled
                ? "bg-emerald-600 dark:bg-emerald-500"
                : "bg-slate-300 dark:bg-zinc-700"
            }`}
            title="Toggle host access switch"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                hostSettings.hostAccessEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Job Chunking Toggle */}
        <div className="flex items-center justify-between gap-4 pt-3 border-t border-slate-100 dark:border-zinc-800">
          <div>
            <div className="text-xs font-semibold text-slate-700 dark:text-zinc-300">
              Job chunking
            </div>
            <p className="text-xs text-slate-600 dark:text-zinc-400 mt-0.5">
              When off, long jobs run in a single turn without banking checkpoints.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            data-testid="job-chunking-toggle-btn"
            aria-checked={hostSettings.jobChunkingEnabled}
            onClick={onToggleJobChunking}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              hostSettings.jobChunkingEnabled
                ? "bg-emerald-600 dark:bg-emerald-500"
                : "bg-slate-300 dark:bg-zinc-700"
            }`}
            title="Toggle job chunking switch"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                hostSettings.jobChunkingEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        <div className="pt-3 border-t border-slate-100 dark:border-zinc-800" />

        {/* Sub-item: Unattended Host Git */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>Allow unattended host git</span>
            </div>
            <p
              data-testid="host-git-status-reason"
              className="text-xs text-slate-500 dark:text-zinc-400 mt-1 max-w-sm"
            >
              {hostSettings.allowUnattendedHostGit
                ? "Permits explicitly-granted unattended and scheduled chat jobs to perform railed Git operations in the host checkout."
                : "Unattended host Git operations are currently disabled. Default is OFF."}
            </p>
          </div>

          {/* Status Badge */}
          <div
            data-testid="host-git-status-badge"
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${
              hostSettings.allowUnattendedHostGit && hostSettings.runnerAvailable
                ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400"
                : hostSettings.allowUnattendedHostGit && !hostSettings.runnerAvailable
                  ? "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 text-zinc-700 dark:text-zinc-400"
                  : "border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-850 text-slate-600 dark:text-zinc-400"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                hostSettings.allowUnattendedHostGit && hostSettings.runnerAvailable
                  ? "bg-emerald-500"
                  : hostSettings.allowUnattendedHostGit && !hostSettings.runnerAvailable
                    ? "bg-zinc-500"
                    : "bg-slate-400 dark:bg-zinc-600"
              }`}
            />
            <span>
              {hostSettings.allowUnattendedHostGit
                ? hostSettings.runnerAvailable
                  ? "Active"
                  : "Runner Offline"
                : "Disabled"}
            </span>
          </div>
        </div>

        {/* Toggle Switch */}
        <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-zinc-800">
          <span className="text-xs font-semibold text-slate-700 dark:text-zinc-300">
            Allow unattended host git
          </span>
          <button
            type="button"
            role="switch"
            data-testid="host-git-toggle-btn"
            aria-checked={hostSettings.allowUnattendedHostGit}
            onClick={onToggleUnattendedGit}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              hostSettings.allowUnattendedHostGit
                ? "bg-emerald-600 dark:bg-emerald-500"
                : "bg-slate-300 dark:bg-zinc-700"
            }`}
            title="Toggle unattended host git switch"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                hostSettings.allowUnattendedHostGit ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Recent Unattended Git Activity (Audit Source: bridge git-ops log) */}
        <div className="pt-3 border-t border-slate-100 dark:border-zinc-800 space-y-2.5">
          <div className="text-xs font-semibold text-slate-700 dark:text-zinc-300 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Terminal className="h-3.5 w-3.5 text-slate-500" />
              <span>Recent Unattended Git Activity</span>
            </div>
            <span className="text-[11px] text-slate-400 dark:text-zinc-400 font-normal">
              {hostSettings.runnerAvailable
                ? "Audit log"
                : "Historical log (runner currently offline)"}
            </span>
          </div>

          {hostSettings.recentActivity && hostSettings.recentActivity.length > 0 ? (
            <div
              data-testid="host-git-activity-list"
              className="space-y-2 max-h-60 overflow-y-auto pr-1"
            >
              {visibleGitActivity.map((item, idx) => (
                <div
                  key={idx}
                  className="p-2.5 rounded-2xl border border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-850/60 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-semibold text-slate-900 dark:text-zinc-100">
                      {item.verb}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        item.result === "success"
                          ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300"
                          : "bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300"
                      }`}
                    >
                      {item.result.toUpperCase()}
                    </span>
                  </div>

                  <div className="text-[11px] text-slate-500 dark:text-zinc-400 flex items-center gap-2">
                    <span>{item.repo || "local-agentic-sandbox"}</span>
                    <span>·</span>
                    <span className="font-mono text-[10px]">{item.branch}</span>
                    {item.timestamp && (
                      <>
                        <span>·</span>
                        <span>
                          {new Date(item.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </>
                    )}
                  </div>

                  {item.prUrl && (
                    <div className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
                      PR #{item.prNumber}: {item.prUrl}
                    </div>
                  )}
                  {item.mergeSha && (
                    <div className="text-[10px] font-mono text-slate-600 dark:text-zinc-400">
                      Merge commit: {item.mergeSha.slice(0, 7)}
                    </div>
                  )}
                  {item.error && (
                    <div className="text-[11px] text-rose-600 dark:text-rose-400 font-medium">
                      {item.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div
              data-testid="host-git-empty-activity"
              className="text-xs text-slate-400 dark:text-zinc-400 italic p-3 text-center bg-slate-50 dark:bg-zinc-850/40 rounded-2xl border border-dashed border-slate-200 dark:border-zinc-800"
            >
              No unattended git operations recorded yet.
            </div>
          )}
          {gitActivityNewestFirst.length > 2 && (
            <button
              type="button"
              data-testid="host-git-activity-expand-btn"
              onClick={onToggleGitActivityExpanded}
              className="flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-300 transition-colors"
            >
              <span>
                {gitActivityExpanded ? "Show less" : `Show all ${gitActivityNewestFirst.length}`}
              </span>
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${gitActivityExpanded ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </div>
      </div>
    </>
  );
}
