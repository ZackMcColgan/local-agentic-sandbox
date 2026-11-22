"use client";

import React from "react";
import { ShieldAlert } from "lucide-react";

export interface DangerZoneProps {
  isSelfDeployActive: boolean;
  onToggleSelfDeploy: () => void;
}

export function DangerZone({ isSelfDeployActive, onToggleSelfDeploy }: DangerZoneProps) {
  return (
    <>
      <h2 className="text-lg font-semibold text-rose-700 dark:text-rose-300 mb-3 px-1">
        Danger Zone
      </h2>

      <div className="bg-rose-50 dark:bg-rose-950/30 rounded-3xl p-5 shadow-sm border border-rose-300 dark:border-rose-900 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
              <ShieldAlert className="h-4 w-4 text-rose-600 dark:text-rose-300" />
              <span>Enable self-deploy</span>
            </div>
            <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
              When OFF, self-deploy is completely disabled. Default is OFF.
            </p>
          </div>

          <button
            type="button"
            onClick={onToggleSelfDeploy}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              isSelfDeployActive
                ? "bg-emerald-600 dark:bg-emerald-500"
                : "bg-slate-300 dark:bg-zinc-700"
            }`}
            role="switch"
            aria-checked={isSelfDeployActive}
            data-testid="self-deploy-kill-switch-btn"
            title="Toggle self-deploy kill switch"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                isSelfDeployActive ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </div>
    </>
  );
}
