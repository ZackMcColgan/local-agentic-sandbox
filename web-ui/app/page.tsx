"use client";

import React, { useEffect, useState, useRef } from "react";
import type { ChatMessage } from "@/components/ChatStream";
import { useLiveTraces } from "@/lib/hooks/useLiveTraces";
import { MorningReport, OvernightMorningReport } from "@/lib/subagents/morningReport";
import { TaskManifest, TaskScope } from "@/lib/subagents/types";
import { Thread, type ActiveTurnInfo } from "@/lib/threads/threadStore";
import { pickMostRecentlyActiveThread } from "@/lib/liveActivity";
import { isLiveStreamingMessage, STREAM_POLL_INTERVAL_MS } from "@/lib/streamSnapshot";
import { isSseStreamDelivering, shouldPollLiveThread } from "@/lib/streamPollGate";
import { SimulationScenarioKey } from "@/lib/simulator";
import type { NavView } from "@/components/NavigationDrawer";
import type { SettingsView } from "@/components/SettingsView";
import type { BoardItem } from "@/lib/board/boardStore";
import type { BoardControlAction, BoardControlState } from "@/lib/board/boardControlStore";
import type { ProjectsView } from "@/components/ProjectsView";
import { ProjectRecord } from "@/lib/projects/projectStore";
import { AgentMode, DEFAULT_AGENT_MODE, DEFAULT_PRIMARY_MODEL } from "@/config/models";
import { getInitialWelcomeMessage } from "@/lib/chatHistory";
import { ViewShell } from "@/components/ViewShell";

