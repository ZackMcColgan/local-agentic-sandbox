"use client";

import React, { useState, useEffect } from "react";
import { FolderGit2, Folder, Plus, Menu, CheckCircle2, X } from "lucide-react";
import { ProjectRecord } from "@/lib/projects/projectStore";
import { ProjectTreeNode } from "@/lib/projects/projectGit";
import { ProjectTree } from "./projects/ProjectTree";
import { FileReviewPanel, ProjectDiffItem } from "./projects/FileReviewPanel";
import { ProjectTaskList } from "./projects/ProjectTaskList";

export interface ProjectsViewProps {
  projects: ProjectRecord[];
  selectedProjectId?: string | null;
  onSelectProject?: (id: string) => void;
  onRegisterProject?: (data: {
    name: string;
    rootPath: string;
    baseBranch?: string;
    toolchain?: string;
  }) => Promise<void>;
  onToggleAllowlist?: (id: string, allowlisted: boolean) => Promise<void>;
  onDeleteProject?: (id: string) => Promise<void>;
  onOpenDrawer: () => void;
  // Phase 2 props (optional)
  onRunOvernightTask?: (
    projectId: string,
    prompt: string,
    mode: "now" | "schedule"
  ) => Promise<void>;
  // Phase 3 props (optional)
  diffs?: ProjectDiffItem[];
  onAcceptFile?: (filePath: string) => Promise<void>;
  onRevertFile?: (filePath: string) => Promise<void>;
}

interface BrowserFolderItem {
  name: string;
  path: string;
  relPath: string;
  isGitRepo?: boolean;
  defaultBranch?: string;
  toolchain?: string;
}

