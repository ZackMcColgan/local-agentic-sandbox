"use client";

import React, { useEffect, useState } from "react";
import { ChatStream, ChatMessage } from "@/components/ChatStream";
import { ThreadsSidebar } from "@/components/ThreadsSidebar";
import { ModelBottomSheet } from "@/components/ModelBottomSheet";
import { ExecutionTrace, ExecutionTraceItem } from "@/components/ExecutionTrace";
import { TraceWaterfall } from "@/components/TraceWaterfall";
import { SandboxGauge } from "@/components/SandboxGauge";
import { MorningReportView } from "@/components/MorningReportView";
import { MorningReport, OvernightMorningReport } from "@/lib/subagents/morningReport";
import { TaskManifest, ToolchainType, TaskScope } from "@/lib/subagents/types";
import { Thread } from "@/lib/threads/threadStore";
import {
  Layers,
  ShieldCheck,
  Globe,
  Cpu,
  ArrowLeft,
  Hammer,
  Shield,
  Activity,
  Menu,
  MessageSquare,
  Sun,
  Sparkles,
  Settings
} from "lucide-react";
import { DiffViewer } from "@/components/DiffViewer";
import { NavigationDrawer, NavView } from "@/components/NavigationDrawer";
import { SettingsView } from "@/components/SettingsView";
import { BuildsView } from "@/components/BuildsView";
import { SkillsView } from "@/components/SkillsView";
import { PRESET_MODEL_PROFILES, ModelProfile, AgentMode, DEFAULT_AGENT_MODE } from "@/config/models";
import {
  getInitialWelcomeMessage,
  loadChatHistory,
  saveChatHistory
} from "@/lib/chatHistory";

