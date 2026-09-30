"use client";

import React from "react";
import { Shield, Cpu, Terminal, Radio, Github, Lock } from "lucide-react";

interface NavbarProps {
  status: {
    ollama: string;
    mcp: string;
    airGapped: boolean;
  };
}

export function Navbar({ status }: NavbarProps) {
  const isOllamaUp = status.ollama === "HEALTHY";
  const isMcpUp = status.mcp === "HEALTHY";

  return (
    <header className="border-b border-white/10 bg-slate-950/80 backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        
        {/* Brand & Identity */}
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-sm shadow-emerald-500/20">
            <Shield className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-100 tracking-tight text-base sm:text-lg">
                local-agentic-sandbox
              </span>
              <span className="text-[10px] font-mono uppercase bg-emerald-950/80 text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/20 tracking-wider">
                v1.0 Zero-Trust
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden sm:block">
              Air-gapped autonomous code execution boundary
            </p>
          </div>
        </div>

        {/* Telemetry Status Indicators */}
        <div className="flex items-center gap-2 sm:gap-4">
          
          {/* Air-gap Badge */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900 border border-white/10 text-xs font-mono text-slate-300">
            <Lock className="h-3.5 w-3.5 text-cyan-400" />
            <span className="hidden md:inline">Network:</span>
            <span className="text-cyan-400 font-semibold">ai-mesh (Zero Egress)</span>
          </div>

          {/* Ollama Pill */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900 border border-white/10 text-xs font-mono">
            <Cpu className="h-3.5 w-3.5 text-indigo-400" />
            <span className="hidden md:inline text-slate-400">LLM:</span>
            <span className="flex items-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full ${isOllamaUp ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
              <span className={isOllamaUp ? "text-emerald-400" : "text-amber-400"}>
                {status.ollama}
              </span>
            </span>
          </div>

          {/* MCP Server Pill */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900 border border-white/10 text-xs font-mono">
            <Terminal className="h-3.5 w-3.5 text-emerald-400" />
            <span className="hidden md:inline text-slate-400">MCP:</span>
            <span className="flex items-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full ${isMcpUp ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
              <span className={isMcpUp ? "text-emerald-400" : "text-amber-400"}>
                {status.mcp}
              </span>
            </span>
          </div>

          {/* GitHub Link */}
          <a
            href="https://github.com/ZackMcColgan/local-agentic-sandbox.git"
            target="_blank"
            rel="noreferrer"
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800/80 rounded-lg transition-colors"
            title="GitHub Repository"
          >
            <Github className="h-5 w-5" />
          </a>
        </div>

      </div>
    </header>
  );
}
