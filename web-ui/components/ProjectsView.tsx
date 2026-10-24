"use client";

import React, { useState, useEffect } from "react";
import {
  FolderGit2,
  Folder,
  FileCode,
  FileText,
  Plus,
  ShieldCheck,
  ShieldAlert,
  Menu,
  ChevronRight,
  RefreshCw,
  GitBranch,
  Terminal,
  CheckCircle2,
  AlertTriangle,
  X,
  Play,
  Calendar,
  Layers,
  ChevronDown,
  Eye,
  Check,
  RotateCcw
} from "lucide-react";
import { ProjectRecord } from "@/lib/projects/projectStore";
import { ProjectTreeNode } from "@/lib/projects/projectGit";
import { CodeBlock } from "./ArtifactRenderers";
import { DiffViewer } from "./DiffViewer";

export interface ProjectsViewProps {
  projects: ProjectRecord[];
  selectedProjectId?: string | null;
  onSelectProject?: (id: string) => void;
  onRegisterProject?: (data: { name: string; rootPath: string; baseBranch?: string; toolchain?: string }) => Promise<void>;
  onToggleAllowlist?: (id: string, allowlisted: boolean) => Promise<void>;
  onDeleteProject?: (id: string) => Promise<void>;
  onOpenDrawer: () => void;
  // Phase 2 props (optional)
  onRunOvernightTask?: (projectId: string, prompt: string, mode: "now" | "schedule") => Promise<void>;
  // Phase 3 props (optional)
  diffs?: any[];
  onAcceptFile?: (filePath: string) => Promise<void>;
  onRevertFile?: (filePath: string) => Promise<void>;
}

