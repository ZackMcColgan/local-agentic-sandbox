"use client";

import React, { useEffect, useState } from "react";
import { Navbar } from "@/components/Navbar";
import { SandboxGauge } from "@/components/SandboxGauge";
import { ChatStream } from "@/components/ChatStream";
import { ExecutionTrace, ExecutionTraceItem } from "@/components/ExecutionTrace";
import { Shield, Terminal, BookOpen, Layers } from "lucide-react";

export default function Home() {
  const [traces, setTraces] = useState<ExecutionTraceItem[]>([]);
  const [status, setStatus] = useState({
    ollama: "INITIALIZING",
    mcp: "INITIALIZING",
    airGapped: true
  });
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
      <Navbar status={status} />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
        
        {/* Security Governance Header / Gauge */}
        <section>
          <SandboxGauge securityPosture={securityPosture} />
        </section>

        {/* Dual-Panel Workspace: Chat Orchestrator & Execution Telemetry */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[620px]">
          
          {/* Left Panel: Chat Interface */}
          <div className="lg:col-span-7 flex flex-col h-[640px]">
            <ChatStream onTracesUpdate={handleTracesUpdate} />
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
                <span>Zero-Trust 3-Tier Topology</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-normal">
                Autonomous code generation runs on <span className="text-slate-200">Ollama (Qwen 3.8)</span>, dispatches tools over <span className="text-slate-200">Model Context Protocol SSE</span>, and executes in a sandboxed container with <span className="text-slate-200 font-mono">cap_drop: ALL</span> and <span className="text-slate-200 font-mono">read_only rootfs</span>.
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
