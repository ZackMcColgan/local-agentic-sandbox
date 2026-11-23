"use client";

import React from "react";
import { ChatStream, ChatMessage } from "@/components/ChatStream";
import { ExplorerPanel } from "@/components/ExplorerPanel";
import { ThreadsSidebar } from "@/components/ThreadsSidebar";
import { ModelBottomSheet } from "@/components/ModelBottomSheet";
import { ExecutionTrace, ExecutionTraceItem } from "@/components/ExecutionTrace";
import { TraceWaterfall } from "@/components/TraceWaterfall";
import { SandboxGauge } from "@/components/SandboxGauge";
import { MorningReportView } from "@/components/MorningReportView";
import { MorningReport, OvernightMorningReport } from "@/lib/subagents/morningReport";
import { TaskManifest, TaskScope } from "@/lib/subagents/types";
import { Thread, type ActiveTurnInfo } from "@/lib/threads/threadStore";
import { SimulationScenarioKey } from "@/lib/simulator";
import {
  ArrowLeft,
  Hammer,
  Menu,
  MessageSquare,
  Sun,
  Sparkles,
  Settings,
  Columns3,
  FolderGit2,
} from "lucide-react";
import { DiffViewer } from "@/components/DiffViewer";
import { CodeBlock } from "@/components/ArtifactRenderers";
import { NavigationDrawer, NavView } from "@/components/NavigationDrawer";
import { SettingsView } from "@/components/SettingsView";
import { BuildsView } from "@/components/BuildsView";
import { BoardView } from "@/components/BoardView";
import type { BoardItem } from "@/lib/board/boardStore";
import type { BoardControlAction, BoardControlState } from "@/lib/board/boardControlStore";
import { SkillsView } from "@/components/SkillsView";
import { ProjectsView } from "@/components/ProjectsView";
import { ProjectRecord } from "@/lib/projects/projectStore";
import { AgentMode } from "@/config/models";

export interface ViewShellSecurityPosture {
  execution_uid: string;
  root_filesystem: string;
  capabilities: string;
  tmpfs_buffer: string;
  provenance_level: string;
}

export interface ViewShellProps {
  // Navigation & layout state
  activeNavView: NavView;
  viewMode: "unified" | "security";
  isDrawerOpen: boolean;
  isSidebarOpen: boolean;
  isWorkspaceOpen: boolean;
  isExplorerOpen: boolean;
  isModelSheetOpen: boolean;
  workspaceTab: "diff" | "output" | "files";
  selectedWorkspaceFile: { path: string; content: string } | null;

  // Navigation & layout callbacks
  onSetActiveNavView: (view: NavView) => void;
  onSetViewMode: (mode: "unified" | "security") => void;
  onSetDrawerOpen: (open: boolean) => void;
  onSetSidebarOpen: (open: boolean) => void;
  onSetWorkspaceOpen: (open: boolean) => void;
  onSetExplorerOpen: (open: boolean) => void;
  onSetModelSheetOpen: (open: boolean) => void;
  onSetWorkspaceTab: (tab: "diff" | "output" | "files") => void;
  onSetSelectedWorkspaceFile: (file: { path: string; content: string } | null) => void;
  onNavigate: (view: NavView) => void;
  onPreviewWorkspaceFile: (filePath: string) => void;

  // Threads & Chat state
  threads: Thread[];
  isLoadingThreads: boolean;
  selectedThreadId: string | null;
  currentThread: Thread | null;
  activeTurn?: ActiveTurnInfo | null;
  threadUpdatedAt?: string | null;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  draftComposerPrompt: string | null;
  onClearDraftPrompt: () => void;
  traces: ExecutionTraceItem[];
  onTracesUpdate: (newTraces: ExecutionTraceItem[]) => void;
  initialSimulation: {
    scenarioKey: SimulationScenarioKey;
    speedMultiplier?: number;
  } | null;

  // Threads & Chat callbacks
  onSelectThread: (threadId: string) => void;
  onBackToList: () => void;
  onNewThread: () => void | Promise<void>;
  onDeleteThread: (threadId: string) => void | Promise<void>;
  onEnsureThread: (initialTitle: string) => Promise<string | null>;
  onThreadUpdated: (updatedThread: Partial<Thread> & { id: string }) => void;

