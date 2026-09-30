"use client";

import React, { useState } from "react";
import { Shield, Cpu, Terminal, Github, Lock, ChevronDown, Sparkles } from "lucide-react";
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
}

export function Navbar({
  status,
  selectedModel,
  onModelChange,
  reasoningEffort,
  onReasoningChange,
  installedModels,
  profiles
}: NavbarProps) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const isOllamaUp = status.ollama === "HEALTHY";
  const isMcpUp = status.mcp === "HEALTHY";
  const isQwen38 = selectedModel.includes("qwen3.8");

  // Combine profiles with any unprofiled models discovered from Ollama
  const allAvailableModels = Array.from(
    new Set([...profiles.map((p) => p.id), ...installedModels])
  );

  return (
    <header className="border-b border-white/10 bg-slate-950/85 backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        
        {/* Brand & Identity */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <div className="h-8 w-8 sm:h-9 sm:w-9 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-sm shadow-emerald-500/20">
            <Shield className="h-4 w-4 sm:h-5 sm:w-5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5 sm:gap-2">
              <span className="font-semibold text-slate-100 tracking-tight text-sm sm:text-base">
                <span className="sm:hidden">agentic-sandbox</span>
                <span className="hidden sm:inline">local-agentic-sandbox</span>
              </span>
              <span className="text-[9px] sm:text-[10px] font-mono uppercase bg-emerald-950/80 text-emerald-400 px-1.5 sm:px-2 py-0.5 rounded border border-emerald-500/20 tracking-wider">
                v1.1
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden md:block">
              Zero-Trust Autonomous Execution & Dynamic Model Router
            </p>
          </div>
        </div>

        {/* Dynamic Model Selector & Reasoning Controls */}
        <div className="flex items-center gap-2 sm:gap-3 flex-1 justify-end">
          
          {/* Reasoning Effort Toggle for Qwen 3.8 */}
          {isQwen38 && (
            <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900 border border-white/10 text-xs font-mono">
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-slate-400">Thinking:</span>
              <div className="flex rounded bg-slate-950 p-0.5 border border-white/5">
                {(["low", "medium", "xhigh"] as const).map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => onReasoningChange(level)}
                    className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-bold transition-colors ${
                      reasoningEffort === level
                        ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                        : "text-slate-500 hover:text-slate-300"
                    }`}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Model Switcher Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-850 border border-white/10 hover:border-emerald-500/40 text-xs font-mono text-slate-200 transition-colors shadow-sm"
            >
              <Cpu className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
              <div className="text-left">
                <span className="font-semibold text-slate-100">{selectedModel}</span>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </button>

            {isDropdownOpen && (
              <div className="absolute right-0 mt-2 w-72 rounded-xl border border-white/10 bg-slate-900/95 backdrop-blur-xl shadow-2xl p-2 z-50 space-y-1">
                <div className="px-2 py-1 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                  Select Active Agent Model
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
                      className={`w-full text-left p-2 rounded-lg text-xs transition-colors flex flex-col gap-0.5 ${
                        isSelected
                          ? "bg-emerald-950/60 border border-emerald-500/30 text-emerald-300"
                          : "hover:bg-slate-800 text-slate-300"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold font-mono">{m}</span>
                        {isInstalled && (
                          <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.2 rounded font-mono">
                            READY
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

          {/* Air-gap Badge */}
          <div className="hidden xl:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900 border border-white/10 text-xs font-mono text-slate-300">
            <Lock className="h-3.5 w-3.5 text-cyan-400" />
            <span className="text-cyan-400 font-semibold">Zero Egress</span>
          </div>

          {/* MCP Status */}
          <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900 border border-white/10 text-xs font-mono">
            <Terminal className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-slate-400">MCP:</span>
            <span className={isMcpUp ? "text-emerald-400" : "text-amber-400"}>
              {status.mcp}
            </span>
          </div>

          {/* GitHub Repo */}
          <a
            href="https://github.com/ZackMcColgan/local-agentic-sandbox.git"
            target="_blank"
            rel="noreferrer"
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800/80 rounded-lg transition-colors shrink-0"
            title="GitHub Repository"
          >
            <Github className="h-5 w-5" />
          </a>
        </div>

      </div>
    </header>
  );
}
