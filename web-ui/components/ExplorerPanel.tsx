"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Search,
  X,
  AlertTriangle,
} from "lucide-react";

export interface ExplorerNode {
  name: string;
  path: string;
  type: "directory" | "file";
  children?: ExplorerNode[];
}

export interface ExplorerPanelProps {
  open: boolean;
  onClose: () => void;
}

function filterTree(node: ExplorerNode, query: string): ExplorerNode | null {
  const q = query.trim().toLowerCase();
  if (!q) return node;

  if (node.type === "file") {
    return node.name.toLowerCase().includes(q) ? node : null;
  }

  const filteredChildren = (node.children ?? [])
    .map((child) => filterTree(child, q))
    .filter((c): c is ExplorerNode => c !== null);

  if (filteredChildren.length > 0 || node.name.toLowerCase().includes(q)) {
    return {
      ...node,
      children: filteredChildren,
    };
  }

  return null;
}

export function ExplorerPanel({ open, onClose }: ExplorerPanelProps) {
  const [tree, setTree] = useState<ExplorerNode | null>(null);
  const [rootName, setRootName] = useState<string>("Repository");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState<boolean>(false);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState<string>("");

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewTruncated, setPreviewTruncated] = useState<boolean>(false);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const loadTree = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRevoked(false);
    try {
      const res = await fetch("/api/explorer/tree");
      const data = await res.json();
      if (res.status === 403) {
        setRevoked(true);
        setError(data?.error || "Project access is currently revoked.");
        setTree(null);
        return;
      }
      if (!res.ok) {
        setError(data?.error || "Failed to load repository tree.");
        setTree(null);
        return;
      }
      setRootName(data.rootName || "Repository");
      setTree(data.tree || null);
    } catch {
      setError("Failed to load repository tree.");
      setTree(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadTree();
    }
  }, [open, loadTree]);

  const toggleDir = useCallback((dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }, []);

  const handleSelectFile = useCallback(async (filePath: string) => {
    setSelectedPath(filePath);
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewContent(null);
    setPreviewTruncated(false);
    try {
      const res = await fetch(`/api/explorer/read?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (res.status === 403) {
        setRevoked(true);
        setPreviewError(data?.error || "Project access is currently revoked.");
        return;
      }
      if (!res.ok) {
        setPreviewError(data?.error || "Failed to read file.");
        return;
      }
      setPreviewContent(data.content ?? "");
      setPreviewTruncated(Boolean(data.truncated));
    } catch {
      setPreviewError("Failed to read file.");
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const displayedTree = useMemo(() => {
    if (!tree) return null;
    if (!searchQuery.trim()) return tree;
    return filterTree(tree, searchQuery);
  }, [tree, searchQuery]);

  if (!open) return null;

  const isSearching = searchQuery.trim().length > 0;

  const renderNode = (node: ExplorerNode, depth: number) => {
    if (node.type === "directory") {
      const isExpanded = isSearching || expanded.has(node.path);
      const indentPx = Math.min(depth * 12, 72);
      return (
        <div key={node.path || node.name} className="min-w-0">
          <button
            type="button"
            onClick={() => toggleDir(node.path)}
            aria-expanded={isExpanded}
            data-testid={`explorer-dir-${node.path}`}
            style={{ paddingLeft: `${12 + indentPx}px` }}
            className="w-full min-h-[44px] pr-3 flex items-center gap-2 text-left text-sm text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-900/80 transition-colors min-w-0"
          >
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 shrink-0 text-zinc-600 dark:text-zinc-400" />
            ) : (
              <ChevronRight className="w-4 h-4 shrink-0 text-zinc-600 dark:text-zinc-400" />
            )}
            {isExpanded ? (
              <FolderOpen className="w-4 h-4 shrink-0 text-zinc-600 dark:text-zinc-400" />
            ) : (
              <Folder className="w-4 h-4 shrink-0 text-zinc-600 dark:text-zinc-400" />
            )}
            <span className="truncate min-w-0">{node.name}</span>
          </button>
          {isExpanded && node.children && node.children.length > 0 && (
            <div className="min-w-0">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    const isSelected = selectedPath === node.path;
    const indentPx = Math.min(depth * 12, 72);
    return (
      <button
        key={node.path}
        type="button"
        onClick={() => void handleSelectFile(node.path)}
        data-testid={`explorer-file-${node.path}`}
        aria-current={isSelected ? "true" : undefined}
        style={{ paddingLeft: `${12 + indentPx + 20}px` }}
        className={`w-full min-h-[44px] pr-3 flex items-center gap-2 text-left text-sm transition-colors min-w-0 ${
          isSelected
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900/80"
        }`}
      >
        <FileText
          className={`w-4 h-4 shrink-0 ${
            isSelected ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-600 dark:text-zinc-400"
          }`}
        />
        <span className="truncate min-w-0">{node.name}</span>
      </button>
    );
  };

  const hasChildren = Boolean(displayedTree?.children && displayedTree.children.length > 0);

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className="fixed inset-0 z-30 bg-black/50 dark:bg-black/70 md:hidden"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        data-testid="explorer-panel"
        aria-label="Repository Explorer"
        className="fixed inset-y-0 right-0 z-40 w-[min(92vw,360px)] md:static md:z-auto md:w-80 lg:w-96 shrink-0 bg-white dark:bg-black border-l border-zinc-200 dark:border-zinc-800 flex flex-col min-w-0 overflow-x-hidden"
      >
        {/* Header */}
        <div className="h-12 px-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Folder className="w-4 h-4 shrink-0 text-zinc-600 dark:text-zinc-400" />
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {rootName}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close explorer"
            data-testid="explorer-close-btn"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search/Filter */}
        <div className="p-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <div className="relative flex items-center">
            <Search className="w-4 h-4 text-zinc-600 dark:text-zinc-400 absolute left-3 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter files..."
              aria-label="Filter files"
              data-testid="explorer-search-input"
              className="w-full min-h-[44px] pl-9 pr-10 bg-zinc-50 dark:bg-black border border-zinc-300 dark:border-zinc-800 rounded-md text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-500 dark:placeholder:text-zinc-400 focus:outline-none focus:border-emerald-500"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear filter"
                data-testid="explorer-search-clear"
                className="absolute right-0 min-h-[44px] min-w-[44px] flex items-center justify-center text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Tree Area */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">
          {loading && (
            <div className="p-4 text-sm text-zinc-600 dark:text-zinc-400">
              Loading repository...
            </div>
          )}

          {!loading && revoked && (
            <div
              data-testid="explorer-revoked-state"
              className="p-4 flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 text-zinc-600 dark:text-zinc-400 mt-0.5" />
              <span>{error || "Project access is currently revoked."}</span>
            </div>
          )}

          {!loading && !revoked && error && (
            <div className="p-4 text-sm text-zinc-600 dark:text-zinc-400">{error}</div>
          )}

          {!loading && !revoked && !error && !hasChildren && (
            <div
              data-testid="explorer-empty-state"
              className="p-4 text-sm text-zinc-600 dark:text-zinc-400"
            >
              {isSearching ? "No matching files." : "This directory is empty."}
            </div>
          )}

          {!loading && !revoked && !error && hasChildren && displayedTree?.children && (
            <div className="py-1 min-w-0">
              {displayedTree.children.map((child) => renderNode(child, 0))}
            </div>
          )}
        </div>

        {/* In-place Read-Only Preview */}
        {selectedPath && (
          <div
            data-testid="explorer-preview"
            className="border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black flex flex-col max-h-[45%] min-h-[160px] min-w-0"
          >
            <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-2 shrink-0">
              <span className="text-xs font-mono text-zinc-800 dark:text-zinc-300 truncate min-w-0">
                {selectedPath}
              </span>
              <button
                type="button"
                onClick={() => {
                  setSelectedPath(null);
                  setPreviewContent(null);
                  setPreviewError(null);
                }}
                aria-label="Close preview"
                className="min-h-[44px] min-w-[44px] -my-2 -mr-2 flex items-center justify-center text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3 min-w-0">
              {previewLoading && (
                <div className="text-xs text-zinc-600 dark:text-zinc-400">Loading file...</div>
              )}
              {!previewLoading && previewError && (
                <div className="text-xs text-zinc-600 dark:text-zinc-400">{previewError}</div>
              )}
              {!previewLoading && !previewError && previewContent !== null && (
                <>
                  <pre className="text-xs font-mono text-zinc-800 dark:text-zinc-300 whitespace-pre-wrap break-words">
                    {previewContent}
                  </pre>
                  {previewTruncated && (
                    <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                      Preview truncated (file exceeds 256 KB).
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
