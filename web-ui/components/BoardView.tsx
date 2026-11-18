"use client";

import React, { useMemo, useRef, useState } from "react";
import type { BoardItem, BoardStatus } from "@/lib/board/boardStore";
import type { BoardControlAction, BoardControlState } from "@/lib/board/boardControlStore";
import { BoardAddSheet } from "./BoardAddSheet";

export interface BoardViewProps {
  items: BoardItem[];
  onOpenDrawer: () => void;
  onItemCreated: (item: BoardItem) => void;
  onAskAssistant: (draftPrompt: string) => void;
  controlState?: BoardControlState;
  stopAtBoundary?: boolean;
  isControlPending?: boolean;
  onControlAction?: (action: BoardControlAction) => void | Promise<void>;
}

const COLUMNS: { status: BoardStatus; label: string }[] = [
  { status: "queued", label: "QUEUED" },
  { status: "working", label: "WORKING" },
  { status: "pr-open", label: "PR OPEN" },
  { status: "parked", label: "ATTENTION / PARKED" },
  { status: "done", label: "DONE" },
];

export function BoardView({
  items,
  onOpenDrawer,
  onItemCreated,
  onAskAssistant,
  controlState = "stopped",
  stopAtBoundary = false,
  isControlPending = false,
  onControlAction,
}: BoardViewProps) {
  const [activeColIndex, setActiveColIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const [expandedBriefIds, setExpandedBriefIds] = useState<Record<string, boolean>>({});

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.key.toLowerCase().includes(q) ||
        item.brief.toLowerCase().includes(q)
    );
  }, [items, searchQuery]);

  const byStatus = useMemo(() => {
    const map: Record<BoardStatus, BoardItem[]> = {
      queued: [],
      working: [],
      "pr-open": [],
      parked: [],
      "needs-attention": [],
      done: [],
    };
    for (const item of filteredItems) {
      if (item.status === "needs-attention") {
        map.parked.push(item);
      } else {
        map[item.status]?.push(item);
      }
    }
    return map;
  }, [filteredItems]);

  const itemById = useMemo(
    () => new Map(items.map((i) => [i.id, i])),
    [items]
  );

  const handleCreateManual = async (input: {
    title: string;
    brief: string;
    dependencies: string[];
  }) => {
    const res = await fetch("/api/board", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        author: "Owner",
        source: "manual",
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Failed to create item");
    }
    onItemCreated(data.item);
  };

  const activeCol = COLUMNS[activeColIndex];

  const handlePrevCol = () => {
    setActiveColIndex((i) => (i > 0 ? i - 1 : COLUMNS.length - 1));
  };
  const handleNextCol = () => {
    setActiveColIndex((i) => (i < COLUMNS.length - 1 ? i + 1 : 0));
  };

  const renderCard = (item: BoardItem) => {
    const isLive = item.status === "working";
    const isDone = item.status === "done";
    const dotColor = isLive || isDone ? "bg-[#10b981]" : "bg-zinc-600";
    const deps = item.dependencies ?? [];
    const allDepsDone =
      deps.length > 0 &&
      deps.every((depId) => itemById.get(depId)?.status === "done");
    const waitingOn = deps
      .map((depId) => itemById.get(depId)?.key || depId)
      .join(", ");

    return (
      <div
        key={item.id}
        className={`mb-2.5 rounded-[14px] border border-[#1d1d21] bg-[#101013] p-3 ${
          isLive ? "shadow-[0_0_0_1px_#10b981_inset]" : ""
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className={`h-2 w-2 flex-none rounded-full ${dotColor}`} />
          <div className="flex-1 min-w-0 break-words line-clamp-2 text-[14.5px] font-semibold tracking-[-0.1px] text-zinc-100">
            {item.title}
          </div>
          <div className="max-w-[96px] truncate font-mono text-[10.5px] text-zinc-400">
            {item.key}
          </div>
        </div>

        <div
          className={`pt-1 text-[12.5px] leading-[1.45] text-zinc-400 ${
            expandedBriefIds[item.id] ? "whitespace-pre-wrap" : "line-clamp-3"
          }`}
        >
          {item.brief}
        </div>

        {item.evidence?.liveLine && (
          <div className="flex items-center gap-1.5 pt-2 text-[12px] text-zinc-400">
            <span className="text-[#10b981]">●</span>
            <span>{item.evidence.liveLine}</span>
          </div>
        )}

        {(item.status === "parked" || item.status === "needs-attention") && item.parkedReason && (
          <div className="pt-2 text-[12px] text-zinc-400">
            {item.parkedReason}
          </div>
        )}

        {item.status === "done" && item.evidence?.prNumber && (
          <div className="pt-2 text-[11.5px] text-zinc-400">
            <span className="text-[#10b981]">✓</span> PR #{item.evidence.prNumber}
            {item.evidence.mergeSha ? ` · ${item.evidence.mergeSha}` : ""}
            {item.evidence.deployTag ? ` · ${item.evidence.deployTag}` : ""}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5 pt-2">
          {(item.needsAttention || item.status === "needs-attention") && (
            <span className="rounded-full border border-zinc-600 bg-zinc-900 px-2 py-0.5 text-[10.5px] font-medium text-zinc-200">
              needs attention
            </span>
          )}
          {deps.length > 0 && !allDepsDone && (
            <span className="rounded-full border border-[#26262b] px-2 py-0.5 text-[10.5px] text-zinc-400">
              waits on <b className="font-semibold text-zinc-300">{waitingOn}</b>
            </span>
          )}
          {allDepsDone && (
            <span className="rounded-full border border-[#26262b] px-2 py-0.5 text-[10.5px] text-zinc-400">
              deps met <b className="font-semibold text-zinc-300">✓</b>
            </span>
          )}
          <span className="rounded-full border border-[#26262b] px-2 py-0.5 text-[10.5px] text-zinc-400">
            Author <b className="font-semibold text-zinc-300">{item.author}</b>
          </span>
          {item.sprint && (
            <span className="rounded-full border border-[#26262b] px-2 py-0.5 text-[10.5px] text-zinc-400">
              {item.sprint}
            </span>
          )}
          {isLive && (
            <>
              <button
                type="button"
                onClick={() =>
                  setExpandedBriefIds((prev) => ({
                    ...prev,
                    [item.id]: !prev[item.id],
                  }))
                }
                className="rounded-full border border-[#26262b] px-2 py-0.5 text-[10.5px] text-zinc-400 hover:text-zinc-200"
              >
                {expandedBriefIds[item.id] ? "Brief ⌄" : "Brief ›"}
              </button>
              {item.threadLink && (
                <a
                  href={item.threadLink}
                  className="rounded-full border border-[#26262b] px-2 py-0.5 text-[10.5px] text-zinc-400 hover:text-zinc-200"
                >
                  Thread ›
                </a>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-black text-zinc-100"
      onTouchStart={(e) => {
        const touch = e.touches[0];
        touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
      }}
      onTouchEnd={(e) => {
        const start = touchStartRef.current;
        touchStartRef.current = null;
        if (!start) return;
        const touch = e.changedTouches[0];
        if (!touch) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > 2 * Math.abs(dy)) {
          if (dx < 0) handleNextCol();
          else handlePrevCol();
        }
      }}
    >
      {/* Header */}
      <header className="flex flex-wrap shrink-0 items-center gap-2 border-b border-zinc-800 bg-black px-4 py-2 md:h-12 md:flex-nowrap md:gap-3 md:px-6 md:py-0">
        <button
          type="button"
          onClick={onOpenDrawer}
          aria-label="Open navigation drawer"
          className="flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-1 rounded-lg hover:bg-zinc-900 md:hidden"
        >
          <span className="block h-0.5 w-5 rounded bg-zinc-300" />
          <span className="block h-0.5 w-5 rounded bg-zinc-300" />
          <span className="block h-0.5 w-5 rounded bg-zinc-300" />
        </button>
        <div className="flex-1 text-[19px] font-semibold tracking-[-0.2px] md:flex-none md:text-[21px]">
          Board
        </div>
        <span
          data-testid="board-control-pill"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
            controlState === "running"
              ? "border-[#10b981]/60 bg-[#10b981]/10 text-[#10b981]"
              : controlState === "paused"
              ? "border-zinc-600 bg-zinc-900 text-zinc-200"
              : "border-zinc-700 bg-zinc-900 text-zinc-300"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              controlState === "running"
                ? "bg-[#10b981]"
                : controlState === "paused"
                ? "bg-zinc-300"
                : "bg-zinc-400"
            }`}
          />
          {controlState === "running"
            ? "Running"
            : controlState === "paused"
            ? stopAtBoundary
              ? "Paused · boundary"
              : "Paused"
            : "Stopped"}
        </span>
        <div
          role="group"
          aria-label="Board drain controls"
          className="flex w-full items-center gap-1.5 md:ml-auto md:w-auto"
        >
          <button
            type="button"
            disabled={isControlPending || controlState === "running"}
            onClick={() => onControlAction?.("start")}
            aria-pressed={controlState === "running"}
            className={`min-h-[36px] flex-1 rounded-[10px] border px-3 py-1 text-[12px] font-semibold transition-colors disabled:opacity-60 md:flex-none ${
              controlState === "running"
                ? "border-[#10b981] bg-[#10b981] text-[#04150e]"
                : "border-[#10b981]/70 text-[#10b981] hover:bg-[#10b981]/10"
            }`}
          >
            Start
          </button>
          <button
            type="button"
            disabled={isControlPending || controlState === "paused"}
            onClick={() => onControlAction?.("pause")}
            aria-pressed={controlState === "paused"}
            className={`min-h-[36px] flex-1 rounded-[10px] border px-3 py-1 text-[12px] font-semibold transition-colors disabled:opacity-60 md:flex-none ${
              controlState === "paused"
                ? "border-zinc-300 bg-zinc-200 text-black"
                : "border-zinc-700 text-zinc-200 hover:bg-zinc-900"
            }`}
          >
            Pause
          </button>
          <button
            type="button"
            disabled={isControlPending || controlState === "stopped"}
            onClick={() => onControlAction?.("stop")}
            aria-pressed={controlState === "stopped"}
            className={`min-h-[36px] flex-1 rounded-[10px] border px-3 py-1 text-[12px] font-semibold transition-colors disabled:opacity-60 md:flex-none ${
              controlState === "stopped"
                ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                : "border-zinc-700 text-zinc-200 hover:bg-zinc-900"
            }`}
          >
            Stop
          </button>
        </div>
        <button
          type="button"
          onClick={() => setIsAddOpen(true)}
          className="hidden min-h-[36px] rounded-[10px] border-[1.5px] border-[#10b981] px-3.5 py-1.5 text-[13px] font-semibold text-[#10b981] hover:bg-[#10b981]/10 md:inline-flex md:items-center"
        >
          + Add item
        </button>
      </header>

      {/* Search / filter row */}
      <div className="mx-4 mt-3 flex shrink-0 items-center gap-2.5 rounded-xl border border-[#1d1d21] bg-[#101013] px-3.5 py-2.5 md:mx-6">
        <span className="text-[15px] text-zinc-400">⌕</span>
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search the board"
          aria-label="Search the board"
          className="flex-1 bg-transparent text-[13.5px] text-zinc-100 placeholder:text-zinc-400 focus:outline-none"
        />
      </div>

      {/* Mobile: single-column carousel */}
      <div className="flex flex-1 min-h-0 flex-col md:hidden">
        <div className="flex items-center gap-2.5 px-4 pt-4">
          <button
            type="button"
            onClick={handlePrevCol}
            aria-label="Previous column"
            className="text-[19px] text-zinc-400 hover:text-zinc-100"
          >
            ‹
          </button>
          <div className="flex-1 text-[15px] font-bold tracking-[1.2px] text-zinc-100">
            {activeCol.label}
          </div>
          <div className="rounded-full border border-[#2a2a30] bg-[#1c1c20] px-2.5 py-0.5 text-[11px] font-bold text-zinc-300">
            {byStatus[activeCol.status].length}
          </div>
          <button
            type="button"
            onClick={handleNextCol}
            aria-label="Next column"
            className="text-[19px] text-zinc-400 hover:text-zinc-100"
          >
            ›
          </button>
        </div>

        <div className="flex items-center gap-1.5 px-4 pt-2.5 pb-1">
          {COLUMNS.map((col, idx) => (
            <button
              key={col.status}
              type="button"
              aria-label={`Show ${col.label}`}
              onClick={() => setActiveColIndex(idx)}
              className={`h-1.5 rounded-full transition-all ${
                idx === activeColIndex
                  ? "w-5 rounded-[3px] bg-[#10b981]"
                  : "w-1.5 bg-zinc-700"
              }`}
            />
          ))}
          <span className="ml-2 text-[10.5px] text-zinc-400">
            {activeCol.status === "queued"
              ? "in order — top item goes next"
              : "swipe — Queued · Working · PR Open · Parked · Done"}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto touch-pan-y overscroll-contain px-4 pt-3 pb-24">
          {byStatus[activeCol.status].map(renderCard)}
          {activeCol.status === "working" && (
            <div className="mt-3.5 rounded-[14px] border-[1.5px] border-dashed border-[#26262b] p-4 text-center text-[12.5px] leading-relaxed text-zinc-400">
              One job at a time.
              <br />
              The next item starts itself when this one lands.
            </div>
          )}
          {byStatus[activeCol.status].length === 0 &&
            activeCol.status !== "working" && (
              <div className="mt-3.5 rounded-[12px] border-[1.5px] border-dashed border-[#26262b] py-6 text-center text-[12.5px] text-zinc-400">
                No items in {activeCol.label}
              </div>
            )}
        </div>

        <button
          type="button"
          onClick={() => setIsAddOpen(true)}
          aria-label="Add to the board"
          className="fixed right-4 bottom-5 flex h-14 w-14 items-center justify-center rounded-full bg-[#10b981] text-[30px] font-medium text-[#04150e] shadow-[0_6px_18px_rgba(16,185,129,0.35)]"
        >
          +
        </button>
      </div>

      {/* Desktop: five columns side by side */}
      <div className="hidden flex-1 min-h-0 grid-cols-5 gap-3.5 overflow-hidden px-6 pt-4 pb-6 md:grid">
        {COLUMNS.map((col) => {
          const colItems = byStatus[col.status];
          return (
            <div key={col.status} className="flex min-h-0 min-w-0 flex-col overflow-hidden">
              <div className="mb-2.5 flex shrink-0 items-baseline gap-2 px-0.5">
                <h2 className="text-[12px] font-bold tracking-[1.1px] text-zinc-300">
                  {col.label}
                </h2>
                <span className="text-[11.5px] text-zinc-400">
                  {colItems.length}
                </span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto touch-pan-y overscroll-contain pr-1">
                {colItems.length === 0 ? (
                  <div className="rounded-[12px] border-[1.5px] border-dashed border-[#26262b] py-5 text-center text-[12.5px] text-zinc-400">
                    No items
                  </div>
                ) : (
                  colItems.map(renderCard)
                )}
              </div>
            </div>
          );
        })}
      </div>

      <BoardAddSheet
        isOpen={isAddOpen}
        existingItems={items}
        onClose={() => setIsAddOpen(false)}
        onAskAssistant={onAskAssistant}
        onCreateManual={handleCreateManual}
      />
    </div>
  );
}
