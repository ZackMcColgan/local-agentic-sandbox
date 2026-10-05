"use client";

import React, { useEffect } from "react";
import {
  Bot,
  PlusCircle,
  List,
  Rocket,
  Wrench,
  FileText,
  Settings,
  X
} from "lucide-react";

export type NavView = "sessions" | "thread" | "builds" | "skills" | "morning-report" | "settings" | "security";

interface NavigationDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  activeView: NavView;
  onNavigate: (view: NavView) => void;
  onNewSession: () => void;
  pendingSkillsCount?: number;
}

export function NavigationDrawer({
  isOpen,
  onClose,
  activeView,
  onNavigate,
  onNewSession,
  pendingSkillsCount = 0
}: NavigationDrawerProps) {
  // Close drawer on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex animate-in fade-in duration-150">
      {/* Dimmed backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity"
        aria-hidden="true"
      />

      {/* Drawer Surface - matching Mockup media_1791044464191.webp */}
      <div className="relative w-64 sm:w-72 max-w-[85vw] h-full bg-white dark:bg-zinc-900 shadow-2xl rounded-r-3xl flex flex-col py-6 px-4 z-50 border-r border-slate-100 dark:border-zinc-800 transition-transform animate-in slide-in-from-left duration-200">
        
        {/* Top Header: Robot Sparkle Icon + "Agent" */}
        <div className="flex items-center justify-between px-3 pb-6">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-[#6750a4]/10 dark:bg-[#d0bcff]/15 flex items-center justify-center text-[#6750a4] dark:text-[#d0bcff]">
              <Bot className="h-6 w-6 stroke-[2.2]" />
            </div>
            <span className="text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
              Agent
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="sm:hidden p-1.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            title="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation Items */}
        <nav className="flex-1 space-y-2 px-1">
          {/* Item 1: New session */}
          <button
            type="button"
            onClick={() => {
              onNewSession();
              onClose();
            }}
            className="w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 font-medium text-sm transition-colors text-left"
          >
            <PlusCircle className="h-5 w-5 text-slate-600 dark:text-zinc-400 shrink-0" />
            <span>New session</span>
          </button>

          {/* Item 2: Sessions (Active View Pill) */}
          <button
            type="button"
            onClick={() => {
              onNavigate("sessions");
              onClose();
            }}
            className={`w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl font-semibold text-sm transition-colors text-left ${
              activeView === "sessions" || activeView === "thread"
                ? "bg-[#d0bcff]/70 dark:bg-[#d0bcff]/20 text-[#381e72] dark:text-[#d0bcff]"
                : "text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
            }`}
          >
            <List className="h-5 w-5 shrink-0" />
            <span>Sessions</span>
          </button>

          {/* Item 3: Builds */}
          <button
            type="button"
            onClick={() => {
              onNavigate("builds");
              onClose();
            }}
            className={`w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl font-medium text-sm transition-colors text-left ${
              activeView === "builds"
                ? "bg-[#d0bcff]/70 dark:bg-[#d0bcff]/20 text-[#381e72] dark:text-[#d0bcff] font-semibold"
                : "text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
            }`}
          >
            <Rocket className="h-5 w-5 text-slate-600 dark:text-zinc-400 shrink-0" />
            <span>Builds</span>
          </button>

          {/* Item 4: Skills with "3 pending" badge */}
          <button
            type="button"
            onClick={() => {
              onNavigate("skills");
              onClose();
            }}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-2xl font-medium text-sm transition-colors text-left ${
              activeView === "skills"
                ? "bg-[#d0bcff]/70 dark:bg-[#d0bcff]/20 text-[#381e72] dark:text-[#d0bcff] font-semibold"
                : "text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
            }`}
          >
            <div className="flex items-center gap-3.5 min-w-0">
              <Wrench className="h-5 w-5 text-slate-600 dark:text-zinc-400 shrink-0" />
              <span>Skills</span>
            </div>
            {pendingSkillsCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-[#d0bcff] dark:bg-[#6750a4] text-[#381e72] dark:text-white font-bold text-[11px] shrink-0">
                {pendingSkillsCount} pending
              </span>
            )}
          </button>

          {/* Item 5: Morning report */}
          <button
            type="button"
            onClick={() => {
              onNavigate("morning-report");
              onClose();
            }}
            className={`w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl font-medium text-sm transition-colors text-left ${
              activeView === "morning-report"
                ? "bg-[#d0bcff]/70 dark:bg-[#d0bcff]/20 text-[#381e72] dark:text-[#d0bcff] font-semibold"
                : "text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
            }`}
          >
            <FileText className="h-5 w-5 text-slate-600 dark:text-zinc-400 shrink-0" />
            <span>Morning report</span>
          </button>

          {/* Item 6: Settings */}
          <button
            type="button"
            onClick={() => {
              onNavigate("settings");
              onClose();
            }}
            className={`w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl font-medium text-sm transition-colors text-left ${
              activeView === "settings"
                ? "bg-[#d0bcff]/70 dark:bg-[#d0bcff]/20 text-[#381e72] dark:text-[#d0bcff] font-semibold"
                : "text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
            }`}
          >
            <Settings className="h-5 w-5 text-slate-600 dark:text-zinc-400 shrink-0" />
            <span>Settings</span>
          </button>
        </nav>

        {/* Footer info */}
        <div className="pt-4 border-t border-slate-100 dark:border-zinc-800 px-3">
          <div className="text-[11px] text-slate-400 dark:text-zinc-500 font-mono">
            Antigravity Local v2.7
          </div>
        </div>
      </div>
    </div>
  );
}
