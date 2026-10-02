"use client";

import React, { useEffect, useState } from "react";
import { Navbar } from "@/components/Navbar";
import { SandboxGauge } from "@/components/SandboxGauge";
import { ChatStream, ChatMessage } from "@/components/ChatStream";
import { ExecutionTrace, ExecutionTraceItem } from "@/components/ExecutionTrace";
import { TraceWaterfall } from "@/components/TraceWaterfall";
import { WorkerTiles, WorkerTileItem } from "@/components/WorkerTiles";
import { MorningReportView } from "@/components/MorningReportView";
import { MorningReport } from "@/lib/subagents/morningReport";
import { TaskManifest, ToolchainType } from "@/lib/subagents/types";
import {
  Layers,
  ShieldCheck,
  Globe,
  Cpu,
  ArrowLeft,
  RefreshCw,
  Hammer,
  Play,
  StopCircle,
  Clock,
  CheckCircle2,
  GitBranch,
  GitCommit,
  Terminal,
  AlertTriangle,
  FileText
} from "lucide-react";
import { PRESET_MODEL_PROFILES, ModelProfile, AgentMode, DEFAULT_AGENT_MODE } from "@/config/models";
import {
  getInitialWelcomeMessage,
  loadChatHistory,
  saveChatHistory
} from "@/lib/chatHistory";

