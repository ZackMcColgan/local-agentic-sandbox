"use client";

import React, { useEffect, useState } from "react";
import { Navbar } from "@/components/Navbar";
import { SandboxGauge } from "@/components/SandboxGauge";
import { ChatStream } from "@/components/ChatStream";
import { ExecutionTrace, ExecutionTraceItem } from "@/components/ExecutionTrace";
import { Layers } from "lucide-react";
import { DEFAULT_PRIMARY_MODEL, PRESET_MODEL_PROFILES, ModelProfile } from "@/config/models";

export default function Home() {
  const [traces, setTraces] = useState<ExecutionTraceItem[]>([]);
  const [status, setStatus] = useState({
    ollama: "INITIALIZING",
    mcp: "INITIALIZING",
    airGapped: true
  });
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_PRIMARY_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "xhigh">("medium");
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ModelProfile[]>(PRESET_MODEL_PROFILES);
  const [securityPosture, setSecurityPosture] = useState<any>(undefined);

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
    <div className="min-h-screen flex flex-col bg-slate-950">
      <Navbar
        status={status}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        reasoningEffort={reasoningEffort}
        onReasoningChange={setReasoningEffort}
        installedModels={installedModels}
        profiles={profiles}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
        
        {/* Security Governance Header / Gauge */}
        <section>
          <SandboxGauge securityPosture={securityPosture} />
        </section>

        {/* Dual-Panel Workspace: Chat Orchestrator & Execution Telemetry */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[620px]">
          
          {/* Left Panel: Chat Interface */}
          <div className="lg:col-span-7 flex flex-col h-[640px]">
            <ChatStream
              onTracesUpdate={handleTracesUpdate}
              activeModel={selectedModel}
              reasoningEffort={reasoningEffort}
            />
          </div>

          {/* Right Panel: Execution Trace & Architecture Reference */}
          <div className="lg:col-span-5 flex flex-col h-[640px] space-y-4 overflow-hidden">
            
            {/* Scrollable Trace Viewer */}
            <div className="flex-1 overflow-y-auto pr-1">
              <ExecutionTrace traces={traces} />
            </div>

            {/* Architecture Card Footer */}
            <div className="rounded-xl border border-white/10 bg-slate-900/40 p-4 space-y-2 shrink-0">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                <Layers className="h-4 w-4 text-cyan-400" />
                <span>Zero-Trust 3-Tier Multi-Agent Topology</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-normal">
                Autonomous orchestrator running on <span className="text-slate-200 font-mono">{selectedModel}</span> ({reasoningEffort} thinking), dispatches tools over <span className="text-slate-200">Model Context Protocol SSE</span>, and executes in a sandboxed container with <span className="text-slate-200 font-mono">cap_drop: ALL</span> and <span className="text-slate-200 font-mono">read_only rootfs</span>.
              </p>
              <div className="pt-1 flex items-center justify-between text-[10px] font-mono text-slate-500">
                <span>Network: ai-mesh (internal)</span>
                <span>User: uid 10001</span>
              </div>
            </div>

          </div>

        </section>

      </main>
    </div>
  );
}
