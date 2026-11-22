"use client";

import React from "react";
import {
  Folder,
  FileCode,
  FileText,
  RefreshCw,
  CheckCircle2,
  Layers,
  Eye,
  Check,
  RotateCcw,
} from "lucide-react";
import { ProjectTreeNode } from "@/lib/projects/projectGit";
import { CodeBlock } from "../ArtifactRenderers";
import { DiffViewer } from "../DiffViewer";

export interface ProjectDiffItem {
  filePath: string;
  status: string;
  changeType?: string;
  diff?: string;
  additions?: number;
  deletions?: number;
  [key: string]: unknown;
}

export interface FileReviewPanelProps {
  activeTab: "files" | "diffs";
  baseBranch: string;
  tree: ProjectTreeNode[];
  isLoadingTree: boolean;
  treeError: string | null;
  selectedFilePath: string | null;
  fileContent: string | null;
  isLoadingFile: boolean;
  fileError: string | null;
  onRefreshTree: () => void;
  onSelectFile: (filePath: string) => void;
  diffItems: ProjectDiffItem[];
  isLoadingDiffs: boolean;
  diffError: string | null;
  diffFilter: "all" | "pending" | "accepted" | "reverted";
  actionInProgress: string | null;
  reviewFinalized: boolean;
  onChangeDiffFilter: (filter: "all" | "pending" | "accepted" | "reverted") => void;
  onAcceptFile: (filePath: string) => void;
  onRevertFile: (filePath: string) => void;
  finalizeBar?: React.ReactNode;
}

