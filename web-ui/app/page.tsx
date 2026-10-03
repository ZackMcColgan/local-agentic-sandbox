"use client";

import React, { useEffect, useState } from "react";
import { ChatStream, ChatMessage } from "@/components/ChatStream";
import { ThreadsSidebar } from "@/components/ThreadsSidebar";
import { ModelBottomSheet } from "@/components/ModelBottomSheet";
import { ExecutionTrace, ExecutionTraceItem } from "@/components/ExecutionTrace";
import { TraceWaterfall } from "@/components/TraceWaterfall";
import { SandboxGauge } from "@/components/SandboxGauge";
import { MorningReportView } from "@/components/MorningReportView";
import { MorningReport } from "@/lib/subagents/morningReport";
import { TaskManifest, ToolchainType } from "@/lib/subagents/types";
import { Thread } from "@/lib/threads/threadStore";
import {
  Layers,
  ShieldCheck,
  Globe,
  Cpu,
  ArrowLeft,
  Hammer,
  Shield,
  Activity
} from "lucide-react";
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

  // Model & telemetry state
  const [traces, setTraces] = useState<ExecutionTraceItem[]>([]);
  const [status, setStatus] = useState({
    ollama: "INITIALIZING",
    mcp: "INITIALIZING",
    airGapped: true
  });
  const [agentMode, setAgentMode] = useState<AgentMode>(DEFAULT_AGENT_MODE);
  const [selectedModel, setSelectedModel] = useState<string>("qwen3.8:27b-q3_k_m");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "xhigh">("medium");
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ModelProfile[]>(PRESET_MODEL_PROFILES);
  const [securityPosture, setSecurityPosture] = useState<any>(undefined);
  const [isModelSheetOpen, setIsModelSheetOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"unified" | "security">("unified");

  // Fallback messages state if no thread is loaded yet
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    getInitialWelcomeMessage("qwen3.8:27b-q3_k_m")
  ]);

  // Synchronous-like hydration for theme support
  useEffect(() => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const queryTheme = urlParams.get("theme");
      const saved = queryTheme || localStorage.getItem("app-theme");
      const isDark = saved === "dark";

      if (isDark) {
        document.documentElement.classList.add("dark");
        document.documentElement.classList.remove("light");
        document.documentElement.setAttribute("data-theme", "dark");
        document.documentElement.style.colorScheme = "dark";
        document.body.classList.add("dark");
        document.body.classList.remove("light");
        document.body.setAttribute("data-theme", "dark");
      } else {
        document.documentElement.classList.remove("dark");
        document.documentElement.classList.add("light");
        document.documentElement.setAttribute("data-theme", "light");
        document.documentElement.style.colorScheme = "light";
        document.body.classList.remove("dark");
        document.body.classList.add("light");
        document.body.setAttribute("data-theme", "light");
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
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, []);

  // Load threads from server on initial load (Durable Threads Item 1)
  const fetchThreads = async (selectLatest: boolean = true) => {
    try {
      const res = await fetch("/api/threads");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.threads)) {
          setThreads(data.threads);
          if (selectLatest && data.threads.length > 0 && selectedThreadId === null) {
            // Find active thread or pick first
            const active = data.threads.find((t: Thread) => t.status === "active") || data.threads[0];
            setSelectedThreadId(active.id);
          }
        }
      }
    } catch (err) {
      console.warn("Failed to fetch threads:", err);
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
    fetchThreads(true);
    fetchActiveTask();
  }, []);

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

  // Actions
  const handleSelectThread = (threadId: string) => {
    setSelectedThreadId(threadId);
    setViewMode("unified");
  };

  const handleNewThread = async () => {
    try {
      const res = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "New task",
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
        const remaining = threads.filter((t) => t.id !== threadId);
        setSelectedThreadId(remaining.length > 0 ? remaining[0].id : null);
        if (remaining.length === 0) setMessages([]);
      }
    } catch (err) {
      console.error("Failed to delete thread:", err);
    }
  };

  // Launch a multi-milestone builder task inside the thread
  const handleLaunchTask = async (goal: string, attachments?: any[]) => {
    try {
      const res = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "launchTask",
          goal,
          toolchain: "node:22",
          threadId: selectedThreadId,
          attachments,
          model: selectedModel,
          reasoningEffort
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

  const currentThread = threads.find((t) => t.id === selectedThreadId) || null;

  return (
    <div className="h-[100dvh] flex flex-col bg-white dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 antialiased overflow-hidden font-sans">
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

      {/* Main Unified View: Sidebar + Thread View */}
      {viewMode === "security" ? (
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
              <span>Back to Threads</span>
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
      ) : (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Threads Sidebar: On desktop visible side-by-side; on mobile visible if no thread selected */}
          <div
            className={`${
              selectedThreadId !== null ? "hidden sm:flex" : "flex"
            } w-full sm:w-80 md:w-84 shrink-0 h-full`}
          >
            <ThreadsSidebar
              threads={threads}
              selectedThreadId={selectedThreadId}
              onSelectThread={handleSelectThread}
              onNewThread={handleNewThread}
              onDeleteThread={handleDeleteThread}
            />
          </div>

          {/* Unified Thread View: Chat + Inline Live Run Blocks */}
          <div
            className={`${
              selectedThreadId === null ? "hidden sm:flex" : "flex"
            } flex-1 min-h-0 flex-col h-full overflow-hidden bg-white dark:bg-zinc-950`}
          >
            <ChatStream
              messages={messages}
              setMessages={setMessages}
              onTracesUpdate={handleTracesUpdate}
              activeModel={selectedModel}
              agentMode={agentMode}
              reasoningEffort={reasoningEffort}
              threadId={currentThread?.id}
              threadTitle={currentThread?.title || "New task"}
              threadStatus={currentThread?.status}
              activeTask={activeTask}
              onStopTask={handleStopRun}
              onBackToList={() => setSelectedThreadId(null)}
              onOpenModelSheet={() => setIsModelSheetOpen(true)}
              onLaunchTask={handleLaunchTask}
              onNewThread={handleNewThread}
              onViewSecurityTelemetry={() => setViewMode("security")}
            />
          </div>
        </div>
      )}
    </div>
  );
}