export default function Home() {
  const [traces, setTraces] = useState<ExecutionTraceItem[]>([]);
  const [status, setStatus] = useState({
    ollama: "INITIALIZING",
    mcp: "INITIALIZING",
    airGapped: true
  });
  const [agentMode, setAgentMode] = useState<AgentMode>(DEFAULT_AGENT_MODE);
  const [activeBranch, setActiveBranch] = useState<string>("feat/v2.5-overnight");
  const [selectedModel, setSelectedModel] = useState<string>("gemma4:e4b");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "xhigh">("low");
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ModelProfile[]>(PRESET_MODEL_PROFILES);
  const [securityPosture, setSecurityPosture] = useState<any>(undefined);
  const [activeTab, setActiveTab] = useState<"chat" | "overnight" | "security">("chat");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    getInitialWelcomeMessage(selectedModel)
  ]);

  // Overnight Builder States
  const [overnightGoal, setOvernightGoal] = useState<string>(
    "Build a draw.io architecture diagram of this repo's current state, README-ready"
  );
  const [selectedToolchain, setSelectedToolchain] = useState<ToolchainType>("node:22");
  const [isSubmittingTask, setIsSubmittingTask] = useState<boolean>(false);
  const [isCancellingTask, setIsCancellingTask] = useState<boolean>(false);
  const [activeTask, setActiveTask] = useState<TaskManifest | null>(null);
  const [morningReport, setMorningReport] = useState<MorningReport | null>(null);
  const [workerTiles, setWorkerTiles] = useState<WorkerTileItem[]>([]);

  const applyTheme = (newTheme: "dark" | "light") => {
    try {
      localStorage.setItem("app-theme", newTheme);
      const isDark = newTheme === "dark";
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
  };

  // Load theme & agent mode preferences on mount
  useEffect(() => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const queryTheme = urlParams.get("theme") as "dark" | "light" | null;
      const savedTheme = queryTheme || (localStorage.getItem("app-theme") as "dark" | "light" | null) || "dark";
      setTheme(savedTheme);
      applyTheme(savedTheme);

      const queryTab = urlParams.get("tab") as "chat" | "overnight" | "security" | null;
      if (queryTab) {
        setActiveTab(queryTab);
      }

      const savedMode = (localStorage.getItem("local_agent_mode") as AgentMode) || DEFAULT_AGENT_MODE;
      setAgentMode(savedMode);
      if (savedMode === "flash") {
        setSelectedModel("gemma4:e4b");
      } else if (savedMode === "pro") {
        setSelectedModel("qwen3.8:27b-q3_k_m");
      }

      // Rehydrate chat history from localStorage
      const savedHistory = loadChatHistory(savedMode === "pro" ? "qwen3.8:27b-q3_k_m" : "gemma4:e4b");
      setMessages(savedHistory);
    } catch {
      applyTheme("dark");
    }
  }, []);

  // Persist chat history to localStorage on change
  useEffect(() => {
    saveChatHistory(messages);
  }, [messages]);

  const handleAgentModeChange = (newMode: AgentMode) => {
    setAgentMode(newMode);
    try {
      localStorage.setItem("local_agent_mode", newMode);
    } catch {}
    if (newMode === "flash") {
      setSelectedModel("gemma4:e4b");
    } else if (newMode === "pro") {
      setSelectedModel("qwen3.8:27b-q3_k_m");
    } else {
      setSelectedModel("gemma4:e4b");
    }
  };

  const handleThemeChange = (newTheme: "dark" | "light") => {
    setTheme(newTheme);
    applyTheme(newTheme);
  };

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
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  // Rehydrate active task from API on page mount (preserves active run across refresh)
  useEffect(() => {
    const fetchActiveTask = async () => {
      try {
        const res = await fetch("/api/tasks?active=true");
        if (res.ok) {
          const data = await res.json();
          if (data.activeTask) {
            setActiveTask(data.activeTask);
            if (data.activeTask.status === "active") {
              const currentM = data.activeTask.milestones[data.activeTask.currentMilestoneIndex];
              setWorkerTiles([
                {
                  role: "Builder",
                  status: "active",
                  detail: `Building ${currentM ? currentM.title : "milestone"}`
                }
              ]);
            } else if (data.activeTask.status === "completed" || data.activeTask.status === "parked") {
              const detailRes = await fetch(`/api/tasks?taskId=${data.activeTask.taskId}`);
              if (detailRes.ok) {
                const detailData = await detailRes.json();
                if (detailData.morningReport) {
                  setMorningReport(detailData.morningReport);
                  setWorkerTiles([]);
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn("Could not rehydrate active task on mount:", err);
      }
    };

    fetchActiveTask();
  }, []);

  // Poll task status if active
  useEffect(() => {
    if (!activeTask || activeTask.status !== "active") return;

    const pollTask = async () => {
      try {
        const res = await fetch(`/api/tasks?taskId=${activeTask.taskId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.task) {
            setActiveTask(data.task);
            if (data.task.status === "active") {
              const currentM = data.task.milestones[data.task.currentMilestoneIndex];
              setWorkerTiles([
                {
                  role: "Builder",
                  status: "active",
                  detail: `Building ${currentM ? currentM.title : "milestone"}`
                }
              ]);
            }
          }
          if (data.morningReport) {
            setMorningReport(data.morningReport);
            setWorkerTiles([]);
          }
        }
      } catch (err) {
        console.warn("Task poll notice:", err);
      }
    };

    const interval = setInterval(pollTask, 3000);
    return () => clearInterval(interval);
  }, [activeTask?.taskId, activeTask?.status]);

  const handleTracesUpdate = (newTraces: ExecutionTraceItem[]) => {
    setTraces((prev) => [...newTraces, ...prev]);
  };

  // Launch Overnight Task
  const handleStartOvernightTask = async () => {
    if (!overnightGoal.trim()) return;
    setIsSubmittingTask(true);
    setMorningReport(null);

    // Initial worker status
    setWorkerTiles([
      { role: "Explorer", status: "active", detail: "Cataloging system boundaries & docker-compose.yml" }
    ]);

    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: overnightGoal,
          toolchain: selectedToolchain
        })
      });

      if (res.ok) {
        const data = await res.json();
        setActiveTask(data.manifest);
      }
    } catch (err: any) {
      console.error("Failed to start overnight task:", err);
    } finally {
      setIsSubmittingTask(false);
    }
  };

  // Cancel Task via Kill Switch
  const handleCancelTask = async () => {
    if (!activeTask) return;
    setIsCancellingTask(true);
    try {
      const res = await fetch(`/api/tasks?taskId=${activeTask.taskId}`, {
        method: "DELETE"
      });
      if (res.ok) {
        setActiveTask((prev) => (prev ? { ...prev, status: "cancelled" } : null));
        setWorkerTiles([]);
      }
    } finally {
      setIsCancellingTask(false);
    }
  };

  // Handle Ambiguity Flag Revert
  const handleRevertFlag = async (flagId: string) => {
    if (!activeTask) return;
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "revert",
        taskId: activeTask.taskId,
        flagId
      })
    });
  };

  // Handle Ambiguity Flag Guidance Adjust
  const handleAdjustFlag = async (flagId: string, instruction: string) => {
    if (!activeTask) return;
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "adjust",
        taskId: activeTask.taskId,
        flagId,
        instruction
      })
    });
  };

  return (
    <div
      data-theme={theme}
      className={`h-[100dvh] flex flex-col overflow-hidden ${
        theme === "dark" ? "dark bg-zinc-950 text-zinc-100" : "bg-white text-slate-900"
      } antialiased selection:bg-emerald-500/20 selection:text-emerald-700 dark:selection:text-emerald-300 transition-colors`}
    >
      <Navbar
        status={status}
        agentMode={agentMode}
        onAgentModeChange={handleAgentModeChange}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        reasoningEffort={reasoningEffort}
        onReasoningChange={setReasoningEffort}
        installedModels={installedModels}
        profiles={profiles}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        traceCount={traces.length}
        theme={theme}
        onThemeChange={handleThemeChange}
        activeBranch={activeBranch}
      />

      <main className="flex-1 min-h-0 flex flex-col max-w-5xl w-full mx-auto p-0 sm:p-4 lg:p-6 overflow-hidden">
        {activeTab === "chat" ? (
          <div className="flex-1 min-h-0 flex flex-col">
            {/* Direct Full-Screen Chat View */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <ChatStream
                messages={messages}
                setMessages={setMessages}
                onTracesUpdate={handleTracesUpdate}
                activeModel={selectedModel}
                agentMode={agentMode}
                reasoningEffort={reasoningEffort}
                onViewSecurityTelemetry={() => setActiveTab("security")}
                activeBranch={activeBranch}
              />
            </div>
          </div>
        ) : activeTab === "overnight" ? (
          <div className="flex-1 min-h-0 overflow-y-auto space-y-4 sm:space-y-6 p-3 sm:p-0 pb-12 animate-in fade-in duration-200">
            {/* Top Bar for Overnight Builder */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-zinc-100 tracking-tight flex items-center gap-2">
                  <Hammer className="h-5 w-5 text-indigo-500" />
                  <span>Mode A: Overnight Autonomous Builder</span>
                </h2>
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  Plans, builds, tests, commits, and self-heals across checkpoints. Zero stalls on ambiguity.
                </p>
              </div>

              {activeTask && (
                <button
                  type="button"
                  onClick={handleCancelTask}
                  disabled={isCancellingTask || activeTask.status === "cancelled"}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/80 dark:hover:bg-rose-900 border border-rose-200 dark:border-rose-800 text-xs font-semibold text-rose-700 dark:text-rose-300 transition-colors shadow-sm disabled:opacity-50"
                  title="Kill switch: Immediately abort all workers and release VRAM within 30s"
                >
                  <StopCircle className="h-4 w-4 text-rose-600 dark:text-rose-400" />
                  <span>{isCancellingTask ? "Halting..." : "Kill Switch"}</span>
                </button>
              )}
            </div>

            {/* Task Submission Card */}
            <div className="p-4 sm:p-5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm transition-colors">
              <label className="block text-xs font-bold text-slate-800 dark:text-zinc-200 mb-2">
                Overnight Task Prompt (One Sentence)
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={overnightGoal}
                  onChange={(e) => setOvernightGoal(e.target.value)}
                  placeholder="e.g. Build a draw.io architecture diagram of this repo's current state, README-ready"
                  disabled={isSubmittingTask || (activeTask !== null && activeTask.status === "active")}
                  className="flex-1 px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 text-xs sm:text-sm text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                />

                <select
                  value={selectedToolchain}
                  onChange={(e) => setSelectedToolchain(e.target.value as any)}
                  disabled={isSubmittingTask || (activeTask !== null && activeTask.status === "active")}
                  className="px-3 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 text-xs font-mono text-slate-800 dark:text-zinc-200 focus:outline-none"
                >
                  <option value="node:22">Toolchain: Node.js 22</option>
                  <option value="python:3.12">Toolchain: Python 3.12</option>
                  <option value="go">Toolchain: Go 1.23</option>
                  <option value="rust">Toolchain: Rust 1.80</option>
                </select>

                <button
                  type="button"
                  onClick={handleStartOvernightTask}
                  disabled={isSubmittingTask || !overnightGoal.trim() || (activeTask !== null && activeTask.status === "active")}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs sm:text-sm transition-all shadow-md shadow-indigo-600/20 disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {isSubmittingTask ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  <span>Launch Builder</span>
                </button>
              </div>
            </div>

            {/* Worker Status Tiles (Docked Minimal Cards, Auto-Collapsing, ZERO Pills) */}
            <WorkerTiles workers={workerTiles} />

            {/* If Morning Report is available: render MorningReportView */}
            {morningReport ? (
              <MorningReportView
                report={morningReport}
                onRevertFlag={handleRevertFlag}
                onAdjustFlag={handleAdjustFlag}
              />
            ) : activeTask ? (
              <div className="space-y-4">
                {/* Active Run Header Card */}
                <div className="p-4 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                        {activeTask.status}
                      </span>
                      <span className="text-xs font-mono text-slate-500 dark:text-zinc-400">
                        {activeTask.taskId}
                      </span>
                    </div>
                    <div className="mt-1 text-sm font-bold text-slate-900 dark:text-zinc-100">
                      {activeTask.goal}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 text-xs font-mono text-slate-600 dark:text-zinc-400 shrink-0">
                    <div className="flex items-center gap-1">
                      <GitBranch className="h-3.5 w-3.5 text-indigo-500" />
                      <span>{activeTask.branch}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5 text-emerald-500" />
                      <span>{new Date(activeTask.startedAt).toLocaleTimeString()}</span>
                    </div>
                  </div>
                </div>

                {/* Milestone Progress */}
                <div className="space-y-2">
                  <h3 className="text-xs font-bold text-slate-800 dark:text-zinc-200 uppercase tracking-wider">
                    SPEC.md Milestones ({activeTask.milestones.length})
                  </h3>
                  {activeTask.milestones.map((m) => (
                    <div
                      key={m.id}
                      className="p-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-xs font-mono text-slate-900 dark:text-zinc-100">
                            [{m.id}]
                          </span>
                          <span className="text-xs font-medium text-slate-800 dark:text-zinc-200 truncate">
                            {m.title}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-slate-500 dark:text-zinc-400 truncate">
                          {m.description}
                        </p>
                      </div>

                      <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 shrink-0">
                        {m.status}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Live Run Journal Tail */}
                <div className="space-y-2">
                  <h3 className="text-xs font-bold text-slate-800 dark:text-zinc-200 uppercase tracking-wider flex items-center gap-1.5">
                    <Terminal className="h-3.5 w-3.5 text-slate-500" />
                    <span>Run Journal Tail</span>
                  </h3>
                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300 max-h-48 overflow-y-auto space-y-1">
                    {activeTask.journal.map((j, idx) => (
                      <div key={idx} className="flex items-start gap-2">
                        <span className="text-slate-500 shrink-0">
                          {new Date(j.timestamp).toLocaleTimeString()}
                        </span>
                        <span className="text-emerald-400 font-semibold shrink-0">
                          [{j.role}]
                        </span>
                        <span className="text-slate-200">{j.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto space-y-6 p-3 sm:p-0 pb-12 animate-in fade-in duration-200">
            {/* Top Bar for Security Tab */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-zinc-100 tracking-tight">
                  System Architecture & Security Telemetry
                </h2>
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  Container isolation boundaries, zero-egress policies, and MCP hardware telemetry.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setActiveTab("chat")}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white dark:bg-zinc-900 hover:bg-slate-100 dark:hover:bg-zinc-800 border border-slate-200 dark:border-zinc-800 text-xs font-medium text-slate-700 dark:text-zinc-200 transition-colors shadow-sm"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Back to Chat</span>
              </button>
            </div>

            {/* Quick Status Chips */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm flex items-center gap-3">
                <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  <ShieldCheck className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase text-slate-400 dark:text-zinc-400">Sandbox Isolation</div>
                  <div className="text-xs font-semibold text-slate-800 dark:text-zinc-100">Air-Gapped (UID 10001)</div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm flex items-center gap-3">
                <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/20">
                  <Globe className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase text-slate-400 dark:text-zinc-400">Scraping Boundary</div>
                  <div className="text-xs font-semibold text-slate-800 dark:text-zinc-100">SSRF Filtered (UID 10002)</div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm flex items-center gap-3">
                <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
                  <Cpu className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase text-slate-400 dark:text-zinc-400">Hardware Engine</div>
                  <div className="text-xs font-semibold text-slate-800 dark:text-zinc-100">AMD Radeon RX 9070 XT</div>
                </div>
              </div>
            </div>

            {/* Security Governance Header / Gauge */}
            <section>
              <SandboxGauge securityPosture={securityPosture} />
            </section>

            {/* Architecture Card */}
            <section className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 sm:p-5 space-y-3 shadow-sm">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-zinc-100">
                <Layers className="h-4 w-4 text-cyan-500 dark:text-cyan-400" />
                <span>Zero-Trust 3-Tier Multi-Agent Topology</span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed font-sans">
                Autonomous orchestrator running on{" "}
                <code className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-mono font-medium border border-emerald-500/20">
                  {selectedModel}
                </code>{" "}
                (<span className="text-amber-600 dark:text-amber-400 font-mono capitalize">{reasoningEffort}</span> effort),
                dispatches tools over{" "}
                <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/10 text-sky-600 dark:text-[#38bdf8] font-mono border border-sky-400/20 font-medium">
                  Model Context Protocol SSE
                </code>. Air-gapped code executes inside a zero-trust Linux container sandbox with{" "}
                <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/10 text-sky-600 dark:text-[#38bdf8] font-mono border border-sky-400/20 font-medium">
                  cap_drop: ALL
                </code>{" "}
                and a{" "}
                <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/10 text-sky-600 dark:text-[#38bdf8] font-mono border border-sky-400/20 font-medium">
                  read_only rootfs
                </code>. Web search and documentation scraping run isolated in an egress-only container with strict SSRF filtering.
              </p>
              <div className="pt-2 flex flex-wrap items-center gap-2 text-[10px] font-mono text-slate-500 dark:text-zinc-400 border-t border-slate-100 dark:border-zinc-800">
                <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300">Network: ai-mesh (air-gapped)</span>
                <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300">Sandbox UID: 10001</span>
                <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300">Browser UID: 10002</span>
                <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300">Attestation: SLSA Level 3</span>
              </div>
            </section>

            {/* OpenTelemetry Distributed Tracing Waterfall */}
            <section>
              <TraceWaterfall />
            </section>

            {/* Execution Trace Viewer */}
            <section>
              <ExecutionTrace traces={traces} />
            </section>

          </div>
        )}
      </main>
    </div>
  );
}
