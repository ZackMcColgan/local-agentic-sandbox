"use client";

import React, { useState } from "react";
import {
  Shield,
  Cpu,
  ChevronDown,
  Sparkles,
  Zap,
  Brain,
  Scale,
  MessageSquare,
  Activity,
  Github
} from "lucide-react";
import { ModelProfile } from "@/config/models";

interface NavbarProps {
  status: {
    ollama: string;
    mcp: string;
    airGapped: boolean;
  };
  selectedModel: string;
  onModelChange: (model: string) => void;
  reasoningEffort: "low" | "medium" | "xhigh";
  onReasoningChange: (effort: "low" | "medium" | "xhigh") => void;
  installedModels: string[];
  profiles: ModelProfile[];
  activeTab: "chat" | "security";
  onTabChange: (tab: "chat" | "security") => void;
  traceCount: number;
}

export function Navbar({
  status,
  selectedModel,
  onModelChange,
  reasoningEffort,
  onReasoningChange,
  installedModels,
  profiles,
  activeTab,
  onTabChange,
  traceCount
}: NavbarProps) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const isOllamaUp = status.ollama === "HEALTHY";

  // Combine profiles with any unprofiled models discovered from Ollama
  const allAvailableModels = Array.from(
    new Set([...profiles.map((p) => p.id), ...installedModels])
  );

  const getModelShortLabel = (id: string) => {
    if (id.includes("qwen2.5-coder:7b")) return "Qwen 2.5 Coder (7B)";
    if (id.includes("qwen2.5-coder:1.5b")) return "Qwen 2.5 Coder (1.5B)";
    if (id.includes("qwen3.8")) return "Qwen 3.8 (27B)";
    return id.split(":")[0];
  };

  return (
    <header className="border-b border-white/10 bg-slate-950/80 backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
        
        {/* Main Header Bar */}
        <div className="h-14 sm:h-16 flex items-center justify-between gap-2 sm:gap-4">
          
          {/* Brand Logo & Title */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className="h-8 w-8 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-sm shadow-emerald-500/20">
              <Shield className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-slate-100 tracking-tight text-xs sm:text-sm">
                  agentic-sandbox
                </span>
                <span className="text-[9px] font-mono uppercase bg-emerald-950/90 text-emerald-400 px-1.5 py-0.2 rounded border border-emerald-500/20">
                  v1.2
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>ROCm GPU Active</span>
              </div>
            </div>
          </div>

          {/* Center Tabs: Chat vs Security Telemetry */}
          <div className="flex items-center bg-slate-900/90 p-1 rounded-xl border border-white/10 shadow-inner">
            <button
              type="button"
              onClick={() => onTabChange("chat")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === "chat"
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span>Chat</span>
            </button>

            <button
              type="button"
              onClick={() => onTabChange("security")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === "security"
                  ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Activity className="h-3.5 w-3.5" />
              <span>Security</span>
              {traceCount > 0 && (
                <span className="ml-0.5 px-1.5 py-0.2 rounded-full text-[9px] font-mono bg-cyan-950 text-cyan-300 border border-cyan-500/30">
                  {traceCount}
                </span>
              )}
            </button>
          </div>

          {/* Right Controls: Model Selector & Reasoning Effort */}
          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
            
            {/* Thinking / Reasoning Effort Selector */}
            <div className="flex items-center rounded-lg bg-slate-900 border border-white/10 p-0.5">
              <button
                type="button"
                onClick={() => onReasoningChange("low")}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all ${
                  reasoningEffort === "low"
                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
                title="Fast Mode: Direct answer without thinking delay"
              >
                <Zap className="h-3 w-3 text-amber-400" />
                <span className="hidden sm:inline">Fast</span>
              </button>

              <button
                type="button"
                onClick={() => onReasoningChange("medium")}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all ${
                  reasoningEffort === "medium"
                    ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
                title="Balanced Mode: Standard reasoning & planning"
              >
                <Scale className="h-3 w-3 text-indigo-400" />
                <span className="hidden sm:inline">Balanced</span>
              </button>

              <button
                type="button"
                onClick={() => onReasoningChange("xhigh")}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all ${
                  reasoningEffort === "xhigh"
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
                title="Deep Mode: Exhaustive chain-of-thought"
              >
                <Brain className="h-3 w-3 text-emerald-400" />
                <span className="hidden sm:inline">Deep</span>
              </button>
            </div>

            {/* Model Switcher Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-850 border border-white/10 hover:border-emerald-500/40 text-xs font-mono text-slate-200 transition-colors shadow-sm"
              >
                <Cpu className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                <span className="font-medium text-slate-100 hidden sm:inline">
                  {getModelShortLabel(selectedModel)}
                </span>
                <span className="font-medium text-slate-100 sm:hidden">
                  {selectedModel.includes("coder:7b") ? "7B" : selectedModel.includes("3.8") ? "27B" : "1.5B"}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>

              {isDropdownOpen && (
                <div className="absolute right-0 mt-2 w-72 sm:w-80 rounded-2xl border border-white/10 bg-slate-900/95 backdrop-blur-xl shadow-2xl p-2 z-50 space-y-1">
                  <div className="px-2.5 py-1 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                    Select Active Model
                  </div>
                  {allAvailableModels.map((m) => {
                    const profile = profiles.find((p) => p.id === m);
                    const isSelected = selectedModel === m;
                    const isInstalled = installedModels.includes(m);

                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          onModelChange(m);
                          setIsDropdownOpen(false);
                        }}
                        className={`w-full text-left p-2.5 rounded-xl text-xs transition-colors flex flex-col gap-0.5 ${
                          isSelected
                            ? "bg-emerald-950/60 border border-emerald-500/30 text-emerald-300"
                            : "hover:bg-slate-800 text-slate-300"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold font-mono">{m}</span>
                          {isInstalled && (
                            <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.2 rounded font-mono">
                              INSTALLED
                            </span>
                          )}
                        </div>
                        {profile && (
                          <div className="text-[10px] text-slate-400 leading-snug">
                            {profile.description} ({profile.recommendedVRAM})
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* GitHub Repo */}
            <a
              href="https://github.com/ZackMcColgan/local-agentic-sandbox.git"
              target="_blank"
              rel="noreferrer"
              className="p-1.5 sm:p-2 text-slate-400 hover:text-white hover:bg-slate-800/80 rounded-lg transition-colors shrink-0 hidden sm:block"
              title="GitHub Repository"
            >
              <Github className="h-4 w-4 sm:h-5 sm:w-5" />
            </a>

          </div>

        </div>

      </div>
    </header>
  );
}