  // Model & telemetry state
  agentMode: AgentMode;
  selectedModel: string;
  reasoningEffort: "low" | "medium" | "xhigh";
  installedModels: string[];
  securityPosture: ViewShellSecurityPosture | undefined;
  onModelChange: (model: string) => void;
  onReasoningChange: (effort: "low" | "medium" | "xhigh") => void;

  // Tasks & Builds state
  activeTask: TaskManifest | null;
  tasks: TaskManifest[];
  plannedFiles: string[];
  onSetActiveTask: (task: TaskManifest) => void;
  onLaunchTask: (
    goal: string,
    attachments?: unknown[],
    scope?: TaskScope,
    autoDeployOnGreen?: boolean
  ) => Promise<void>;
  onStopRun: () => Promise<void>;
  onDeployRun: (taskId: string) => Promise<void>;

  // Board state
  boardItems: BoardItem[];
  boardControlState: BoardControlState;
  boardStopAtBoundary: boolean;
  isBoardControlPending: boolean;
  onBoardItemCreated: (item: BoardItem) => void;
  onBoardControlAction: (action: BoardControlAction) => void;
  onAskAssistantFromBoard: (draftPrompt: string) => void;

  // Projects state
  projects: ProjectRecord[];
  selectedProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  onRegisterProject: React.ComponentProps<typeof ProjectsView>["onRegisterProject"];
  onToggleAllowlist: React.ComponentProps<typeof ProjectsView>["onToggleAllowlist"];
  onDeleteProject: React.ComponentProps<typeof ProjectsView>["onDeleteProject"];

  // Settings, Skills & Morning Report state
  pendingSkillsCount: number;
  selfDeployEnabled: boolean;
  onToggleSelfDeploy: () => void | Promise<void>;
  deployHistory: NonNullable<React.ComponentProps<typeof SettingsView>["deployHistory"]>;
  morningReport: MorningReport | null;
  overnightReport: OvernightMorningReport | null;
}

