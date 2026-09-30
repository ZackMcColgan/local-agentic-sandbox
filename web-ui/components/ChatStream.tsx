"use client";

import React, { useState, useRef, useEffect } from "react";
import { Send, Bot, User, Sparkles, Loader2, Play, Terminal, ShieldAlert } from "lucide-react";
import { ExecutionTraceItem } from "./ExecutionTrace";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatStreamProps {
  onTracesUpdate: (traces: ExecutionTraceItem[]) => void;
}

const PRESET_PROMPTS = [
  {
    title: "Fibonacci & Test Suite",
    prompt: "Write a python script to calculate fibonacci up to 10 and run it with unit tests."
  },
  {
    title: "Verify Zero Egress",
    prompt: "Write a Python script that attempts to open a socket connection to 8.8.8.8 on port 53 and run it to verify zero network egress."
  },
  {
    title: "Supply-Chain Attestation",
    prompt: "Verify the container provenance for image 'local-agentic-sandbox/mcp-server:latest' targeting the 'staging' environment."
  },
  {
    title: "Filesystem Immutability Test",
    prompt: "Write a Python script that tries to write a file to /etc/test.txt and /root/test.txt to confirm the root filesystem is read-only."
  }
];

export function ChatStream({ onTracesUpdate }: ChatStreamProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: "Welcome to **local-agentic-sandbox**. I am your local AI coding agent running on an air-gapped `ai-mesh` network. You can ask me to generate, test, and execute Python code, verify container provenance, and inspect our zero-trust boundaries."
    }
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const handleSend = async (textToSend?: string) => {
    const prompt = (textToSend || input).trim();
    if (!prompt || isLoading) return;

    setErrorMsg(null);
    setInput("");

    const newMessages: Message[] = [...messages, { role: "user", content: prompt }];
    setMessages(newMessages);
    setIsLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to orchestrate request");
      }

      if (data.traces && data.traces.length > 0) {
        onTracesUpdate(data.traces);
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.content || "Code executed inside sandbox successfully."
        }
      ]);
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "Failed to communicate with agent orchestrator");
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full rounded-xl border border-white/10 bg-slate-900/40 overflow-hidden">
      
      {/* Top Header of Chat Panel */}
      <div className="px-4 py-3 border-b border-white/5 bg-slate-950/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-emerald-400" />
          <span className="text-xs font-semibold text-slate-200">
            Autonomous Agent Orchestrator
          </span>
        </div>
        <span className="text-[10px] font-mono text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded">
          Local LLM + MCP SSE
        </span>
      </div>

      {/* Preset Prompt Carousel */}
      <div className="px-4 py-2.5 bg-slate-950/20 border-b border-white/5 flex gap-2 overflow-x-auto">
        {PRESET_PROMPTS.map((p, idx) => (
          <button
            key={idx}
            type="button"
            disabled={isLoading}
            onClick={() => handleSend(p.prompt)}
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800/60 hover:bg-slate-800 border border-white/5 text-[11px] text-slate-300 hover:text-white transition-colors"
          >
            <Play className="h-3 w-3 text-cyan-400 fill-cyan-400/20" />
            <span>{p.title}</span>
          </button>
        ))}
      </div>

      {/* Message Feed */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((m, idx) => {
          const isUser = m.role === "user";
          return (
            <div
              key={idx}
              className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}
            >
              {!isUser && (
                <div className="h-7 w-7 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0 mt-0.5">
                  <Bot className="h-4 w-4" />
                </div>
              )}

              <div
                className={`max-w-2xl rounded-xl p-3.5 text-xs leading-relaxed ${
                  isUser
                    ? "bg-indigo-600/90 text-white rounded-tr-none shadow-md shadow-indigo-500/10"
                    : "bg-slate-950/80 border border-white/10 text-slate-200 rounded-tl-none whitespace-pre-wrap font-sans"
                }`}
              >
                {m.content}
              </div>

              {isUser && (
                <div className="h-7 w-7 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-300 shrink-0 mt-0.5">
                  <User className="h-4 w-4" />
                </div>
              )}
            </div>
          );
        })}

        {/* Loading Indicator */}
        {isLoading && (
          <div className="flex gap-3 justify-start">
            <div className="h-7 w-7 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
            <div className="rounded-xl rounded-tl-none p-3.5 bg-slate-950/80 border border-white/10 text-xs text-slate-400 flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5 text-cyan-400 animate-pulse" />
              <span>Orchestrating local model & dispatching sandboxed MCP tools...</span>
            </div>
          </div>
        )}

        {/* Error Alert */}
        {errorMsg && (
          <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div ref={scrollRef} />
      </div>

      {/* Input Bar */}
      <div className="p-3 bg-slate-950/70 border-t border-white/10">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex items-center gap-2"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={isLoading}
            placeholder="Ask the agent to write and execute code in the sandbox (Shift+Enter for new line)..."
            className="flex-1 bg-slate-900 border border-white/10 focus:border-emerald-500/60 rounded-lg px-3.5 py-2.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none resize-none transition-colors"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="p-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 text-white transition-colors shrink-0 shadow-sm shadow-emerald-500/20"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500 px-1 font-mono">
          <span>Zero-trust sandbox execution boundary enforced</span>
          <span>Press Enter ↵ to send</span>
        </div>
      </div>

    </div>
  );
}
