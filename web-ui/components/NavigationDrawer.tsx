"use client";

import React, { useEffect } from "react";
import {
  Bot,
  Plus,
  List,
  Rocket,
  Wrench,
  FileText,
  Settings,
  FolderGit2,
  X,
  MessageSquare
} from "lucide-react";
import { Thread } from "@/lib/threads/threadStore";

export type NavView = "sessions" | "thread" | "builds" | "skills" | "morning-report" | "settings" | "security" | "projects";

interface NavigationDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  activeView: NavView;
  onNavigate: (view: NavView) => void;
  onNewSession: () => void;
  pendingSkillsCount?: number;
  threads?: Thread[];
  selectedThreadId?: string | null;
  onSelectThread?: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
}

export function NavigationDrawer({
  isOpen,
  onClose,
  activeView,
  onNavigate,
  onNewSession,
  pendingSkillsCount = 0,
  threads = [],
  selectedThreadId,
  onSelectThread,
  onDeleteThread
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

  const formatThreadTimestamp = (dateStr?: string) => {
    if (!dateStr) return "";
    try {
      const d = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      if (diffHours < 1) return "Just now";
      if (diffHours < 24) return `${diffHours}h ago`;
      const days = Math.floor(diffHours / 24);
      if (days === 1) return "Yesterday";
      if (days < 7) return `${days}d ago`;
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex animate-in fade-in duration-150">
      {/* Dimmed backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity"
        aria-hidden="true"
      />

      {/* Drawer Surface - Gemini Mobile Menu Pattern */}
      <div
        data-testid="navigation-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation Drawer"
        className="relative w-72 sm:w-80 max-w-[88vw] h-full bg-white dark:bg-zinc-900 shadow-2xl rounded-r-3xl flex flex-col py-5 px-3.5 z-50 border-r border-slate-100 dark:border-zinc-800 transition-transform animate-in slide-in-from-left duration-200"
      >
        
        {/* Top Header: Robot Sparkle Icon + "Agent" + Close (X) button */}
        <div className="flex items-center justify-between px-2 pb-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
              <Bot className="h-6 w-6 stroke-[2.2]" />
            </div>
            <span className="text-xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
              Agent
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-full text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            title="Close drawer"
            aria-label="Close drawer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 1. Prominent New Session Action */}
        <div className="px-1 pb-3 shrink-0">
          <button
            type="button"
            onClick={() => {
              onNewSession();
              onClose();
            }}
            className="w-full min-h-[44px] flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-semibold text-sm shadow-sm transition-all"
            title="New session"
            aria-label="New session"
          >
            <Plus className="h-5 w-5 stroke-[2.5]" />
            <span>New session</span>
          </button>
        </div>

        {/* 2. Destinations Hub */}
        <nav aria-label="Main Navigation" className="space-y-1 px-1 shrink-0">
          {/* Destination: Sessions */}
          <button
            type="button"
            onClick={() => {
              onNavigate("sessions");
              onClose();
            }}
            className={`w-full min-h-[44px] flex items-center gap-3.5 px-3.5 py-2.5 rounded-2xl text-sm transition-colors text-left ${
              activeView === "sessions" || activeView === "thread"
                ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 font-semibold border border-emerald-200/80 dark:border-emerald-800/80"
                : "text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 font-medium"
            }`}
          >
            <List className="h-5 w-5 shrink-0" />
            <span>Sessions</span>
          </button>

          {/* Destination: Builds */}
          <button
            type="button"
            onClick={() => {
              onNavigate("builds");
              onClose();
            }}
            className={`w-full min-h-[44px] flex items-center gap-3.5 px-3.5 py-2.5 rounded-2xl text-sm transition-colors text-left ${
              activeView === "builds"
                ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 font-semibold border border-emerald-200/80 dark:border-emerald-800/80"
                : "text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 font-medium"
            }`}
          >
            <Rocket className="h-5 w-5 text-slate-600 dark:text-zinc-400 shrink-0" />
            <span>Builds</span>
          </button>

          {/* Destination: Projects & Folders */}
          <button
            type="button"
            onClick={() => {
              onNavigate("projects");
              onClose();
            }}
            className={`w-full min-h-[44px] flex items-center gap-3.5 px-3.5 py-2.5 rounded-2xl text-sm transition-colors text-left ${
              activeView === "projects"
                ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 font-semibold border border-emerald-200/80 dark:border-emerald-800/80"
                : "text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 font-medium"
            }`}
          >
            <FolderGit2 className="h-5 w-5 text-slate-600 dark:text-zinc-400 shrink-0" />
            <span>Projects &amp; Folders</span>
          </button>

          {/* Destination: Skills with pending badge */}
          <button
            type="button"
            onClick={() => {
              onNavigate("skills");
              onClose();
            }}
            className={`w-full min-h-[44px] flex items-center justify-between px-3.5 py-2.5 rounded-2xl text-sm transition-colors text-left ${
              activeView === "skills"
                ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 font-semibold border border-emerald-200/80 dark:border-emerald-800/80"
                : "text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 font-medium"
            }`}
          >
            <div className="flex items-center gap-3.5 min-w-0">
              <Wrench className="h-5 w-5 text-slate-600 dark:text-zinc-400 shrink-0" />
              <span>Skills</span>
            </div>
            {pendingSkillsCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-200 font-bold text-[11px] shrink-0 border border-amber-200 dark:border-amber-800">
                {`${pendingSkillsCount} pending`}
              </span>
            )}
          </button>

          {/* Destination: Morning report */}
          <button
            type="button"
            onClick={() => {
              onNavigate("morning-report");
              onClose();
            }}
            className={`w-full min-h-[44px] flex items-center gap-3.5 px-3.5 py-2.5 rounded-2xl text-sm transition-colors text-left ${
              activeView === "morning-report"
                ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 font-semibold border border-emerald-200/80 dark:border-emerald-800/80"
                : "text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 font-medium"
            }`}
          >
            <FileText className="h-5 w-5 text-slate-600 dark:text-zinc-400 shrink-0" />
            <span>Morning report</span>
          </button>
        </nav>

        {/* 3. Sessions List (Recents-style section) */}
        <div className="pt-4 pb-1 px-3 flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-wider shrink-0">
          <span>Recents</span>
          {threads.length > 0 && (
            <span className="text-[11px] font-mono text-slate-400 dark:text-zinc-500 font-normal">
              {threads.length}
            </span>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-1 px-1 py-1">
          {threads.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-slate-400 dark:text-zinc-500">
              No recent sessions
            </div>
          ) : (
            threads.map((thread) => {
              const isSelected = thread.id === selectedThreadId;
              const timeLabel = formatThreadTimestamp(thread.updatedAt || thread.createdAt);
              return (
                <div
                  key={thread.id}
                  className={`group relative flex items-center justify-between rounded-xl px-3 py-2 text-xs transition-colors min-h-[44px] ${
                    isSelected
                      ? "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-200 font-semibold border border-emerald-200/60 dark:border-emerald-800/60"
                      : "text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800/60"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (onSelectThread) onSelectThread(thread.id);
                      onClose();
                    }}
                    className="flex-1 min-w-0 text-left flex flex-col gap-0.5"
                    title={thread.title}
                  >
                    <span className="truncate text-xs">{thread.title || "Untitled session"}</span>
                    {timeLabel && (
                      <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-mono">
                        {timeLabel}
                      </span>
                    )}
                  </button>
                  {thread.status === "active" && (
                    <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0 ml-1.5 animate-pulse" title="Active" />
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* 4. Settings Pinned at Bottom */}
        <div className="pt-2 border-t border-slate-100 dark:border-zinc-800 px-1 shrink-0">
          <button
            type="button"
            onClick={() => {
              onNavigate("settings");
              onClose();
            }}
            className={`w-full min-h-[44px] flex items-center gap-3.5 px-3.5 py-2.5 rounded-2xl text-sm transition-colors text-left ${
              activeView === "settings"
                ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 font-semibold border border-emerald-200/80 dark:border-emerald-800/80"
                : "text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 font-medium"
            }`}
          >
            <Settings className="h-5 w-5 text-slate-600 dark:text-zinc-400 shrink-0" />
            <span>Settings</span>
          </button>

          {/* Footer info */}
          <div className="pt-2 pb-1 px-3 text-[11px] text-slate-400 dark:text-zinc-500 font-mono">
            Local Agentic Sandbox v1.0.0
          </div>
        </div>
      </div>
    </div>
  );
}
