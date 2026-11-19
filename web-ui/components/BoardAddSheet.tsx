"use client";

import React, { useEffect, useState } from "react";
import type { BoardItem } from "@/lib/board/boardStore";
import type { IntakeStackItem } from "@/lib/board/monsterIntake";

export interface BoardAddSheetProps {
  isOpen: boolean;
  existingItems: BoardItem[];
  onClose: () => void;
  onAskAssistant?: (draftPrompt: string) => void;
  onItemsFiled?: (items: BoardItem[], startedDrain: boolean) => void;
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
  onItemsFiled,
  onCreateManual,
}: BoardAddSheetProps) {
  const [assistantText, setAssistantText] = useState("");
  const [stagedItems, setStagedItems] = useState<IntakeStackItem[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);

  const [showManualEditor, setShowManualEditor] = useState(false);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [selectedDeps, setSelectedDeps] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleClose = () => {
    setStagedItems(null);
    setIntakeError(null);
    onClose();
  };

  const handlePreviewSubmit = async () => {
    const trimmed = assistantText.trim();
    if (!trimmed) {
      setIntakeError("Describe what you want to build or paste a prompt first.");
      return;
    }
    setIntakeError(null);
    setPreviewLoading(true);
    try {
      const res = await fetch("/api/board/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "preview",
          prompt: trimmed,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStagedItems(null);
        setIntakeError(data.error || "Failed to generate intake preview");
        return;
      }
      setStagedItems(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setStagedItems(null);
      setIntakeError(err instanceof Error ? err.message : "Failed to generate intake preview");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleConfirmStack = async (startDrain: boolean) => {
    if (!stagedItems || stagedItems.length === 0) return;
    setIntakeError(null);
    setConfirmLoading(true);
    try {
      const res = await fetch("/api/board/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "confirm",
          items: stagedItems,
          startDrain,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setIntakeError(data.error || "Failed to file stack");
        return;
      }
      const filed: BoardItem[] = Array.isArray(data.items) ? data.items : [];
      onItemsFiled?.(filed, startDrain);
      setAssistantText("");
      setStagedItems(null);
      setIntakeError(null);
      onClose();
    } catch (err) {
      setIntakeError(err instanceof Error ? err.message : "Failed to file stack");
    } finally {
      setConfirmLoading(false);
    }
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
      <div className="max-h-[90vh] w-full max-w-[420px] overflow-y-auto rounded-[20px] border border-[#26262b] bg-[#101013] p-5 text-zinc-100 shadow-2xl">
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
            onClick={handleClose}
            aria-label="Close"
            className="rounded-lg px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>

        {/* Door 1: Ask the assistant (Monster-Prompt Single-Call Intake) */}
        <div className="mt-3.5 rounded-[14px] border border-[#10b981] p-3.5 shadow-[0_0_0_1px_#10b981_inset]">
          <h2 className="flex items-center gap-2 text-[14.5px] font-semibold text-zinc-100">
            Ask the assistant
            <span className="rounded-full bg-[#10b981] px-2 py-0.5 text-[9.5px] font-bold tracking-[0.6px] text-[#04150e]">
              NEW
            </span>
          </h2>
          <p className="pt-1.5 text-[12.5px] leading-relaxed text-zinc-400">
            Paste a plain-words request or multi-item spec. Preview the ordered stack first, then confirm in one tap.
          </p>

          {!stagedItems ? (
            <>
              <textarea
                value={assistantText}
                onChange={(e) => setAssistantText(e.target.value)}
                placeholder="Paste a task or multi-item prompt…"
                rows={4}
                data-testid="intake-prompt-input"
                className="mt-2.5 w-full rounded-[11px] border border-[#2a2a30] bg-black px-3 py-2.5 text-[13.5px] text-zinc-200 placeholder:text-zinc-400 focus:border-[#10b981] focus:outline-none"
              />
              {intakeError && (
                <p
                  data-testid="intake-error"
                  className="mt-2 rounded-lg border border-red-500/40 bg-red-950/40 px-2.5 py-1.5 text-[12px] text-red-300"
                >
                  {intakeError}
                </p>
              )}
              <button
                type="button"
                onClick={handlePreviewSubmit}
                disabled={previewLoading}
                data-testid="intake-preview-btn"
                className="mt-2.5 w-full rounded-[11px] bg-[#10b981] py-2.5 text-center text-[14px] font-bold text-[#04150e] transition hover:opacity-90 disabled:opacity-50"
              >
                {previewLoading ? "Drafting stack…" : "Preview stack"}
              </button>
            </>
          ) : (
            <div className="mt-3 space-y-2.5" data-testid="intake-preview-stack">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-zinc-200">
                  Staged stack ({stagedItems.length}{" "}
                  {stagedItems.length === 1 ? "item" : "items"})
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setStagedItems(null);
                    setIntakeError(null);
                  }}
                  disabled={confirmLoading}
                  data-testid="intake-discard-btn"
                  className="text-[12px] font-medium text-zinc-400 underline hover:text-zinc-200"
                >
                  Edit prompt
                </button>
              </div>

              <ol className="max-h-60 space-y-2 overflow-y-auto pr-0.5">
                {stagedItems.map((item, idx) => (
                  <li
                    key={item.tempKey || idx}
                    data-testid={`intake-staged-item-${idx}`}
                    className="rounded-[11px] border border-[#26262b] bg-black p-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[13px] font-semibold text-zinc-100">
                        {idx + 1}. {item.title}
                      </span>
                      {item.tempKey && (
                        <span className="shrink-0 rounded bg-[#1d1d21] px-1.5 py-0.5 text-[10px] font-mono text-zinc-300">
                          {item.tempKey}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[12px] leading-snug text-zinc-300">
                      {item.brief}
                    </p>
                    {item.dependencies.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <span className="text-[11px] text-zinc-400">Deps:</span>
                        {item.dependencies.map((dep) => (
                          <span
                            key={dep}
                            className="rounded-full border border-[#10b981]/50 bg-[#10b981]/10 px-2 py-0.5 text-[10.5px] text-[#10b981]"
                          >
                            {dep}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-1.5 text-[11px] text-zinc-400">
                      {item.fileAllowlist.length} file
                      {item.fileAllowlist.length === 1 ? "" : "s"} ·{" "}
                      {item.acceptanceCriteria.length} acceptance check
                      {item.acceptanceCriteria.length === 1 ? "" : "s"}
                    </div>
                  </li>
                ))}
              </ol>

              {intakeError && (
                <p
                  data-testid="intake-error"
                  className="rounded-lg border border-red-500/40 bg-red-950/40 px-2.5 py-1.5 text-[12px] text-red-300"
                >
                  {intakeError}
                </p>
              )}

              <div className="flex flex-col gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => handleConfirmStack(false)}
                  disabled={confirmLoading}
                  data-testid="intake-confirm-queued-btn"
                  className="w-full rounded-[11px] bg-[#10b981] py-2.5 text-center text-[13.5px] font-bold text-[#04150e] transition hover:opacity-90 disabled:opacity-50"
                >
                  {confirmLoading ? "Filing…" : "Confirm & File to Queued"}
                </button>
                <button
                  type="button"
                  onClick={() => handleConfirmStack(true)}
                  disabled={confirmLoading}
                  data-testid="intake-confirm-drain-btn"
                  className="w-full rounded-[11px] border border-[#10b981] bg-[#10b981]/15 py-2.5 text-center text-[13.5px] font-bold text-[#10b981] transition hover:bg-[#10b981]/25 disabled:opacity-50"
                >
                  {confirmLoading ? "Filing…" : "Confirm & Start Drain"}
                </button>
              </div>
            </div>
          )}
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
              className="mt-2.5 w-full rounded-[11px] border border-[#2a2a30] bg-transparent py-2.5 text-center text-[14px] font-bold text-zinc-300 transition hover:border-zinc-400 hover:text-zinc-100"
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
