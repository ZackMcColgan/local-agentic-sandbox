"use client";

import React, { useEffect, useState } from "react";
import { Navbar } from "@/components/Navbar";
import { SandboxGauge } from "@/components/SandboxGauge";
import { ChatStream } from "@/components/ChatStream";
import { ExecutionTrace, ExecutionTraceItem } from "@/components/ExecutionTrace";
import { Layers, ShieldCheck, Globe, Cpu, ArrowLeft, RefreshCw } from "lucide-react";
import { PRESET_MODEL_PROFILES, ModelProfile } from "@/config/models";

export default function Home() {
  const [traces, setTraces] = useState<ExecutionTraceItem[]>([]);
  const [status, setStatus] = useState({
    ollama: "INITIALIZING",
    mcp: "INITIALIZING",
    airGapped: true
  });
  const [selectedModel, setSelectedModel] = useState<string>("gemma4:e4b");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "xhigh">("low");
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ModelProfile[]>(PRESET_MODEL_PROFILES);
  const [securityPosture, setSecurityPosture] = useState<any>(undefined);
  const [activeTab, setActiveTab] = useState<"chat" | "security">("chat");
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  // Load theme preference on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("app-theme") as "dark" | "light" | null;
      if (saved) {
        setTheme(saved);
        if (saved === "dark") {
          document.documentElement.classList.add("dark");
        } else {
          document.documentElement.classList.remove("dark");
        }
      } else {
        document.documentElement.classList.add("dark");
      }
    } catch {}
  }, []);

  const handleThemeChange = (newTheme: "dark" | "light") => {
    setTheme(newTheme);
    try {
      localStorage.setItem("app-theme", newTheme);
      if (newTheme === "dark") {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
    } catch {}
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

  const handleTracesUpdate = (newTraces: ExecutionTraceItem[]) => {
    setTraces((prev) => [...newTraces, ...prev]);
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 antialiased selection:bg-emerald-500/20 selection:text-emerald-700 dark:selection:text-emerald-300 transition-colors">
      <Navbar
        status={status}
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
      />

      <main className="flex-1 max-w-5xl w-full mx-auto p-2 sm:p-4 lg:p-6 flex flex-col">
        {activeTab === "chat" ? (
          <div className="flex-1 flex flex-col h-[calc(100dvh-4.2rem)] sm:h-[calc(100dvh-5.5rem)]">
            {/* Direct Full-Screen Chat View (No Cluttering Strips) */}
            <div className="flex-1 overflow-hidden">
              <ChatStream
                onTracesUpdate={handleTracesUpdate}
                activeModel={selectedModel}
                reasoningEffort={reasoningEffort}
                onViewSecurityTelemetry={() => setActiveTab("security")}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-6 pb-12 animate-in fade-in duration-200">
            
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
                  <div className="text-[10px] font-mono uppercase text-slate-400 dark:text-zinc-400">Egress Scraper</div>
                  <div className="text-xs font-semibold text-slate-800 dark:text-zinc-100">SSRF Blocklist Enforced</div>
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
              <p className="text-xs text-slate-600 dark:text-zinc-400 leading-relaxed">
                Autonomous orchestrator running on{" "}
                <span className="text-emerald-600 dark:text-emerald-400 font-mono font-medium">{selectedModel}</span> (
                <span className="text-amber-600 dark:text-amber-400 font-mono capitalize">{reasoningEffort}</span> effort),
                dispatches tools over <span className="text-slate-800 dark:text-zinc-200 font-medium">Model Context Protocol SSE</span>. Air-gapped code executes inside a Linux container sandbox with{" "}
                <span className="text-cyan-600 dark:text-cyan-400 font-mono">cap_drop: ALL</span> and a{" "}
                <span className="text-cyan-600 dark:text-cyan-400 font-mono">read_only rootfs</span>. Web search and documentation scraping run isolated in an egress-only container with strict SSRF filtering.
              </p>
              <div className="pt-2 flex flex-wrap items-center gap-2 text-[10px] font-mono text-slate-500 dark:text-zinc-400 border-t border-slate-100 dark:border-zinc-800">
                <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300">Network: ai-mesh (air-gapped)</span>
                <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300">Sandbox UID: 10001</span>
                <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300">Browser UID: 10002</span>
                <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300">Attestation: SLSA Level 3</span>
              </div>
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