export function FileReviewPanel({
  activeTab,
  baseBranch,
  tree,
  isLoadingTree,
  treeError,
  selectedFilePath,
  fileContent,
  isLoadingFile,
  fileError,
  onRefreshTree,
  onSelectFile,
  diffItems,
  isLoadingDiffs,
  diffError,
  diffFilter,
  actionInProgress,
  reviewFinalized,
  onChangeDiffFilter,
  onAcceptFile,
  onRevertFile,
  finalizeBar,
}: FileReviewPanelProps) {
  if (activeTab === "files") {
    return (
      <div className="min-h-[420px] flex flex-col md:flex-row">
        {/* File Tree Sidebar */}
        <div className="w-full md:w-72 border-b md:border-b-0 md:border-r border-slate-100 dark:border-zinc-800 p-3 overflow-y-auto max-h-[500px]">
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="text-xs font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-wider">
              Repository Tree
            </span>
            <button
              type="button"
              data-testid="project-tree-refresh-btn"
              onClick={onRefreshTree}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 p-1 rounded-lg"
              title="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>

          {isLoadingTree && (
            <div className="p-4 text-center text-xs text-slate-400">Loading tree...</div>
          )}

          {treeError && (
            <div className="p-3 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300 text-xs">
              {treeError}
            </div>
          )}

          {!isLoadingTree && !treeError && tree.length === 0 && (
            <div className="p-4 text-center text-xs text-slate-400">No files found.</div>
          )}

          <div className="space-y-1">
            {tree.map((node) => {
              const isFile = node.type === "file";
              const isSelected = selectedFilePath === node.path;

              return (
                <div
                  key={node.path}
                  onClick={() => isFile && onSelectFile(node.path)}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-xl text-xs transition-colors ${
                    isFile ? "cursor-pointer" : "cursor-default text-slate-400 font-semibold"
                  } ${
                    isSelected
                      ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-900 dark:text-emerald-200 font-semibold"
                      : isFile
                        ? "hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300"
                        : "text-slate-500 dark:text-zinc-400"
                  }`}
                >
                  {isFile ? (
                    <FileCode className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  )}
                  <span className="truncate">{node.path}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* File Preview Pane */}
        <div className="flex-1 p-4 overflow-y-auto max-h-[600px] flex flex-col bg-slate-50/30 dark:bg-black/30">
          {selectedFilePath ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-mono text-slate-700 dark:text-zinc-300">
                  <FileText className="h-4 w-4 text-emerald-600" />
                  <span>{selectedFilePath}</span>
                </div>
              </div>

              {isLoadingFile && (
                <div className="p-8 text-center text-xs text-slate-400">
                  Loading file content...
                </div>
              )}

              {fileError && (
                <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300 text-xs">
                  {fileError}
                </div>
              )}

              {!isLoadingFile && !fileError && fileContent !== null && (
                <CodeBlock
                  code={fileContent}
                  filename={selectedFilePath.split("/").pop()}
                  language={
                    selectedFilePath.endsWith(".ts") || selectedFilePath.endsWith(".tsx")
                      ? "typescript"
                      : "javascript"
                  }
                />
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-400 dark:text-zinc-400">
              <Eye className="h-8 w-8 mb-2 opacity-50" />
              <p className="text-xs">
                Select any file from the repository tree to preview its content.
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4">
      {/* Diff Review Header & Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-zinc-800">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-zinc-100">
              Per-File Git Diff Engine &amp; Review
            </h3>
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400">
            Surgically inspect and accept or revert changes byte-for-byte from baseSha.
          </p>
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {(["all", "pending", "accepted", "reverted"] as const).map((filter) => {
            const count =
              filter === "all"
                ? diffItems.length
                : diffItems.filter((i) => i.status === filter).length;
            const isSelected = diffFilter === filter;

            return (
              <button
                key={filter}
                type="button"
                onClick={() => onChangeDiffFilter(filter)}
                className={`min-h-[32px] px-3 py-1 rounded-full text-xs font-semibold capitalize flex items-center gap-1.5 transition-colors ${
                  isSelected
                    ? "bg-emerald-600 text-white shadow-xs"
                    : "bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100"
                }`}
              >
                <span>{filter}</span>
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono ${
                    isSelected
                      ? "bg-white/20 text-white"
                      : "bg-slate-200 dark:bg-zinc-700 text-slate-700 dark:text-zinc-300"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {isLoadingDiffs && (
        <div className="p-8 text-center text-xs text-slate-400">Loading diffs...</div>
      )}

      {diffError && (
        <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300 text-xs">
          {diffError}
        </div>
      )}

      {reviewFinalized && (
        <div className="p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span>File review has been finalized. Accepted files are approved for merge.</span>
        </div>
      )}

      {!isLoadingDiffs && !diffError && diffItems.length === 0 && (
        <div className="p-8 text-center space-y-2">
          <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto opacity-70" />
          <p className="text-xs font-semibold text-slate-700 dark:text-zinc-300">
            No modified files found.
          </p>
          <p className="text-xs text-slate-400 dark:text-zinc-400">
            Run an overnight autonomous task or checkout a task branch to review diffs.
          </p>
        </div>
      )}

      {/* Diff Items List */}
      <div className="space-y-4">
        {diffItems
          .filter((item) => diffFilter === "all" || item.status === diffFilter)
          .map((item) => {
            const isAccepted = item.status === "accepted";
            const isReverted = item.status === "reverted";
            const inProgress = actionInProgress === item.filePath;

            const typeColor =
              item.changeType === "A"
                ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800"
                : item.changeType === "D"
                  ? "bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300 border-rose-200 dark:border-rose-800"
                  : item.changeType === "R"
                    ? "bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 border-blue-200 dark:border-blue-800"
                    : "bg-zinc-100 dark:bg-zinc-900 text-zinc-800 dark:text-zinc-300 border-zinc-200 dark:border-zinc-800";

            const typeLabel =
              item.changeType === "A"
                ? "Added"
                : item.changeType === "D"
                  ? "Deleted"
                  : item.changeType === "R"
                    ? "Renamed"
                    : "Modified";

            return (
              <div
                key={item.filePath}
                className="bg-white dark:bg-zinc-900 rounded-2xl border border-slate-200 dark:border-zinc-800 overflow-hidden shadow-xs"
              >
                {/* File Header */}
                <div className="p-3 sm:p-4 bg-slate-50/60 dark:bg-black/60 border-b border-slate-100 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`px-2 py-0.5 rounded-md text-[10px] font-bold font-mono border ${typeColor}`}
                    >
                      {typeLabel} ({item.changeType})
                    </span>
                    <span className="font-mono text-xs font-bold text-slate-800 dark:text-zinc-200 truncate break-all">
                      {item.filePath}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {/* Status Badge */}
                    <span
                      className={`px-2.5 py-1 rounded-full text-[10px] font-bold flex items-center gap-1 ${
                        isAccepted
                          ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                          : isReverted
                            ? "bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800"
                            : "bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700"
                      }`}
                    >
                      {isAccepted && <Check className="h-3 w-3" />}
                      {isReverted && <RotateCcw className="h-3 w-3" />}
                      <span className="capitalize">{item.status}</span>
                    </span>

                    {/* Action Buttons */}
                    <button
                      type="button"
                      disabled={inProgress || isAccepted}
                      onClick={() => onAcceptFile(item.filePath)}
                      className="min-h-[36px] px-3 py-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-semibold text-xs flex items-center gap-1 transition-colors shadow-2xs"
                    >
                      <Check className="h-3 w-3" />
                      <span>Accept</span>
                    </button>

                    <button
                      type="button"
                      disabled={inProgress || isReverted}
                      onClick={() => onRevertFile(item.filePath)}
                      className="min-h-[36px] px-3 py-1 rounded-xl bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/40 disabled:opacity-50 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800 font-semibold text-xs flex items-center gap-1 transition-colors"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>Revert</span>
                    </button>
                  </div>
                </div>

                {/* Diff Body */}
                <div className="p-3">
                  <DiffViewer
                    branch={baseBranch}
                    diff={item.diff}
                    modifiedFiles={[item.filePath]}
                  />
                </div>
              </div>
            );
          })}
      </div>

      {finalizeBar}
    </div>
  );
}
