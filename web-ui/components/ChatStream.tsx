"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  Send,
  Bot,
  User,
  Sparkles,
  Loader2,
  Terminal,
  ShieldAlert,
  Copy,
  Check,
  Edit3,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Globe,
  Cpu,
  Trash2,
  ArrowRight,
  Paperclip,
  FileText,
  X,
  Image as ImageIcon
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExecutionTraceItem } from "./ExecutionTrace";

export interface AttachedFileItem {
  id: string;
  name: string;
  type: string;
  size: number;
  previewUrl?: string;
  base64: string;
  isImage: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thought?: string;
  traces?: ExecutionTraceItem[];
  attachments?: Array<{
    name: string;
    type: string;
    size: number;
    previewUrl?: string;
    isImage: boolean;
  }>;
  modelUsed?: string;
  durationMs?: number;
}

interface ChatStreamProps {
  onTracesUpdate: (traces: ExecutionTraceItem[]) => void;
  activeModel: string;
  reasoningEffort: "low" | "medium" | "xhigh";
  onViewSecurityTelemetry?: () => void;
}

const PRESET_PROMPTS = [
  {
    title: "Web Research & Docs",
    prompt: "Search the web for the latest Python 3.13 release highlights and summarize the key security features."
  },
  {
    title: "Fibonacci & Test Suite",
    prompt: "Write a python script to calculate fibonacci up to 10 and run it with unit tests in the sandbox."
  },
  {
    title: "Verify Zero Egress",
    prompt: "Write a Python script that attempts to open a socket connection to 8.8.8.8 on port 53 and run it to verify zero network egress."
  },
  {
    title: "Filesystem Immutability",
    prompt: "Write a Python script that tries to write a file to /etc/test.txt and /root/test.txt to confirm the root filesystem is read-only."
  },
  {
    title: "Container Provenance",
    prompt: "Verify the container provenance for image 'local-agentic-sandbox/mcp-server:latest' targeting the 'staging' environment."
  }
];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-3 rounded-lg border border-slate-700/60 bg-slate-950 overflow-hidden shadow-md">
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-900 border-b border-slate-800 text-[11px] font-mono text-slate-400">
        <span className="text-emerald-400/80 font-medium">{language || "bash"}</span>
        <button
          onClick={handleCopy}
          type="button"
          className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          title="Copy code"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-400" />
              <span className="text-emerald-400 text-[10px]">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span className="text-[10px]">Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-3 text-[11px] font-mono text-emerald-300/90 overflow-x-auto leading-relaxed selection:bg-emerald-900 selection:text-white">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function parseThinkingAndContent(raw: string): { thought?: string; content: string } {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/i;
  const match = raw.match(thinkRegex);
  if (match) {
    const thought = match[1].trim();
    const content = raw.replace(thinkRegex, "").trim();
    return { thought, content };
  }

  // Handle case where <think> tag was unclosed or cutoff
  if (raw.startsWith("<think>")) {
    const parts = raw.split("</think>");
    if (parts.length > 1) {
      return {
        thought: parts[0].replace("<think>", "").trim(),
        content: parts.slice(1).join("</think>").trim()
      };
    }
  }

  return { content: raw };
}

