"use client";

import React from "react";
import { Folder, ShieldCheck, ShieldAlert, GitBranch, Terminal, Trash2 } from "lucide-react";
import { ProjectRecord } from "@/lib/projects/projectStore";

export interface ProjectTreeProps {
  projects: ProjectRecord[];
  activeProjectId: string | null;
  confirmDeleteProjectId: string | null;
  deletingProjectId: string | null;
  canDelete: boolean;
  onOpenRegisterModal: () => void;
  onSelectProject: (projectId: string) => void;
  onToggleAllowlist: (project: ProjectRecord) => void;
  onRequestDelete: (projectId: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (projectId: string) => void;
}

export function ProjectTree({
  projects,
  activeProjectId,
  confirmDeleteProjectId,
  deletingProjectId,
  canDelete,
  onOpenRegisterModal,
  onSelectProject,
  onToggleAllowlist,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: ProjectTreeProps) {
  if (projects.length === 0) {
    return (
      <div className="bg-white dark:bg-[#0e0e12] rounded-3xl p-8 text-center surface-card border border-stone-200/90 dark:border-white/[0.10] space-y-3">
        <div className="h-12 w-12 rounded-2xl bg-stone-100 dark:bg-[#1f1f28] flex items-center justify-center mx-auto text-zinc-600 dark:text-zinc-400">
          <Folder className="h-6 w-6" />
        </div>
        <h3 className="text-base font-semibold text-stone-900 dark:text-stone-100">
          No Projects Registered
        </h3>
        <p className="text-xs text-zinc-600 dark:text-zinc-400 max-w-md mx-auto">
          Register a local repository directory to enable overnight autonomous runs, read-only file
          exploration, and surgical git diff reviews.
        </p>
        <button
          type="button"
          onClick={onOpenRegisterModal}
          className="min-h-[44px] px-4 py-2 mt-2 rounded-2xl bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-black font-semibold text-xs transition-colors"
        >
          Register First Folder
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {projects.map((proj) => {
        const isSelected = proj.project_id === activeProjectId;
        const isAllowlisted = proj.allowlisted === 1;

        return (
          <div
            key={proj.project_id}
            onClick={() => onSelectProject(proj.project_id)}
            className={`cursor-pointer rounded-3xl p-4 transition-all border ${
              isSelected
                ? "bg-emerald-50/60 dark:bg-emerald-950/40 border-emerald-500 shadow-sm ring-1 ring-emerald-500/30"
                : "bg-white dark:bg-zinc-900 border-slate-100 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-bold text-sm text-slate-900 dark:text-zinc-100 truncate flex items-center gap-1.5">
                  <Folder className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span className="truncate">{proj.name}</span>
                </div>
                <div className="text-[11px] font-mono text-slate-500 dark:text-zinc-400 truncate mt-0.5">
                  {proj.root_path}
                </div>
              </div>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleAllowlist(proj);
                }}
                title={isAllowlisted ? "Revoke allowlist" : "Grant allowlist"}
                className={`min-h-[32px] px-2.5 py-1 rounded-full text-[10px] font-bold flex items-center gap-1 shrink-0 transition-colors ${
                  isAllowlisted
                    ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                    : "bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800"
                }`}
              >
                {isAllowlisted ? (
                  <>
                    <ShieldCheck className="h-3 w-3" />
                    <span>Allowlisted</span>
                  </>
                ) : (
                  <>
                    <ShieldAlert className="h-3 w-3" />
                    <span>Revoked</span>
                  </>
                )}
              </button>
            </div>

            <div className="flex items-center gap-2 mt-3 pt-2 border-t border-slate-100 dark:border-zinc-800/80 text-[11px] text-slate-600 dark:text-zinc-400">
              <span className="inline-flex items-center gap-1">
                <GitBranch className="h-3 w-3 text-slate-600 dark:text-zinc-400" />
                <span>{proj.base_branch}</span>
              </span>
              <span>•</span>
              <span className="inline-flex items-center gap-1">
                <Terminal className="h-3 w-3 text-slate-600 dark:text-zinc-400" />
                <span className="font-mono">{proj.toolchain}</span>
              </span>
              {proj.active_task_id && (
                <>
                  <span>•</span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold animate-pulse">
                    Active Run
                  </span>
                </>
              )}
              {canDelete && (
                <button
                  type="button"
                  data-testid={`project-delete-btn-${proj.project_id}`}
                  aria-label={`Delete project ${proj.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestDelete(proj.project_id);
                  }}
                  className="ml-auto inline-flex items-center gap-1 text-slate-600 dark:text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors p-1 rounded-lg"
                  title="Remove project from registry"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {confirmDeleteProjectId === proj.project_id && canDelete && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="mt-3 p-3 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 space-y-2"
              >
                <p className="text-[11px] text-rose-800 dark:text-rose-200">
                  Remove <strong>{proj.name}</strong> from the registry? Files on disk and linked
                  chat threads will not be deleted.
                </p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={onCancelDelete}
                    className="px-2.5 py-1 rounded-xl text-[11px] font-semibold text-slate-600 dark:text-zinc-300 hover:bg-white/60 dark:hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid={`project-delete-confirm-${proj.project_id}`}
                    disabled={deletingProjectId === proj.project_id}
                    onClick={() => onConfirmDelete(proj.project_id)}
                    className="px-2.5 py-1 rounded-xl text-[11px] font-semibold bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-50"
                  >
                    {deletingProjectId === proj.project_id ? "Removing..." : "Confirm Delete"}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
