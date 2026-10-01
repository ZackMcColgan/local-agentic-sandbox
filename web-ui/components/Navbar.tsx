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
  Github,
  Sun,
  Moon
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
  theme: "dark" | "light";
  onThemeChange: (theme: "dark" | "light") => void;
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
  traceCount,
  theme,
  onThemeChange
}: NavbarProps) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const isOllamaUp = status.ollama === "HEALTHY";

  const allAvailableModels = Array.from(
    new Set([...profiles.map((p) => p.id), ...installedModels])
  );

  const getModelShortLabel = (id: string) => {
    if (id.includes("gemma4")) return "Gemma 4 (Flash)";
    if (id.includes("qwen3.8")) return "Qwen 27B (Pro)";
    return id.split(":")[0];
  };

  return (
    <header className="border-b border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-950/90 backdrop-blur-md sticky top-0 z-50 transition-colors">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
        
        {/* Main Header Bar */}
        <div className="h-14 flex items-center justify-between gap-1 sm:gap-4">
          
          {/* Brand Logo & Title */}
          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
            <div className="h-7 w-7 sm:h-8 sm:w-8 rounded-lg sm:rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shadow-sm shrink-0">
              <Shield className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            </div>
            <div className="hidden sm:block">
              <div className="flex items-center gap-1">
                <span className="font-bold text-slate-900 dark:text-zinc-100 tracking-tight text-xs sm:text-sm">
                  agentic-sandbox
                </span>
                <span className="text-[9px] font-mono uppercase bg-emerald-100 dark:bg-emerald-950/90 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.2 rounded border border-emerald-300 dark:border-emerald-500/20">
                  v1.2
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-zinc-400 font-mono">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span>ROCm GPU Active</span>
              </div>
            </div>
          </div>

          {/* Center Tabs: Chat vs System & Security */}
          <div className="flex items-center bg-slate-100 dark:bg-zinc-900 p-0.5 sm:p-1 rounded-xl border border-slate-200 dark:border-zinc-800 shadow-inner shrink-0">
            <button
              type="button"
              onClick={() => onTabChange("chat")}
              className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === "chat"
                  ? "bg-white dark:bg-zinc-800 text-emerald-600 dark:text-emerald-300 border border-slate-200 dark:border-zinc-700 shadow-sm"
                  : "text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100"
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span>Chat</span>
            </button>

            <button
              type="button"
              onClick={() => onTabChange("security")}
              className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === "security"
                  ? "bg-white dark:bg-zinc-800 text-cyan-600 dark:text-cyan-300 border border-slate-200 dark:border-zinc-700 shadow-sm"
                  : "text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100"
              }`}
            >
              <Activity className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">System</span>
              <span className="sm:hidden">Sys</span>
              {traceCount > 0 && (
                <span className="px-1 py-0.2 rounded-full text-[9px] font-mono bg-cyan-100 dark:bg-cyan-950 text-cyan-700 dark:text-cyan-300 border border-cyan-300 dark:border-cyan-500/30">
                  {traceCount}
                </span>
              )}
            </button>
          </div>

          {/* Right Controls: Model Selector, Thinking Effort, Theme Toggle */}
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            
            {/* Mobile Compact Thinking Mode Toggle Chip */}
            <button
              type="button"
              onClick={() => {
                const next = reasoningEffort === "low" ? "medium" : reasoningEffort === "medium" ? "xhigh" : "low";
                onReasoningChange(next);
              }}
              className={`sm:hidden flex items-center gap-1 px-2 py-1.5 rounded-lg border text-xs font-mono transition-all shadow-sm active:scale-95 ${
                reasoningEffort === "low"
                  ? "bg-amber-50 dark:bg-amber-950/60 border-amber-300 dark:border-amber-500/40 text-amber-700 dark:text-amber-300"
                  : reasoningEffort === "medium"
                  ? "bg-indigo-50 dark:bg-indigo-950/60 border-indigo-300 dark:border-indigo-500/40 text-indigo-700 dark:text-indigo-300"
                  : "bg-emerald-50 dark:bg-emerald-950/60 border-emerald-300 dark:border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
              }`}
              title={`Mode: ${reasoningEffort}. Tap to toggle Fast / Balanced / Deep.`}
              aria-label={`Mode: ${reasoningEffort}. Tap to toggle Fast / Balanced / Deep.`}
            >
              {reasoningEffort === "low" && <Zap className="h-3 w-3 text-amber-500" />}
              {reasoningEffort === "medium" && <Scale className="h-3 w-3 text-indigo-500" />}
              {reasoningEffort === "xhigh" && <Brain className="h-3 w-3 text-emerald-500" />}
              <span className="text-[11px] font-medium capitalize">
                {reasoningEffort === "low" ? "Fast" : reasoningEffort === "medium" ? "Bal" : "Deep"}
              </span>
            </button>

            {/* Desktop Thinking / Reasoning Effort Selector */}
            <div className="hidden sm:flex items-center rounded-lg bg-slate-100 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 p-0.5">
              <button
                type="button"
                onClick={() => onReasoningChange("low")}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all ${
                  reasoningEffort === "low"
                    ? "bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-500/30 shadow-sm"
                    : "text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                }`}
                title="Fast Mode: Direct answer"
              >
                <Zap className="h-3 w-3 text-amber-500 dark:text-amber-400" />
                <span>Fast</span>
              </button>

              <button
                type="button"
                onClick={() => onReasoningChange("medium")}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all ${
                  reasoningEffort === "medium"
                    ? "bg-indigo-100 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-300 dark:border-indigo-500/30 shadow-sm"
                    : "text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                }`}
                title="Balanced Mode: Standard reasoning & planning"
              >
                <Scale className="h-3 w-3 text-indigo-500 dark:text-indigo-400" />
                <span>Balanced</span>
              </button>

              <button
                type="button"
                onClick={() => onReasoningChange("xhigh")}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all ${
                  reasoningEffort === "xhigh"
                    ? "bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-500/30 shadow-sm"
                    : "text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                }`}
                title="Deep Mode: Exhaustive chain-of-thought"
              >
                <Brain className="h-3 w-3 text-emerald-500 dark:text-emerald-400" />
                <span>Deep</span>
              </button>
            </div>

            {/* Model Switcher Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-slate-200 dark:border-zinc-800 text-xs font-mono text-slate-800 dark:text-zinc-200 transition-colors shadow-sm"
              >
                <Cpu className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" />
                <span className="font-medium hidden sm:inline">
                  {getModelShortLabel(selectedModel)}
                </span>
                <span className="font-medium sm:hidden">
                  {selectedModel.includes("gemma4") ? "Gemma" : "Qwen"}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400 dark:text-zinc-400" />
              </button>

              {isDropdownOpen && (
                <div className="absolute right-0 mt-2 w-72 sm:w-80 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl shadow-2xl p-2 z-50 space-y-1">
                  <div className="px-2.5 py-1 text-[10px] font-mono text-slate-400 dark:text-zinc-400 uppercase tracking-wider">
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
                            ? "bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-300 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300"
                            : "hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold font-mono">{m}</span>
                          {isInstalled && (
                            <span className="text-[9px] bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.2 rounded font-mono font-medium">
                              INSTALLED
                            </span>
                          )}
                        </div>
                        {profile && (
                          <div className="text-[10px] text-slate-500 dark:text-zinc-400 leading-snug">
                            {profile.description} ({profile.recommendedVRAM})
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Light / Dark Mode Toggle Button */}
            <button
              type="button"
              id="theme-toggle-btn"
              onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}
              className="p-1.5 sm:p-2 rounded-lg bg-white hover:bg-slate-100 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-slate-200 dark:border-zinc-800 text-slate-700 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-zinc-100 transition-all shadow-sm active:scale-95"
              title={theme === "dark" ? "Switch to Daytime / Light Mode" : "Switch to Dark Mode"}
              aria-label={theme === "dark" ? "Switch to Daytime / Light Mode" : "Switch to Dark Mode"}
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4 text-amber-400" />
              ) : (
                <Moon className="h-4 w-4 text-indigo-600" />
              )}
            </button>

            {/* GitHub Repo */}
            <a
              href="https://github.com/ZackMcColgan/local-agentic-sandbox.git"
              target="_blank"
              rel="noreferrer"
              className="p-1.5 sm:p-2 text-slate-400 hover:text-slate-800 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg transition-colors shrink-0 hidden md:block"
              title="GitHub Repository"
            >
              <Github className="h-4 w-4" />
            </a>

          </div>

        </div>

      </div>
    </header>
  );
}