export default function Home() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [isLoadingThreads, setIsLoadingThreads] = useState(true);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<TaskManifest | null>(null);
  const [tasks, setTasks] = useState<TaskManifest[]>([]);
  const [morningReport, setMorningReport] = useState<MorningReport | null>(null);
  const [overnightReport, setOvernightReport] = useState<OvernightMorningReport | null>(null);

  // Model & telemetry state
  const skipThreadLoadRef = useRef<string | null>(null);
  const { traces, updateTraces: handleTracesUpdate } = useLiveTraces(selectedThreadId, {
    shouldSkipClear: (threadId) => skipThreadLoadRef.current === threadId,
  });
  const agentMode: AgentMode = DEFAULT_AGENT_MODE;
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("preferred_model");
      if (saved) return saved;
    }
    return DEFAULT_PRIMARY_MODEL;
  });
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "xhigh">(() => {
    if (typeof window !== "undefined") {
      const saved = window.localStorage.getItem("las.reasoningEffort");
      if (saved === "low" || saved === "medium" || saved === "xhigh") return saved;
    }
    return "low";
  });
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [securityPosture, setSecurityPosture] = useState<
    | {
        execution_uid: string;
        root_filesystem: string;
        capabilities: string;
        tmpfs_buffer: string;
        provenance_level: string;
      }
    | undefined
  >(undefined);
  const [isModelSheetOpen, setIsModelSheetOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"unified" | "security">("unified");
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [boardItems, setBoardItems] = useState<BoardItem[]>([]);
  const [boardControlState, setBoardControlState] = useState<BoardControlState>("stopped");
  const [boardStopAtBoundary, setBoardStopAtBoundary] = useState<boolean>(false);
  const [isBoardControlPending, setIsBoardControlPending] = useState<boolean>(false);
  const [activeNavView, setActiveNavView] = useState<NavView>("sessions");
  const [draftComposerPrompt, setDraftComposerPrompt] = useState<string | null>(null);

  useEffect(() => {
    if (activeNavView !== "board") return;
    let active = true;
    const refreshBoard = () => {
      if (!active) return;
      if (typeof document !== "undefined" && document.hidden) return;
      fetch("/api/board")
        .then((res) => (res.ok ? res.json() : { items: [] }))
        .then((data) => {
          if (active && Array.isArray(data.items)) {
            setBoardItems(data.items);
          }
        })
        .catch(() => {});
      fetch("/api/board/control")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (active && data?.control?.state) {
            setBoardControlState(data.control.state);
            setBoardStopAtBoundary(Boolean(data.control.stopAtBoundary));
          }
        })
        .catch(() => {});
    };
    refreshBoard();
    const interval = setInterval(refreshBoard, 4000);
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        refreshBoard();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      active = false;
      clearInterval(interval);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [activeNavView]);

  const handleBoardControlAction = async (action: BoardControlAction) => {
    setIsBoardControlPending(true);
    try {
      const res = await fetch("/api/board/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.control?.state) {
          setBoardControlState(data.control.state);
          setBoardStopAtBoundary(Boolean(data.control.stopAtBoundary));
        }
      }
    } catch {
      // Best-effort control update
    } finally {
      setIsBoardControlPending(false);
    }
  };
  const [pendingSkillsCount, setPendingSkillsCount] = useState<number>(0);
  const [selfDeployEnabled, setSelfDeployEnabled] = useState<boolean>(false);
  const [deployHistory, setDeployHistory] = useState<
    NonNullable<React.ComponentProps<typeof SettingsView>["deployHistory"]>
  >([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(false);
  const [isExplorerOpen, setIsExplorerOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<"diff" | "output" | "files">("diff");
  const [selectedWorkspaceFile, setSelectedWorkspaceFile] = useState<{
    path: string;
    content: string;
  } | null>(null);

  const handlePreviewWorkspaceFile = async (filePath: string) => {
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(filePath)}&format=json`);
      if (res.ok) {
        const data = await res.json();
        setSelectedWorkspaceFile({ path: filePath, content: data.content || "" });
      } else {
        const textRes = await fetch(`/api/files?path=${encodeURIComponent(filePath)}`);
        const text = await textRes.text();
        setSelectedWorkspaceFile({ path: filePath, content: text });
      }
    } catch (err: unknown) {
      console.warn(
        "[WorkspacePreview] Failed to preview file:",
        err instanceof Error ? err.message : String(err)
      );
    }
  };

  const [initialSimulation, setInitialSimulation] = useState<{
    scenarioKey: SimulationScenarioKey;
    speedMultiplier?: number;
  } | null>(null);

  // Fallback messages state if no thread is loaded yet
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    getInitialWelcomeMessage(DEFAULT_PRIMARY_MODEL),
  ]);
  const [observedActiveTurn, setObservedActiveTurn] = useState<ActiveTurnInfo | null>(null);
  const [observedThreadUpdatedAt, setObservedThreadUpdatedAt] = useState<string | null>(null);

  // Synchronous-like hydration for theme support
  useEffect(() => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const queryTheme = urlParams.get("theme");
      const queryTab = urlParams.get("tab") || urlParams.get("view");
      const querySimulate = urlParams.get("simulate");
      const querySpeed = urlParams.get("speed");
      if (querySimulate) {
        const speedNum = querySpeed ? parseFloat(querySpeed) : undefined;
        setInitialSimulation({
          scenarioKey: querySimulate as SimulationScenarioKey,
          speedMultiplier: isNaN(speedNum as number) ? undefined : speedNum,
        });
      }
      if (queryTab === "skills") setActiveNavView("skills");
      else if (queryTab === "builds") setActiveNavView("builds");
      else if (queryTab === "projects") setActiveNavView("projects");
      else if (queryTab === "morning-report") setActiveNavView("morning-report");
      else if (queryTab === "settings") setActiveNavView("settings");
      else if (queryTab === "security") setViewMode("security");

      const saved =
        queryTheme || localStorage.getItem("theme") || localStorage.getItem("app-theme");
      const isDark = saved
        ? saved === "dark"
        : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

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
        const llmModels =
          data.services?.llm?.installed_models || data.services?.ollama?.installed_models;
        if (llmModels) {
          setInstalledModels(llmModels);
        }
        setSecurityPosture(data.security_posture);
      }

      try {
        const engRes = await fetch("/api/engine");
        if (engRes.ok) {
          const engData = await engRes.json();
          if (engData.model && typeof engData.model === "string") {
            setSelectedModel(engData.model);
          }
        }
      } catch {}
    } catch {
      // Best-effort status refresh
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchSkills();
    fetchDeployStatus();
    fetchProjects();
    const interval = setInterval(() => {
      fetchStatus();
      fetchSkills();
      fetchDeployStatus();
      fetchProjects();
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  const fetchProjects = async () => {
    try {
      const res = await fetch("/api/projects");
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
      }
    } catch {}
  };

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
        body: JSON.stringify({ action: "toggleKillSwitch", enabled: targetState }),
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
          action: "executeSelfDeploy",
          taskId,
          threadId: selectedThreadId,
          branchName: activeTask?.branchName || (activeTask as { branch?: string } | null)?.branch,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (activeTask && activeTask.taskId === taskId) {
          setActiveTask({
            ...activeTask,
            deploymentUrl:
              data.deploymentUrl ||
              (data.status === "deployed" || data.record?.status === "deployed" || data.success
                ? `http://${typeof window !== "undefined" ? window.location.hostname : "127.0.0.1"}:3001`
                : activeTask.deploymentUrl),
            deploymentNamespace:
              data.deploymentNamespace ||
              data.namespace ||
              activeTask.deploymentNamespace ||
              "local-agentic-sandbox",
          });
        }
        await fetchDeployStatus();
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
            const urlParams =
              typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
            const explicitThread = urlParams?.get("thread");
            const explicitView = (urlParams?.get("view") || urlParams?.get("tab")) as NavView;
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
            } else {
              const mostRecent = pickMostRecentlyActiveThread(data.threads);
              if (mostRecent) {
                setSelectedThreadId(mostRecent.id);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn("Failed to fetch threads:", err);
    } finally {
      setIsLoadingThreads(false);
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
        if (data.tasks) {
          setTasks(data.tasks);
        }
        if (data.activeTask) {
          if (
            !selectedThreadId &&
            (data.activeTask.status === "active" || data.activeTask.status === "planning")
          ) {
            setActiveTask(data.activeTask);
          }
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

  const fetchThreadsRef = useRef(fetchThreads);
  fetchThreadsRef.current = fetchThreads;
  const fetchActiveTaskRef = useRef(fetchActiveTask);
  fetchActiveTaskRef.current = fetchActiveTask;
  const selectedThreadIdRef = useRef(selectedThreadId);
  selectedThreadIdRef.current = selectedThreadId;

  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setIsSidebarOpen(false);
    }
    fetchThreadsRef.current(true);
    fetchActiveTaskRef.current();
    fetchMorningReport();
  }, []);

  useEffect(() => {
    if (activeNavView === "morning-report") {
      fetchMorningReport();
    }
  }, [activeNavView]);

  // Sync messages and task whenever selectedThreadId changes
  useEffect(() => {
    if (!selectedThreadId) {
      return;
    }

    if (skipThreadLoadRef.current === selectedThreadId) {
      skipThreadLoadRef.current = null;
      return;
    }

    const loadSelectedThread = async () => {
      try {
        const res = await fetch(`/api/threads/${selectedThreadId}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        });
        if (res.ok) {
          const data = await res.json();
          setObservedActiveTurn(data.activeTurn || null);
          if (data.thread) {
            setObservedThreadUpdatedAt(data.thread.updatedAt || null);
            setSelectedModel((prev) => data.thread.model || prev);
            setReasoningEffort((prev) => data.thread.reasoningEffort || prev);
            if (Array.isArray(data.thread.messages)) {
              setMessages(data.thread.messages);
            }
          } else {
            setObservedThreadUpdatedAt(null);
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

  // CHAT-8 / U2: live mid-turn visibility — poll the selected thread while its
  // latest assistant message is "streaming" or an activeTurn presence exists.
  // Resilient: re-arms in `finally` with bounded backoff on transient errors,
  // and pauses while hidden or outside the Sessions view.
  const latestAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");
  const isThreadLiveStreaming =
    isLiveStreamingMessage(latestAssistantMessage) || Boolean(observedActiveTurn);

  // PERF-P4 (#128): track when the last streamed chunk landed. SSE chunks arrive
  // through the shared `messages` state (ChatStream's setMessages), so the
  // existing state channel is the transport signal — no new stream-active state.
  const lastStreamChunkAtRef = useRef<number>(0);
  useEffect(() => {
    lastStreamChunkAtRef.current = Date.now();
  }, [messages]);

  useEffect(() => {
    if (!selectedThreadId || !isThreadLiveStreaming) return;
    if (activeNavView !== "sessions") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveErrors = 0;

    const scheduleNext = (delayMs: number) => {
      if (!active) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(pollLiveThread, delayMs);
    };

    const pollLiveThread = async () => {
      if (!active) return;
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      // PERF-P4 (#128): while the SSE stream is actively delivering chunks the
      // stream itself is the transport, so the full-thread poll is redundant
      // churn on the 1-vCPU event loop. Suppress it and re-arm once the stream
      // goes quiet; the effect tears down when the stream ends.
      const sseStreamDelivering = isSseStreamDelivering(lastStreamChunkAtRef.current, Date.now());
      if (!shouldPollLiveThread({ threadLiveStreaming: true, sseStreamDelivering })) {
        scheduleNext(STREAM_POLL_INTERVAL_MS);
        return;
      }
      let shouldContinue = true;
      let nextDelay = STREAM_POLL_INTERVAL_MS;
      try {
        const res = await fetch(`/api/threads/${selectedThreadId}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        });
        if (!active) return;
        if (!res.ok) {
          consecutiveErrors += 1;
          nextDelay = Math.min(
            STREAM_POLL_INTERVAL_MS * Math.pow(2, Math.min(consecutiveErrors, 4)),
            15_000
          );
          return;
        }
        consecutiveErrors = 0;
        const data = await res.json();
        if (!active) return;
        const nextActiveTurn: ActiveTurnInfo | null = data?.activeTurn || null;
        setObservedActiveTurn(nextActiveTurn);
        if (data?.thread) {
          if (typeof data.thread.updatedAt === "string") {
            setObservedThreadUpdatedAt(data.thread.updatedAt);
          }
          setThreads((prev) =>
            prev.map((t) =>
              t.id === selectedThreadId
                ? {
                    ...t,
                    updatedAt: data.thread.updatedAt || t.updatedAt,
                    status: data.thread.status || t.status,
                    liveness: data.thread.liveness ?? t.liveness,
                    hasStreamingMessage: Array.isArray(data.thread.messages)
                      ? data.thread.messages.some(
                          (m: ChatMessage) => m.role === "assistant" && m.status === "streaming"
                        )
                      : undefined,
                  }
                : t
            )
          );
        }
        if (Array.isArray(data?.thread?.messages)) {
          setMessages(data.thread.messages);
          const lastAssistant = [...data.thread.messages]
            .reverse()
            .find((m: ChatMessage) => m.role === "assistant");
          shouldContinue = isLiveStreamingMessage(lastAssistant) || Boolean(nextActiveTurn);
        } else {
          shouldContinue = Boolean(nextActiveTurn);
        }
      } catch (err) {
        consecutiveErrors += 1;
        nextDelay = Math.min(
          STREAM_POLL_INTERVAL_MS * Math.pow(2, Math.min(consecutiveErrors, 4)),
          15_000
        );
        console.warn("Live thread poll notice:", err);
      } finally {
        if (active && shouldContinue) {
          scheduleNext(nextDelay);
        }
      }
    };

    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && !document.hidden && active) {
        scheduleNext(0);
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    scheduleNext(STREAM_POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, [selectedThreadId, isThreadLiveStreaming, activeNavView]);

  // Real-time 2s polling while a task is running (Live run block updates)
  const activeTaskId = activeTask?.taskId;
  const activeTaskStatus = activeTask?.status;
  useEffect(() => {
    if (!activeTaskId || (activeTaskStatus !== "active" && activeTaskStatus !== "planning")) return;
    if (activeTaskId.startsWith("sim-")) return;

    const pollTask = async () => {
      try {
        const res = await fetch(`/api/tasks?taskId=${activeTaskId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.task) {
            setActiveTask(data.task);
            if (data.task.status !== "active") {
              fetchThreadsRef.current(false);
              const currentThreadId = selectedThreadIdRef.current;
              if (currentThreadId) {
                fetch(`/api/threads/${currentThreadId}`)
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
  }, [activeTaskId, activeTaskStatus]);

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
          reasoningEffort,
        }),
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
            window.history.pushState(
              { threadId: data.thread.id },
              "",
              `?thread=${encodeURIComponent(data.thread.id)}`
            );
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
        setSelectedThreadId(null);
        setMessages([]);
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
    attachments?: unknown[],
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
          autoDeployOnGreen: Boolean(autoDeployOnGreen),
        }),
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
          try {
            window.history.pushState(
              { threadId: data.thread.id },
              "",
              `?thread=${encodeURIComponent(data.thread.id)}`
            );
          } catch {}
        }
        if (data.task) {
          setActiveTask(data.task);
        }
      } else {
        const errData = await res
          .json()
          .catch(() => ({ error: `Failed to launch task: HTTP ${res.status}` }));
        const msg = errData.error || `Failed to launch task: HTTP ${res.status}`;
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}-err`,
            role: "assistant",
            content: `Error launching task: ${msg}`,
            timestamp: new Date().toISOString(),
          },
        ]);
        throw new Error(msg);
      }
    } catch (err) {
      console.error("Failed to launch engineering task:", err);
    }
  };

  // Stop Run action: stops workers, releases VRAM, honestly marks status as stopped
  const handleStopRun = async () => {
    if (!selectedThreadId && !activeTask) return;
    try {
      if (activeTask?.taskId?.startsWith("sim-")) {
        setActiveTask((prev) => (prev ? { ...prev, status: "cancelled" } : null));
        return;
      }
      if (selectedThreadId) {
        await fetch(`/api/threads/${selectedThreadId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" }),
        });
      }
      if (activeTask) {
        await fetch(`/api/tasks?taskId=${activeTask.taskId}`, { method: "DELETE" });
        setActiveTask((prev) => (prev ? { ...prev, status: "cancelled" } : null));
      }
      fetchThreads(false);
    } catch (err) {
      console.error("Failed to stop run:", err);
    }
  };

  const handleNavigate = (view: NavView) => {
    setActiveNavView(view);
    setIsDrawerOpen(false);
    if (view === "sessions") {
      const isMobile = typeof window !== "undefined" && window.innerWidth < 640;
      if (isMobile) {
        // Navigating to Sessions on mobile must DISMISS the sidebar slide-over
        // and its backdrop (mobile-sidebar-open mounts a fixed inset-0 z-40
        // backdrop that would cover the chat and block mid-run controls like
        // the stop button). The destination view is the chat, not the thread list.
        setIsSidebarOpen(false);
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
          reasoningEffort,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.thread) {
          skipThreadLoadRef.current = data.thread.id;
          setActiveTask(null);
          setThreads((prev) => [data.thread, ...prev]);
          setSelectedThreadId(data.thread.id);
          try {
            window.history.pushState(
              { threadId: data.thread.id },
              "",
              `?thread=${encodeURIComponent(data.thread.id)}`
            );
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

  const handleModelChange = (m: string) => {
    setSelectedModel(m);
    try {
      if (typeof window !== "undefined") {
        localStorage.setItem("preferred_model", m);
      }
    } catch {}
    if (selectedThreadId) {
      fetch(`/api/threads/${selectedThreadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setModel", model: m, reasoningEffort }),
      }).catch(() => {});
    }
  };

  const handleReasoningChange = (e: "low" | "medium" | "xhigh") => {
    setReasoningEffort(e);
    try {
      if (typeof window !== "undefined") {
        localStorage.setItem("las.reasoningEffort", e);
      }
    } catch {}
    if (selectedThreadId) {
      fetch(`/api/threads/${selectedThreadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setModel",
          model: selectedModel,
          reasoningEffort: e,
        }),
      }).catch(() => {});
    }
  };

  const handleThreadUpdated = (updatedThread: Partial<Thread> & { id: string }) => {
    setThreads((prev) =>
      prev.map((t) => (t.id === updatedThread.id ? { ...t, ...updatedThread } : t))
    );
  };

  const handleAskAssistantFromBoard = (draftPrompt: string) => {
    setDraftComposerPrompt(draftPrompt);
    setActiveNavView("sessions");
    setViewMode("unified");
    void handleNewThread();
  };

  const handleRegisterProject: React.ComponentProps<
    typeof ProjectsView
  >["onRegisterProject"] = async (data) => {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Failed to register project");
    }
    await fetchProjects();
  };

  const handleToggleAllowlist: React.ComponentProps<
    typeof ProjectsView
  >["onToggleAllowlist"] = async (id, allowlisted) => {
    await fetch("/api/projects", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, allowlisted }),
    });
    await fetchProjects();
  };

  const handleDeleteProject: React.ComponentProps<typeof ProjectsView>["onDeleteProject"] = async (
    id
  ) => {
    const res = await fetch(`/api/projects?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      if (selectedProjectId === id) {
        setSelectedProjectId(null);
      }
      await fetchProjects();
    }
  };

  return (
    <ViewShell
      activeNavView={activeNavView}
      viewMode={viewMode}
      isDrawerOpen={isDrawerOpen}
      isSidebarOpen={isSidebarOpen}
      isWorkspaceOpen={isWorkspaceOpen}
      isExplorerOpen={isExplorerOpen}
      isModelSheetOpen={isModelSheetOpen}
      workspaceTab={workspaceTab}
      selectedWorkspaceFile={selectedWorkspaceFile}
      onSetActiveNavView={setActiveNavView}
      onSetViewMode={setViewMode}
      onSetDrawerOpen={setIsDrawerOpen}
      onSetSidebarOpen={setIsSidebarOpen}
      onSetWorkspaceOpen={setIsWorkspaceOpen}
      onSetExplorerOpen={setIsExplorerOpen}
      onSetModelSheetOpen={setIsModelSheetOpen}
      onSetWorkspaceTab={setWorkspaceTab}
      onSetSelectedWorkspaceFile={setSelectedWorkspaceFile}
      onNavigate={handleNavigate}
      onPreviewWorkspaceFile={handlePreviewWorkspaceFile}
      threads={threads}
      isLoadingThreads={isLoadingThreads}
      selectedThreadId={selectedThreadId}
      currentThread={currentThread}
      activeTurn={observedActiveTurn}
      threadUpdatedAt={observedThreadUpdatedAt || currentThread?.updatedAt || null}
      messages={messages}
      setMessages={setMessages}
      draftComposerPrompt={draftComposerPrompt}
      onClearDraftPrompt={() => setDraftComposerPrompt(null)}
      traces={traces}
      onTracesUpdate={handleTracesUpdate}
      initialSimulation={initialSimulation}
      onSelectThread={handleSelectThread}
      onBackToList={handleBackToList}
      onNewThread={handleNewThread}
      onDeleteThread={handleDeleteThread}
      onEnsureThread={handleEnsureThread}
      onThreadUpdated={handleThreadUpdated}
      agentMode={agentMode}
      selectedModel={selectedModel}
      reasoningEffort={reasoningEffort}
      installedModels={installedModels}
      securityPosture={securityPosture}
      onModelChange={handleModelChange}
      onReasoningChange={handleReasoningChange}
      activeTask={activeTask}
      tasks={tasks}
      plannedFiles={plannedFiles}
      onSetActiveTask={setActiveTask}
      onLaunchTask={handleLaunchTask}
      onStopRun={handleStopRun}
      onDeployRun={handleDeployRun}
      boardItems={boardItems}
      boardControlState={boardControlState}
      boardStopAtBoundary={boardStopAtBoundary}
      isBoardControlPending={isBoardControlPending}
      onBoardItemCreated={(item) => setBoardItems((prev) => [...prev, item])}
      onBoardItemUpdated={(item) =>
        setBoardItems((prev) => prev.map((b) => (b.id === item.id ? item : b)))
      }
      onBoardItemDeleted={(id) => setBoardItems((prev) => prev.filter((b) => b.id !== id))}
      onBoardControlAction={handleBoardControlAction}
      onAskAssistantFromBoard={handleAskAssistantFromBoard}
      projects={projects}
      selectedProjectId={selectedProjectId}
      onSelectProject={setSelectedProjectId}
      onRegisterProject={handleRegisterProject}
      onToggleAllowlist={handleToggleAllowlist}
      onDeleteProject={handleDeleteProject}
      pendingSkillsCount={pendingSkillsCount}
      selfDeployEnabled={selfDeployEnabled}
      onToggleSelfDeploy={handleToggleSelfDeploy}
      deployHistory={deployHistory}
      morningReport={morningReport}
      overnightReport={overnightReport}
    />
  );
}
