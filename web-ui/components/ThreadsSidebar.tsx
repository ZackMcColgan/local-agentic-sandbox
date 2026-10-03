"use client";

import React, { useState } from "react";
import { Plus, Search, MessageSquare, Trash2, Clock, CheckCircle2, StopCircle, AlertCircle } from "lucide-react";
import { Thread } from "@/lib/threads/threadStore";

interface ThreadsSidebarProps {
  threads: Thread[];
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
  onDeleteThread?: (threadId: string) => void;
}

export function ThreadsSidebar({
  threads,
  selectedThreadId,
  onSelectThread,
  onNewThread,
  onDeleteThread
}: ThreadsSidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [swipedThreadId, setSwipedThreadId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const touchStartXRef = React.useRef<number>(0);

  const filteredThreads = threads.filter((t) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return t.title.toLowerCase().includes(q) || (t.messages && t.messages.some((m) => m.content.toLowerCase().includes(q)));
  });

  const formatThreadTimestamp = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffHrs / 24);

      if (diffHrs < 1) return "Just now";
      if (diffHrs < 24) return `${diffHrs}h ago`;
      if (diffDays === 1) return "Yesterday";
      if (diffDays < 7) return `${diffDays}d ago`;
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  };

  return (
    <aside className="w-full sm:w-80 md:w-84 flex flex-col h-full bg-white dark:bg-zinc-950 border-r border-slate-200/80 dark:border-zinc-800 shrink-0">
      {/* Top Header */}
      <div className="p-4 flex items-center justify-between border-b border-slate-100 dark:border-zinc-900">
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
          Threads
        </h2>

        <button
          type="button"
          onClick={onNewThread}
          className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-zinc-850 dark:hover:bg-zinc-800 text-slate-800 dark:text-zinc-200 transition-colors shadow-xs"
          title="Start new thread"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Search Threads Input */}
      <div className="px-4 py-3 border-b border-slate-100 dark:border-zinc-900">
        <div className="relative flex items-center bg-[#edf1f7] dark:bg-zinc-900 rounded-full px-3.5 py-2 border border-slate-200/50 dark:border-zinc-800">
          <Search className="h-4 w-4 text-slate-400 shrink-0 mr-2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search threads"
            className="w-full text-xs text-slate-900 dark:text-zinc-100 placeholder-slate-400 bg-transparent focus:outline-none"
          />
        </div>
      </div>

      {/* Threads List */}
      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-slate-100/60 dark:divide-zinc-900/60 py-1">
        {filteredThreads.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 dark:text-zinc-500">
            {searchQuery ? "No matching threads" : "No threads yet. Tap + to start one."}
          </div>
        ) : (
          filteredThreads.map((thread) => {
            const isSelected = thread.id === selectedThreadId;
            const timeAgo = thread.timeLabel || formatThreadTimestamp(thread.updatedAt || thread.createdAt);
            const isSwiped = swipedThreadId === thread.id;
            const isConfirming = confirmDeleteId === thread.id;

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
                className={`group relative flex items-center overflow-hidden cursor-pointer transition-all ${
                  isSelected
                    ? "bg-[#ede7fe] dark:bg-indigo-950/40"
                    : "hover:bg-slate-50 dark:hover:bg-zinc-900/40"
                }`}
              >
                {/* Active left indicator strip */}
                {isSelected && (
                  <div className="w-1.5 self-stretch bg-[#5b32e6] rounded-r shrink-0" />
                )}

                <div className={`flex-1 p-3.5 min-w-0 transition-transform ${!isSelected ? "pl-5" : "pl-3.5"} ${isSwiped ? "-translate-x-20" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-xs sm:text-sm truncate ${
                        isSelected
                          ? "font-bold text-slate-900 dark:text-zinc-100"
                          : "font-semibold text-slate-900 dark:text-zinc-200"
                      }`}
                    >
                      {thread.title || "New thread"}
                    </span>

                    {/* Desktop quick-delete trigger without any ⋮ menu */}
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
                        className={`opacity-0 group-hover:opacity-100 px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                          isConfirming
                            ? "opacity-100 bg-rose-600 text-white"
                            : "text-slate-400 hover:text-rose-500"
                        }`}
                        title={isConfirming ? "Confirm delete" : "Delete session"}
                      >
                        {isConfirming ? "Confirm?" : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  </div>

                  {/* Subtitle with status and timestamp */}
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-zinc-400">
                    {thread.status === "active" ? (
                      <span className="flex items-center gap-1 font-medium text-slate-600 dark:text-zinc-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-[#5b32e6] shrink-0" />
                        <span className="font-semibold text-[#5b32e6] dark:text-indigo-400">Active</span>
                        <span className="text-slate-400">·</span>
                        <span>{thread.workerInfo || "Worker 2"}</span>
                      </span>
                    ) : thread.status === "stopped" ? (
                      <span className="text-slate-500 dark:text-zinc-400">
                        Stopped · {timeAgo}
                      </span>
                    ) : thread.status === "completed" ? (
                      <span className="text-slate-500 dark:text-zinc-400">
                        Completed · {timeAgo}
                      </span>
                    ) : (
                      <span className="text-rose-600 dark:text-rose-400">
                        Failed · {timeAgo}
                      </span>
                    )}
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
                    className="absolute right-0 top-0 bottom-0 px-4 bg-rose-600 text-white font-medium text-xs flex items-center justify-center transition-all z-10"
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
