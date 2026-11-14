"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Menu,
  Plus,
  Search,
  MoreHorizontal,
  Trash2,
  Clock,
  CheckCircle2,
  StopCircle,
  AlertCircle,
  X,
  FileText,
  Settings,
  List
} from "lucide-react";
import { Thread } from "@/lib/threads/threadStore";
import { NavView } from "./NavigationDrawer";

interface ThreadsSidebarProps {
  threads: Thread[];
  selectedThreadId: string | null;
  activeNavView?: NavView;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
  onDeleteThread?: (threadId: string) => void;
  onNavigate?: (view: NavView) => void;
  onOpenDrawer?: () => void;
  onCollapse?: () => void;
  hideDock?: boolean;
  isLoadingThreads?: boolean;
}

export function ThreadsSidebar({
  threads,
  selectedThreadId,
  activeNavView = "sessions",
  onSelectThread,
  onNewThread,
  onDeleteThread,
  onNavigate,
  onOpenDrawer,
  onCollapse,
  hideDock = false,
  isLoadingThreads = false
}: ThreadsSidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [actionSheetThread, setActionSheetThread] = useState<Thread | null>(null);
  const [confirmDeleteThread, setConfirmDeleteThread] = useState<Thread | null>(null);

  const lastActiveElementRef = useRef<HTMLElement | null>(null);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const didLongPressRef = useRef<boolean>(false);
  const confirmDialogRef = useRef<HTMLDivElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  const closeConfirmDialog = () => {
    setConfirmDeleteThread(null);
    setTimeout(() => {
      lastActiveElementRef.current?.focus();
    }, 0);
  };

  // Keyboard trap and Esc handler for confirm dialog
  useEffect(() => {
    if (!confirmDeleteThread) return;
    cancelBtnRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeConfirmDialog();
        return;
      }
      if (e.key === "Tab" && confirmDialogRef.current) {
        const focusableElements = confirmDialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusableElements.length === 0) return;
        const first = focusableElements[0];
        const last = focusableElements[focusableElements.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmDeleteThread]);

  // Esc handler for action sheet
  useEffect(() => {
    if (!actionSheetThread) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setActionSheetThread(null);
        lastActiveElementRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [actionSheetThread]);

  const handleTouchStart = (thread: Thread, e: React.TouchEvent) => {
    didLongPressRef.current = false;
    touchStartPosRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      didLongPressRef.current = true;
      lastActiveElementRef.current = document.activeElement as HTMLElement;
      setActionSheetThread(thread);
    }, 500);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartPosRef.current) return;
    const deltaX = Math.abs(e.touches[0].clientX - touchStartPosRef.current.x);
    const deltaY = Math.abs(e.touches[0].clientY - touchStartPosRef.current.y);
    if (deltaX > 10 || deltaY > 10) {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }
  };

  const handleTouchEnd = (e?: React.TouchEvent) => {
    // Preserve touch handling when touching interactive buttons
    if (e && (e.target as HTMLElement).closest("button")) return;
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const filteredThreads = threads.filter((t) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      t.title.toLowerCase().includes(q) ||
      (t.messages && t.messages.some((m) => m.content.toLowerCase().includes(q)))
    );
  });

  const formatThreadTimestamp = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      const day = d.getDate();
      const month = d.toLocaleDateString(undefined, { month: "short" });
      const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      return `${day} ${month} · ${time}`;
    } catch {
      return "";
    }
  };

  return (
    <aside className="w-full flex flex-col h-full bg-white dark:bg-[#121215] border-r border-slate-200/80 dark:border-zinc-800 shrink-0 overflow-hidden">
      {/* Top Header matching Mockup media_1791044464191.webp */}
      <div className="p-4 bg-white dark:bg-[#121215] border-b border-slate-100 dark:border-zinc-800 flex items-center justify-between shadow-xs">
        <div className="flex items-center gap-2">
          {onOpenDrawer && (
            <button
              type="button"
              onClick={onOpenDrawer}
              className="hidden min-h-[44px] min-w-[44px] items-center justify-center p-2 rounded-full text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
              title="Open navigation menu"
              aria-label="Open navigation menu"
            >
              <Menu className="h-6 w-6" />
            </button>
          )}
          <h1 className="text-[19px] font-bold tracking-tight text-slate-900 dark:text-zinc-100">
            Sessions
          </h1>
        </div>

        <div className="flex items-center gap-1.5">
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="panel-toggle-btn hidden md:flex min-h-[44px] min-w-[44px] items-center justify-center text-[11.5px] font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-300 transition-colors"
              title="Collapse Sessions Panel"
            >
              « Hide
            </button>
          )}

          {/* Search Toggle Button */}
          <button
            type="button"
            onClick={() => setIsSearchOpen(!isSearchOpen)}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-full text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            title="Search sessions"
            aria-label="Search sessions"
          >
            <Search className="h-5 w-5" />
          </button>

          {/* New Session Button */}
          <button
            type="button"
            onClick={onNewThread}
            className="h-[30px] w-[30px] flex items-center justify-center rounded-[9px] bg-emerald-500 text-[#052e16] hover:bg-emerald-400 transition-colors shrink-0"
            title="New session"
            aria-label="New session"
          >
            <Plus className="h-4 w-4" />
          </button>

          {/* Overflow Menu */}
          <div className="relative hidden">
            <button
              type="button"
              onClick={() => setShowOverflow(!showOverflow)}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-full text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
              title="Sessions menu"
              aria-label="Sessions menu"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>

            {showOverflow && (
              <div
                className="absolute right-0 mt-1 w-48 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xl p-1 z-30 animate-in fade-in zoom-in-95 duration-100"
                onClick={() => setShowOverflow(false)}
              >
                <button
                  type="button"
                  onClick={onNewThread}
                  className="w-full text-left px-3 py-2 text-xs font-medium text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-xl"
                >
                  New session
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Expandable Search Input */}
      {isSearchOpen && (
        <div className="px-4 py-2.5 bg-white dark:bg-zinc-900 border-b border-slate-100 dark:border-zinc-800 animate-in fade-in duration-100">
          <div className="relative flex items-center bg-white dark:bg-[#18181b] rounded-[11px] px-3.5 py-2 border border-slate-200 dark:border-zinc-800">
            <Search className="h-4 w-4 text-slate-400 shrink-0 mr-2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sessions..."
              autoFocus
              className="w-full text-xs text-slate-900 dark:text-zinc-100 placeholder-slate-400 bg-transparent focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="px-4 sm:px-5 pt-3 pb-0.5 text-[11px] font-semibold tracking-[0.14em] text-slate-400 dark:text-zinc-500">
        RECENTS
      </div>

      {/* Elevated Cards Session List matching Mockup media_1791044464191.webp */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 space-y-[11px]" role="list" aria-label="Sessions list">
        {isLoadingThreads && filteredThreads.length === 0 ? (
          <div className="space-y-3" aria-label="Loading sessions">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 rounded-xl bg-slate-100 dark:bg-zinc-900 animate-pulse border border-slate-200 dark:border-zinc-800" />
            ))}
          </div>
        ) : filteredThreads.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 dark:text-zinc-500">
            {searchQuery ? "No matching sessions" : "No sessions yet. Tap + to start one."}
          </div>
        ) : (
          filteredThreads.map((thread) => {
            const isSelected = thread.id === selectedThreadId;
            const timeFormatted = formatThreadTimestamp(thread.updatedAt || thread.createdAt);
            const progressChars = (thread.messages || []).reduce(
              (n, m) => n + (m.content ? m.content.replace(/\s/g, "").length : 0),
              0
            );
            const progressTraces = (thread.messages || []).reduce(
              (n, m) => n + (m.traces ? m.traces.length : 0),
              0
            );
            const livenessBadge =
              thread.liveness === "alive" || thread.liveness === "stalled" ? thread.liveness : null;
            const rawStatus = (thread.status as string) || "";
            const statusLabel = (() => {
              if (rawStatus === "running") return "Running";
              if (rawStatus === "active") return "Active";
              if (rawStatus === "paused" || rawStatus === "needs_input") return "Needs Input";
              if (rawStatus === "failed") return "Failed";
              if (rawStatus === "completed" || (thread.messages && thread.messages.length > 0) || ((thread as any).messageCount ?? 0) > 0) return "Completed";
              return "New";
            })();
            const isRunning = statusLabel === "Running" || statusLabel === "Active";
            const statusChip = (() => {
              if (isRunning)
                return { label: "● RUNNING", classes: "bg-emerald-500/15 text-emerald-700 dark:text-[#34d399]" };
              if (statusLabel === "Completed")
                return { label: "✓ DONE", classes: "bg-emerald-500/10 text-emerald-700 dark:text-[#34d399]" };
              if (statusLabel === "Failed")
                return { label: "✕ FAILED", classes: "bg-red-500/10 text-red-700 dark:text-[#fca5a5]" };
              if (statusLabel === "Needs Input")
                return { label: "NEEDS INPUT", classes: "bg-amber-500/10 text-amber-700 dark:text-amber-300" };
              return { label: "NEW", classes: "bg-slate-500/10 text-slate-500 dark:text-zinc-400" };
            })();

            return (
              <div
                key={thread.id}
                role="button"
                tabIndex={0}
                data-testid={`thread-row-${thread.id}`}
                aria-label={`Session: ${thread.title || "New session"}`}
                onTouchStart={(e) => handleTouchStart(thread, e)}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onTouchCancel={handleTouchEnd}
                onKeyDown={(e) => {
                  if (e.key === "Delete" || e.key === "Backspace") {
                    e.preventDefault();
                    e.stopPropagation();
                    lastActiveElementRef.current = e.currentTarget;
                    setConfirmDeleteThread(thread);
                  } else if (e.key === "Enter" || e.key === " ") {
                    if (e.target === e.currentTarget) {
                      e.preventDefault();
                      onSelectThread(thread.id);
                    }
                  }
                }}
                onClick={() => {
                  if (didLongPressRef.current) {
                    didLongPressRef.current = false;
                    return;
                  }
                  onSelectThread(thread.id);
                }}
                className={`group relative overflow-hidden rounded-[14px] px-[14px] py-[13px] transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                  isRunning
                    ? "bg-white dark:bg-[#18181b] border border-[rgba(16,185,129,0.45)] shadow-[inset_3px_0_0_#10b981]"
                    : isSelected
                    ? "bg-white dark:bg-[#18181b] ring-2 ring-emerald-500 shadow-md border border-transparent"
                    : "bg-white dark:bg-[#18181b] hover:shadow-md shadow-xs border border-slate-200 dark:border-zinc-800"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <h2
                      className={`text-[14.5px] leading-snug line-clamp-2 break-words ${
                        isSelected
                          ? "font-bold text-slate-900 dark:text-zinc-100"
                          : "font-semibold text-slate-900 dark:text-zinc-100"
                      }`}
                    >
                      {thread.title || "New session"}
                    </h2>
                    {(thread as any).matchSnippet && (
                      <p className="mt-0.5 text-[11px] leading-snug truncate text-emerald-700 dark:text-emerald-300 bg-emerald-50/80 dark:bg-emerald-950/50 px-1.5 py-0.5 rounded">
                        {(thread as any).matchSnippet}
                      </p>
                    )}

                    {onDeleteThread && (
                      <button
                        type="button"
                        data-testid="thread-overflow-btn"
                        aria-label={`Session options for ${thread.title || "session"}`}
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          lastActiveElementRef.current = e.currentTarget;
                          setActionSheetThread(thread);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.stopPropagation();
                            e.preventDefault();
                            lastActiveElementRef.current = e.currentTarget;
                            setActionSheetThread(thread);
                          }
                        }}
                        className="min-h-[36px] min-w-[36px] flex items-center justify-center p-1.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors shrink-0"
                        title="Session actions"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {/* Subtext matching Mockup: "• 12 Oct • 2:34 PM • 3 participants • Active" */}
                  <div
                    className={`mt-2 font-mono text-[12.3px] flex items-center flex-wrap gap-x-1.5 gap-y-1 ${
                      isRunning ? "text-slate-600 dark:text-[#34d399]" : "text-slate-500 dark:text-zinc-500"
                    }`}
                  >
                    <span>{timeFormatted || "Today"}</span>
                    <span>·</span>
                    <span
                      data-testid={`thread-status-chip-${thread.id}`}
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10.5px] font-bold font-sans ${statusChip.classes}`}
                    >
                      {statusChip.label}
                    </span>
                    {livenessBadge && (
                      <span
                        data-testid={`thread-liveness-${thread.id}`}
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10.5px] font-semibold ${
                          livenessBadge === "alive"
                            ? "bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300"
                            : "bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300"
                        }`}
                        title={livenessBadge === "alive" ? "Turn active — activity within the last 30s" : "Turn stalled — no activity past the stale window"}
                      >
                        {livenessBadge === "alive" ? "Alive" : "Stalled"}
                      </span>
                    )}
                    {livenessBadge ? (
                      <span data-testid={`thread-progress-${thread.id}`}>
                        {`${progressChars} chars · ${progressTraces} traces`}
                      </span>
                    ) : progressTraces > 0 ? (
                      <span data-testid={`thread-progress-${thread.id}`}>
                        {`· ${progressTraces} traces`}
                      </span>
                    ) : null}
                  </div>

                  {isRunning && (
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        data-testid={`thread-resume-${thread.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectThread(thread.id);
                        }}
                        className="px-3 py-1.5 rounded-lg bg-emerald-500 text-[#052e16] text-xs font-bold hover:bg-emerald-400 transition-colors"
                      >
                        Resume
                      </button>
                      {onNavigate && (
                        <button
                          type="button"
                          data-testid={`thread-open-settings-${thread.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onNavigate("settings");
                          }}
                          className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 text-xs font-semibold text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                        >
                          Open settings
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {!hideDock && (
        <div className="p-2.5 bg-white dark:bg-zinc-900 border-t border-slate-200/80 dark:border-zinc-800 flex items-center justify-around gap-1 shrink-0">
          <button
            type="button"
            onClick={() => (onNavigate ? onNavigate("sessions") : undefined)}
            aria-current={activeNavView === "sessions" || activeNavView === "thread" ? "page" : undefined}
            className={`flex flex-col items-center gap-1 py-1.5 px-2.5 rounded-xl text-[11px] font-semibold transition-colors ${
              activeNavView === "sessions" || activeNavView === "thread"
                ? "text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 font-semibold"
                : "text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800"
            }`}
            title="Sessions"
          >
            <List className="h-4 w-4" />
            <span>Sessions</span>
          </button>

          <button
            type="button"
            onClick={onNewThread}
            className="flex flex-col items-center gap-1 py-1.5 px-2.5 rounded-xl text-[11px] font-medium text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            title="New session"
          >
            <Plus className="h-4 w-4" />
            <span>New</span>
          </button>

          <button
            type="button"
            onClick={() => (onNavigate ? onNavigate("morning-report") : undefined)}
            aria-current={activeNavView === "morning-report" ? "page" : undefined}
            className={`flex flex-col items-center gap-1 py-1.5 px-2.5 rounded-xl text-[11px] font-medium transition-colors ${
              activeNavView === "morning-report"
                ? "text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 font-semibold"
                : "text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800"
            }`}
            title="Morning report"
          >
            <FileText className="h-4 w-4" />
            <span>Report</span>
          </button>

          <button
            type="button"
            onClick={() => (onNavigate ? onNavigate("settings") : undefined)}
            aria-current={activeNavView === "settings" ? "page" : undefined}
            className={`flex flex-col items-center gap-1 py-1.5 px-2.5 rounded-xl text-[11px] font-medium transition-colors ${
              activeNavView === "settings"
                ? "text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 font-semibold"
                : "text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800"
            }`}
            title="Settings"
          >
            <Settings className="h-4 w-4" />
            <span>Settings</span>
          </button>
        </div>
      )}

      {/* Action Sheet for Touch Long-Press & Overflow Button */}
      {actionSheetThread && (
        <div
          data-testid="thread-action-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Session actions"
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-150"
          onClick={() => {
            setActionSheetThread(null);
            lastActiveElementRef.current?.focus();
          }}
        >
          <div
            className="w-full sm:max-w-sm bg-white dark:bg-zinc-900 border-t sm:border border-slate-200 dark:border-zinc-800 rounded-t-3xl sm:rounded-3xl shadow-2xl p-5 space-y-4 animate-in slide-in-from-bottom duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 dark:text-zinc-100 truncate pr-2">
                {actionSheetThread.title || "Session Options"}
              </h3>
              <button
                type="button"
                data-testid="action-sheet-close-btn"
                onClick={() => {
                  setActionSheetThread(null);
                  lastActiveElementRef.current?.focus();
                }}
                className="min-h-[36px] min-w-[36px] flex items-center justify-center p-1 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
                aria-label="Close action sheet"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-2">
              {onDeleteThread && (
                <button
                  type="button"
                  data-testid="action-sheet-delete-btn"
                  onClick={() => {
                    const target = actionSheetThread;
                    setActionSheetThread(null);
                    setConfirmDeleteThread(target);
                  }}
                  className="w-full min-h-[44px] flex items-center gap-2.5 px-4 py-3 rounded-2xl bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 font-semibold text-sm hover:bg-rose-100 dark:hover:bg-rose-950/70 transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                  <span>Delete session</span>
                </button>
              )}
              <button
                type="button"
                data-testid="action-sheet-cancel-btn"
                onClick={() => {
                  setActionSheetThread(null);
                  lastActiveElementRef.current?.focus();
                }}
                className="w-full min-h-[44px] px-4 py-2.5 rounded-2xl border border-slate-200 dark:border-zinc-800 text-slate-700 dark:text-zinc-300 font-medium text-xs hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ONE Confirm Dialog for Permanent Deletion */}
      {confirmDeleteThread && (
        <div
          data-testid="thread-delete-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-delete-title"
          ref={confirmDialogRef}
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150"
          onClick={() => closeConfirmDialog()}
        >
          <div
            className="w-full max-w-md bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-3xl shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-2xl bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 shrink-0">
                <Trash2 className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3
                  id="confirm-delete-title"
                  className="text-base font-bold text-slate-900 dark:text-zinc-100 line-clamp-2"
                >
                  Delete &ldquo;{confirmDeleteThread.title || "Untitled session"}&rdquo;?
                </h3>
                <p className="mt-1.5 text-xs text-slate-600 dark:text-zinc-400 leading-relaxed">
                  This action is permanent and cannot be undone.{" "}
                  {confirmDeleteThread.taskId &&
                  (confirmDeleteThread.id === `thread-${confirmDeleteThread.taskId}` ||
                    confirmDeleteThread.id.startsWith("thread-task-"))
                    ? "All messages and the task checkpoint for this session will be removed."
                    : confirmDeleteThread.taskId
                      ? "All messages for this session will be removed. The task checkpoint is retained and the task will be marked cancelled."
                      : "All messages for this session will be removed."}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                ref={cancelBtnRef}
                data-testid="cancel-delete-btn"
                onClick={() => closeConfirmDialog()}
                className="min-h-[44px] px-4 py-2 rounded-xl text-xs font-semibold text-slate-700 dark:text-zinc-300 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                ref={confirmBtnRef}
                data-testid="confirm-delete-btn"
                onClick={() => {
                  if (onDeleteThread) {
                    onDeleteThread(confirmDeleteThread.id);
                  }
                  closeConfirmDialog();
                }}
                className="min-h-[44px] px-4 py-2 rounded-xl text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 shadow-sm transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
