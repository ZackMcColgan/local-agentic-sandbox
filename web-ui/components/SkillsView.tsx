"use client";

import React from "react";
import { Menu, Wrench } from "lucide-react";

interface SkillsViewProps {
  onOpenDrawer: () => void;
  pendingCount?: number;
}

export function SkillsView({ onOpenDrawer }: SkillsViewProps) {
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[#f4f3f7] dark:bg-zinc-950 overflow-y-auto">
      <div className="max-w-3xl mx-auto w-full p-4 sm:p-6 space-y-6">
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-4 shadow-sm border border-slate-100 dark:border-zinc-800 flex items-center gap-3">
          <button
            type="button"
            onClick={onOpenDrawer}
            className="p-1.5 rounded-full text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            title="Open menu"
          >
            <Menu className="h-6 w-6" />
          </button>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">Skills</h1>
        </div>

        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-sm border border-slate-100 dark:border-zinc-800 text-center space-y-2">
          <div className="h-12 w-12 rounded-2xl bg-slate-100 dark:bg-zinc-800 flex items-center justify-center mx-auto text-slate-400">
            <Wrench className="h-6 w-6" />
          </div>
          <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">No skills to review</h3>
          <p className="text-xs text-slate-600 dark:text-zinc-400 max-w-sm mx-auto">
            Skill candidates proposed by the recorder will appear here for approval once the skills service is connected to the UI.
          </p>
        </div>
      </div>
    </div>
  );
}
