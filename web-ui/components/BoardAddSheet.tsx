"use client";

import React, { useState } from "react";
import type { BoardItem } from "@/lib/board/boardStore";

export interface BoardAddSheetProps {
  isOpen: boolean;
  existingItems: BoardItem[];
  onClose: () => void;
  onAskAssistant: (draftPrompt: string) => void;
  onCreateManual: (input: {
    title: string;
    brief: string;
    dependencies: string[];
  }) => Promise<void>;
}

export function BoardAddSheet({
  isOpen,
  existingItems,
  onClose,
  onAskAssistant,
  onCreateManual,
}: BoardAddSheetProps) {
  const [assistantText, setAssistantText] = useState("");
  const [showManualEditor, setShowManualEditor] = useState(false);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [selectedDeps, setSelectedDeps] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleAssistantSubmit = () => {
    const trimmed = assistantText.trim();
    const prompt = trimmed
      ? `Draft a board item for Queued: ${trimmed}`
      : "Help me draft a new board item for Queued.";
    onAskAssistant(prompt);
    setAssistantText("");
    onClose();
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !brief.trim()) {
      setError("Title and brief are required.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onCreateManual({
        title: title.trim(),
        brief: brief.trim(),
        dependencies: selectedDeps,
      });
      setTitle("");
      setBrief("");
      setSelectedDeps([]);
      setShowManualEditor(false);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create item");
    } finally {
      setSubmitting(false);
    }
  };

  const toggleDep = (id: string) => {
    setSelectedDeps((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-4 md:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Add to the board"
    >
      <div className="w-full max-w-[390px] rounded-[20px] border border-[#26262b] bg-[#101013] p-5 text-zinc-100 shadow-2xl">
        <div className="mx-auto mb-4 h-1 w-9 rounded-full bg-zinc-700" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-[19px] font-semibold tracking-[-0.2px] text-zinc-100">
              Add to the board
            </h1>
            <p className="pt-1 text-[12.5px] leading-relaxed text-zinc-400">
              New items land in Queued. Nothing reaches the board without you behind it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>

        {/* Door 1: Ask the assistant */}
        <div className="mt-3.5 rounded-[14px] border border-[#10b981] p-3.5 shadow-[0_0_0_1px_#10b981_inset]">
          <h2 className="flex items-center gap-2 text-[14.5px] font-semibold text-zinc-100">
            Ask the assistant
            <span className="rounded-full bg-[#10b981] px-2 py-0.5 text-[9.5px] font-bold tracking-[0.6px] text-[#04150e]">
              NEW
            </span>
          </h2>
          <p className="pt-1.5 text-[12.5px] leading-relaxed text-zinc-400">
            Say it in plain words. The assistant drafts the brief, files it in Queued, and stamps it as your request.
          </p>
          <input
            type="text"
            value={assistantText}
            onChange={(e) => setAssistantText(e.target.value)}
            placeholder="Add an item: fix the settings toggle spacing…"
            className="mt-2.5 w-full rounded-[11px] border border-[#2a2a30] bg-black px-3 py-2.5 text-[13.5px] text-zinc-200 placeholder:text-zinc-400 focus:border-[#10b981] focus:outline-none"
          />
          <button
            type="button"
            onClick={handleAssistantSubmit}
            className="mt-2.5 w-full rounded-[11px] bg-[#10b981] py-2.5 text-center text-[14px] font-bold text-[#04150e] transition hover:opacity-90"
          >
            Add via assistant
          </button>
        </div>

        {/* Door 2: Write it myself */}
        <div className="mt-3.5 rounded-[14px] border border-[#26262b] p-3.5">
          <h2 className="text-[14.5px] font-semibold text-zinc-100">
            Write it myself
          </h2>
          <p className="pt-1.5 text-[12.5px] leading-relaxed text-zinc-400">
            Title, brief, dependencies — the full editor, same as any existing item.
          </p>

          {!showManualEditor ? (
            <button
              type="button"
              onClick={() => setShowManualEditor(true)}
              className="mt-2.5 w-full rounded-[11px] border border-[#2a2a30] bg-transparent py-2.5 text-center text-[14px] font-bold text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
            >
              Open the editor
            </button>
          ) : (
            <form onSubmit={handleManualSubmit} className="mt-3 space-y-2.5">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Item title (e.g. fix-toggle-spacing)"
                className="w-full rounded-[11px] border border-[#2a2a30] bg-black px-3 py-2 text-[13px] text-zinc-200 placeholder:text-zinc-400 focus:border-[#10b981] focus:outline-none"
              />
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="Brief description of what needs to be done"
                rows={3}
                className="w-full rounded-[11px] border border-[#2a2a30] bg-black px-3 py-2 text-[13px] text-zinc-200 placeholder:text-zinc-400 focus:border-[#10b981] focus:outline-none"
              />
              {existingItems.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold text-zinc-400">
                    Dependencies (optional)
                  </div>
                  <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                    {existingItems.slice(0, 12).map((item) => {
                      const active = selectedDeps.includes(item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => toggleDep(item.id)}
                          className={`rounded-full border px-2.5 py-0.5 text-[10.5px] ${
                            active
                              ? "border-[#10b981] bg-[#10b981]/15 text-[#10b981]"
                              : "border-[#26262b] text-zinc-400"
                          }`}
                        >
                          {item.key} {item.title}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {error && <p className="text-[12px] text-red-400">{error}</p>}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowManualEditor(false)}
                  className="flex-1 rounded-[11px] border border-[#2a2a30] py-2 text-[13px] font-semibold text-zinc-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 rounded-[11px] bg-[#10b981] py-2 text-[13px] font-bold text-[#04150e] disabled:opacity-50"
                >
                  {submitting ? "Saving…" : "File in Queued"}
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="mt-4 border-t border-[#1d1d21] pt-3.5 text-center text-[11.5px] leading-relaxed text-zinc-400">
          However it arrives, the item shows its author.
          <br />
          <b className="text-zinc-300">The loop never adds items on its own.</b>
        </div>
      </div>
    </div>
  );
}