async function extractHttpError(res: Response, fallbackMessage: string): Promise<Error> {
  const data = await res.json().catch(() => ({}));
  const msg =
    data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error
      : "";
  return new Error(msg || `${fallbackMessage} (HTTP ${res.status})`);
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
  onRevertFile,
}: ProjectsViewProps) {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    selectedProjectId || (projects.length > 0 ? projects[0].project_id : null)
  );
  const [activeTab, setActiveTab] = useState<"files" | "tasks" | "diffs">("files");
  const [isRegisterModalOpen, setIsRegisterModalOpen] = useState(false);
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskSuccess, setTaskSuccess] = useState<string | null>(null);

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
  const [browserItems, setBrowserItems] = useState<BrowserFolderItem[]>([]);
  const [browserParentPath, setBrowserParentPath] = useState<string | null>(null);
  const [isBrowserLoading, setIsBrowserLoading] = useState<boolean>(false);
  const [selectedFolder, setSelectedFolder] = useState<BrowserFolderItem | null>(null);
  const [greenfieldName, setGreenfieldName] = useState<string>("");
  const [greenfieldToolchain, setGreenfieldToolchain] = useState<string>("node:22");

  const fetchBrowse = async (sub = "") => {
    try {
      setIsBrowserLoading(true);
      const res = await fetch(`/api/projects/browse?subpath=${encodeURIComponent(sub)}`);
      if (!res.ok) {
        throw await extractHttpError(res, "Failed to browse filesystem");
      }
      const data = await res.json();
      setBrowserItems(data.items || []);
      setBrowserParentPath(data.parentPath || null);
      setBrowserSubpath(data.relPath === "." ? "" : data.relPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setFormError(msg);
      console.warn("Failed to browse filesystem:", msg);
    } finally {
      setIsBrowserLoading(false);
    }
  };

  useEffect(() => {
    if (isRegisterModalOpen && entryMode === "browse") {
      fetchBrowse(browserSubpath);
    }
  }, [isRegisterModalOpen, entryMode, browserSubpath]);

  const handleSelectFolder = (folder: BrowserFolderItem) => {
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
        body: JSON.stringify({ action: "init-repo", targetPath: formPath }),
      });
      if (!initRes.ok) {
        const d = await initRes.json().catch(() => ({}));
        throw new Error(d.error || "Failed to initialize git repository");
      }
      if (onRegisterProject) {
        await onRegisterProject({
          name:
            formName.trim() ||
            formPath
              .split(/[\/\\]/)
              .filter(Boolean)
              .pop() ||
            "project",
          rootPath: formPath.trim(),
          baseBranch: formBranch.trim() || "main",
          toolchain: formToolchain.trim() || "node:22",
        });
      } else {
        const regRes = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name:
              formName.trim() ||
              formPath
                .split(/[\/\\]/)
                .filter(Boolean)
                .pop() ||
              "project",
            rootPath: formPath.trim(),
            baseBranch: formBranch.trim() || "main",
            toolchain: formToolchain.trim() || "node:22",
          }),
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
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : String(err));
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
        body: JSON.stringify({ action: "create-greenfield", name: greenfieldName.trim() }),
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
          toolchain: greenfieldToolchain,
        });
      } else {
        const regRes = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: data.name,
            rootPath: data.projectPath,
            baseBranch: data.defaultBranch || "main",
            toolchain: greenfieldToolchain,
          }),
        });
        if (!regRes.ok) {
          const d = await regRes.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${regRes.status}`);
        }
      }
      setIsRegisterModalOpen(false);
      setGreenfieldName("");
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Explorer State
  const [tree, setTree] = useState<ProjectTreeNode[]>([]);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // Diff Review State
  const [diffItems, setDiffItems] = useState<ProjectDiffItem[]>(diffs);
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
    setActiveProjectId((prev) => {
      if (selectedProjectId && selectedProjectId !== prev) {
        return selectedProjectId;
      }
      if (!prev && projects.length > 0) {
        return projects[0].project_id;
      }
      return prev;
    });
  }, [selectedProjectId, projects]);

  const activeProject = projects.find((p) => p.project_id === activeProjectId) || null;
  const activeProjectKey = activeProject?.project_id;
  const activeProjectAllowlisted = activeProject?.allowlisted;

  // Load diffs when tab is switched to diffs
  useEffect(() => {
    if (activeTab !== "diffs" || !activeProjectKey) return;
    if (activeProjectAllowlisted !== 1) {
      setDiffItems([]);
      setDiffError("Project access is currently revoked. Enable allowlist to view diffs.");
      return;
    }

    const fetchDiffs = async () => {
      setIsLoadingDiffs(true);
      setDiffError(null);
      try {
        const res = await fetch(`/api/projects/${activeProjectKey}/diff`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setDiffItems(data.files || []);
        if (data.taskId) setDiffTaskId(data.taskId);
        if (data.baseSha) setDiffBaseSha(data.baseSha);
      } catch (err: unknown) {
        setDiffError(
          (err instanceof Error ? err.message : undefined) || "Failed to load project diffs"
        );
      } finally {
        setIsLoadingDiffs(false);
      }
    };

    fetchDiffs();
  }, [activeTab, activeProjectKey, activeProjectAllowlisted]);

  const handleAcceptFile = async (filePath: string) => {
    if (!activeProject) return;
    setActionInProgress(filePath);
    setDiffError(null);
    try {
      if (onAcceptFile) {
        await onAcceptFile(filePath);
      } else {
        const tId = diffTaskId || activeProject.active_task_id;
        const res = await fetch(`/api/projects/${activeProject.project_id}/diff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "accept", taskId: tId, filePath }),
        });
        if (!res.ok) {
          throw await extractHttpError(res, "Failed to accept file");
        }
      }
      setDiffItems((prev) =>
        prev.map((f) => (f.filePath === filePath ? { ...f, status: "accepted" } : f))
      );
    } catch (err: unknown) {
      setDiffError((err instanceof Error ? err.message : undefined) || "Failed to accept file");
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRevertFile = async (filePath: string) => {
    if (!activeProject) return;
    setActionInProgress(filePath);
    setDiffError(null);
    try {
      if (onRevertFile) {
        await onRevertFile(filePath);
      } else {
        const tId = diffTaskId || activeProject.active_task_id;
        const res = await fetch(`/api/projects/${activeProject.project_id}/diff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "revert", taskId: tId, filePath, baseSha: diffBaseSha }),
        });
        if (!res.ok) {
          throw await extractHttpError(res, "Failed to revert file");
        }
      }
      setDiffItems((prev) =>
        prev.map((f) => (f.filePath === filePath ? { ...f, status: "reverted" } : f))
      );
    } catch (err: unknown) {
      setDiffError((err instanceof Error ? err.message : undefined) || "Failed to revert file");
    } finally {
      setActionInProgress(null);
    }
  };

  const handleFinalizeReview = async () => {
    if (!activeProject) return;
    const tId = diffTaskId || activeProject.active_task_id;
    if (!tId) return;
    setDiffError(null);
    try {
      const res = await fetch(`/api/projects/${activeProject.project_id}/diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finalize", taskId: tId }),
      });
      if (!res.ok) {
        throw await extractHttpError(res, "Failed to finalize review");
      }
      setReviewFinalized(true);
    } catch (err: unknown) {
      setDiffError((err instanceof Error ? err.message : undefined) || "Failed to finalize review");
    }
  };

  // Load tree when active project changes
  useEffect(() => {
    if (!activeProjectKey) {
      setTree([]);
      setSelectedFilePath(null);
      setFileContent(null);
      return;
    }

    if (activeProjectAllowlisted !== 1) {
      setTree([]);
      setTreeError("Project access is currently revoked. Enable allowlist to view files.");
      return;
    }

    const fetchTree = async () => {
      setIsLoadingTree(true);
      setTreeError(null);
      try {
        const res = await fetch(`/api/projects/${activeProjectKey}/files`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setTree(data.tree || []);
      } catch (err: unknown) {
        setTreeError(
          (err instanceof Error ? err.message : undefined) || "Failed to load project tree"
        );
      } finally {
        setIsLoadingTree(false);
      }
    };

    fetchTree();
  }, [activeProjectKey, activeProjectAllowlisted, treeRefreshKey]);

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
    } catch (err: unknown) {
      setFileError((err instanceof Error ? err.message : undefined) || "Failed to read file");
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
          toolchain: formToolchain.trim() || "node:22",
        });
      } else {
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formName.trim(),
            rootPath: formPath.trim(),
            baseBranch: formBranch.trim() || "develop",
            toolchain: formToolchain.trim() || "node:22",
          }),
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
    } catch (err: unknown) {
      setFormError(
        (err instanceof Error ? err.message : undefined) || "Failed to register project"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggle = async (p: ProjectRecord) => {
    setProjectActionError(null);
    const nextVal = p.allowlisted === 1 ? false : true;
    try {
      if (onToggleAllowlist) {
        await onToggleAllowlist(p.project_id, nextVal);
      } else {
        const res = await fetch("/api/projects", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: p.project_id, allowlisted: nextVal }),
        });
        if (!res.ok) {
          throw await extractHttpError(res, "Failed to update project allowlist");
        }
      }
    } catch (err: unknown) {
      setProjectActionError(
        (err instanceof Error ? err.message : undefined) || "Failed to update project allowlist"
      );
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-stone-50 dark:bg-black overflow-y-auto">
      <div className="max-w-6xl mx-auto w-full p-4 sm:p-6 space-y-6">
        {/* Top Header */}
        <div className="bg-white dark:bg-[#0e0e12] rounded-3xl p-4 surface-card border border-stone-200/90 dark:border-white/[0.10] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onOpenDrawer}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-full text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-white/[0.08] transition-colors"
              title="Open menu"
              aria-label="Open navigation menu"
            >
              <Menu className="h-6 w-6" />
            </button>
            <div className="flex items-center gap-2">
              <FolderGit2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-900 dark:text-stone-50">
                Projects &amp; Folders
              </h1>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsRegisterModalOpen(true)}
            className="min-h-[44px] px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-black font-semibold text-xs sm:text-sm flex items-center gap-2 shadow-xs transition-colors"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Register Folder</span>
            <span className="sm:hidden">Register</span>
          </button>
        </div>

        {/* Project Action Error Banner */}
        {projectActionError && (
          <div
            role="alert"
            className="p-3 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300 text-xs flex items-center justify-between gap-2"
          >
            <span>{projectActionError}</span>
            <button
              type="button"
              onClick={() => setProjectActionError(null)}
              className="text-rose-700 dark:text-rose-300 hover:underline font-semibold shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Project Selector Chips / Cards */}
        <ProjectTree
          projects={projects}
          activeProjectId={activeProjectId}
          confirmDeleteProjectId={confirmDeleteProjectId}
          deletingProjectId={deletingProjectId}
          canDelete={Boolean(onDeleteProject)}
          onOpenRegisterModal={() => setIsRegisterModalOpen(true)}
          onSelectProject={(projectId) => {
            setActiveProjectId(projectId);
            setTaskError(null);
            setTaskSuccess(null);
            if (onSelectProject) onSelectProject(projectId);
          }}
          onToggleAllowlist={handleToggle}
          onRequestDelete={(projectId) => setConfirmDeleteProjectId(projectId)}
          onCancelDelete={() => setConfirmDeleteProjectId(null)}
          onConfirmDelete={async (projectId) => {
            if (!onDeleteProject) return;
            setProjectActionError(null);
            setDeletingProjectId(projectId);
            try {
              await onDeleteProject(projectId);
              if (activeProjectId === projectId) {
                setActiveProjectId(null);
              }
            } catch (err: unknown) {
              setProjectActionError(
                (err instanceof Error ? err.message : undefined) || "Failed to delete project"
              );
            } finally {
              setDeletingProjectId(null);
              setConfirmDeleteProjectId(null);
            }
          }}
        />

        {/* Selected Project Main Panel */}
        {activeProject && (
          <div className="bg-white dark:bg-zinc-900 rounded-3xl shadow-sm border border-slate-100 dark:border-zinc-800 overflow-hidden">
            {/* Project Navigation Bar */}
            <div className="p-4 border-b border-slate-100 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3 bg-slate-50/50 dark:bg-zinc-900/50">
              <div className="flex items-center gap-2">
                <span className="text-base font-bold text-slate-900 dark:text-zinc-100">
                  {activeProject.name}
                </span>
                <span className="text-xs font-mono text-slate-600 dark:text-zinc-400">
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
              <FileReviewPanel
                activeTab="files"
                baseBranch={activeProject.base_branch}
                tree={tree}
                isLoadingTree={isLoadingTree}
                treeError={treeError}
                selectedFilePath={selectedFilePath}
                fileContent={fileContent}
                isLoadingFile={isLoadingFile}
                fileError={fileError}
                onRefreshTree={() => setTreeRefreshKey((k) => k + 1)}
                onSelectFile={handleSelectFile}
                diffItems={diffItems}
                isLoadingDiffs={isLoadingDiffs}
                diffError={diffError}
                diffFilter={diffFilter}
                actionInProgress={actionInProgress}
                reviewFinalized={reviewFinalized}
                onChangeDiffFilter={setDiffFilter}
                onAcceptFile={handleAcceptFile}
                onRevertFile={handleRevertFile}
              />
            )}

            {/* TAB 2: Overnight Tasks */}
            {activeTab === "tasks" && (
              <ProjectTaskList
                projectName={activeProject.name}
                baseBranch={activeProject.base_branch}
                activeTaskId={activeProject.active_task_id}
                taskError={taskError}
                taskSuccess={taskSuccess}
                onSubmitTask={async (prompt, mode) => {
                  setTaskError(null);
                  setTaskSuccess(null);
                  try {
                    if (onRunOvernightTask) {
                      await onRunOvernightTask(activeProject.project_id, prompt, mode);
                    } else {
                      const res = await fetch(`/api/projects/${activeProject.project_id}/tasks`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(
                          mode === "schedule"
                            ? { prompt, mode: "schedule", scheduleTime: "02:00" }
                            : { prompt, mode: "now" }
                        ),
                      });
                      if (!res.ok) {
                        throw await extractHttpError(res, "Failed to submit project task");
                      }
                      const data = await res.json().catch(() => ({}));
                      if (mode === "schedule" && data.nextRun) {
                        setTaskSuccess(`Scheduled for ${new Date(data.nextRun).toLocaleString()}`);
                      } else if (data.task?.task_id) {
                        setTaskSuccess(`Started task ${data.task.task_id}`);
                      }
                    }
                  } catch (err: unknown) {
                    const msg =
                      (err instanceof Error ? err.message : undefined) ||
                      "Failed to submit project task";
                    setTaskError(msg);
                    throw err;
                  }
                }}
              />
            )}

            {/* TAB 3: Diff Review */}
            {activeTab === "diffs" && (
              <FileReviewPanel
                activeTab="diffs"
                baseBranch={activeProject.base_branch}
                tree={tree}
                isLoadingTree={isLoadingTree}
                treeError={treeError}
                selectedFilePath={selectedFilePath}
                fileContent={fileContent}
                isLoadingFile={isLoadingFile}
                fileError={fileError}
                onRefreshTree={() => setTreeRefreshKey((k) => k + 1)}
                onSelectFile={handleSelectFile}
                diffItems={diffItems}
                isLoadingDiffs={isLoadingDiffs}
                diffError={diffError}
                diffFilter={diffFilter}
                actionInProgress={actionInProgress}
                reviewFinalized={reviewFinalized}
                onChangeDiffFilter={setDiffFilter}
                onAcceptFile={handleAcceptFile}
                onRevertFile={handleRevertFile}
                finalizeBar={
                  diffItems.length > 0 ? (
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
                  ) : null
                }
              />
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
              className="bg-white dark:bg-zinc-900 rounded-3xl p-5 sm:p-6 shadow-2xl border border-slate-100 dark:border-zinc-800 max-w-xl w-full max-h-[85dvh] flex flex-col space-y-4 animate-in zoom-in-95 duration-150 overflow-hidden"
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
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
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
                  onClick={() => {
                    setEntryMode("browse");
                    setFormError(null);
                  }}
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
                  onClick={() => {
                    setEntryMode("greenfield");
                    setFormError(null);
                  }}
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
                  onClick={() => {
                    setEntryMode("manual");
                    setFormError(null);
                  }}
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
                      <div className="p-8 text-center text-xs text-slate-600 dark:text-zinc-400">
                        Scanning filesystem...
                      </div>
                    ) : browserItems.length === 0 ? (
                      <div className="p-8 text-center text-xs text-slate-600 dark:text-zinc-400">
                        No subdirectories found
                      </div>
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
                              <div
                                className={`h-8 w-8 rounded-xl flex items-center justify-center shrink-0 ${
                                  item.isGitRepo
                                    ? "bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300"
                                    : "bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400"
                                }`}
                              >
                                {item.isGitRepo ? (
                                  <FolderGit2 className="h-4 w-4" />
                                ) : (
                                  <Folder className="h-4 w-4" />
                                )}
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
                                    <span className="text-[10px] text-zinc-600 dark:text-zinc-400 font-semibold">
                                      non-git folder
                                    </span>
                                  )}
                                  <span className="text-[10px] font-mono text-slate-600 dark:text-zinc-400">
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
                              className="px-2 py-1 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100 text-[11px] shrink-0 font-semibold"
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
                          {selectedFolder.isGitRepo
                            ? `Git [HEAD: ${formBranch}]`
                            : "No Git initialized"}
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
                          <option value="python:3.12">python:3.12</option>
                          <option value="golang:1.24">golang:1.24</option>
                          <option value="rust:1.88">rust:1.88</option>
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
                    <p className="text-[11px] text-slate-600 dark:text-zinc-400 mt-1 font-mono">
                      Location: ./workspace/projects/
                      {greenfieldName.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "<slug>"}
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
                      <option value="python:3.12">python:3.12</option>
                      <option value="golang:1.24">golang:1.24</option>
                      <option value="rust:1.88">rust:1.88</option>
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
                        <option value="python:3.12">python:3.12</option>
                        <option value="golang:1.24">golang:1.24</option>
                        <option value="rust:1.88">rust:1.88</option>
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
