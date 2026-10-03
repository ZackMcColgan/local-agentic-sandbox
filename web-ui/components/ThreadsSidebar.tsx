"use client";

import React, { useState } from "react";
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
  X
} from "lucide-react";
import { Thread } from "@/lib/threads/threadStore";

interface ThreadsSidebarProps {
  threads: Thread[];
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
  onDeleteThread?: (threadId: string) => void;
  onOpenDrawer?: () => void;
}

export function ThreadsSidebar({
  threads,
  selectedThreadId,
  onSelectThread,
  onNewThread,
  onDeleteThread,
  onOpenDrawer
}: ThreadsSidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [swipedThreadId, setSwipedThreadId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const touchStartXRef = React.useRef<number>(0);

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
      return `• ${day} ${month} • ${time}`;
    } catch {
      return "";
    }
  };

  return (
    <aside className="w-full flex flex-col h-full bg-[#f4f3f7] dark:bg-zinc-950 border-r border-slate-200/80 dark:border-zinc-800 shrink-0">
      {/* Top Header matching Mockup media_1791044464191.webp */}
      <div className="p-4 bg-white dark:bg-zinc-900 border-b border-slate-100 dark:border-zinc-800 flex items-center justify-between shadow-xs">
        <div className="flex items-center gap-2">
          {onOpenDrawer && (
            <button
              type="button"
              onClick={onOpenDrawer}
              className="p-1.5 -ml-1 rounded-full text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
              title="Open navigation menu"
              aria-label="Open navigation menu"
            >
              <Menu className="h-6 w-6" />
            </button>
          )}
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
            Sessions
          </h1>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Search Toggle Button */}
          <button
            type="button"
            onClick={() => setIsSearchOpen(!isSearchOpen)}
            className="p-2 rounded-full text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            title="Search sessions"
          >
            <Search className="h-5 w-5" />
          </button>

          {/* New Session Button */}
          <button
            type="button"
            onClick={onNewThread}
            className="p-2 rounded-full text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            title="New session"
          >
            <Plus className="h-5 w-5" />
          </button>

          {/* Overflow Menu */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowOverflow(!showOverflow)}
              className="p-2 rounded-full text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
              title="Sessions menu"
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
                <button
                  type="button"
                  onClick={() => {
                    const isDark = document.documentElement.classList.contains("dark");
                    const next = isDark ? "light" : "dark";
                    document.documentElement.classList.toggle("dark", next === "dark");
                    document.documentElement.classList.toggle("light", next === "light");
                    document.documentElement.setAttribute("data-theme", next);
                    localStorage.setItem("app-theme", next);
                  }}
                  className="w-full text-left px-3 py-2 text-xs font-medium text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-xl"
                >
                  Toggle theme
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Expandable Search Input */}
      {isSearchOpen && (
        <div className="px-4 py-2.5 bg-white dark:bg-zinc-900 border-b border-slate-100 dark:border-zinc-800 animate-in fade-in duration-100">
          <div className="relative flex items-center bg-[#edf1f7] dark:bg-zinc-800 rounded-full px-3.5 py-1.5 border border-slate-200/50 dark:border-zinc-700">
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

      {/* Elevated Cards Session List matching Mockup media_1791044464191.webp */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 space-y-3">
        {filteredThreads.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 dark:text-zinc-500">
            {searchQuery ? "No matching sessions" : "No sessions yet. Tap + to start one."}
          </div>
        ) : (
          filteredThreads.map((thread) => {
            const isSelected = thread.id === selectedThreadId;
            const timeFormatted = formatThreadTimestamp(thread.updatedAt || thread.createdAt);
            const isSwiped = swipedThreadId === thread.id;
            const isConfirming = confirmDeleteId === thread.id;
            const statusLabel =
              thread.status === "active"
                ? "Active"
                : thread.status === "stopped"
                ? "Stopped"
                : thread.status === "failed"
                ? "Failed"
                : "Completed";

            return (
              <div
                key={thread.id}
                onTouchStart={(e) => {
                  touchStartXRef.current = e.touches[0].clientX;
                }}
                onTouchEnd={(e) => {
                  const deltaX = e.changedTouches[0].clientX - touchStartXRef.current;
                  if (deltaX < -40) {
                    setSwipedThreadId(thread.id);
                  } else if (deltaX > 40) {
                    setSwipedThreadId(null);
                    setConfirmDeleteId(null);
                  }
                }}
                onClick={() => {
                  if (isSwiped) {
                    setSwipedThreadId(null);
                    setConfirmDeleteId(null);
                  } else {
                    onSelectThread(thread.id);
                  }
                }}
                className={`group relative overflow-hidden rounded-3xl p-4 sm:p-5 transition-all cursor-pointer ${
                  isSelected
                    ? "bg-white dark:bg-zinc-900 ring-2 ring-[#6750a4] shadow-md"
                    : "bg-white dark:bg-zinc-900 hover:shadow-md shadow-xs border border-slate-100 dark:border-zinc-850"
                }`}
              >
                <div
                  className={`min-w-0 transition-transform ${
                    isSwiped ? "-translate-x-20" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h2
                      className={`text-sm sm:text-base leading-snug line-clamp-2 ${
                        isSelected
                          ? "font-bold text-slate-900 dark:text-zinc-100"
                          : "font-semibold text-slate-900 dark:text-zinc-100"
                      }`}
                    >
                      {thread.title || "New session"}
                    </h2>

                    {onDeleteThread && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isConfirming) {
                            onDeleteThread(thread.id);
                            setConfirmDeleteId(null);
                            setSwipedThreadId(null);
                          } else {
                            setConfirmDeleteId(thread.id);
                          }
                        }}
                        className={`opacity-0 group-hover:opacity-100 p-1.5 rounded-full text-xs font-medium transition-all ${
                          isConfirming
                            ? "opacity-100 bg-rose-600 text-white"
                            : "text-slate-400 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-zinc-800"
                        }`}
                        title={isConfirming ? "Confirm delete" : "Delete session"}
                      >
                        {isConfirming ? "Confirm?" : <Trash2 className="h-4 w-4" />}
                      </button>
                    )}
                  </div>

                  {/* Subtext matching Mockup: "• 12 Oct • 2:34 PM • 3 participants • Active" */}
                  <div className="mt-2 text-xs text-slate-500 dark:text-zinc-400 flex items-center flex-wrap gap-1 font-normal">
                    <span>{timeFormatted || "• Today"}</span>
                    <span>•</span>
                    <span
                      className={
                        thread.status === "active"
                          ? "text-[#6750a4] dark:text-[#d0bcff] font-semibold"
                          : ""
                      }
                    >
                      {statusLabel}
                    </span>
                  </div>
                </div>

                {/* Swiped Action Button */}
                {isSwiped && onDeleteThread && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isConfirming) {
                        onDeleteThread(thread.id);
                        setConfirmDeleteId(null);
                        setSwipedThreadId(null);
                      } else {
                        setConfirmDeleteId(thread.id);
                      }
                    }}
                    className="absolute right-0 top-0 bottom-0 px-5 bg-rose-600 text-white font-medium text-xs flex items-center justify-center transition-all z-10 rounded-r-3xl"
                  >
                    {isConfirming ? "Confirm?" : "Delete"}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