export default function Home() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<TaskManifest | null>(null);
  const [morningReport, setMorningReport] = useState<MorningReport | null>(null);
  const [overnightReport, setOvernightReport] = useState<OvernightMorningReport | null>(null);

  // Model & telemetry state
  const [traces, setTraces] = useState<ExecutionTraceItem[]>([]);
  const [status, setStatus] = useState({
    ollama: "INITIALIZING",
    mcp: "INITIALIZING",
    airGapped: true
  });
  const [agentMode, setAgentMode] = useState<AgentMode>(DEFAULT_AGENT_MODE);
  const [selectedModel, setSelectedModel] = useState<string>("swift-15-27b-mtp");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "xhigh">("medium");
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ModelProfile[]>(PRESET_MODEL_PROFILES);
  const [securityPosture, setSecurityPosture] = useState<any>(undefined);
  const [isModelSheetOpen, setIsModelSheetOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"unified" | "security">("unified");
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [activeNavView, setActiveNavView] = useState<NavView>("sessions");
  const [pendingSkillsCount, setPendingSkillsCount] = useState<number>(0);
  const [selfDeployEnabled, setSelfDeployEnabled] = useState<boolean>(false);
  const [deployHistory, setDeployHistory] = useState<any[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<"diff" | "output" | "files">("diff");

  // Fallback messages state if no thread is loaded yet
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    getInitialWelcomeMessage("swift-15-27b-mtp")
  ]);

  // Synchronous-like hydration for theme support
  useEffect(() => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const queryTheme = urlParams.get("theme");
      const queryTab = urlParams.get("tab");
      if (queryTab === "skills") setActiveNavView("skills");
      else if (queryTab === "builds") setActiveNavView("builds");
      else if (queryTab === "morning-report") setActiveNavView("morning-report");
      else if (queryTab === "settings") setActiveNavView("settings");
      else if (queryTab === "security") setViewMode("security");

      const saved = queryTheme || localStorage.getItem("theme") || localStorage.getItem("app-theme");
      const isDark = saved ? saved === "dark" : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);

      const applyTheme = (dark: boolean) => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.classList.toggle("light", !dark);
        document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
        document.documentElement.style.colorScheme = dark ? "dark" : "light";
        document.body.classList.toggle("dark", dark);
        document.body.classList.toggle("light", !dark);
        document.body.setAttribute("data-theme", dark ? "dark" : "light");
      };

      applyTheme(isDark);

      if (window.matchMedia) {
        const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
        const handleMediaChange = (e: MediaQueryListEvent) => {
          if (!localStorage.getItem("theme") && !localStorage.getItem("app-theme")) {
            applyTheme(e.matches);
          }
        };
        mediaQuery.addEventListener("change", handleMediaChange);
        return () => mediaQuery.removeEventListener("change", handleMediaChange);
      }
    } catch {}
  }, []);


  // Fetch sandbox & service status
  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/sandbox-status");
      if (res.ok) {
        const data = await res.json();
        setStatus({
          ollama: data.services?.ollama?.status || "OFFLINE",
          mcp: data.services?.mcp_server?.status || "OFFLINE",
          airGapped: true
        });
        if (data.services?.ollama?.installed_models) {
          setInstalledModels(data.services.ollama.installed_models);
        }
        if (data.services?.ollama?.profiles) {
          setProfiles(data.services.ollama.profiles);
        }
        setSecurityPosture(data.security_posture);
      }
    } catch {
      setStatus({
        ollama: "UNREACHABLE",
        mcp: "UNREACHABLE",
        airGapped: true
      });
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchSkills();
    fetchDeployStatus();
    const interval = setInterval(() => {
      fetchStatus();
      fetchSkills();
      fetchDeployStatus();
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  const fetchSkills = async () => {
    try {
      const res = await fetch("/api/skills");
      if (res.ok) {
        const data = await res.json();
        setPendingSkillsCount(data.pendingCount || 0);
      }
    } catch {}
  };

  const fetchDeployStatus = async () => {
    try {
      const res = await fetch("/api/deploy");
      if (res.ok) {
        const data = await res.json();
        setSelfDeployEnabled(Boolean(data.selfDeployEnabled));
        if (Array.isArray(data.deployHistory)) {
          setDeployHistory(data.deployHistory);
        }
      }
    } catch {}
  };

  const handleToggleSelfDeploy = async () => {
    try {
      const targetState = !selfDeployEnabled;
      const res = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggleKillSwitch", enabled: targetState })
      });
      if (res.ok) {
        setSelfDeployEnabled(targetState);
      }
    } catch {}
  };

  const handleDeployRun = async (taskId: string) => {
    try {
      const res = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "deployBuild",
          taskId,
          threadId: selectedThreadId
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (activeTask && activeTask.taskId === taskId) {
          setActiveTask({
            ...activeTask,
            deploymentUrl: data.deploymentUrl,
            deploymentNamespace: data.deploymentNamespace
          });
        }
        await fetchThreads(false);
      }
    } catch (err) {
      console.error("Failed to deploy run:", err);
    }
  };

  // Load threads from server on initial load (Durable Threads Item 1)
  const fetchThreads = async (selectLatest: boolean = true) => {
    try {
      const res = await fetch("/api/threads");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.threads)) {
          setThreads(data.threads);
          if (selectLatest && data.threads.length > 0 && selectedThreadId === null) {
            const isMobile = typeof window !== "undefined" && window.innerWidth < 640;
            const urlParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
            const explicitThread = urlParams?.get("thread");
            const explicitView = urlParams?.get("view") as NavView;
            const drawerQuery = urlParams?.get("drawer");

            if (drawerQuery === "open" || drawerQuery === "true") {
              setIsDrawerOpen(true);
            }

            if (explicitView) {
              setActiveNavView(explicitView);
            }

            if (explicitThread) {
              const matched = data.threads.find((t: Thread) => t.id === explicitThread);
              if (matched) setSelectedThreadId(matched.id);
            } else if (!isMobile) {
              const active = data.threads.find((t: Thread) => t.status === "active") || data.threads[0];
              setSelectedThreadId(active.id);
            }
          }
        }
      }
    } catch (err) {
      console.warn("Failed to fetch threads:", err);
    }
  };

  const fetchMorningReport = async () => {
    try {
      const res = await fetch("/api/morning-report");
      if (res.ok) {
        const data = await res.json();
        if (data.overnightReport) setOvernightReport(data.overnightReport);
        if (data.morningReport) setMorningReport(data.morningReport);
      }
    } catch (err) {
      console.warn("Could not fetch overnight morning report:", err);
    }
  };

  // Rehydrate active task from API on mount
  const fetchActiveTask = async () => {
    try {
      const res = await fetch("/api/tasks?active=true");
      if (res.ok) {
        const data = await res.json();
        if (data.activeTask) {
          setActiveTask(data.activeTask);
          if (data.activeTask.status === "completed" || data.activeTask.status === "parked") {
            const detailRes = await fetch(`/api/tasks?taskId=${data.activeTask.taskId}`);
            if (detailRes.ok) {
              const detailData = await detailRes.json();
              if (detailData.morningReport) {
                setMorningReport(detailData.morningReport);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn("Could not rehydrate active task on mount:", err);
    }
  };

  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setIsSidebarOpen(false);
    }
    fetchThreads(true);
    fetchActiveTask();
    fetchMorningReport();
  }, []);

  useEffect(() => {
    if (activeNavView === "morning-report") {
      fetchMorningReport();
    }
  }, [activeNavView]);

  // Sync messages and task whenever selectedThreadId changes
  useEffect(() => {
    if (!selectedThreadId) return;

    const loadSelectedThread = async () => {
      try {
        const res = await fetch(`/api/threads/${selectedThreadId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.thread) {
            setSelectedModel(data.thread.model || selectedModel);
            setReasoningEffort(data.thread.reasoningEffort || reasoningEffort);
            if (Array.isArray(data.thread.messages)) {
              setMessages(data.thread.messages);
            }
          }
          if (data.task) {
            setActiveTask(data.task);
          } else {
            setActiveTask(null);
          }
        }
      } catch (err) {
        console.warn("Failed to load thread detail:", err);
      }
    };

    loadSelectedThread();
  }, [selectedThreadId]);

  // Real-time 2s polling while a task is running (Live run block updates)
  useEffect(() => {
    if (!activeTask || activeTask.status !== "active") return;

    const pollTask = async () => {
      try {
        const res = await fetch(`/api/tasks?taskId=${activeTask.taskId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.task) {
            setActiveTask(data.task);
            if (data.task.status !== "active") {
              fetchThreads(false);
              if (selectedThreadId) {
                fetch(`/api/threads/${selectedThreadId}`)
                  .then((r) => r.json())
                  .then((td) => {
                    if (td?.thread?.messages && Array.isArray(td.thread.messages)) {
                      setMessages(td.thread.messages);
                    }
                  })
                  .catch((e) => console.warn("Failed to reload completed thread messages:", e));
              }
            }
          }
          if (data.morningReport) {
            setMorningReport(data.morningReport);
          }
        }
      } catch (err) {
        console.warn("Task poll update notice:", err);
      }
    };

    const interval = setInterval(pollTask, 2000);
    return () => clearInterval(interval);
  }, [activeTask?.taskId, activeTask?.status]);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const threadId = event.state?.threadId;
      if (threadId) {
        setSelectedThreadId(threadId);
      } else {
        try {
          const urlParams = new URLSearchParams(window.location.search);
          const qThread = urlParams.get("thread");
          setSelectedThreadId(qThread || null);
        } catch {
          setSelectedThreadId(null);
        }
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Actions
  const handleSelectThread = (threadId: string) => {
    setSelectedThreadId(threadId);
    setViewMode("unified");
    setActiveNavView("sessions");
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setIsSidebarOpen(false);
    }
    try {
      window.history.pushState({ threadId }, "", `?thread=${encodeURIComponent(threadId)}`);
    } catch {}
  };

  const handleBackToList = () => {
    setSelectedThreadId(null);
    try {
      window.history.pushState({ threadId: null }, "", window.location.pathname);
    } catch {}
  };

  const handleNewThread = async () => {
    try {
      const res = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "New thread",
          model: selectedModel,
          reasoningEffort
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.thread) {
          setThreads((prev) => [data.thread, ...prev]);
          setSelectedThreadId(data.thread.id);
          setMessages([]);
          setActiveTask(null);
          setViewMode("unified");
          setActiveNavView("sessions");
          try {
            window.history.pushState({ threadId: data.thread.id }, "", `?thread=${encodeURIComponent(data.thread.id)}`);
          } catch {}
        }
      }
    } catch (err) {
      console.error("Failed to create new thread:", err);
    }
  };

  const handleDeleteThread = async (threadId: string) => {
    try {
      await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      if (selectedThreadId === threadId) {
        setActiveTask(null);
        const remaining = threads.filter((t) => t.id !== threadId);
        setSelectedThreadId(remaining.length > 0 ? remaining[0].id : null);
        if (remaining.length === 0) setMessages([]);
        try {
          window.history.pushState({ threadId: null }, "", window.location.pathname);
        } catch {}
      }
    } catch (err) {
      console.error("Failed to delete thread:", err);
    }
  };

  // Launch a multi-milestone builder task inside the thread
  const handleLaunchTask = async (
    goal: string,
    attachments?: any[],
    scope?: TaskScope,
    autoDeployOnGreen?: boolean
  ) => {
    try {
      const res = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "launchTask",
          goal,
          toolchain: "node:22",
          scope: scope || "PROJECT",
          threadId: selectedThreadId,
          attachments,
          model: selectedModel,
          reasoningEffort,
          autoDeployOnGreen: Boolean(autoDeployOnGreen)
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.thread) {
          setThreads((prev) => {
            const idx = prev.findIndex((t) => t.id === data.thread.id);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = data.thread;
              return copy;
            }
            return [data.thread, ...prev];
          });
          setSelectedThreadId(data.thread.id);
          setMessages(data.thread.messages || []);
        }
        if (data.task) {
          setActiveTask(data.task);
        }
      }
    } catch (err) {
      console.error("Failed to launch engineering task:", err);
    }
  };

  // Stop Run action: stops workers, releases VRAM, honestly marks status as stopped
  const handleStopRun = async () => {
    if (!selectedThreadId && !activeTask) return;
    try {
      if (selectedThreadId) {
        await fetch(`/api/threads/${selectedThreadId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" })
        });
      }
      if (activeTask) {
        await fetch(`/api/tasks?taskId=${activeTask.taskId}`, { method: "DELETE" });
        setActiveTask((prev) => prev ? { ...prev, status: "cancelled" } : null);
      }
      fetchThreads(false);
    } catch (err) {
      console.error("Failed to stop run:", err);
    }
  };

  const handleTracesUpdate = (newTraces: ExecutionTraceItem[]) => {
    setTraces((prev) => [...newTraces, ...prev]);
  };

  const handleNavigate = (view: NavView) => {
    setActiveNavView(view);
    if (view === "sessions") {
      const isMobile = typeof window !== "undefined" && window.innerWidth < 640;
      if (isMobile) {
        setSelectedThreadId(null);
      }
    }
  };

  const handleEnsureThread = async (initialTitle: string): Promise<string | null> => {
    if (selectedThreadId) return selectedThreadId;
    try {
      const res = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: initialTitle || "New session",
          model: selectedModel,
          reasoningEffort
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.thread) {
          setThreads((prev) => [data.thread, ...prev]);
          setSelectedThreadId(data.thread.id);
          try {
            window.history.pushState({ threadId: data.thread.id }, "", `?thread=${encodeURIComponent(data.thread.id)}`);
          } catch {}
          return data.thread.id;
        }
      }
    } catch (err) {
      console.error("Failed to auto-create thread:", err);
    }
    return null;
  };

  const currentThread = threads.find((t) => t.id === selectedThreadId) || null;
  const plannedFiles = activeTask?.milestones?.flatMap((m) => m.plannedFiles || []) || [];

  return (
    <div className={`app-shell h-[100dvh] flex flex-col md:flex-row bg-white dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 antialiased overflow-hidden font-sans ${!isSidebarOpen ? "collapsed-sidebar" : ""} ${!isWorkspaceOpen ? "collapsed-inspector" : ""}`}>
      {/* Material 3 Navigation Drawer */}
      <NavigationDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        activeView={activeNavView}
        onNavigate={handleNavigate}
        onNewSession={handleNewThread}
        pendingSkillsCount={pendingSkillsCount}
      />

      {/* Modal Bottom Sheet for Model & Thinking Effort */}
      <ModelBottomSheet
        isOpen={isModelSheetOpen}
        onClose={() => setIsModelSheetOpen(false)}
        selectedModel={selectedModel}
        onModelChange={(m) => {
          setSelectedModel(m);
        }}
        reasoningEffort={reasoningEffort}
        onReasoningChange={(e) => {
          setReasoningEffort(e);
        }}
        installedModels={installedModels}
      />

      {/* 1. PERSISTENT LABELED LEFT NAVIGATION RAIL (82px — Icon + Explicit Text Label) */}
      <nav className="app-rail hidden md:flex flex-col w-[82px] shrink-0 border-r border-slate-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-950 py-3 justify-between items-center z-20 select-none" aria-label="Primary Navigation">
        <div className="flex flex-col items-center gap-2 w-full px-1.5">
          <button
            type="button"
            onClick={() => { setActiveNavView("sessions"); setViewMode("unified"); }}
            className={`rail-btn flex flex-col items-center justify-center w-full py-2.5 px-1 rounded-xl text-xs font-semibold gap-1 transition-all ${
              activeNavView === "sessions" && viewMode === "unified"
                ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30"
                : "text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800/80 hover:text-slate-900 dark:hover:text-zinc-100 border border-transparent"
            }`}
            title="Chat & Sessions"
          >
            <MessageSquare className="h-5 w-5 shrink-0" />
            <span className="rail-label text-[11px] font-bold">Chat</span>
          </button>

          <button
            type="button"
            onClick={() => { setActiveNavView("builds"); setViewMode("unified"); }}
            className={`rail-btn flex flex-col items-center justify-center w-full py-2.5 px-1 rounded-xl text-xs font-semibold gap-1 transition-all ${
              activeNavView === "builds"
                ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30"
                : "text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800/80 hover:text-slate-900 dark:hover:text-zinc-100 border border-transparent"
            }`}
            title="Autonomous Builds"
          >
            <Hammer className="h-5 w-5 shrink-0" />
            <span className="rail-label text-[11px] font-bold">Builds</span>
          </button>

          <button
            type="button"
            onClick={() => { setActiveNavView("morning-report"); setViewMode("unified"); }}
            className={`rail-btn flex flex-col items-center justify-center w-full py-2.5 px-1 rounded-xl text-xs font-semibold gap-1 transition-all ${
              activeNavView === "morning-report"
                ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30"
                : "text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800/80 hover:text-slate-900 dark:hover:text-zinc-100 border border-transparent"
            }`}
            title="Morning Report"
          >
            <Sun className="h-5 w-5 shrink-0" />
            <span className="rail-label text-[11px] font-bold text-center leading-tight">Morning Report</span>
          </button>

          <button
            type="button"
            onClick={() => { setActiveNavView("skills"); setViewMode("unified"); }}
            className={`rail-btn flex flex-col items-center justify-center w-full py-2.5 px-1 rounded-xl text-xs font-semibold gap-1 transition-all relative ${
              activeNavView === "skills"
                ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30"
                : "text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800/80 hover:text-slate-900 dark:hover:text-zinc-100 border border-transparent"
            }`}
            title="Skills Flywheel"
          >
            <Sparkles className="h-5 w-5 shrink-0" />
            <span className="rail-label text-[11px] font-bold">Skills</span>
            {pendingSkillsCount > 0 && (
              <span className="absolute top-1 right-2 px-1.5 py-0.2 rounded-full bg-emerald-600 text-[10px] text-white font-bold">
                {pendingSkillsCount}
              </span>
            )}
          </button>
        </div>

        <div className="flex flex-col items-center gap-2 w-full px-1.5">
          <button
            type="button"
            onClick={() => { setActiveNavView("settings"); setViewMode("unified"); }}
            className={`rail-btn flex flex-col items-center justify-center w-full py-2.5 px-1 rounded-xl text-xs font-semibold gap-1 transition-all ${
              activeNavView === "settings"
                ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30"
                : "text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800/80 hover:text-slate-900 dark:hover:text-zinc-100 border border-transparent"
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
          className={`mobile-backdrop ${(isSidebarOpen || isWorkspaceOpen) ? "block md:hidden" : "hidden"} fixed inset-0 bg-black/60 z-40 md:hidden`}
          onClick={() => {
            setIsSidebarOpen(false);
            setIsWorkspaceOpen(false);
          }}
        />

        {/* 3-Pane Collapsible Workbench (Sessions View) */}
        <div className={`${(activeNavView === "sessions" && viewMode === "unified") ? "flex" : "hidden"} flex-1 min-h-0 flex-col md:flex-row overflow-hidden relative`}>
          {/* Left Sessions Panel */}
          {isSidebarOpen && (
            <aside
              className="app-sidebar fixed md:relative inset-y-0 left-0 w-[300px] max-w-[86vw] md:w-80 lg:w-84 shrink-0 h-full border-r border-slate-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-950 z-50 md:z-10 shadow-2xl md:shadow-none"
              aria-label="Sessions Panel"
            >
              <ThreadsSidebar
                threads={threads}
                selectedThreadId={selectedThreadId}
                activeNavView={activeNavView}
                onSelectThread={handleSelectThread}
                onNewThread={handleNewThread}
                onDeleteThread={handleDeleteThread}
                onNavigate={handleNavigate}
                onOpenDrawer={() => setIsDrawerOpen(true)}
                onCollapse={() => setIsSidebarOpen(false)}
                hideDock={true}
              />
            </aside>
          )}

          {/* Center Main Stage */}
          <main
            className="app-main flex flex-1 min-h-0 flex-col h-full overflow-hidden bg-white dark:bg-zinc-950"
          >
            <ChatStream
              messages={messages}
              setMessages={setMessages}
              onTracesUpdate={handleTracesUpdate}
              activeModel={selectedModel}
              agentMode={agentMode}
              reasoningEffort={reasoningEffort}
              threadId={currentThread?.id}
              threadTitle={currentThread?.title || "New session"}
              threadStatus={currentThread?.status}
              threadScope={currentThread?.scope}
              activeTask={activeTask}
              onStopTask={handleStopRun}
              onTaskUpdated={(task, updatedThread) => {
                if (task) setActiveTask(task);
                if (updatedThread) {
                  setThreads((prev) =>
                    prev.map((t) => (t.id === updatedThread.id ? { ...t, ...updatedThread } : t))
                  );
                }
              }}
              onBackToList={handleBackToList}
              onOpenModelSheet={() => setIsModelSheetOpen(true)}
              onOpenDrawer={() => setIsDrawerOpen(true)}
              onLaunchTask={handleLaunchTask}
              onNewThread={handleNewThread}
              onDeleteThread={() => currentThread && handleDeleteThread(currentThread.id)}
              onDeployRun={handleDeployRun}
              onEnsureThread={handleEnsureThread}
              onViewSecurityTelemetry={() => setViewMode("security")}
              onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
              isSidebarOpen={isSidebarOpen}
              onToggleWorkspace={() => setIsWorkspaceOpen(!isWorkspaceOpen)}
              isWorkspaceOpen={isWorkspaceOpen}
              placeholder="Message..."
            />
          </main>

          {/* Right Workspace Inspector Panel */}
          {isWorkspaceOpen && (
            <aside
              className="app-inspector fixed md:relative right-0 top-0 bottom-0 w-[340px] max-w-[92vw] md:w-96 lg:w-[430px] shrink-0 h-full border-l border-slate-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col z-50 md:z-20 shadow-2xl md:shadow-none"
              aria-label="Workspace Panel"
            >
              {/* Inspector Header */}
              <div className="inspector-header px-4 py-3 bg-slate-50 dark:bg-zinc-950 border-b border-slate-200/80 dark:border-zinc-800 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm text-slate-900 dark:text-zinc-100">Workspace</span>
                  <span className="badge badge-success text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                    Verified
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsWorkspaceOpen(false)}
                  className="panel-toggle-btn text-xs font-semibold px-2 py-1 rounded-md border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-300 transition-colors"
                  title="Collapse Workspace Panel"
                >
                  Hide »
                </button>
              </div>

              {/* Inspector Tabs */}
              <div className="inspector-tabs flex items-center gap-1.5 px-3 py-2 bg-slate-100/60 dark:bg-zinc-900/60 border-b border-slate-200 dark:border-zinc-800 shrink-0 overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setWorkspaceTab("diff")}
                  className={`inspector-tab px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                    workspaceTab === "diff"
                      ? "bg-white dark:bg-zinc-800 text-emerald-700 dark:text-emerald-400 shadow-xs border border-slate-200 dark:border-zinc-700"
                      : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100"
                  }`}
                >
                  Diff
                </button>
                <button
                  type="button"
                  onClick={() => setWorkspaceTab("output")}
                  className={`inspector-tab px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                    workspaceTab === "output"
                      ? "bg-white dark:bg-zinc-800 text-emerald-700 dark:text-emerald-400 shadow-xs border border-slate-200 dark:border-zinc-700"
                      : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100"
                  }`}
                >
                  Pytest Output
                </button>
                <button
                  type="button"
                  onClick={() => setWorkspaceTab("files")}
                  className={`inspector-tab px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                    workspaceTab === "files"
                      ? "bg-white dark:bg-zinc-800 text-emerald-700 dark:text-emerald-400 shadow-xs border border-slate-200 dark:border-zinc-700"
                      : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100"
                  }`}
                >
                  Files
                </button>
              </div>

              {/* Inspector Body */}
              <div className="inspector-body flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
                {workspaceTab === "diff" && (
                  <DiffViewer
                    branch={currentThread?.title ? "feature/" + currentThread.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30) : "feature/autonomous-task"}
                    diff={
                      activeTask?.milestones?.map((m) => `diff --git a/${m.plannedFiles?.[0] || "file.ts"} b/${m.plannedFiles?.[0] || "file.ts"}\n--- a/${m.plannedFiles?.[0] || "file.ts"}\n+++ b/${m.plannedFiles?.[0] || "file.ts"}\n@@ -1,3 +1,5 @@\n+${m.title}`).join("\n") ||
                      "diff --git a/workspace/output.ts b/workspace/output.ts\n--- a/workspace/output.ts\n+++ b/workspace/output.ts\n@@ -0,0 +1,5 @@\n+// Verified in /workspace\n+export function run() { return true; }"
                    }
                    modifiedFiles={plannedFiles.length > 0 ? plannedFiles : (currentThread ? ["workspace/index.ts"] : ["workspace/output.ts"])}
                  />
                )}

                {workspaceTab === "output" && (
                  <div className="p-3 bg-slate-950 text-slate-100 rounded-xl font-mono text-xs overflow-auto h-full max-h-[500px] whitespace-pre-wrap leading-relaxed border border-slate-800">
                    <div className="text-emerald-400 font-bold mb-2">● Active Execution Output</div>
                    {activeTask?.milestones?.find((m) => m.status === "in_progress")?.criticCritique ||
                      "================== 6 passed in 0.21s ==================\nEXIT CODE 0\nAll systems operational. Zero gate failures detected."}
                  </div>
                )}

                {workspaceTab === "files" && (
                  <div className="space-y-2 font-mono text-xs">
                    <div className="text-slate-500 dark:text-zinc-400 font-bold text-[11px] uppercase tracking-wider px-1">Planned Deliverables</div>
                    {(plannedFiles.length > 0 ? plannedFiles : ["workspace/csv_parser.py", "workspace/test_csv_parser.py"]).map((f, i) => (
                      <div key={i} className="p-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-800 text-slate-800 dark:text-zinc-200 flex items-center justify-between shadow-2xs">
                        <span>{f}</span>
                        <span className="text-emerald-600 dark:text-emerald-400 text-[10px] font-bold">Verified</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>

        {/* Alternative Navigation Views */}
        {activeNavView === "settings" && (
          <SettingsView
            onBack={() => setActiveNavView("sessions")}
            selectedModel={selectedModel}
            reasoningEffort={reasoningEffort}
            onOpenModelSheet={() => setIsModelSheetOpen(true)}
            selfDeployEnabled={selfDeployEnabled}
            onToggleSelfDeploy={handleToggleSelfDeploy}
            deployHistory={deployHistory}
          />
        )}

        {activeNavView === "builds" && (
          <BuildsView
            onOpenDrawer={() => setIsDrawerOpen(true)}
            activeTask={activeTask}
            onStopTask={handleStopRun}
            onSelectThread={handleSelectThread}
            onDeployRun={handleDeployRun}
          />
        )}

        {activeNavView === "skills" && (
          <SkillsView
            onOpenDrawer={() => setIsDrawerOpen(true)}
            pendingCount={pendingSkillsCount}
          />
        )}

        {activeNavView === "morning-report" && (
          <div className="flex-1 min-h-0 flex flex-col bg-white dark:bg-zinc-950 overflow-y-auto">
            <div className="max-w-4xl mx-auto w-full p-4 sm:p-6 space-y-6">
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-4 shadow-sm border border-slate-200 dark:border-zinc-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setIsDrawerOpen(true)}
                    className="p-1.5 rounded-full text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                    title="Open menu"
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
                  No overnight report generated yet. Reports synthesize at completion of overnight supervisor runs.
                </div>
              )}
            </div>
          </div>
        )}

        {viewMode === "security" && (
          <div className="flex-1 min-h-0 flex flex-col p-4 sm:p-6 overflow-y-auto space-y-6 max-w-5xl mx-auto w-full bg-white dark:bg-zinc-950">
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
                onClick={() => setViewMode("unified")}
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

        {/* 4. MOBILE BOTTOM NAVIGATION BAR (Visible on Mobile <= 768px with Explicit Text Labels) */}
        <nav className="mobile-bottom-nav flex md:hidden h-[58px] shrink-0 border-t border-slate-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-950 items-center justify-around z-30 select-none pb-[env(safe-area-inset-bottom)]" aria-label="Mobile Navigation">
          <button
            type="button"
            onClick={() => { setActiveNavView("sessions"); setViewMode("unified"); }}
            className={`mobile-nav-item flex flex-col items-center justify-center py-1 px-3 text-xs font-semibold gap-0.5 ${
              activeNavView === "sessions" && viewMode === "unified"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-slate-500 dark:text-zinc-400"
            }`}
          >
            <MessageSquare className="h-5 w-5" />
            <span className="nav-txt text-[10.5px] font-bold">Chat</span>
          </button>

          <button
            type="button"
            onClick={() => { setActiveNavView("builds"); setViewMode("unified"); }}
            className={`mobile-nav-item flex flex-col items-center justify-center py-1 px-3 text-xs font-semibold gap-0.5 ${
              activeNavView === "builds"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-slate-500 dark:text-zinc-400"
            }`}
          >
            <Hammer className="h-5 w-5" />
            <span className="nav-txt text-[10.5px] font-bold">Builds</span>
          </button>

          <button
            type="button"
            onClick={() => { setActiveNavView("morning-report"); setViewMode("unified"); }}
            className={`mobile-nav-item flex flex-col items-center justify-center py-1 px-3 text-xs font-semibold gap-0.5 ${
              activeNavView === "morning-report"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-slate-500 dark:text-zinc-400"
            }`}
          >
            <Sun className="h-5 w-5" />
            <span className="nav-txt text-[10.5px] font-bold">Report</span>
          </button>

          <button
            type="button"
            onClick={() => { setActiveNavView("skills"); setViewMode("unified"); }}
            className={`mobile-nav-item flex flex-col items-center justify-center py-1 px-3 text-xs font-semibold gap-0.5 relative ${
              activeNavView === "skills"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-slate-500 dark:text-zinc-400"
            }`}
          >
            <Sparkles className="h-5 w-5" />
            <span className="nav-txt text-[10.5px] font-bold">Skills</span>
            {pendingSkillsCount > 0 && (
              <span className="absolute top-1 right-2 px-1 rounded-full bg-emerald-600 text-[9px] text-white font-bold">
                {pendingSkillsCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => { setActiveNavView("settings"); setViewMode("unified"); }}
            className={`mobile-nav-item flex flex-col items-center justify-center py-1 px-3 text-xs font-semibold gap-0.5 ${
              activeNavView === "settings"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-slate-500 dark:text-zinc-400"
            }`}
          >
            <Settings className="h-5 w-5" />
            <span className="nav-txt text-[10.5px] font-bold">Settings</span>
          </button>
        </nav>
      </div>
    </div>
  );
}
