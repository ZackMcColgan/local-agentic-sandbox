"use client";

import React, { useEffect, useState } from "react";
import { Menu, Wrench, CheckCircle2, XCircle, Sparkles, BookOpen, FileCode, X } from "lucide-react";

interface SkillCandidateItem {
  id: string;
  title: string;
  pattern: string;
  occurrences: number;
  solutionSummary: string;
  status: "pending" | "approved" | "rejected";
}

interface SkillsViewProps {
  onOpenDrawer: () => void;
  pendingCount?: number;
  initialPending?: SkillCandidateItem[];
  initialActive?: string[];
  initialFlywheel?: any[];
  initialPreviewCandidate?: SkillCandidateItem | null;
}

export function SkillsView({
  onOpenDrawer,
  pendingCount = 0,
  initialPending,
  initialActive,
  initialFlywheel,
  initialPreviewCandidate
}: SkillsViewProps) {
  const [pending, setPending] = useState<SkillCandidateItem[]>(initialPending || []);
  const [active, setActive] = useState<string[]>(initialActive || []);
  const [flywheel, setFlywheel] = useState<any[]>(initialFlywheel || []);
  const [loading, setLoading] = useState<boolean>(!initialPending);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewCandidate, setPreviewCandidate] = useState<SkillCandidateItem | null>(initialPreviewCandidate || null);

  const fetchSkills = async () => {
    if (typeof window === "undefined" || !window.location || !window.location.origin) {
      return;
    }
    try {
      setLoading(true);
      const res = await fetch("/api/skills");
      if (res.ok) {
        const data = await res.json();
        setPending(data.pendingCandidates || []);
        setActive(data.activeSkills || []);
        setFlywheel(data.flywheelSkills || []);
      }
    } catch {
      // Non-fatal in test environments
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!initialPending) {
      fetchSkills();
    }
  }, [initialPending]);

  const handleApprove = async (candidateId: string) => {
    try {
      setActionError(null);
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve", candidateId })
      });
      if (res.ok) {
        await fetchSkills();
      } else {
        const errJson = await res.json();
        setActionError(errJson.error || "Failed to approve skill candidate");
      }
    } catch (err: any) {
      setActionError(err.message || "Failed to approve skill candidate");
    }
  };

  const handleReject = async (candidateId: string) => {
    try {
      setActionError(null);
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", candidateId })
      });
      if (res.ok) {
        await fetchSkills();
      } else {
        const errJson = await res.json();
        setActionError(errJson.error || "Failed to reject skill candidate");
      }
    } catch (err: any) {
      setActionError(err.message || "Failed to reject skill candidate");
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-white dark:bg-zinc-950 overflow-y-auto">
      <div className="max-w-4xl mx-auto w-full p-4 sm:p-6 space-y-6">
        {/* Header */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-4 shadow-sm border border-slate-100 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onOpenDrawer}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-full text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
              title="Open menu"
              aria-label="Open navigation menu"
            >
              <Menu className="h-6 w-6" />
            </button>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
              Skills
            </h1>
          </div>
          {pending.length > 0 && (
            <span className="px-3 py-1 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-400">
              {pending.length} <span className="hidden sm:inline">Pending Review</span><span className="sm:hidden">Pending</span>
            </span>
          )}
        </div>

        {actionError && (
          <div className="p-3 text-xs rounded-2xl bg-rose-50 text-rose-800 border border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-900">
            {actionError}
          </div>
        )}

        {/* Section 1: Pending Candidates for Human Approval or Empty State */}
        {pending.length === 0 ? (
          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-sm border border-slate-100 dark:border-zinc-800 text-center space-y-2">
            <div className="h-12 w-12 rounded-2xl bg-slate-100 dark:bg-zinc-800 flex items-center justify-center mx-auto text-slate-400">
              <Wrench className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">No skills to review</h3>
            <p className="text-xs text-slate-600 dark:text-zinc-400 max-w-sm mx-auto">
              Skill candidates proposed by the recorder will appear here for human review and promotion into active skills.
            </p>
          </div>
        ) : (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
              <h2 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                Pending Human Approval (Observed ≥ 3x)
              </h2>
            </div>
            <div className="space-y-3">
              {pending.map((candidate) => (
                <div
                  key={candidate.id}
                  className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                        {candidate.title}
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-zinc-400 font-mono">
                        Pattern: {candidate.pattern} • Observed {candidate.occurrences} times
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 flex-wrap">
                      <button
                        type="button"
                        data-testid="view-skill-md-btn"
                        onClick={() => setPreviewCandidate(candidate)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors"
                      >
                        <FileCode className="h-3.5 w-3.5 text-slate-500 dark:text-zinc-400" />
                        <span>View SKILL.md</span>
                      </button>
                      <button
                        type="button"
                        data-testid="reject-skill-btn"
                        onClick={() => handleReject(candidate.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs font-semibold hover:bg-rose-100 dark:hover:bg-rose-900/60 transition-colors"
                      >
                        <XCircle className="h-4 w-4" />
                        Reject
                      </button>
                      <button
                        type="button"
                        data-testid="approve-skill-btn"
                        onClick={() => handleApprove(candidate.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-xs transition-colors"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        Approve &amp; Promote
                      </button>
                    </div>
                  </div>
                  <div className="p-3 bg-slate-50 dark:bg-zinc-800/60 rounded-2xl text-xs text-slate-800 dark:text-zinc-200">
                    <span className="font-semibold text-slate-900 dark:text-zinc-100 block mb-1">
                      Proposed Solution Summary:
                    </span>
                    {candidate.solutionSummary}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Section 2: Active Promoted Skills (.agent/skills) */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            <h2 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
              Active Promoted Skills ({active.length})
            </h2>
          </div>

          {active.length === 0 ? (
            <div className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-800 text-center text-xs text-slate-500 dark:text-zinc-400">
              No active skills promoted yet. Approved skills are saved to <code className="font-mono">.agent/skills/*.md</code>.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {active.map((filename) => (
                <div
                  key={filename}
                  className="bg-white dark:bg-zinc-900 rounded-2xl p-4 shadow-sm border border-slate-100 dark:border-zinc-800 flex items-center gap-3"
                >
                  <div className="h-8 w-8 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-xs font-mono font-medium text-slate-800 dark:text-zinc-200 truncate block">
                      {filename}
                    </span>
                    <span className="text-[11px] text-slate-500 dark:text-zinc-400">Promoted &amp; Active</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Section 3: SQLite Flywheel Reusable Patterns */}
        {flywheel.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
              Flywheel SQLite Pattern Store ({flywheel.length})
            </h2>
            <div className="space-y-2">
              {flywheel.map((fSkill: any) => (
                <div
                  key={fSkill.skillId}
                  className="bg-white dark:bg-zinc-900 rounded-2xl p-4 border border-slate-100 dark:border-zinc-800 flex items-center justify-between text-xs"
                >
                  <div>
                    <span className="font-semibold text-slate-900 dark:text-zinc-100">{fSkill.name}</span>
                    <span className="text-slate-500 dark:text-zinc-400 ml-2 font-mono text-[11px]">
                      [{fSkill.domain}] • {fSkill.sourceTaskId}
                    </span>
                  </div>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 font-mono text-slate-600 dark:text-zinc-300">
                    Used {fSkill.useCount}x
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* SKILL.md Preview Slide-Over Drawer matching Mockup 04 */}
      {previewCandidate && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/60"
          role="dialog"
          aria-modal="true"
          aria-label="Skill Inspector"
        >
          <div
            className="fixed inset-0 -z-10"
            onClick={() => setPreviewCandidate(null)}
          />
          <div className="bg-white dark:bg-zinc-900 w-[420px] max-w-[92vw] h-full flex flex-col shadow-2xl border-l border-slate-200 dark:border-zinc-800 overflow-hidden animate-in slide-in-from-right duration-200">
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-100 dark:border-zinc-800 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <FileCode className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                <span className="font-bold text-base text-slate-900 dark:text-zinc-100">
                  SKILL.md Preview
                </span>
              </div>
              <button
                type="button"
                data-testid="close-skill-preview-btn"
                onClick={() => setPreviewCandidate(null)}
                className="text-xs font-semibold px-2 py-1 rounded-md border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-300 transition-colors flex items-center gap-1"
                title="Collapse Preview Drawer"
              >
                Hide »
              </button>
            </div>

            {/* Body */}
            <div className="p-5 overflow-y-auto space-y-4 flex-1">
              <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950 overflow-hidden">
                <div className="px-3.5 py-2 bg-slate-100 dark:bg-zinc-900 border-b border-slate-200 dark:border-zinc-800 text-xs font-mono font-semibold text-slate-700 dark:text-zinc-300">
                  {`skills/pending/${previewCandidate.id || "candidate"}.md`}
                </div>
                <pre className="p-4 font-mono text-xs text-slate-800 dark:text-zinc-200 whitespace-pre-wrap leading-relaxed overflow-x-auto">
{`---
id: ${previewCandidate.id}
status: ${previewCandidate.status || "pending"}
confidence: ${(previewCandidate as any).confidence ?? 0.94}
pattern: ${previewCandidate.pattern}
occurrences: ${previewCandidate.occurrences}
---

## Directive
1. Write module & test files via \`workspace_write_file\`.
2. ${previewCandidate.solutionSummary}`}
                </pre>
              </div>
            </div>

            {/* Direct Actions Footer */}
            <div className="px-5 py-3.5 border-t border-slate-100 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-900/50 flex items-center justify-end gap-2.5 shrink-0">
              <button
                type="button"
                data-testid="preview-reject-skill-btn"
                onClick={() => {
                  handleReject(previewCandidate.id);
                  setPreviewCandidate(null);
                }}
                className="px-3 py-1.5 rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs font-semibold hover:bg-rose-100 dark:hover:bg-rose-900/60 transition-colors flex items-center gap-1.5"
              >
                <XCircle className="h-4 w-4" />
                Reject
              </button>
              <button
                type="button"
                data-testid="preview-approve-skill-btn"
                onClick={() => {
                  handleApprove(previewCandidate.id);
                  setPreviewCandidate(null);
                }}
                className="px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-xs transition-colors flex items-center gap-1.5"
              >
                <CheckCircle2 className="h-4 w-4" />
                Approve & Promote
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
