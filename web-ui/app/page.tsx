"use client";

import React, { useEffect, useState } from "react";
import { Navbar } from "@/components/Navbar";
import { SandboxGauge } from "@/components/SandboxGauge";
import { ChatStream } from "@/components/ChatStream";
import { ExecutionTrace, ExecutionTraceItem } from "@/components/ExecutionTrace";
import { Layers, ShieldCheck, Globe, Cpu, ArrowLeft } from "lucide-react";
import { PRESET_MODEL_PROFILES, ModelProfile } from "@/config/models";

export default function Home() {
  const [traces, setTraces] = useState<ExecutionTraceItem[]>([]);
  const [status, setStatus] = useState({
    ollama: "INITIALIZING",
    mcp: "INITIALIZING",
    airGapped: true
  });
  const [selectedModel, setSelectedModel] = useState<string>("qwen2.5-coder:7b");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "xhigh">("low");
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ModelProfile[]>(PRESET_MODEL_PROFILES);
  const [securityPosture, setSecurityPosture] = useState<any>(undefined);
  const [activeTab, setActiveTab] = useState<"chat" | "security">("chat");

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
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100 antialiased selection:bg-emerald-900 selection:text-white">
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
      />

      <main className="flex-1 max-w-5xl w-full mx-auto p-2 sm:p-4 lg:p-6 flex flex-col">
        {activeTab === "chat" ? (
          <div className="flex-1 flex flex-col space-y-2 sm:space-y-3 h-[calc(100vh-5rem)] sm:h-[calc(100vh-6.5rem)]">
            
            {/* Minimalist Top Status Strip */}
            <div className="flex items-center justify-between px-2 sm:px-1 text-[11px] font-mono text-slate-400">
              <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                <span className="inline-flex items-center gap-1 text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded-full border border-emerald-500/20">
                  <ShieldCheck className="h-3 w-3" />
                  <span>Sandbox: Air-Gapped (10001)</span>
                </span>
                <span className="hidden sm:inline-flex items-center gap-1 text-cyan-400 bg-cyan-950/40 px-2 py-0.5 rounded-full border border-cyan-500/20">
                  <Globe className="h-3 w-3" />
                  <span>Browser: Isolated Scraper</span>
                </span>
                <span className="hidden md:inline-flex items-center gap-1 text-indigo-300 bg-indigo-950/40 px-2 py-0.5 rounded-full border border-indigo-500/20">
                  <Cpu className="h-3 w-3" />
                  <span>GPU: ROCm RX 9070 XT</span>
                </span>
              </div>

              <button
                type="button"
                onClick={() => setActiveTab("security")}
                className="hover:text-emerald-300 transition-colors flex items-center gap-1 text-[10px] sm:text-xs"
              >
                <span>Telemetry ({traces.length})</span>
                <span className="text-emerald-400">→</span>
              </button>
            </div>

            {/* Chat Container */}
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
                <h2 className="text-lg font-bold text-slate-100 tracking-tight">
                  Security Governance & Execution Telemetry
                </h2>
                <p className="text-xs text-slate-400">
                  Real-time container boundaries, zero-egress enforcement, and MCP audit logs.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setActiveTab("chat")}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-850 border border-white/10 text-xs font-medium text-slate-200 hover:text-white transition-colors shadow-sm"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Back to Chat</span>
              </button>
            </div>

            {/* Security Governance Header / Gauge */}
            <section>
              <SandboxGauge securityPosture={securityPosture} />
            </section>

            {/* Architecture Card */}
            <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 sm:p-5 space-y-3 shadow-md">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <Layers className="h-4 w-4 text-cyan-400" />
                <span>Zero-Trust 3-Tier Multi-Agent Topology</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Autonomous orchestrator running on{" "}
                <span className="text-emerald-400 font-mono font-medium">{selectedModel}</span> (
                <span className="text-amber-400 font-mono capitalize">{reasoningEffort}</span> effort),
                dispatches tools over <span className="text-slate-200 font-medium">Model Context Protocol SSE</span>. Air-gapped code executes inside a Linux container sandbox with{" "}
                <span className="text-cyan-300 font-mono">cap_drop: ALL</span> and a{" "}
                <span className="text-cyan-300 font-mono">read_only rootfs</span>. Web search and documentation scraping run isolated in an egress-only container with SSRF guard.
              </p>
              <div className="pt-2 flex flex-wrap items-center gap-2 text-[10px] font-mono text-slate-400 border-t border-white/5">
                <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">Network: ai-mesh (air-gapped)</span>
                <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">Sandbox UID: 10001</span>
                <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">Browser UID: 10002</span>
                <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">Attestation: SLSA Level 3</span>
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
