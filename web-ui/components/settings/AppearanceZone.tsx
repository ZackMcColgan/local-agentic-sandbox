"use client";

import React from "react";
import { Check } from "lucide-react";

export type ThemeMode = "light" | "dark" | "system";

export interface AppearanceZoneProps {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}

function getThemeDescription(themeMode: ThemeMode): string {
  if (themeMode === "light") return "Light — easy on the eyes during the day.";
  if (themeMode === "dark") return "Dark — low light comfort with high contrast.";
  return "System — matches your operating system preference.";
}

export function AppearanceZone({ themeMode, onThemeChange }: AppearanceZoneProps) {
  return (
    <>
      <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
        Appearance
      </h2>

      <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
        <label className="block text-sm font-semibold text-slate-900 dark:text-zinc-100">
          Theme
        </label>

        {/* Segmented Button: Light | Dark | System */}
        <div className="grid grid-cols-3 gap-1 bg-slate-100 dark:bg-zinc-800 p-1 rounded-full">
          <button
            type="button"
            onClick={() => onThemeChange("light")}
            className={`py-2 px-3 rounded-full text-sm font-semibold flex items-center justify-center gap-1.5 transition-all ${
              themeMode === "light"
                ? "bg-emerald-600 dark:bg-emerald-500 text-white shadow-sm"
                : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
            }`}
          >
            {themeMode === "light" && <Check className="h-4 w-4 stroke-[2.5]" />}
            <span>Light</span>
          </button>

          <button
            type="button"
            onClick={() => onThemeChange("dark")}
            className={`py-2 px-3 rounded-full text-sm font-semibold flex items-center justify-center gap-1.5 transition-all ${
              themeMode === "dark"
                ? "bg-emerald-600 dark:bg-emerald-500 text-white shadow-sm"
                : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
            }`}
          >
            {themeMode === "dark" && <Check className="h-4 w-4 stroke-[2.5]" />}
            <span>Dark</span>
          </button>

          <button
            type="button"
            onClick={() => onThemeChange("system")}
            className={`py-2 px-3 rounded-full text-sm font-semibold flex items-center justify-center gap-1.5 transition-all ${
              themeMode === "system"
                ? "bg-emerald-600 dark:bg-emerald-500 text-white shadow-sm"
                : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
            }`}
          >
            {themeMode === "system" && <Check className="h-4 w-4 stroke-[2.5]" />}
            <span>System</span>
          </button>
        </div>

        <p className="text-xs text-slate-500 dark:text-zinc-400 px-1">
          {getThemeDescription(themeMode)}
        </p>
      </div>
    </>
  );
}
