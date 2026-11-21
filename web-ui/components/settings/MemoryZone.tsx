"use client";

import React from "react";
import { History } from "lucide-react";

export interface MemoryZoneProps {
  memoryText: string;
  memoryMessage: string | null;
  memorySaving: boolean;
  memoryTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onMemoryTextChange: (value: string) => void;
  onSaveMemory: () => void;
}

export function MemoryZone({
  memoryText,
  memoryMessage,
  memorySaving,
  memoryTextareaRef,
  onMemoryTextChange,
  onSaveMemory,
}: MemoryZoneProps) {
  return (
    <>
      <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-400 mb-3 px-1">
        Memory
      </h2>

      <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-4">
        <div>
          <div className="text-base font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
            <History className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <span>What the assistant should always know</span>
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 mt-1">
            Stored on this machine only. Never committed to the repository.
          </p>
        </div>

        <textarea
          data-testid="settings-memory-textarea"
          ref={memoryTextareaRef}
          value={memoryText}
          onChange={(e) => onMemoryTextChange(e.target.value)}
          rows={6}
          className="w-full rounded-2xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 px-3 py-2 text-sm text-slate-900 dark:text-zinc-100 font-mono resize-y"
          placeholder="Standing facts the assistant should trust without rediscovering..."
        />

        <div className="flex items-center justify-between">
          <div
            data-testid="settings-memory-counter"
            className={
              memoryText.length > 2000
                ? "text-xs font-mono text-rose-600 dark:text-rose-400"
                : "text-xs font-mono text-slate-500 dark:text-zinc-400"
            }
          >
            {memoryText.length} / 2000
          </div>
          <button
            data-testid="settings-memory-save-btn"
            onClick={onSaveMemory}
            disabled={memorySaving || memoryText.length > 2000}
            className="rounded-xl px-4 py-2 text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {memorySaving ? "Saving..." : "Save"}
          </button>
        </div>

        {memoryMessage && (
          <div
            data-testid="settings-memory-message"
            className="text-xs text-slate-600 dark:text-zinc-400"
          >
            {memoryMessage}
          </div>
        )}
      </div>
    </>
  );
}
