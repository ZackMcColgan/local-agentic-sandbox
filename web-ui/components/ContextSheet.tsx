"use client";

import React from "react";
import { X, Sparkles } from "lucide-react";
import { formatContextK } from "../lib/tokenEconomics";
import type { ContextSegments } from "../lib/contextSegments";

// Board #138 (owner directive, Nov 25 2026): the context sheet. ONE component
// that renders as a bottom sheet on mobile (< md:) and a centered dialog on
// desktop. Design locks: pure #000000 canvas, emerald #10b981 as the only
// accent, rose reserved for the 85K auto-compact trigger tick, text zinc-400
// or brighter, 44px minimum touch targets, one idea per row.

export interface ContextSheetCompaction {
  summary: string;
  compactedAt: string;
  tokensBefore: number;
  tokensAfter: number;
}

interface ContextSheetProps {
  open: boolean;
  onClose: () => void;
  usedTokens: number;
  budgetTokens: number;
  /** Auto-compact trigger marker (85K). */
  triggerTokens: number;
  segments: ContextSegments;
  /** The last round's actual prompt tokens from the thread record. */
  lastRoundPromptTokens: number;
  compactionCount: number;
  /** Last compaction boundary, or null when none exists. */
  compaction: ContextSheetCompaction | null;
  isStreaming: boolean;
  isCompacting: boolean;
  onCompact: () => void;
  onRestore: () => void;
}

function SegmentRow({
  label,
  tokens,
  budget,
}: {
  label: string;
  tokens: number;
  budget: number;
}) {
  const pct = budget > 0 ? Math.min(100, Math.round((tokens / budget) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-xs font-medium text-zinc-300">{label}</span>
      <div className="h-[6px] flex-1 rounded-[3px] bg-zinc-800">
        <div
          className="h-full rounded-[3px] bg-[#10b981]"
          style={{ width: `${pct}%`, minWidth: tokens > 0 ? "4px" : "0px" }}
        />
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-[11px] text-zinc-300">
        {formatContextK(tokens)}
      </span>
    </div>
  );
}

export function ContextSheet(props: ContextSheetProps) {
  if (!props.open) return null;

  const {
    onClose,
    usedTokens,
    budgetTokens,
    triggerTokens,
    segments,
    lastRoundPromptTokens,
    compactionCount,
    compaction,
    isStreaming,
    isCompacting,
    onCompact,
    onRestore,
  } = props;

  const percent = budgetTokens > 0 ? Math.round((usedTokens / budgetTokens) * 100) : 0;
  const freeTokens = Math.max(0, budgetTokens - usedTokens);
  const compactDisabled = isStreaming || isCompacting;
  const compactReason = isStreaming
    ? "A turn is streaming — wait for it to finish."
    : isCompacting
      ? "Compaction in flight."
      : "";

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Context"
        data-testid="context-sheet"
        className="relative w-full md:w-[420px] md:max-w-full bg-black border border-zinc-800 rounded-t-2xl md:rounded-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Row 1: title + close */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <h3 className="text-sm font-bold text-zinc-100">Context</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close context sheet"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-zinc-300 hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Row 2: big used / budget readout */}
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-2xl font-semibold text-zinc-100">
            {formatContextK(usedTokens)}
          </span>
          <span className="font-mono text-sm text-zinc-300">
            {`/ ${Math.round(budgetTokens / 1000)}K · ${percent}% · ${formatContextK(freeTokens)} free`}
          </span>
        </div>

        {/* Row 3: bar with the rose 85K trigger tick */}
        <div data-testid="context-sheet-bar" className="relative h-[8px] w-full rounded-[4px] bg-zinc-800">
          <div
            className="h-full rounded-[4px] bg-[#10b981]"
            style={{
              width: `${Math.min(100, percent)}%`,
              minWidth: usedTokens > 0 ? "4px" : "0px",
            }}
          />
          <span
            data-testid="context-sheet-tick"
            aria-hidden="true"
            title={`${Math.round(triggerTokens / 1000)}K compaction trigger`}
            className="absolute left-[85%] -top-[3px] w-[2px] h-[14px] bg-[#f87171]"
          />
          <span className="absolute left-[85%] top-[10px] font-mono text-[10px] text-[#f87171]">
            {Math.round(triggerTokens / 1000)}K
          </span>
        </div>

        {/* Rows 4-6: segment bars, one idea per row */}
        <div className="space-y-2 pt-2">
          <SegmentRow label="Tool results" tokens={segments.toolResults} budget={budgetTokens} />
          <SegmentRow label="Conversation" tokens={segments.conversation} budget={budgetTokens} />
          <SegmentRow label="System" tokens={segments.system} budget={budgetTokens} />
        </div>

        {/* Row 7: chips — last round, compactions */}
        <div className="flex items-center gap-2">
          <span className="px-3 py-1.5 rounded-full border border-zinc-800 text-xs font-medium text-zinc-300">
            Last round {formatContextK(lastRoundPromptTokens)}
          </span>
          <span className="px-3 py-1.5 rounded-full border border-zinc-800 text-xs font-medium text-zinc-300">
            Compactions <span className="font-mono text-zinc-100">{compactionCount}</span>
          </span>
        </div>

        {/* Row 8: last-compaction card (only when a boundary exists) */}
        {compaction && (
          <div className="rounded-xl border border-zinc-800 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-[#10b981]" />
              <span className="text-xs font-semibold text-zinc-200">Last compaction</span>
            </div>
            <div className="flex justify-between font-mono text-[11px] text-zinc-300">
              <span>{compaction.tokensBefore} → {compaction.tokensAfter} tokens</span>
              <span>{new Date(compaction.compactedAt).toLocaleString()}</span>
            </div>
            <pre className="max-h-40 overflow-y-auto p-2 rounded-lg bg-zinc-900 font-mono text-[11px] whitespace-pre-wrap text-zinc-300 border border-zinc-800">
              {compaction.summary}
            </pre>
          </div>
        )}

        {/* Row 9: actions */}
        <div className="flex items-center gap-2 pt-2 border-t border-zinc-800">
          <button
            type="button"
            data-testid="context-sheet-compact"
            onClick={onCompact}
            disabled={compactDisabled}
            className="min-h-[44px] flex-1 rounded-xl text-xs font-semibold bg-[#10b981] text-black hover:bg-[#34d399] disabled:opacity-40 disabled:pointer-events-none transition-colors"
          >
            {isCompacting ? "Compacting history..." : "Compact history now"}
          </button>
          {compaction && (
            <button
              type="button"
              data-testid="context-sheet-restore"
              onClick={onRestore}
              className="min-h-[44px] px-3 rounded-xl text-xs font-semibold border border-[#f87171] text-[#f87171] hover:border-[#fca5a5] hover:text-[#fca5a5] transition-colors"
            >
              Restore full history
            </button>
          )}
        </div>
        {compactReason && (
          <p className="text-[11px] text-zinc-300">{compactReason}</p>
        )}
      </div>
    </div>
  );
}
