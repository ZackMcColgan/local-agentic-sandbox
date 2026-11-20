"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Plus,
  List,
  Hammer,
  Columns3,
  Wrench,
  FileText,
  Settings,
  FolderGit2,
  FolderTree,
  X,
  MessageSquare,
  MoreHorizontal,
  Trash2
} from "lucide-react";
import { Thread } from "@/lib/threads/threadStore";
import { deriveThreadDisplayTitle } from "../lib/chatUtils";

export type NavView = "sessions" | "thread" | "builds" | "board" | "skills" | "morning-report" | "settings" | "security" | "projects";

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
  isLoadingThreads?: boolean;
  onOpenExplorer?: () => void;
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
  onDeleteThread,
  isLoadingThreads = false,
  onOpenExplorer
}: NavigationDrawerProps) {
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

  useEffect(() => {
    const handleOverlayOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ source?: string }>).detail;
      if (detail?.source !== "session-action-sheet") {
        setActionSheetThread(null);
      }
    };
    window.addEventListener("ui:overlay-open", handleOverlayOpen);
    return () => window.removeEventListener("ui:overlay-open", handleOverlayOpen);
  }, []);

  useEffect(() => {
    if (actionSheetThread && typeof window !== "undefined") {
      const Evt = window.CustomEvent ?? globalThis.CustomEvent;
      if (Evt) {
        window.dispatchEvent(new Evt("ui:overlay-open", { detail: { source: "session-action-sheet" } }));
      }
    }
  }, [actionSheetThread]);

  // Close drawer, action sheet, or confirm dialog on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmDeleteThread) {
          e.preventDefault();
          e.stopPropagation();
          closeConfirmDialog();
          return;
        }
        if (actionSheetThread) {
          e.preventDefault();
          e.stopPropagation();
          setActionSheetThread(null);
          lastActiveElementRef.current?.focus();
          return;
        }
        if (isOpen) {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, confirmDeleteThread, actionSheetThread]);

  // Focus trap for confirm dialog
  useEffect(() => {
    if (!confirmDeleteThread) return;
    cancelBtnRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
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

  const handleTouchStart = (thread: Thread, e: React.TouchEvent) => {
    didLongPressRef.current = false;
    const touch = e.touches?.[0];
    touchStartPosRef.current = touch ? { x: touch.clientX, y: touch.clientY } : { x: 0, y: 0 };
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      didLongPressRef.current = true;
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        try { navigator.vibrate(40); } catch {}
      }
      lastActiveElementRef.current = document.activeElement as HTMLElement;
      setActionSheetThread(thread);
    }, 500);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartPosRef.current) return;
    const touch = e.touches?.[0];
    if (!touch) return;
    const deltaX = Math.abs(touch.clientX - touchStartPosRef.current.x);
    const deltaY = Math.abs(touch.clientY - touchStartPosRef.current.y);
    if (deltaX > 10 || deltaY > 10) {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }
  };

  const handleTouchEnd = (e?: React.TouchEvent) => {
    if (e && (e.target as HTMLElement).closest('[data-testid="thread-overflow-btn"]')) return;
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

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

      {/* Drawer Surface - Mobile Menu */}
      <div
        data-testid="navigation-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation Drawer"
        className="relative w-72 sm:w-80 max-w-[88vw] h-full bg-stone-50 dark:bg-[#0e0e12] shadow-2xl rounded-r-3xl flex flex-col py-5 px-3.5 z-50 border-r border-stone-200/90 dark:border-white/[0.10] transition-transform animate-in slide-in-from-left duration-200"
      >
        
        {/* Top Header: Neutral Menu title + Close (X) button */}
        <div className="flex items-center justify-between px-2 pb-4 shrink-0">
          <span className="text-sm font-semibold tracking-tight text-stone-900 dark:text-stone-100">
            Menu
          </span>

          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-full text-zinc-600 hover:text-stone-900 dark:text-zinc-400 dark:hover:text-stone-100 hover:bg-stone-200/70 dark:hover:bg-white/[0.08] transition-colors"
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
            className="w-full min-h-[44px] flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 active:scale-[0.98] text-white dark:text-black font-semibold text-sm shadow-sm transition-all"
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
            className={`w-full min-h-[44px] flex items-center gap-3.5 px-3.5 py-2.5 rounded-2xl text-sm transition-all text-left ${
              activeView === "sessions" || activeView === "thread"
                ? "bg-emerald-100/80 dark:bg-emerald-500/15 text-emerald-900 dark:text-emerald-300 font-semibold border border-emerald-300/80 dark:border-emerald-500/35"
                : "text-stone-700 dark:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-white/[0.06] font-medium border border-transparent"
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
            className={`w-full min-h-[44px] flex items-center gap-3.5 px-3.5 py-2.5 rounded-2xl text-sm transition-all text-left ${
              activeView === "builds"
                ? "bg-emerald-100/80 dark:bg-emerald-500/15 text-emerald-900 dark:text-emerald-300 font-semibold border border-emerald-300/80 dark:border-emerald-500/35"
                : "text-stone-700 dark:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-white/[0.06] font-medium border border-transparent"
            }`}
          >
            <Hammer className="h-5 w-5 shrink-0 opacity-80" />
            <span>Builds</span>
          </button>

          {/* Destination: Board */}
          <button
            type="button"
            onClick={() => {
              onNavigate("board");
              onClose();
            }}
            className={`w-full min-h-[44px] flex items-center gap-3.5 px-3.5 py-2.5 rounded-2xl text-sm transition-all text-left ${
              activeView === "board"
                ? "bg-emerald-100/80 dark:bg-emerald-500/15 text-emerald-900 dark:text-emerald-300 font-semibold border border-emerald-300/80 dark:border-emerald-500/35"
                : "text-stone-700 dark:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-white/[0.06] font-medium border border-transparent"
            }`}
          >
            <Columns3 className="h-5 w-5 shrink-0 opacity-80" />
            <span>Board</span>
          </button>

          {/* Destination: Projects & Folders */}
          <button
            type="button"
            onClick={() => {
              onNavigate("projects");
              onClose();
            }}
            className={`w-full min-h-[44px] flex items-center gap-3.5 px-3.5 py-2.5 rounded-2xl text-sm transition-all text-left ${
              activeView === "projects"
                ? "bg-emerald-100/80 dark:bg-emerald-500/15 text-emerald-900 dark:text-emerald-300 font-semibold border border-emerald-300/80 dark:border-emerald-500/35"
                : "text-stone-700 dark:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-white/[0.06] font-medium border border-transparent"
            }`}
          >
            <FolderGit2 className="h-5 w-5 shrink-0 opacity-80" />
            <span>Projects &amp; Folders</span>
          </button>

          {/* Destination: File Explorer */}
          {onOpenExplorer && (
            <button
              type="button"
              data-testid="explorer-drawer-entry"
              onClick={() => {
                onOpenExplorer();
                onClose();
              }}
              className="w-full min-h-[44px] flex items-center gap-3.5 px-3.5 py-2.5 rounded-2xl text-sm transition-all text-left text-stone-700 dark:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-white/[0.06] font-medium border border-transparent"
            >
              <FolderTree className="h-5 w-5 shrink-0 opacity-80" />
              <span>File Explorer</span>
            </button>
          )}

          {/* Destination: Skills with pending badge */}
          <button
            type="button"
            onClick={() => {
              onNavigate("skills");
              onClose();
            }}
            className={`w-full min-h-[44px] flex items-center justify-between px-3.5 py-2.5 rounded-2xl text-sm transition-all text-left ${
              activeView === "skills"
                ? "bg-emerald-100/80 dark:bg-emerald-500/15 text-emerald-900 dark:text-emerald-300 font-semibold border border-emerald-300/80 dark:border-emerald-500/35"
                : "text-stone-700 dark:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-white/[0.06] font-medium border border-transparent"
            }`}
          >
            <div className="flex items-center gap-3.5 min-w-0">
              <Wrench className="h-5 w-5 shrink-0 opacity-80" />
              <span>Skills</span>
            </div>
            {pendingSkillsCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-900 dark:text-emerald-300 font-bold text-[11px] shrink-0 border border-emerald-300/60 dark:border-emerald-500/30 tabular-nums">
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
            className={`w-full min-h-[44px] flex items-center gap-3.5 px-3.5 py-2.5 rounded-2xl text-sm transition-all text-left ${
              activeView === "morning-report"
                ? "bg-emerald-100/80 dark:bg-emerald-500/15 text-emerald-900 dark:text-emerald-300 font-semibold border border-emerald-300/80 dark:border-emerald-500/35"
                : "text-stone-700 dark:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-white/[0.06] font-medium border border-transparent"
            }`}
          >
            <FileText className="h-5 w-5 shrink-0 opacity-80" />
            <span>Morning report</span>
          </button>
        </nav>

        {/* 3. Sessions List (Recents-style section) */}
        <div className="pt-4 pb-1 px-3 flex items-center justify-between text-[10px] font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-[0.1em] shrink-0">
          <span>Recents</span>
          {threads.length > 0 && (
            <span className="text-[11px] font-mono tabular-nums text-zinc-600 dark:text-zinc-400 font-normal">
              {threads.length}
            </span>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 px-1 pt-1 pb-4">
          {isLoadingThreads && threads.length === 0 ? (
            <div className="space-y-2 px-1 py-1" aria-label="Loading sessions">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 rounded-2xl bg-stone-200/60 dark:bg-[#15151b] animate-pulse border border-stone-200 dark:border-white/[0.08]" />
              ))}
            </div>
          ) : threads.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-zinc-600 dark:text-zinc-400">
              No recent sessions
            </div>
          ) : (
            threads.map((thread) => {
              const isSelected = thread.id === selectedThreadId;
              const timeLabel = formatThreadTimestamp(thread.updatedAt || thread.createdAt);
              return (
                <div
                  key={thread.id}
                  data-testid={`thread-row-${thread.id}`}
                  aria-label={`Session: ${thread.title || "Untitled session"}`}
                  onTouchStart={(e) => handleTouchStart(thread, e)}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  onTouchCancel={handleTouchEnd}
                  className={`group relative flex items-center justify-between rounded-2xl px-3.5 py-3 text-xs transition-all min-h-[44px] bg-white dark:bg-[#15151b] surface-card border ${
                    isSelected
                      ? "text-emerald-900 dark:text-emerald-200 font-semibold border-emerald-500/60 dark:border-emerald-500/50"
                      : "text-stone-700 dark:text-stone-200 border-stone-200/90 dark:border-white/[0.08] hover:border-stone-300 dark:hover:border-white/[0.16]"
                  }`}
                >
                  <button
                    type="button"
                    tabIndex={0}
                    onClick={() => {
                      if (didLongPressRef.current) {
                        didLongPressRef.current = false;
                        return;
                      }
                      if (onSelectThread) onSelectThread(thread.id);
                      onClose();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Delete" || e.key === "Backspace") {
                        e.preventDefault();
                        e.stopPropagation();
                        lastActiveElementRef.current = e.currentTarget;
                        setConfirmDeleteThread(thread);
                      }
                    }}
                    className="flex-1 min-w-0 text-left flex flex-col gap-0.5 focus:outline-none"
                    title={thread.title}
                  >
                    <span className="line-clamp-2 break-words text-[13.5px] font-semibold">{deriveThreadDisplayTitle(thread.title)}</span>
                    {(thread as any).matchSnippet && (
                      <span className="text-[11px] leading-snug truncate text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/15 px-1.5 py-0.5 rounded">
                        {(thread as any).matchSnippet}
                      </span>
                    )}
                    {timeLabel && (
                      <span className="text-[10px] text-zinc-600 dark:text-zinc-400 font-mono tabular-nums">
                        {timeLabel}
                      </span>
                    )}
                  </button>
                  <div className="flex items-center gap-1 shrink-0 ml-1.5">
                    {thread.status === "active" && (
                      <span className="h-2 w-2 rounded-full bg-cyan-400 shrink-0 animate-pulse" title="Active" />
                    )}
                    {onDeleteThread && (
                      <button
                        type="button"
                        data-testid="thread-overflow-btn"
                        aria-label={`Session options for ${thread.title || "session"}`}
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
                        className="min-h-[36px] min-w-[36px] flex items-center justify-center p-1.5 rounded-xl text-stone-400 hover:text-stone-800 dark:hover:text-stone-100 hover:bg-stone-200/60 dark:hover:bg-white/[0.08] transition-colors"
                        title="Session actions"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 4. Settings Pinned at Bottom */}
        <div className="pt-2 border-t border-stone-200/80 dark:border-white/[0.08] px-1 shrink-0">
          <button
            type="button"
            onClick={() => {
              onNavigate("settings");
              onClose();
            }}
            className={`w-full min-h-[44px] flex items-center gap-3.5 px-3.5 py-2.5 rounded-2xl text-sm transition-all text-left ${
              activeView === "settings"
                ? "bg-emerald-100/80 dark:bg-emerald-500/15 text-emerald-900 dark:text-emerald-300 font-semibold border border-emerald-300/80 dark:border-emerald-500/35"
                : "text-stone-700 dark:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-white/[0.06] font-medium border border-transparent"
            }`}
          >
            <Settings className="h-5 w-5 shrink-0 opacity-80" />
            <span>Settings</span>
          </button>

          {/* Footer info */}
          <div className="pt-2 pb-1 px-3 text-[11px] text-zinc-600 dark:text-zinc-400 font-mono">
            Local Agentic Sandbox
          </div>
        </div>
      </div>

      {/* Material 3 Bottom Sheet for Actions */}
      {actionSheetThread && (
        <div
          data-testid="thread-action-sheet"
          className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-150"
          onClick={() => {
            setActionSheetThread(null);
            lastActiveElementRef.current?.focus();
          }}
        >
          <div
            className="w-full sm:max-w-md bg-white dark:bg-zinc-900 border-t sm:border border-slate-200 dark:border-zinc-800 rounded-t-3xl sm:rounded-3xl shadow-2xl p-4 sm:p-6 space-y-4 animate-in slide-in-from-bottom duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-900 dark:text-zinc-100 break-words leading-snug pr-2">
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
              {onSelectThread && (
                <button
                  type="button"
                  data-testid="action-sheet-open-btn"
                  onClick={() => {
                    const target = actionSheetThread;
                    setActionSheetThread(null);
                    onSelectThread(target.id);
                    onClose();
                  }}
                  className="w-full min-h-[44px] flex items-center gap-2.5 px-4 py-3 rounded-2xl bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 font-semibold text-sm hover:bg-emerald-500/25 transition-colors"
                >
                  <MessageSquare className="h-4 w-4" />
                  <span>Open session</span>
                </button>
              )}
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
          aria-labelledby="confirm-delete-drawer-title"
          ref={confirmDialogRef}
          className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150"
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
                  id="confirm-delete-drawer-title"
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
    </div>
  );
}