export function ChatStream({
  onTracesUpdate,
  activeModel,
  reasoningEffort,
  onViewSecurityTelemetry
}: ChatStreamProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "initial-welcome",
      role: "assistant",
      content:
        "Welcome to **local-agentic-sandbox**! I'm your local AI agent combining hardware-accelerated local models (`gemma4:e4b` Flash & `qwen3.8:27b` Pro), zero-trust container execution, live web research, and multimodal image & document support.\n\n- 🔒 **Air-Gapped Python Sandbox**: `cap_drop: ALL`, read-only rootfs, zero egress.\n- 🌐 **Isolated Web Scraper**: Live DuckDuckGo search & documentation fetch via isolated proxy.\n- 📎 **Multimodal Inputs**: Upload images (`.png`, `.jpg`), PDFs (`.pdf`), Word docs (`.docx`), and code for instant analysis.\n- 🛡️ **Container Provenance**: Docker Scout CVE gating & SLSA verification.",
      modelUsed: activeModel
    }
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});
  
  // Attached files state (Images, PDFs, Word docs)
  const [attachedFiles, setAttachedFiles] = useState<AttachedFileItem[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [previewModalImage, setPreviewModalImage] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const toggleThought = (msgId: string) => {
    setExpandedThoughts((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  const copyToClipboard = (text: string, msgId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedMessageId(msgId);
    setTimeout(() => setCopiedMessageId(null), 2000);
  };

  const handleEditPrompt = (text: string) => {
    setInput(text);
    textareaRef.current?.focus();
  };

  const handleClearHistory = () => {
    setMessages([
      {
        id: `welcome-${Date.now()}`,
        role: "assistant",
        content: "Chat cleared. What would you like to build, run, or research next?",
        modelUsed: activeModel
      }
    ]);
  };

  // Handle file selection from input or drag-and-drop
  const processFiles = async (files: FileList | File[]) => {
    const newItems: AttachedFileItem[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
      
      try {
        const base64 = await fileToBase64(file);
        newItems.push({
          id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          previewUrl: isImage ? base64 : undefined,
          base64,
          isImage
        });
      } catch (err) {
        console.error("Failed to read file", file.name, err);
      }
    }

    setAttachedFiles((prev) => [...prev, ...newItems]);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachedFiles((prev) => prev.filter((item) => item.id !== id));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  };

  const handleSend = async (textToSend?: string) => {
    const prompt = (textToSend || input).trim();
    if ((!prompt && attachedFiles.length === 0) || isLoading) return;

    setErrorMsg(null);
    setInput("");

    const currentAttachments = [...attachedFiles];
    setAttachedFiles([]);

    const userMsgId = `user-${Date.now()}`;
    const userMessage: ChatMessage = {
      id: userMsgId,
      role: "user",
      content: prompt || (currentAttachments.length > 0 ? `Analyzed attached files: ${currentAttachments.map(a => a.name).join(", ")}` : ""),
      attachments: currentAttachments.map(a => ({
        name: a.name,
        type: a.type,
        size: a.size,
        previewUrl: a.previewUrl,
        isImage: a.isImage
      }))
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setIsLoading(true);

    const startTime = performance.now();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: updatedMessages.map((m) => ({ role: m.role, content: m.content })),
          model: activeModel,
          reasoning_effort: reasoningEffort,
          attachments: currentAttachments.map(a => ({
            name: a.name,
            type: a.type,
            size: a.size,
            base64: a.base64
          }))
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to orchestrate request");
      }

      if (data.traces && data.traces.length > 0) {
        onTracesUpdate(data.traces);
      }

      const durationMs = Math.round(performance.now() - startTime);
      const parsed = parseThinkingAndContent(data.content || "Code executed inside sandbox successfully.");

      const assistantMsgId = `assistant-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: assistantMsgId,
          role: "assistant",
          content: parsed.content,
          thought: parsed.thought,
          traces: data.traces,
          modelUsed: activeModel,
          durationMs
        }
      ]);
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "Failed to communicate with agent orchestrator");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegenerate = () => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        handleSend(messages[i].content);
        break;
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative flex flex-col h-full rounded-2xl border transition-colors bg-slate-900/50 backdrop-blur-sm overflow-hidden shadow-2xl ${
        isDraggingOver ? "border-emerald-500/80 bg-emerald-950/20" : "border-white/10"
      }`}
    >
      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.doc,.docx,.txt,.md,.json,.csv,.py"
        onChange={handleFileInputChange}
        className="hidden"
      />

      {/* Image Lightbox Modal */}
      {previewModalImage && (
        <div
          onClick={() => setPreviewModalImage(null)}
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 cursor-pointer"
        >
          <div className="relative max-w-4xl max-h-[90vh]">
            <img
              src={previewModalImage}
              alt="Fullscreen preview"
              className="rounded-xl shadow-2xl max-w-full max-h-[85vh] object-contain border border-white/10"
            />
            <button
              onClick={() => setPreviewModalImage(null)}
              className="absolute top-2 right-2 p-1.5 rounded-full bg-slate-900/90 text-white hover:bg-slate-850 border border-white/20"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Header Bar */}
      <div className="px-4 py-3 border-b border-white/10 bg-slate-950/60 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="h-6 w-6 rounded-md bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <Bot className="h-3.5 w-3.5" />
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-200 block">Agent Workspace</span>
            <span className="text-[10px] text-slate-400 font-mono">
              Model: <span className="text-emerald-400">{activeModel}</span>
              {" • "}
              Thinking: <span className="text-amber-400 capitalize">{reasoningEffort}</span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {messages.length > 2 && (
            <button
              onClick={handleClearHistory}
              type="button"
              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800/80 transition-colors"
              title="Clear chat history"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Preset Suggestions Carousel */}
      <div className="px-3 py-2 bg-slate-950/30 border-b border-white/5 flex gap-2 overflow-x-auto scrollbar-none">
        {PRESET_PROMPTS.map((p, idx) => (
          <button
            key={idx}
            type="button"
            disabled={isLoading}
            onClick={() => handleSend(p.prompt)}
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800/60 hover:bg-slate-800 border border-white/5 hover:border-emerald-500/30 text-[11px] text-slate-300 hover:text-white transition-all shadow-sm"
          >
            <Sparkles className="h-3 w-3 text-cyan-400" />
            <span>{p.title}</span>
          </button>
        ))}
      </div>

      {/* Scrollable Conversation Thread */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
        {messages.map((m, idx) => {
          const isUser = m.role === "user";
          const isCopied = copiedMessageId === m.id;
          const isThoughtOpen = !!expandedThoughts[m.id];
          const isLastAssistant =
            !isUser &&
            (idx === messages.length - 1 ||
              (idx === messages.length - 2 && messages[messages.length - 1].role === "user"));

          return (
            <div
              key={m.id || idx}
              className={`group flex gap-3 sm:gap-4 ${isUser ? "justify-end" : "justify-start"}`}
            >
              {/* Assistant Avatar */}
              {!isUser && (
                <div className="h-8 w-8 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0 mt-0.5 shadow-sm shadow-emerald-500/10">
                  <Bot className="h-4 w-4" />
                </div>
              )}

              {/* Message Content Container */}
              <div className={`flex flex-col ${isUser ? "items-end" : "items-start"} max-w-[85%] sm:max-w-2xl`}>
                
                {/* Collapsible Reasoning Block (Gemini-style Thought Process) */}
                {!isUser && m.thought && (
                  <div className="w-full mb-3 rounded-xl border border-slate-700/50 bg-slate-900/60 overflow-hidden shadow-sm">
                    <button
                      type="button"
                      onClick={() => toggleThought(m.id)}
                      className="w-full flex items-center justify-between px-3.5 py-2 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                        <span className="font-medium text-slate-300">Thinking Process</span>
                        <span className="text-[10px] text-slate-500 font-mono">
                          ({m.thought.split("\n").length} lines)
                        </span>
                      </div>
                      {isThoughtOpen ? (
                        <ChevronUp className="h-3.5 w-3.5 text-slate-400" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                      )}
                    </button>

                    {isThoughtOpen && (
                      <div className="px-3.5 py-2.5 text-[11px] font-mono text-slate-400 border-t border-slate-800/80 bg-slate-950/60 whitespace-pre-wrap max-h-56 overflow-y-auto leading-relaxed">
                        {m.thought}
                      </div>
                    )}
                  </div>
                )}

                {/* Render Attached Files for User Message */}
                {isUser && m.attachments && m.attachments.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2 justify-end">
                    {m.attachments.map((att, aIdx) => (
                      <div key={aIdx}>
                        {att.isImage && att.previewUrl ? (
                          <div
                            onClick={() => setPreviewModalImage(att.previewUrl || null)}
                            className="cursor-pointer group/img relative rounded-lg border border-white/20 overflow-hidden shadow-md max-w-[120px]"
                          >
                            <img
                              src={att.previewUrl}
                              alt={att.name}
                              className="h-20 w-28 object-cover group-hover/img:scale-105 transition-transform"
                            />
                            <span className="absolute bottom-0 inset-x-0 bg-black/60 text-[9px] text-white px-1 py-0.5 truncate font-mono">
                              {att.name}
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-950/80 border border-indigo-400/30 text-indigo-200 text-[11px] font-mono shadow-sm">
                            <FileText className="h-3.5 w-3.5 text-cyan-400" />
                            <span className="max-w-[140px] truncate">{att.name}</span>
                            <span className="text-[10px] text-indigo-400/80">({formatFileSize(att.size)})</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Main Message Bubble */}
                <div
                  className={`rounded-2xl p-4 text-xs leading-relaxed ${
                    isUser
                      ? "bg-indigo-600 text-white rounded-tr-sm shadow-md shadow-indigo-500/10"
                      : "w-full bg-slate-950/80 border border-white/10 text-slate-200 rounded-tl-sm shadow-md"
                  }`}
                >
                  {isUser ? (
                    <div className="whitespace-pre-wrap font-sans">{m.content}</div>
                  ) : (
                    <div className="prose prose-invert max-w-none text-xs leading-relaxed">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          table: ({ children }: any) => (
                            <div className="my-3 overflow-x-auto rounded-lg border border-slate-700/60 shadow-inner bg-slate-900/60">
                              <table className="w-full text-left text-xs border-collapse font-sans">
                                {children}
                              </table>
                            </div>
                          ),
                          thead: ({ children }: any) => (
                            <thead className="bg-slate-800/90 text-slate-200 border-b border-slate-700/80 uppercase text-[10px] tracking-wider font-semibold">
                              {children}
                            </thead>
                          ),
                          tbody: ({ children }: any) => (
                            <tbody className="divide-y divide-slate-800/60 text-slate-300">
                              {children}
                            </tbody>
                          ),
                          th: ({ children }: any) => (
                            <th className="px-3 py-2 font-medium">{children}</th>
                          ),
                          td: ({ children }: any) => (
                            <td className="px-3 py-2 whitespace-normal">{children}</td>
                          ),
                          code: ({ inline, className, children, ...props }: any) => {
                            const match = /language-(\w+)/.exec(className || "");
                            const codeString = String(children).replace(/\n$/, "");
                            if (!inline && (match || codeString.includes("\n"))) {
                              return (
                                <CodeBlock
                                  language={match ? match[1] : "bash"}
                                  code={codeString}
                                />
                              );
                            }
                            return (
                              <code
                                className="px-1.5 py-0.5 rounded bg-slate-800/90 text-emerald-300 font-mono text-[11px] border border-white/5"
                                {...props}
                              >
                                {children}
                              </code>
                            );
                          },
                          p: ({ children }: any) => (
                            <p className="mb-2.5 last:mb-0 leading-relaxed text-slate-200">
                              {children}
                            </p>
                          ),
                          ul: ({ children }: any) => (
                            <ul className="mb-2.5 list-disc list-inside space-y-1 text-slate-300 pl-1">
                              {children}
                            </ul>
                          ),
                          ol: ({ children }: any) => (
                            <ol className="mb-2.5 list-decimal list-inside space-y-1 text-slate-300 pl-1">
                              {children}
                            </ol>
                          ),
                          li: ({ children }: any) => <li className="leading-relaxed">{children}</li>,
                          blockquote: ({ children }: any) => (
                            <blockquote className="border-l-2 border-emerald-500/60 pl-3 my-2 text-slate-400 italic bg-slate-900/30 py-1 rounded-r">
                              {children}
                            </blockquote>
                          ),
                          strong: ({ children }: any) => (
                            <strong className="font-semibold text-slate-100">{children}</strong>
                          ),
                          a: ({ href, children }: any) => (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
                            >
                              {children}
                            </a>
                          )
                        }}
                      >
                        {m.content}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>

                {/* Inline Tool Execution Summary Badges */}
                {!isUser && m.traces && m.traces.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {m.traces.map((trace, tIdx) => (
                      <div
                        key={tIdx}
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-900 border border-white/10 text-[10px] font-mono text-slate-400 shadow-sm"
                      >
                        {trace.tier === "browser" ? (
                          <Globe className="h-3 w-3 text-cyan-400" />
                        ) : (
                          <Cpu className="h-3 w-3 text-emerald-400" />
                        )}
                        <span className="text-slate-300 font-semibold">{trace.tool}</span>
                        <span>({trace.durationMs}ms)</span>
                      </div>
                    ))}
                    {onViewSecurityTelemetry && (
                      <button
                        type="button"
                        onClick={onViewSecurityTelemetry}
                        className="inline-flex items-center gap-1 text-[10px] text-cyan-400 hover:text-cyan-300 font-mono hover:underline ml-1"
                      >
                        <span>View Security Proof</span>
                        <ArrowRight className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </div>
                )}

                {/* Message Action Footer (Copy, Edit, Regenerate, Metrics) */}
                <div className="mt-1.5 flex items-center gap-2 text-[10px] text-slate-500 font-mono">
                  {isUser ? (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => handleEditPrompt(m.content)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
                        title="Edit prompt in input box"
                      >
                        <Edit3 className="h-3 w-3" />
                        <span>Edit</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(m.content, m.id)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
                        title="Copy prompt"
                      >
                        {isCopied ? (
                          <>
                            <Check className="h-3 w-3 text-emerald-400" />
                            <span className="text-emerald-400">Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => copyToClipboard(m.content, m.id)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
                        title="Copy response markdown"
                      >
                        {isCopied ? (
                          <>
                            <Check className="h-3 w-3 text-emerald-400" />
                            <span className="text-emerald-400">Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>

                      {isLastAssistant && (
                        <button
                          type="button"
                          onClick={handleRegenerate}
                          disabled={isLoading}
                          className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-40 transition-colors"
                          title="Regenerate response"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>Regenerate</span>
                        </button>
                      )}

                      {m.durationMs && (
                        <span className="text-slate-600">
                          {m.durationMs > 1000 ? `${(m.durationMs / 1000).toFixed(1)}s` : `${m.durationMs}ms`}
                        </span>
                      )}
                    </div>
                  )}
                </div>

              </div>

              {/* User Avatar */}
              {isUser && (
                <div className="h-8 w-8 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-300 shrink-0 mt-0.5 shadow-sm shadow-indigo-500/10">
                  <User className="h-4 w-4" />
                </div>
              )}
            </div>
          );
        })}

        {/* Loading Indicator */}
        {isLoading && (
          <div className="flex gap-3 sm:gap-4 justify-start">
            <div className="h-8 w-8 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0 shadow-sm shadow-emerald-500/10">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
            <div className="rounded-2xl rounded-tl-sm p-4 bg-slate-950/80 border border-white/10 text-xs text-slate-400 flex items-center gap-2.5">
              <Terminal className="h-4 w-4 text-cyan-400 animate-pulse" />
              <span>
                Orchestrating <span className="text-slate-200 font-mono">{activeModel}</span> & analyzing input...
              </span>
            </div>
          </div>
        )}

        {/* Error Alert */}
        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2.5 shadow-md">
            <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div ref={scrollRef} />
      </div>

      {/* Modern Floating Prompt Bar with Attachment Staging Area */}
      <div className="p-3 sm:p-4 bg-slate-950/80 border-t border-white/10">
        
        {/* Attachment Chips Preview Bar (when files are attached) */}
        {attachedFiles.length > 0 && (
          <div className="mb-2.5 flex flex-wrap items-center gap-2 p-2 rounded-xl bg-slate-900/90 border border-white/10">
            {attachedFiles.map((att) => (
              <div
                key={att.id}
                className="group relative flex items-center gap-2 p-1.5 pr-2 rounded-lg bg-slate-800 border border-white/10 text-xs text-slate-200"
              >
                {att.isImage && att.previewUrl ? (
                  <img
                    src={att.previewUrl}
                    alt={att.name}
                    className="h-7 w-7 rounded object-cover border border-white/10"
                  />
                ) : (
                  <FileText className="h-4 w-4 text-cyan-400 shrink-0" />
                )}
                <div className="flex flex-col">
                  <span className="max-w-[120px] sm:max-w-[160px] truncate font-medium text-[11px]">
                    {att.name}
                  </span>
                  <span className="text-[9px] text-slate-400 font-mono">
                    {formatFileSize(att.size)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveAttachment(att.id)}
                  className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-rose-400 transition-colors ml-1"
                  title="Remove file"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="relative flex items-center gap-2"
        >
          {/* File Attach Button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-white/10 text-slate-400 hover:text-cyan-400 transition-colors shadow-inner"
            title="Attach images (PNG, JPG) or documents (PDF, DOCX, Code)"
          >
            <Paperclip className="h-4 w-4" />
          </button>

          {/* Prompt Textarea */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={isLoading}
            placeholder={
              attachedFiles.length > 0
                ? "Ask questions about the attached files (or press Enter)..."
                : "Ask agent to write code, search the web, analyze documents or images (drop files here)..."
            }
            className="flex-1 bg-slate-900/90 border border-white/10 focus:border-emerald-500/60 rounded-xl px-4 py-3 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none resize-none transition-all shadow-inner"
          />

          {/* Send Button */}
          <button
            type="submit"
            disabled={(!input.trim() && attachedFiles.length === 0) || isLoading}
            className="p-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 text-white transition-all shrink-0 shadow-md shadow-emerald-500/20 active:scale-95"
            title="Send prompt"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>

        <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500 px-1 font-mono">
          <span className="hidden sm:inline">Supports PNG, JPG, PDF, DOCX, TXT, CSV, Code • Drag & Drop enabled</span>
          <span>Shift+Enter for new line • Enter ↵ to send</span>
        </div>
      </div>

    </div>
  );
}