export function ProjectsView({
  projects = [],
  selectedProjectId,
  onSelectProject,
  onRegisterProject,
  onToggleAllowlist,
  onDeleteProject,
  onOpenDrawer,
  onRunOvernightTask,
  diffs = [],
  onAcceptFile,
  onRevertFile
}: ProjectsViewProps) {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    selectedProjectId || (projects.length > 0 ? projects[0].project_id : null)
  );
  const [activeTab, setActiveTab] = useState<"files" | "tasks" | "diffs">("files");
  const [isRegisterModalOpen, setIsRegisterModalOpen] = useState(false);

  // Registration Form State
  const [formName, setFormName] = useState("");
  const [formPath, setFormPath] = useState("");
  const [formBranch, setFormBranch] = useState("main");
  const [formToolchain, setFormToolchain] = useState("node:22");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Folder Browser & Smart Discovery State
  const [entryMode, setEntryMode] = useState<"browse" | "greenfield" | "manual">("browse");
  const [browserSubpath, setBrowserSubpath] = useState<string>("");
  const [browserItems, setBrowserItems] = useState<any[]>([]);
  const [browserCurrentPath, setBrowserCurrentPath] = useState<string>("");
  const [browserParentPath, setBrowserParentPath] = useState<string | null>(null);
  const [isBrowserLoading, setIsBrowserLoading] = useState<boolean>(false);
  const [selectedFolder, setSelectedFolder] = useState<any | null>(null);
  const [greenfieldName, setGreenfieldName] = useState<string>("");
  const [greenfieldToolchain, setGreenfieldToolchain] = useState<string>("node:22");

  const fetchBrowse = async (sub = "") => {
    try {
      setIsBrowserLoading(true);
      const res = await fetch(`/api/projects/browse?subpath=${encodeURIComponent(sub)}`);
      if (res.ok) {
        const data = await res.json();
        setBrowserItems(data.items || []);
        setBrowserCurrentPath(data.currentPath || "");
        setBrowserParentPath(data.parentPath || null);
        setBrowserSubpath(data.relPath === "." ? "" : data.relPath);
      }
    } catch (err: any) {
      console.warn("Failed to browse filesystem:", err.message);
    } finally {
      setIsBrowserLoading(false);
    }
  };

  useEffect(() => {
    if (isRegisterModalOpen && entryMode === "browse") {
      fetchBrowse(browserSubpath);
    }
  }, [isRegisterModalOpen, entryMode, browserSubpath]);

  const handleSelectFolder = (folder: any) => {
    setSelectedFolder(folder);
    setFormName(folder.name);
    setFormPath(folder.path);
    setFormBranch(folder.defaultBranch || "main");
    setFormToolchain(folder.toolchain || "node:22");
    setFormError(null);
  };

  const handleInitAndRegister = async () => {
    if (!formPath) return;
    setIsSubmitting(true);
    setFormError(null);
    try {
      const initRes = await fetch("/api/projects/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "init-repo", targetPath: formPath })
      });
      if (!initRes.ok) {
        const d = await initRes.json().catch(() => ({}));
        throw new Error(d.error || "Failed to initialize git repository");
      }
      if (onRegisterProject) {
        await onRegisterProject({
          name: formName.trim() || (formPath.split(/[\/\\]/).filter(Boolean).pop() || "project"),
          rootPath: formPath.trim(),
          baseBranch: formBranch.trim() || "main",
          toolchain: formToolchain.trim() || "node:22"
        });
      } else {
        const regRes = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formName.trim() || (formPath.split(/[\/\\]/).filter(Boolean).pop() || "project"),
            rootPath: formPath.trim(),
            baseBranch: formBranch.trim() || "main",
            toolchain: formToolchain.trim() || "node:22"
          })
        });
        if (!regRes.ok) {
          const d = await regRes.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${regRes.status}`);
        }
      }
      setIsRegisterModalOpen(false);
      setSelectedFolder(null);
      setFormName("");
      setFormPath("");
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateGreenfield = async () => {
    if (!greenfieldName.trim()) {
      setFormError("Project Name is required.");
      return;
    }
    setIsSubmitting(true);
    setFormError(null);
    try {
      const gfRes = await fetch("/api/projects/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create-greenfield", name: greenfieldName.trim() })
      });
      if (!gfRes.ok) {
        const d = await gfRes.json().catch(() => ({}));
        throw new Error(d.error || "Failed to create greenfield project");
      }
      const data = await gfRes.json();
      if (onRegisterProject) {
        await onRegisterProject({
          name: data.name,
          rootPath: data.projectPath,
          baseBranch: data.defaultBranch || "main",
          toolchain: greenfieldToolchain
        });
      } else {
        const regRes = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: data.name,
            rootPath: data.projectPath,
            baseBranch: data.defaultBranch || "main",
            toolchain: greenfieldToolchain
          })
        });
        if (!regRes.ok) {
          const d = await regRes.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${regRes.status}`);
        }
      }
      setIsRegisterModalOpen(false);
      setGreenfieldName("");
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Explorer State
  const [tree, setTree] = useState<ProjectTreeNode[]>([]);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // Diff Review State
  const [diffItems, setDiffItems] = useState<any[]>(diffs);
  const [isLoadingDiffs, setIsLoadingDiffs] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffFilter, setDiffFilter] = useState<"all" | "pending" | "accepted" | "reverted">("all");
  const [diffTaskId, setDiffTaskId] = useState<string | null>(null);
  const [diffBaseSha, setDiffBaseSha] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [reviewFinalized, setReviewFinalized] = useState(false);

  // Sync diffs prop if provided
  useEffect(() => {
    if (diffs && diffs.length > 0) {
      setDiffItems(diffs);
    }
  }, [diffs]);

  // Sync active project if prop changes
  useEffect(() => {
    if (selectedProjectId && selectedProjectId !== activeProjectId) {
      setActiveProjectId(selectedProjectId);
    } else if (!activeProjectId && projects.length > 0) {
      setActiveProjectId(projects[0].project_id);
    }
  }, [selectedProjectId, projects]);

  const activeProject = projects.find((p) => p.project_id === activeProjectId) || null;

  // Load diffs when tab is switched to diffs
  useEffect(() => {
    if (activeTab !== "diffs" || !activeProject) return;
    if (activeProject.allowlisted !== 1) {
      setDiffItems([]);
      setDiffError("Project access is currently revoked. Enable allowlist to view diffs.");
      return;
    }

    const fetchDiffs = async () => {
      setIsLoadingDiffs(true);
      setDiffError(null);
      try {
        const res = await fetch(`/api/projects/${activeProject.project_id}/diff`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setDiffItems(data.files || []);
        if (data.taskId) setDiffTaskId(data.taskId);
        if (data.baseSha) setDiffBaseSha(data.baseSha);
      } catch (err: any) {
        setDiffError(err.message || "Failed to load project diffs");
      } finally {
        setIsLoadingDiffs(false);
      }
    };

    fetchDiffs();
  }, [activeTab, activeProject?.project_id, activeProject?.allowlisted]);

  const handleAcceptFile = async (filePath: string) => {
    if (!activeProject) return;
    setActionInProgress(filePath);
    try {
      if (onAcceptFile) {
        await onAcceptFile(filePath);
      } else {
        const tId = diffTaskId || activeProject.active_task_id;
        await fetch(`/api/projects/${activeProject.project_id}/diff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "accept", taskId: tId, filePath })
        });
      }
      setDiffItems((prev) =>
        prev.map((f) => (f.filePath === filePath ? { ...f, status: "accepted" } : f))
      );
    } catch (err: any) {
      setDiffError(err.message || "Failed to accept file");
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRevertFile = async (filePath: string) => {
    if (!activeProject) return;
    setActionInProgress(filePath);
    try {
      if (onRevertFile) {
        await onRevertFile(filePath);
      } else {
        const tId = diffTaskId || activeProject.active_task_id;
        await fetch(`/api/projects/${activeProject.project_id}/diff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "revert", taskId: tId, filePath, baseSha: diffBaseSha })
        });
      }
      setDiffItems((prev) =>
        prev.map((f) => (f.filePath === filePath ? { ...f, status: "reverted" } : f))
      );
    } catch (err: any) {
      setDiffError(err.message || "Failed to revert file");
    } finally {
      setActionInProgress(null);
    }
  };

  const handleFinalizeReview = async () => {
    if (!activeProject) return;
    const tId = diffTaskId || activeProject.active_task_id;
    if (!tId) return;
    try {
      await fetch(`/api/projects/${activeProject.project_id}/diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finalize", taskId: tId })
      });
      setReviewFinalized(true);
    } catch (err: any) {
      setDiffError(err.message || "Failed to finalize review");
    }
  };

  // Load tree when active project changes
  useEffect(() => {
    if (!activeProject) {
      setTree([]);
      setSelectedFilePath(null);
      setFileContent(null);
      return;
    }

    if (activeProject.allowlisted !== 1) {
      setTree([]);
      setTreeError("Project access is currently revoked. Enable allowlist to view files.");
      return;
    }

    const fetchTree = async () => {
      setIsLoadingTree(true);
      setTreeError(null);
      try {
        const res = await fetch(`/api/projects/${activeProject.project_id}/files`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setTree(data.tree || []);
      } catch (err: any) {
        setTreeError(err.message || "Failed to load project tree");
      } finally {
        setIsLoadingTree(false);
      }
    };

    fetchTree();
  }, [activeProject?.project_id, activeProject?.allowlisted]);

  // Load file content when a file is clicked
  const handleSelectFile = async (filePath: string) => {
    if (!activeProject) return;
    setSelectedFilePath(filePath);
    setIsLoadingFile(true);
    setFileError(null);

    try {
      const res = await fetch(
        `/api/projects/${activeProject.project_id}/files?path=${encodeURIComponent(filePath)}`
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setFileContent(data.content || "");
    } catch (err: any) {
      setFileError(err.message || "Failed to read file");
      setFileContent(null);
    } finally {
      setIsLoadingFile(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!formName.trim() || !formPath.trim()) {
      setFormError("Project Name and Root Path are required.");
      return;
    }

    setIsSubmitting(true);
    try {
      if (onRegisterProject) {
        await onRegisterProject({
          name: formName.trim(),
          rootPath: formPath.trim(),
          baseBranch: formBranch.trim() || "develop",
          toolchain: formToolchain.trim() || "node:22"
        });
      } else {
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formName.trim(),
            rootPath: formPath.trim(),
            baseBranch: formBranch.trim() || "develop",
            toolchain: formToolchain.trim() || "node:22"
          })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (data.project) {
          setActiveProjectId(data.project.project_id);
        }
      }
      setIsRegisterModalOpen(false);
      setFormName("");
      setFormPath("");
    } catch (err: any) {
      setFormError(err.message || "Failed to register project");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggle = async (p: ProjectRecord) => {
    const nextVal = p.allowlisted === 1 ? false : true;
    if (onToggleAllowlist) {
      await onToggleAllowlist(p.project_id, nextVal);
    } else {
      await fetch("/api/projects", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.project_id, allowlisted: nextVal })
      });
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-white dark:bg-zinc-950 overflow-y-auto">
      <div className="max-w-6xl mx-auto w-full p-4 sm:p-6 space-y-6">
        
        {/* Top Header matching M3 Principles */}
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
            <div className="flex items-center gap-2">
              <FolderGit2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
                Projects &amp; Folders
              </h1>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsRegisterModalOpen(true)}
            className="min-h-[44px] px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs sm:text-sm flex items-center gap-2 shadow-xs transition-colors"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Register Folder</span>
            <span className="sm:hidden">Register</span>
          </button>
        </div>

        {/* Project Selector Chips / Cards */}
        {projects.length === 0 ? (
          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 text-center border border-slate-100 dark:border-zinc-800 space-y-3">
            <div className="h-12 w-12 rounded-2xl bg-slate-100 dark:bg-zinc-800 flex items-center justify-center mx-auto text-slate-400">
              <Folder className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
              No Projects Registered
            </h3>
            <p className="text-xs text-slate-500 dark:text-zinc-400 max-w-md mx-auto">
              Register a local repository directory to enable overnight autonomous runs, read-only file exploration, and surgical git diff reviews.
            </p>
            <button
              type="button"
              onClick={() => setIsRegisterModalOpen(true)}
              className="min-h-[44px] px-4 py-2 mt-2 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs transition-colors"
            >
              Register First Folder
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {projects.map((proj) => {
              const isSelected = proj.project_id === activeProjectId;
              const isAllowlisted = proj.allowlisted === 1;

              return (
                <div
                  key={proj.project_id}
                  onClick={() => {
                    setActiveProjectId(proj.project_id);
                    if (onSelectProject) onSelectProject(proj.project_id);
                  }}
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
                        handleToggle(proj);
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
                      <GitBranch className="h-3 w-3 text-slate-400" />
                      <span>{proj.base_branch}</span>
                    </span>
                    <span>•</span>
                    <span className="inline-flex items-center gap-1">
                      <Terminal className="h-3 w-3 text-slate-400" />
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
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Selected Project Main Panel */}
        {activeProject && (
          <div className="bg-white dark:bg-zinc-900 rounded-3xl shadow-sm border border-slate-100 dark:border-zinc-800 overflow-hidden">
            {/* Project Navigation Bar */}
            <div className="p-4 border-b border-slate-100 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3 bg-slate-50/50 dark:bg-zinc-900/50">
              <div className="flex items-center gap-2">
                <span className="text-base font-bold text-slate-900 dark:text-zinc-100">
                  {activeProject.name}
                </span>
                <span className="text-xs font-mono text-slate-400 dark:text-zinc-500">
                  ({activeProject.base_branch})
                </span>
              </div>

              {/* View Tabs */}
              <div className="flex items-center bg-white dark:bg-zinc-800 rounded-2xl p-1 border border-slate-200 dark:border-zinc-700">
                <button
                  type="button"
                  onClick={() => setActiveTab("files")}
                  className={`min-h-[36px] px-3.5 py-1 rounded-xl text-xs font-semibold transition-colors ${
                    activeTab === "files"
                      ? "bg-emerald-600 text-white shadow-xs"
                      : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100"
                  }`}
                >
                  Files (Explorer)
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("tasks")}
                  className={`min-h-[36px] px-3.5 py-1 rounded-xl text-xs font-semibold transition-colors ${
                    activeTab === "tasks"
                      ? "bg-emerald-600 text-white shadow-xs"
                      : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100"
                  }`}
                >
                  Overnight Tasks
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("diffs")}
                  className={`min-h-[36px] px-3.5 py-1 rounded-xl text-xs font-semibold transition-colors ${
                    activeTab === "diffs"
                      ? "bg-emerald-600 text-white shadow-xs"
                      : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100"
                  }`}
                >
                  Diff Review
                </button>
              </div>
            </div>

            {/* TAB 1: File Explorer */}
            {activeTab === "files" && (
              <div className="min-h-[420px] flex flex-col md:flex-row">
                {/* File Tree Sidebar */}
                <div className="w-full md:w-72 border-b md:border-b-0 md:border-r border-slate-100 dark:border-zinc-800 p-3 overflow-y-auto max-h-[500px]">
                  <div className="flex items-center justify-between mb-2 px-1">
                    <span className="text-xs font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-wider">
                      Repository Tree
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const evt = new CustomEvent("refreshTree");
                        window.dispatchEvent(evt);
                      }}
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
                          onClick={() => isFile && handleSelectFile(node.path)}
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
                <div className="flex-1 p-4 overflow-y-auto max-h-[600px] flex flex-col bg-slate-50/30 dark:bg-zinc-950/30">
                  {selectedFilePath ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-xs font-mono text-slate-700 dark:text-zinc-300">
                          <FileText className="h-4 w-4 text-emerald-600" />
                          <span>{selectedFilePath}</span>
                        </div>
                      </div>

                      {isLoadingFile && (
                        <div className="p-8 text-center text-xs text-slate-400">Loading file content...</div>
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
                          language={selectedFilePath.endsWith(".ts") || selectedFilePath.endsWith(".tsx") ? "typescript" : "javascript"}
                        />
                      )}
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-400 dark:text-zinc-500">
                      <Eye className="h-8 w-8 mb-2 opacity-50" />
                      <p className="text-xs">Select any file from the repository tree to preview its content.</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 2: Overnight Tasks */}
            {activeTab === "tasks" && (
              <div className="p-4 sm:p-6 space-y-6">
                {/* Active Task Banner if running */}
                {activeProject.active_task_id && (
                  <div className="p-4 rounded-3xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
                        <span className="text-xs font-bold text-emerald-800 dark:text-emerald-300 uppercase tracking-wider">
                          Active Overnight Task Running
                        </span>
                      </div>
                      <span className="text-xs font-mono text-emerald-700 dark:text-emerald-400">
                        {activeProject.active_task_id}
                      </span>
                    </div>
                    <p className="text-xs text-slate-700 dark:text-zinc-300">
                      Task execution in progress on branch <code className="font-mono bg-emerald-100 dark:bg-emerald-900/60 px-1 py-0.5 rounded">feat/task...</code>
                    </p>
                  </div>
                )}

                {/* Task Composer Form */}
                <div className="bg-slate-50/50 dark:bg-zinc-800/40 rounded-3xl p-5 border border-slate-100 dark:border-zinc-800 space-y-4">
                  <div className="flex items-center gap-2">
                    <Play className="h-5 w-5 text-emerald-600" />
                    <h3 className="text-sm font-bold text-slate-900 dark:text-zinc-100">
                      Compose Autonomous Task for {activeProject.name}
                    </h3>
                  </div>

                  <textarea
                    rows={3}
                    placeholder="Describe what you want the autonomous agent to build overnight (e.g. Implement authentication routes, write tests, refactor database models)..."
                    className="w-full px-4 py-3 rounded-2xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-900 dark:text-zinc-100 text-xs sm:text-sm focus:outline-emerald-500 resize-none"
                    id="project-task-prompt-input"
                  />

                  <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
                    <div className="text-[11px] text-slate-400">
                      Target branch: <code className="font-mono">{activeProject.base_branch}</code> · Engine: <code className="font-mono">Swift 1.5</code>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          const el = document.getElementById("project-task-prompt-input") as HTMLTextAreaElement | null;
                          const prompt = el?.value || "";
                          if (!prompt.trim()) return;
                          if (onRunOvernightTask) {
                            await onRunOvernightTask(activeProject.project_id, prompt, "schedule");
                          } else {
                            await fetch(`/api/projects/${activeProject.project_id}/tasks`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ prompt, mode: "schedule", scheduleTime: "02:00" })
                            });
                          }
                          if (el) el.value = "";
                        }}
                        className="min-h-[44px] px-3.5 py-2 rounded-2xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 font-semibold text-xs flex items-center gap-1.5 transition-colors"
                      >
                        <Calendar className="h-3.5 w-3.5 text-slate-500" />
                        <span>Schedule 2:00 AM</span>
                      </button>

                      <button
                        type="button"
                        onClick={async () => {
                          const el = document.getElementById("project-task-prompt-input") as HTMLTextAreaElement | null;
                          const prompt = el?.value || "";
                          if (!prompt.trim()) return;
                          if (onRunOvernightTask) {
                            await onRunOvernightTask(activeProject.project_id, prompt, "now");
                          } else {
                            await fetch(`/api/projects/${activeProject.project_id}/tasks`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ prompt, mode: "now" })
                            });
                          }
                          if (el) el.value = "";
                        }}
                        className="min-h-[44px] px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs flex items-center gap-1.5 shadow-xs transition-colors"
                      >
                        <Play className="h-3.5 w-3.5" />
                        <span>Run Overnight Now</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: Diff Review */}
            {activeTab === "diffs" && (
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
                          onClick={() => setDiffFilter(filter)}
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
                    <p className="text-xs text-slate-400 dark:text-zinc-500">
                      Run an overnight autonomous task or checkout a task branch to review diffs.
                    </p>
                  </div>
                )}

                {/* Diff Items List */}
                <div className="space-y-4">
                  {diffItems
                    .filter((item) => diffFilter === "all" || item.status === diffFilter)
                    .map((item) => {
                      const isPending = item.status === "pending";
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
                          : "bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800";

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
                          <div className="p-3 sm:p-4 bg-slate-50/60 dark:bg-zinc-950/60 border-b border-slate-100 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3">
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
                                onClick={() => handleAcceptFile(item.filePath)}
                                className="min-h-[36px] px-3 py-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-semibold text-xs flex items-center gap-1 transition-colors shadow-2xs"
                              >
                                <Check className="h-3 w-3" />
                                <span>Accept</span>
                              </button>

                              <button
                                type="button"
                                disabled={inProgress || isReverted}
                                onClick={() => handleRevertFile(item.filePath)}
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
                              branch={activeProject.base_branch}
                              diff={item.diff}
                              modifiedFiles={[item.filePath]}
                            />
                          </div>
                        </div>
                      );
                    })}
                </div>

                {/* Finalize Bar */}
                {diffItems.length > 0 && (
                  <div className="pt-4 flex items-center justify-between border-t border-slate-100 dark:border-zinc-800">
                    <div className="text-xs text-slate-500 dark:text-zinc-400">
                      {diffItems.filter((i) => i.status === "accepted").length} accepted,{" "}
                      {diffItems.filter((i) => i.status === "reverted").length} reverted,{" "}
                      {diffItems.filter((i) => i.status === "pending").length} pending
                    </div>

                    <button
                      type="button"
                      disabled={reviewFinalized}
                      onClick={handleFinalizeReview}
                      className="min-h-[44px] px-4 py-2 rounded-2xl bg-slate-900 dark:bg-zinc-100 hover:bg-slate-800 dark:hover:bg-white text-white dark:text-zinc-900 font-semibold text-xs flex items-center gap-1.5 transition-colors disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      <span>{reviewFinalized ? "Review Finalized" : "Finalize Review"}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Modal: Interactive Project Discovery & Registration */}
        {isRegisterModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Add Project"
              data-testid="add-project-modal"
              className="bg-white dark:bg-zinc-900 rounded-3xl p-5 sm:p-6 shadow-2xl border border-slate-100 dark:border-zinc-800 max-w-xl w-full max-h-[92vh] flex flex-col space-y-4 animate-in zoom-in-95 duration-150 overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2.5">
                  <div className="h-9 w-9 rounded-2xl bg-emerald-50 dark:bg-emerald-950/60 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                    <FolderGit2 className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-slate-900 dark:text-zinc-100">
                      Add Project
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-zinc-400">
                      Pick a repository, init in-place, or create greenfield
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsRegisterModalOpen(false)}
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                  title="Close modal"
                  aria-label="Close modal"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Mode Tabs */}
              <div className="flex items-center gap-1.5 p-1 bg-slate-100 dark:bg-zinc-800 rounded-2xl shrink-0">
                <button
                  type="button"
                  onClick={() => { setEntryMode("browse"); setFormError(null); }}
                  className={`flex-1 py-1.5 px-3 rounded-xl text-xs font-semibold transition-colors ${
                    entryMode === "browse"
                      ? "bg-white dark:bg-zinc-900 text-emerald-700 dark:text-emerald-400 shadow-xs"
                      : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                  }`}
                >
                  Browse Repos
                </button>
                <button
                  type="button"
                  onClick={() => { setEntryMode("greenfield"); setFormError(null); }}
                  className={`flex-1 py-1.5 px-3 rounded-xl text-xs font-semibold transition-colors ${
                    entryMode === "greenfield"
                      ? "bg-white dark:bg-zinc-900 text-emerald-700 dark:text-emerald-400 shadow-xs"
                      : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                  }`}
                >
                  New Greenfield
                </button>
                <button
                  type="button"
                  onClick={() => { setEntryMode("manual"); setFormError(null); }}
                  className={`flex-1 py-1.5 px-3 rounded-xl text-xs font-semibold transition-colors ${
                    entryMode === "manual"
                      ? "bg-white dark:bg-zinc-900 text-emerald-700 dark:text-emerald-400 shadow-xs"
                      : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                  }`}
                >
                  Manual Path
                </button>
              </div>

              {formError && (
                <div className="p-3 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300 text-xs shrink-0">
                  {formError}
                </div>
              )}

              {/* Body: Mode 1: Browse Repos / Folder Picker */}
              {entryMode === "browse" && (
                <div className="flex-1 min-h-0 flex flex-col space-y-3 overflow-hidden">
                  {/* Path Bar & Up Button */}
                  <div className="flex items-center gap-2 p-2 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-700 shrink-0 text-xs font-mono">
                    <span className="text-slate-500 dark:text-zinc-400 shrink-0">Path:</span>
                    <span className="truncate flex-1 font-semibold text-slate-800 dark:text-zinc-200">
                      {browserSubpath ? `./workspace/${browserSubpath}` : "./workspace"}
                    </span>
                    {browserParentPath && (
                      <button
                        type="button"
                        onClick={() => {
                          const parts = browserSubpath.split("/").filter(Boolean);
                          parts.pop();
                          setBrowserSubpath(parts.join("/"));
                        }}
                        className="px-2.5 py-1 rounded-xl bg-white dark:bg-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 font-semibold text-[11px] border border-slate-200 dark:border-zinc-600"
                      >
                        ↑ Up
                      </button>
                    )}
                  </div>

                  {/* Directory Listing */}
                  <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1">
                    {isBrowserLoading ? (
                      <div className="p-8 text-center text-xs text-slate-400">Scanning filesystem...</div>
                    ) : browserItems.length === 0 ? (
                      <div className="p-8 text-center text-xs text-slate-400">No subdirectories found</div>
                    ) : (
                      browserItems.map((item) => {
                        const isSelected = selectedFolder?.path === item.path;
                        return (
                          <div
                            key={item.path}
                            onClick={() => handleSelectFolder(item)}
                            className={`p-3 rounded-2xl border transition-all cursor-pointer flex items-center justify-between gap-2.5 ${
                              isSelected
                                ? "border-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/40 shadow-xs"
                                : "border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700 bg-white dark:bg-zinc-800/40"
                            }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className={`h-8 w-8 rounded-xl flex items-center justify-center shrink-0 ${
                                item.isGitRepo
                                  ? "bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300"
                                  : "bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400"
                              }`}>
                                {item.isGitRepo ? <FolderGit2 className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
                              </div>
                              <div className="min-w-0">
                                <span className="font-bold text-xs text-slate-900 dark:text-zinc-100 block truncate">
                                  {item.name}
                                </span>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  {item.isGitRepo ? (
                                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-200">
                                      branch: {item.defaultBranch}
                                    </span>
                                  ) : (
                                    <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">
                                      non-git folder
                                    </span>
                                  )}
                                  <span className="text-[10px] font-mono text-slate-400">
                                    {item.toolchain}
                                  </span>
                                </div>
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setBrowserSubpath(item.relPath);
                              }}
                              className="px-2 py-1 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-700 text-slate-400 hover:text-slate-700 text-[11px] shrink-0 font-semibold"
                              title="Explore into directory"
                            >
                              Open →
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Selected Folder Action Card */}
                  {selectedFolder && (
                    <div className="p-3.5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 shrink-0 space-y-2.5 animate-in fade-in">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-emerald-950 dark:text-emerald-200">
                          Selected: {selectedFolder.name}
                        </span>
                        <span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
                          {selectedFolder.isGitRepo ? `Git [HEAD: ${formBranch}]` : "No Git initialized"}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <input
                          type="text"
                          value={formName}
                          onChange={(e) => setFormName(e.target.value)}
                          placeholder="Project name"
                          className="px-2.5 py-1.5 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-white dark:bg-zinc-900 text-slate-900 dark:text-zinc-100 text-xs"
                        />
                        <select
                          value={formToolchain}
                          onChange={(e) => setFormToolchain(e.target.value)}
                          className="px-2.5 py-1.5 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-white dark:bg-zinc-900 text-slate-900 dark:text-zinc-100 text-xs"
                        >
                          <option value="node:22">node:22</option>
                          <option value="python:3.11">python:3.11</option>
                          <option value="golang:1.22">golang:1.22</option>
                          <option value="rust:1.77">rust:1.77</option>
                        </select>
                      </div>

                      <div className="flex items-center justify-end gap-2 pt-1">
                        {selectedFolder.isGitRepo ? (
                          <button
                            type="button"
                            onClick={handleRegisterSubmit}
                            disabled={isSubmitting}
                            className="min-h-[44px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs shadow-xs transition-colors"
                          >
                            {isSubmitting ? "Registering..." : "Register Repository"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={handleInitAndRegister}
                            disabled={isSubmitting}
                            className="min-h-[44px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs shadow-xs transition-colors"
                          >
                            {isSubmitting ? "Initializing..." : "Git Init & Register"}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Body: Mode 2: Greenfield Project */}
              {entryMode === "greenfield" && (
                <div className="space-y-4 py-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-zinc-300 mb-1">
                      New Project Name
                    </label>
                    <input
                      type="text"
                      value={greenfieldName}
                      onChange={(e) => setGreenfieldName(e.target.value)}
                      placeholder="e.g. auth-service"
                      className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 text-sm focus:outline-emerald-500"
                    />
                    <p className="text-[11px] text-slate-400 mt-1 font-mono">
                      Location: ./workspace/projects/{greenfieldName.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "<slug>"}
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-zinc-300 mb-1">
                      Toolchain
                    </label>
                    <select
                      value={greenfieldToolchain}
                      onChange={(e) => setGreenfieldToolchain(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-2xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 text-xs font-mono focus:outline-emerald-500"
                    >
                      <option value="node:22">node:22</option>
                      <option value="python:3.11">python:3.11</option>
                      <option value="golang:1.22">golang:1.22</option>
                      <option value="rust:1.77">rust:1.77</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setIsRegisterModalOpen(false)}
                      className="min-h-[44px] px-4 py-2 rounded-2xl border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-300 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleCreateGreenfield}
                      disabled={isSubmitting || !greenfieldName.trim()}
                      className="min-h-[44px] px-5 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold shadow-xs"
                    >
                      {isSubmitting ? "Creating..." : "Create & Register"}
                    </button>
                  </div>
                </div>
              )}

              {/* Body: Mode 3: Manual Path Entry */}
              {entryMode === "manual" && (
                <form onSubmit={handleRegisterSubmit} className="space-y-4 py-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-zinc-300 mb-1">
                      Project Display Name
                    </label>
                    <input
                      type="text"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="e.g. Core Backend Service"
                      required
                      className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 text-sm focus:outline-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-zinc-300 mb-1">
                      Filesystem Root Path
                    </label>
                    <input
                      type="text"
                      value={formPath}
                      onChange={(e) => setFormPath(e.target.value)}
                      placeholder="./workspace/projects/my-service"
                      required
                      className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 text-sm font-mono focus:outline-emerald-500"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 dark:text-zinc-300 mb-1">
                        Base Branch
                      </label>
                      <input
                        type="text"
                        value={formBranch}
                        onChange={(e) => setFormBranch(e.target.value)}
                        placeholder="main"
                        className="w-full px-3.5 py-2 rounded-2xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 dark:text-zinc-300 mb-1">
                        Toolchain
                      </label>
                      <select
                        value={formToolchain}
                        onChange={(e) => setFormToolchain(e.target.value)}
                        className="w-full px-3.5 py-2 rounded-2xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 text-xs font-mono"
                      >
                        <option value="node:22">node:22</option>
                        <option value="python:3.11">python:3.11</option>
                        <option value="golang:1.22">golang:1.22</option>
                        <option value="rust:1.77">rust:1.77</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setIsRegisterModalOpen(false)}
                      className="min-h-[44px] px-4 py-2 rounded-2xl border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-300 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="min-h-[44px] px-5 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold shadow-xs"
                    >
                      {isSubmitting ? "Registering..." : "Register"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