export function ViewShell({
  activeNavView,
  viewMode,
  isDrawerOpen,
  isSidebarOpen,
  isWorkspaceOpen,
  isExplorerOpen,
  isModelSheetOpen,
  workspaceTab,
  selectedWorkspaceFile,
  onSetActiveNavView,
  onSetViewMode,
  onSetDrawerOpen,
  onSetSidebarOpen,
  onSetWorkspaceOpen,
  onSetExplorerOpen,
  onSetModelSheetOpen,
  onSetWorkspaceTab,
  onSetSelectedWorkspaceFile,
  onNavigate,
  onPreviewWorkspaceFile,
  threads,
  isLoadingThreads,
  selectedThreadId,
  currentThread,
  activeTurn,
  threadUpdatedAt,
  messages,
  setMessages,
  draftComposerPrompt,
  onClearDraftPrompt,
  traces,
  onTracesUpdate,
  initialSimulation,
  onSelectThread,
  onBackToList,
  onNewThread,
  onDeleteThread,
  onEnsureThread,
  onThreadUpdated,
  agentMode,
  selectedModel,
  reasoningEffort,
  installedModels,
  securityPosture,
  onModelChange,
  onReasoningChange,
  activeTask,
  tasks,
  plannedFiles,
  onSetActiveTask,
  onLaunchTask,
  onStopRun,
  onDeployRun,
  boardItems,
  boardControlState,
  boardStopAtBoundary,
  isBoardControlPending,
  onBoardItemCreated,
  onBoardControlAction,
  onAskAssistantFromBoard,
  projects,
  selectedProjectId,
  onSelectProject,
  onRegisterProject,
  onToggleAllowlist,
  onDeleteProject,
  pendingSkillsCount,
  selfDeployEnabled,
  onToggleSelfDeploy,
  deployHistory,
  morningReport,
  overnightReport,
}: ViewShellProps) {
  return (
    <div
      className={`app-shell h-[100dvh] md:flex md:flex-row bg-white dark:bg-black text-slate-900 dark:text-zinc-100 antialiased overflow-hidden font-sans ${isSidebarOpen ? "mobile-sidebar-open" : "collapsed-sidebar"} ${isWorkspaceOpen ? "mobile-inspector-open" : "collapsed-inspector"}`}
    >
      {/* Material 3 Navigation Drawer */}
      <NavigationDrawer
        isLoadingThreads={isLoadingThreads}
        isOpen={isDrawerOpen}
        onClose={() => onSetDrawerOpen(false)}
        activeView={activeNavView}
        onNavigate={onNavigate}
        onNewSession={onNewThread}
        pendingSkillsCount={pendingSkillsCount}
        threads={threads}
        selectedThreadId={selectedThreadId}
        onSelectThread={onSelectThread}
        onDeleteThread={onDeleteThread}
        onOpenExplorer={() => {
          onSetActiveNavView("sessions");
          onSetViewMode("unified");
          onSetExplorerOpen(true);
        }}
      />

      {/* Modal Bottom Sheet for Model & Thinking Effort */}
      <ModelBottomSheet
        isOpen={isModelSheetOpen}
        onClose={() => onSetModelSheetOpen(false)}
        selectedModel={selectedModel}
        onModelChange={onModelChange}
        reasoningEffort={reasoningEffort}
        onReasoningChange={onReasoningChange}
        installedModels={installedModels}
      />

      {/* 1. PERSISTENT LABELED LEFT NAVIGATION RAIL (82px) */}
      <nav
        className="app-rail hidden md:flex flex-col w-[82px] shrink-0 border-r border-stone-200/80 dark:border-white/[0.08] bg-stone-50 dark:bg-black py-3 justify-between items-center z-20 select-none"
        aria-label="Primary Navigation"
      >
        <div className="flex flex-col items-center gap-2 w-full px-1.5">
          <button
            type="button"
            onClick={() => {
              onSetActiveNavView("sessions");
              onSetViewMode("unified");
            }}
            className={`rail-btn flex flex-col items-center justify-center w-full py-2.5 px-1 rounded-xl text-xs font-semibold gap-1 transition-all ${
              activeNavView === "sessions" && viewMode === "unified"
                ? "bg-emerald-600 dark:bg-emerald-500 text-white dark:text-black border border-transparent shadow-sm"
                : "text-stone-600 dark:text-stone-400 hover:bg-stone-200/70 dark:hover:bg-white/[0.07] hover:text-stone-900 dark:hover:text-stone-100 border border-transparent"
            }`}
            title="Chat & Sessions"
          >
            <MessageSquare className="h-5 w-5 shrink-0" />
            <span className="rail-label text-[11px] font-bold">Chat</span>
          </button>

          <button
            type="button"
            onClick={() => {
              onSetActiveNavView("board");
              onSetViewMode("unified");
            }}
            className={`rail-btn flex flex-col items-center justify-center w-full py-2.5 px-1 rounded-xl text-xs font-semibold gap-1 transition-all ${
              activeNavView === "board"
                ? "bg-emerald-600 dark:bg-emerald-500 text-white dark:text-black border border-transparent shadow-sm"
                : "text-stone-600 dark:text-stone-400 hover:bg-stone-200/70 dark:hover:bg-white/[0.07] hover:text-stone-900 dark:hover:text-stone-100 border border-transparent"
            }`}
            title="Board"
          >
            <Columns3 className="h-5 w-5 shrink-0" />
            <span className="rail-label text-[11px] font-bold">Board</span>
          </button>

          <button
            type="button"
            onClick={() => {
              onSetActiveNavView("builds");
              onSetViewMode("unified");
            }}
            className={`rail-btn flex flex-col items-center justify-center w-full py-2.5 px-1 rounded-xl text-xs font-semibold gap-1 transition-all ${
              activeNavView === "builds"
                ? "bg-emerald-600 dark:bg-emerald-500 text-white dark:text-black border border-transparent shadow-sm"
                : "text-stone-600 dark:text-stone-400 hover:bg-stone-200/70 dark:hover:bg-white/[0.07] hover:text-stone-900 dark:hover:text-stone-100 border border-transparent"
            }`}
            title="Autonomous Builds"
          >
            <Hammer className="h-5 w-5 shrink-0" />
            <span className="rail-label text-[11px] font-bold">Builds</span>
          </button>

          <button
            type="button"
            onClick={() => {
              onSetActiveNavView("projects");
              onSetViewMode("unified");
            }}
            className={`rail-btn flex flex-col items-center justify-center w-full py-2.5 px-1 rounded-xl text-xs font-semibold gap-1 transition-all ${
              activeNavView === "projects"
                ? "bg-emerald-600 dark:bg-emerald-500 text-white dark:text-black border border-transparent shadow-sm"
                : "text-stone-600 dark:text-stone-400 hover:bg-stone-200/70 dark:hover:bg-white/[0.07] hover:text-stone-900 dark:hover:text-stone-100 border border-transparent"
            }`}
            title="Projects & Folders"
          >
            <FolderGit2 className="h-5 w-5 shrink-0" />
            <span className="rail-label text-[11px] font-bold">Projects</span>
          </button>

          <button
            type="button"
            onClick={() => {
              onSetActiveNavView("morning-report");
              onSetViewMode("unified");
            }}
            className={`rail-btn flex flex-col items-center justify-center w-full py-2.5 px-1 rounded-xl text-xs font-semibold gap-1 transition-all ${
              activeNavView === "morning-report"
                ? "bg-emerald-600 dark:bg-emerald-500 text-white dark:text-black border border-transparent shadow-sm"
                : "text-stone-600 dark:text-stone-400 hover:bg-stone-200/70 dark:hover:bg-white/[0.07] hover:text-stone-900 dark:hover:text-stone-100 border border-transparent"
            }`}
            title="Morning Report"
          >
            <Sun className="h-5 w-5 shrink-0" />
            <span className="rail-label text-[11px] font-bold text-center leading-tight">
              Morning Report
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              onSetActiveNavView("skills");
              onSetViewMode("unified");
            }}
            className={`rail-btn flex flex-col items-center justify-center w-full py-2.5 px-1 rounded-xl text-xs font-semibold gap-1 transition-all relative ${
              activeNavView === "skills"
                ? "bg-emerald-600 dark:bg-emerald-500 text-white dark:text-black border border-transparent shadow-sm"
                : "text-stone-600 dark:text-stone-400 hover:bg-stone-200/70 dark:hover:bg-white/[0.07] hover:text-stone-900 dark:hover:text-stone-100 border border-transparent"
            }`}
            title="Skills Flywheel"
          >
            <Sparkles className="h-5 w-5 shrink-0" />
            <span className="rail-label text-[11px] font-bold">Skills</span>
            {pendingSkillsCount > 0 && (
              <span className="absolute top-1 right-2 px-1.5 py-0.2 rounded-full bg-emerald-600 text-[10px] text-white font-bold tabular-nums">
                {pendingSkillsCount}
              </span>
            )}
          </button>
        </div>

        <div className="flex flex-col items-center gap-2 w-full px-1.5">
          <button
            type="button"
            onClick={() => {
              onSetActiveNavView("settings");
              onSetViewMode("unified");
            }}
            className={`rail-btn flex flex-col items-center justify-center w-full py-2.5 px-1 rounded-xl text-xs font-semibold gap-1 transition-all ${
              activeNavView === "settings"
                ? "bg-emerald-600 dark:bg-emerald-500 text-white dark:text-black border border-transparent shadow-sm"
                : "text-stone-600 dark:text-stone-400 hover:bg-stone-200/70 dark:hover:bg-white/[0.07] hover:text-stone-900 dark:hover:text-stone-100 border border-transparent"
            }`}
            title="System Settings"
          >
            <Settings className="h-5 w-5 shrink-0" />
            <span className="rail-label text-[11px] font-bold">Settings</span>
          </button>
        </div>
      </nav>

      {/* Main Content Area */}
      <div className="flex-1 min-h-0 flex flex-col h-full overflow-hidden relative">
        {/* Mobile Backdrop for slide-over Drawers (Sidebar & Inspector) */}
        <div
          className={`mobile-backdrop ${isSidebarOpen || isWorkspaceOpen ? "block md:hidden" : "hidden"} fixed inset-0 bg-black/60 z-40 md:hidden`}
          onClick={() => {
            onSetSidebarOpen(false);
            onSetWorkspaceOpen(false);
          }}
        />

        {/* 3-Pane Collapsible Workbench (Sessions View) */}
        <div
          className={`${(activeNavView === "sessions" || !["board", "builds", "projects", "morning-report", "skills", "settings"].includes(activeNavView)) && viewMode === "unified" ? "flex" : "hidden"} flex-1 min-h-0 flex-col md:flex-row overflow-hidden relative`}
        >
          {/* Left Sessions Panel */}
          {isSidebarOpen && (
            <aside
              className="app-sidebar hidden md:flex md:relative inset-y-0 left-0 md:w-80 shrink-0 h-full border-r border-slate-200/80 dark:border-zinc-800 bg-white dark:bg-black md:z-10 flex-col overflow-hidden"
              aria-label="Sessions Panel"
            >
              <ThreadsSidebar
                isLoadingThreads={isLoadingThreads}
                threads={threads}
                selectedThreadId={selectedThreadId}
                activeNavView={activeNavView}
                onSelectThread={onSelectThread}
                onNewThread={onNewThread}
                onDeleteThread={onDeleteThread}
                onNavigate={onNavigate}
                onOpenDrawer={() => onSetDrawerOpen(true)}
                onCollapse={() => onSetSidebarOpen(false)}
                hideDock={true}
              />
            </aside>
          )}

          {/* Center Main Stage */}
          <main className="app-main flex flex-1 min-h-0 flex-col h-full overflow-hidden bg-white dark:bg-black">
            <div className="flex flex-1 min-h-0 flex-row relative">
              <div className="flex flex-1 min-w-0 min-h-0 flex-col relative">
                <ChatStream
                  messages={messages}
                  draftPrompt={draftComposerPrompt}
                  onClearDraftPrompt={onClearDraftPrompt}
                  setMessages={setMessages}
                  onTracesUpdate={onTracesUpdate}
                  liveTraces={traces}
                  isActiveView={activeNavView === "sessions" && viewMode === "unified"}
                  activeModel={selectedModel}
                  agentMode={agentMode}
                  reasoningEffort={reasoningEffort}
                  threadId={currentThread?.id}
                  threadTitle={currentThread?.title || "New session"}
                  activeTurn={activeTurn}
                  threadUpdatedAt={threadUpdatedAt ?? currentThread?.updatedAt ?? null}
                  supervisorState={
                    currentThread
                      ? {
                          needsAttention: currentThread.needsAttention,
                          stalledReason: currentThread.stalledReason,
                          autoResumeCount: currentThread.autoResumeCount,
                        }
                      : undefined
                  }
                  threadStatus={currentThread?.status}
                  threadScope={currentThread?.scope}
                  threadHostAccess={currentThread?.hostAccess}
                  onHostAccessChanged={(_enabled, updatedThread) => {
                    if (updatedThread) {
                      onThreadUpdated(updatedThread);
                    }
                  }}
                  activeTask={activeTask}
                  onStopTask={onStopRun}
                  onTaskUpdated={(task, updatedThread) => {
                    if (task) onSetActiveTask(task);
                    if (updatedThread) {
                      onThreadUpdated(updatedThread);
                    }
                  }}
                  onBackToList={onBackToList}
                  onOpenModelSheet={() => onSetModelSheetOpen(true)}
                  onOpenSettings={() => {
                    onSetActiveNavView("settings");
                    onSetViewMode("unified");
                  }}
                  onOpenDrawer={() => onSetDrawerOpen(true)}
                  onLaunchTask={onLaunchTask}
                  onNewThread={onNewThread}
                  onDeleteThread={() => currentThread && onDeleteThread(currentThread.id)}
                  onDeployRun={onDeployRun}
                  onEnsureThread={onEnsureThread}
                  onViewSecurityTelemetry={() => onSetViewMode("security")}
                  onToggleSidebar={() => onSetSidebarOpen(!isSidebarOpen)}
                  isSidebarOpen={isSidebarOpen}
                  onToggleWorkspace={() => onSetWorkspaceOpen(!isWorkspaceOpen)}
                  isWorkspaceOpen={isWorkspaceOpen}
                  onOpenProjects={() => {
                    onSetActiveNavView("projects");
                    onSetViewMode("unified");
                  }}
                  initialSimulation={initialSimulation || undefined}
                  placeholder="Message..."
                />
              </div>
              <ExplorerPanel open={isExplorerOpen} onClose={() => onSetExplorerOpen(false)} />
            </div>
          </main>

          {/* Right Workspace Inspector Panel */}
          {isWorkspaceOpen && (
            <aside
              className="app-inspector fixed md:relative inset-0 md:inset-auto md:right-0 md:top-0 md:bottom-0 w-full md:w-96 lg:w-[430px] shrink-0 h-full border-l border-slate-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col z-50 md:z-20 shadow-none"
              aria-label="Workspace Panel"
            >
              {/* Inspector Header */}
              <div className="inspector-header h-12 px-4 bg-white dark:bg-black border-b border-slate-200/80 dark:border-zinc-800 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onSetWorkspaceOpen(false)}
                    className="flex md:hidden min-h-[44px] min-w-[44px] items-center justify-center -ml-2 p-2 rounded-xl text-slate-700 dark:text-zinc-300 hover:bg-slate-200 dark:hover:bg-zinc-800 transition-colors"
                    title="Back to chat"
                    aria-label="Back to chat"
                  >
                    <ArrowLeft className="h-5 w-5" />
                  </button>
                  <span className="font-bold text-sm text-slate-900 dark:text-zinc-100">
                    Workspace
                  </span>
                  {activeTask?.status === "completed" && (
                    <span className="badge badge-success text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                      Verified
                    </span>
                  )}
                  {activeTask?.status === "active" && (
                    <span className="badge badge-info text-[10px] font-semibold px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border border-cyan-500/20">
                      Running
                    </span>
                  )}
                </div>
              </div>

              {/* Inspector Tabs */}
              <div className="inspector-tabs flex items-center gap-1.5 px-3 py-2 bg-stone-100/80 dark:bg-[#0e0e12] border-b border-stone-200 dark:border-white/[0.08] shrink-0 overflow-x-auto">
                <button
                  type="button"
                  onClick={() => onSetWorkspaceTab("diff")}
                  className={`inspector-tab px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                    workspaceTab === "diff"
                      ? "bg-white dark:bg-[#1f1f28] text-emerald-700 dark:text-emerald-300 shadow-xs border border-stone-200 dark:border-emerald-500/35"
                      : "text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
                  }`}
                >
                  Diff
                </button>
                <button
                  type="button"
                  onClick={() => onSetWorkspaceTab("output")}
                  className={`inspector-tab px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                    workspaceTab === "output"
                      ? "bg-white dark:bg-[#1f1f28] text-emerald-700 dark:text-emerald-300 shadow-xs border border-stone-200 dark:border-emerald-500/35"
                      : "text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
                  }`}
                >
                  Test Output
                </button>
                <button
                  type="button"
                  onClick={() => onSetWorkspaceTab("files")}
                  className={`inspector-tab px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                    workspaceTab === "files"
                      ? "bg-white dark:bg-[#1f1f28] text-emerald-700 dark:text-emerald-300 shadow-xs border border-stone-200 dark:border-emerald-500/35"
                      : "text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
                  }`}
                >
                  Files
                </button>
              </div>

              {/* Inspector Body */}
              <div className="inspector-body flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
                {workspaceTab === "diff" &&
                  (() => {
                    const taskDiff =
                      activeTask?.milestones
                        ?.map((m) => m.diffSummary || m.diff)
                        .filter(Boolean)
                        .join("\n") || "";
                    const activeBranch =
                      activeTask?.branchName ||
                      (currentThread?.title
                        ? "feature/" +
                          currentThread.title
                            .toLowerCase()
                            .replace(/[^a-z0-9]+/g, "-")
                            .slice(0, 30)
                        : "");
                    if (!taskDiff) {
                      return (
                        <div className="p-8 text-center text-xs text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-850/50 rounded-2xl border border-dashed border-slate-200 dark:border-zinc-800">
                          No file diffs recorded for this run.
                        </div>
                      );
                    }
                    return (
                      <DiffViewer
                        branch={activeBranch || "feature/task-diff"}
                        diff={taskDiff}
                        modifiedFiles={plannedFiles.length > 0 ? plannedFiles : []}
                      />
                    );
                  })()}

                {workspaceTab === "output" &&
                  (() => {
                    const activeCritic = activeTask?.milestones?.find(
                      (m) => m.status === "in_progress"
                    )?.criticCritique;
                    const lastCritic = activeTask?.milestones
                      ?.slice()
                      .reverse()
                      .find((m) => m.criticCritique)?.criticCritique;
                    const testSummary = activeTask?.testSummary;
                    const outputText =
                      activeCritic ||
                      lastCritic ||
                      (testSummary
                        ? `Passed: ${testSummary.passed}, Failed: ${testSummary.failed}${testSummary.durationMs ? ` (${testSummary.durationMs}ms)` : ""}`
                        : "");

                    return (
                      <div className="p-3 bg-slate-950 text-slate-100 rounded-xl font-mono text-xs overflow-auto h-full max-h-[500px] whitespace-pre-wrap leading-relaxed border border-slate-800">
                        <div className="text-emerald-400 font-bold mb-2">
                          ● Active Execution Output
                        </div>
                        {outputText ? (
                          <div>{outputText}</div>
                        ) : (
                          <div className="text-slate-400">No test output recorded yet.</div>
                        )}
                      </div>
                    );
                  })()}

                {workspaceTab === "files" &&
                  (() => {
                    const traceFiles: string[] = [];
                    const activeMessages = currentThread?.messages || messages;
                    activeMessages.forEach((m) => {
                      m.traces?.forEach((t) => {
                        if (
                          (t.tool === "workspace_write_file" ||
                            t.tool === "workspace_patch_file") &&
                          typeof t.args?.path === "string"
                        ) {
                          traceFiles.push(t.args.path);
                        }
                      });
                    });
                    const allFiles = Array.from(new Set([...plannedFiles, ...traceFiles]));

                    return (
                      <div className="space-y-2 font-mono text-xs">
                        <div className="text-slate-500 dark:text-zinc-400 font-bold text-[11px] uppercase tracking-wider px-1">
                          Planned Deliverables
                        </div>
                        {allFiles.length > 0 ? (
                          <>
                            <div className="space-y-1.5">
                              {allFiles.map((f, i) => (
                                <button
                                  key={i}
                                  type="button"
                                  onClick={() => onPreviewWorkspaceFile(f)}
                                  className={`w-full p-2.5 rounded-xl border text-left flex items-center justify-between transition-colors shadow-2xs ${
                                    selectedWorkspaceFile?.path === f
                                      ? "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200"
                                      : "bg-slate-50 dark:bg-zinc-800/60 border-slate-200 dark:border-zinc-800 text-slate-800 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800"
                                  }`}
                                >
                                  <span className="truncate">{f}</span>
                                  <span className="text-emerald-600 dark:text-emerald-400 text-[10px] font-bold shrink-0 ml-2">
                                    {plannedFiles.includes(f) ? "Planned" : "Created"}
                                  </span>
                                </button>
                              ))}
                            </div>
                            {selectedWorkspaceFile && (
                              <div className="mt-3 pt-3 border-t border-slate-200 dark:border-zinc-800">
                                <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 dark:text-zinc-400 mb-1.5">
                                  <span className="font-semibold text-slate-700 dark:text-zinc-300">
                                    Preview: {selectedWorkspaceFile.path}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => onSetSelectedWorkspaceFile(null)}
                                    className="text-[10px] text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200"
                                  >
                                    Close
                                  </button>
                                </div>
                                <CodeBlock
                                  filename={selectedWorkspaceFile.path}
                                  code={selectedWorkspaceFile.content}
                                />
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="p-8 text-center text-xs text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-850/50 rounded-2xl border border-dashed border-slate-200 dark:border-zinc-800">
                            No workspace files modified yet.
                          </div>
                        )}
                      </div>
                    );
                  })()}
              </div>
            </aside>
          )}
        </div>

        {/* Alternative Navigation Views */}
        {activeNavView === "settings" && (
          <SettingsView
            onBack={() => onSetActiveNavView("sessions")}
            selectedModel={selectedModel}
            reasoningEffort={reasoningEffort}
            onOpenModelSheet={() => onSetModelSheetOpen(true)}
            selfDeployEnabled={selfDeployEnabled}
            onToggleSelfDeploy={onToggleSelfDeploy}
            deployHistory={deployHistory}
          />
        )}

        {activeNavView === "board" && (
          <BoardView
            items={boardItems}
            onOpenDrawer={() => onSetDrawerOpen(true)}
            onItemCreated={onBoardItemCreated}
            controlState={boardControlState}
            stopAtBoundary={boardStopAtBoundary}
            isControlPending={isBoardControlPending}
            onControlAction={onBoardControlAction}
            onAskAssistant={onAskAssistantFromBoard}
          />
        )}

        {activeNavView === "builds" && (
          <BuildsView
            onOpenDrawer={() => onSetDrawerOpen(true)}
            activeTask={activeTask}
            tasks={tasks}
            onStopTask={onStopRun}
            onSelectThread={onSelectThread}
            onDeployRun={onDeployRun}
            onNavigateToProjects={() => onSetActiveNavView("projects")}
          />
        )}

        {activeNavView === "projects" && (
          <ProjectsView
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelectProject={onSelectProject}
            onRegisterProject={onRegisterProject}
            onToggleAllowlist={onToggleAllowlist}
            onDeleteProject={onDeleteProject}
            onOpenDrawer={() => onSetDrawerOpen(true)}
          />
        )}

        {activeNavView === "skills" && (
          <SkillsView
            onOpenDrawer={() => onSetDrawerOpen(true)}
            pendingCount={pendingSkillsCount}
          />
        )}

        {activeNavView === "morning-report" && (
          <div className="flex-1 min-h-0 flex flex-col bg-white dark:bg-black overflow-y-auto">
            <div className="max-w-4xl mx-auto w-full p-4 sm:p-6 space-y-6">
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-4 shadow-sm border border-slate-200 dark:border-zinc-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onSetDrawerOpen(true)}
                    className="p-1.5 rounded-full text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                    title="Open menu"
                    aria-label="Open navigation menu"
                  >
                    <Menu className="h-6 w-6" />
                  </button>
                  <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
                    Morning Report
                  </h1>
                </div>
                <a
                  href="/morning-report"
                  className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  Permalink (/morning-report)
                </a>
              </div>
              {overnightReport || morningReport ? (
                <MorningReportView overnightReport={overnightReport} report={morningReport} />
              ) : (
                <div className="p-8 text-center text-slate-600 dark:text-zinc-400 bg-white dark:bg-zinc-900 rounded-3xl shadow-sm border border-slate-200 dark:border-zinc-800">
                  No overnight report generated yet. Reports synthesize at completion of overnight
                  supervisor runs.
                </div>
              )}
            </div>
          </div>
        )}

        {viewMode === "security" && (
          <div className="flex-1 min-h-0 flex flex-col p-4 sm:p-6 overflow-y-auto space-y-6 max-w-5xl mx-auto w-full bg-white dark:bg-black">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-zinc-800">
              <div>
                <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
                  System Architecture &amp; Security Telemetry
                </h2>
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  Zero-trust container isolation and MCP hardware telemetry
                </p>
              </div>
              <button
                type="button"
                onClick={() => onSetViewMode("unified")}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-xs font-semibold text-slate-700 dark:text-zinc-200 transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                <span>Back to Sessions</span>
              </button>
            </div>

            <section>
              <SandboxGauge securityPosture={securityPosture} />
            </section>

            <section>
              <TraceWaterfall />
            </section>

            <section>
              <ExecutionTrace traces={traces} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
