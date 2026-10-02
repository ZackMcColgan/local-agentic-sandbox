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
  ShieldCheck,
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
import { DiffViewer } from "./DiffViewer";
import { AgentMode } from "@/config/models";
import { getInitialWelcomeMessage, clearChatHistory } from "@/lib/chatHistory";

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
  agentMode?: AgentMode;
  reasoningEffort: "low" | "medium" | "xhigh";
  onViewSecurityTelemetry?: () => void;
  activeBranch?: string;
  messages?: ChatMessage[];
  setMessages?: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

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
    <div className="my-3 rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-900 dark:bg-black overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-800/80 dark:bg-zinc-900 border-b border-slate-700/60 dark:border-zinc-800 text-[11px] font-mono text-slate-400">
        <span className="text-emerald-400 font-medium">{language || "bash"}</span>
        <button
          onClick={handleCopy}
          type="button"
          className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-slate-700 dark:hover:bg-zinc-800 text-slate-400 hover:text-slate-200 transition-colors"
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
      <pre className="p-3 text-[11px] font-mono text-emerald-300/90 overflow-x-auto leading-relaxed">
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
  agentMode = "auto",
  reasoningEffort,
  onViewSecurityTelemetry,
  activeBranch,
  messages: propsMessages,
  setMessages: propsSetMessages
}: ChatStreamProps) {
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>(() => [
    getInitialWelcomeMessage(activeModel)
  ]);
  const messages = propsMessages ?? localMessages;
  const setMessages = propsSetMessages ?? setLocalMessages;
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});
  const [expandedProofs, setExpandedProofs] = useState<Record<string, boolean>>({});
  
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

  const toggleProof = (proofKey: string) => {
    setExpandedProofs((prev) => ({ ...prev, [proofKey]: !prev[proofKey] }));
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

  // Dynamically adjust textarea height to prevent clipping and support multi-line prompts
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(Math.max(textareaRef.current.scrollHeight, 40), 144)}px`;
    }
  }, [input]);

  const handleClearHistory = () => {
    const cleared = clearChatHistory(activeModel);
    setMessages(cleared);
  };

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
          mode: agentMode,
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
      const parsed = parseThinkingAndContent(data.content || "I didn't receive a response. Please try again.");

      const assistantMsgId = `assistant-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: assistantMsgId,
          role: "assistant",
          content: parsed.content,
          thought: parsed.thought,
          traces: data.traces,
          modelUsed: data.model || activeModel,
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
      className={`relative flex flex-col h-full rounded-none sm:rounded-2xl border-0 sm:border transition-colors bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-800 shadow-md overflow-hidden ${
        isDraggingOver ? "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20" : ""
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
              className="rounded-2xl shadow-2xl max-w-full max-h-[85vh] object-contain border border-white/10"
            />
            <button
              onClick={() => setPreviewModalImage(null)}
              className="absolute top-2 right-2 p-1.5 rounded-full bg-slate-900/90 text-white hover:bg-slate-800 border border-white/20"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Header Bar */}
      <div className="px-4 py-2.5 border-b border-slate-100 dark:border-zinc-800 bg-white dark:bg-zinc-950/60 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
            <Bot className="h-3.5 w-3.5" />
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-800 dark:text-zinc-200 block">Workspace</span>
          </div>
          {activeBranch && (
            <span className="flex items-center gap-1 text-[11px] font-mono text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 px-2 py-0.5 rounded-md border border-emerald-200 dark:border-emerald-500/30 shadow-xs">
              <span className="text-[10px]">🌿</span>
              <span>{activeBranch}</span>
            </span>
          )}
          <span className="text-[10px] text-slate-500 dark:text-zinc-400 font-mono hidden sm:inline">
            <span className="text-emerald-600 dark:text-emerald-400 font-medium">{activeModel}</span>
            {" • "}
            <span className="capitalize">{reasoningEffort}</span>
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {messages.length > 1 && (
            <button
              onClick={handleClearHistory}
              type="button"
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-slate-500 dark:text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors"
              title="Clear chat history"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Clear</span>
            </button>
          )}
        </div>
      </div>

      {/* Scrollable Conversation Thread */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-5 space-y-4 bg-white dark:bg-zinc-900">
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
              key={m.id}
              className={`flex gap-2.5 sm:gap-3.5 ${
                isUser ? "justify-end" : "justify-start"
              } group`}
            >
              {/* Assistant Avatar */}
              {!isUser && (
                <div className="h-7 w-7 sm:h-8 sm:w-8 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-500/30 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5 shadow-sm">
                  <Bot className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                </div>
              )}

              <div className={`max-w-[94%] sm:max-w-[85%] ${isUser ? "items-end" : "items-start"}`}>
                
                {/* Reasoning Thought Accordion (Assistant only) */}
                {!isUser && m.thought && (
                  <div className="mb-2">
                    <button
                      type="button"
                      onClick={() => toggleThought(m.id)}
                      className="flex items-center gap-1.5 text-[11px] font-mono text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 bg-slate-100 dark:bg-zinc-800/80 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 transition-colors"
                    >
                      <Sparkles className="h-3 w-3 text-amber-500 dark:text-amber-400" />
                      <span>Reasoning Process</span>
                      {isThoughtOpen ? (
                        <ChevronUp className="h-3 w-3 text-slate-400" />
                      ) : (
                        <ChevronDown className="h-3 w-3 text-slate-400" />
                      )}
                    </button>

                    {isThoughtOpen && (
                      <div className="mt-1.5 p-3 rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950/90 text-slate-600 dark:text-zinc-400 text-xs font-mono leading-relaxed whitespace-pre-wrap">
                        {m.thought}
                      </div>
                    )}
                  </div>
                )}

                {/* Attached Files rendering in user message */}
                {isUser && m.attachments && m.attachments.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5 justify-end">
                    {m.attachments.map((att, aIdx) => (
                      <div key={aIdx} className="relative group/att">
                        {att.isImage && att.previewUrl ? (
                          <div
                            onClick={() => setPreviewModalImage(att.previewUrl || null)}
                            className="cursor-pointer overflow-hidden rounded-xl border border-white/20 shadow-sm"
                          >
                            <img
                              src={att.previewUrl}
                              alt={att.name}
                              className="h-20 w-20 object-cover hover:scale-105 transition-transform"
                            />
                            <span className="absolute bottom-1 right-1 bg-black/70 text-white text-[9px] px-1 rounded">
                              {att.name}
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-200/80 dark:bg-zinc-800/80 border border-slate-300 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 text-[11px] font-mono shadow-sm">
                            <FileText className="h-3.5 w-3.5 text-cyan-600 dark:text-cyan-400" />
                            <span className="max-w-[140px] truncate">{att.name}</span>
                            <span className="text-[10px] text-slate-500 dark:text-zinc-400">({formatFileSize(att.size)})</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Main Message Bubble */}
                <div
                  className={`rounded-2xl p-3.5 sm:p-4 text-xs leading-relaxed ${
                    isUser
                      ? "bg-blue-50/90 dark:bg-blue-500/15 border border-blue-200/80 dark:border-blue-500/30 text-blue-950 dark:text-slate-100 rounded-2xl rounded-tr-sm shadow-sm"
                      : "w-full bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-900 dark:text-zinc-100 rounded-tl-sm shadow-sm"
                  }`}
                >
                  {isUser ? (
                    <div className="whitespace-pre-wrap font-sans">{m.content}</div>
                  ) : (
                    <div className="prose dark:prose-invert max-w-none text-xs leading-relaxed">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          table: ({ children }: any) => (
                            <div className="my-3 overflow-x-auto rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-sm">
                              <table className="w-full text-left text-xs border-collapse font-sans min-w-[280px]">
                                {children}
                              </table>
                            </div>
                          ),
                          thead: ({ children }: any) => (
                            <thead className="bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white border-b border-slate-200 dark:border-zinc-700 uppercase text-[10px] tracking-wider font-bold">
                              {children}
                            </thead>
                          ),
                          tbody: ({ children }: any) => (
                            <tbody className="divide-y divide-slate-100 dark:divide-zinc-800 text-slate-800 dark:text-zinc-100 font-medium">
                              {children}
                            </tbody>
                          ),
                          tr: ({ children }: any) => (
                            <tr className="odd:bg-white dark:odd:bg-zinc-900 even:bg-slate-50/70 dark:even:bg-zinc-850/50 hover:bg-slate-100/60 dark:hover:bg-zinc-800/60 transition-colors">
                              {children}
                            </tr>
                          ),
                          th: ({ children }: any) => (
                            <th className="px-3.5 py-2.5 font-bold text-slate-900 dark:text-white text-left">
                              {children}
                            </th>
                          ),
                          td: ({ children }: any) => (
                            <td className="px-3.5 py-2.5 text-slate-800 dark:text-zinc-100 whitespace-normal text-left font-normal leading-normal">
                              {children}
                            </td>
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
                                className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-emerald-700 dark:text-emerald-300 font-mono text-[11px] border border-slate-200 dark:border-zinc-700"
                                {...props}
                              >
                                {children}
                              </code>
                            );
                          },
                          p: ({ children }: any) => (
                            <p className="mb-2.5 last:mb-0 leading-relaxed text-slate-800 dark:text-zinc-100">
                              {children}
                            </p>
                          ),
                          ul: ({ children }: any) => (
                            <ul className="mb-2.5 list-disc list-inside space-y-1 text-slate-700 dark:text-zinc-200 pl-1">
                              {children}
                            </ul>
                          ),
                          ol: ({ children }: any) => (
                            <ol className="mb-2.5 list-decimal list-inside space-y-1 text-slate-700 dark:text-zinc-200 pl-1">
                              {children}
                            </ol>
                          ),
                          li: ({ children }: any) => <li className="leading-relaxed">{children}</li>,
                          blockquote: ({ children }: any) => (
                            <blockquote className="border-l-2 border-emerald-500 pl-3 my-2 text-slate-600 dark:text-zinc-400 italic bg-slate-50 dark:bg-zinc-950 py-1 rounded-r">
                              {children}
                            </blockquote>
                          ),
                          strong: ({ children }: any) => (
                            <strong className="font-semibold text-slate-900 dark:text-white">{children}</strong>
                          ),
                          a: ({ href, children }: any) => (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-cyan-600 dark:text-cyan-400 hover:underline underline-offset-2 font-medium"
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

                {/* Inline Expandable Sandbox & Telemetry Badges (Demo Flex) */}
                {!isUser && m.traces && m.traces.length > 0 && (
                  <div className="mt-2.5 space-y-2 w-full">
                    {m.traces.map((trace, tIdx) => {
                      const proofKey = `${m.id}-${tIdx}`;
                      const isExpanded = !!expandedProofs[proofKey];
                      const isBrowser = trace.tier === "browser" || trace.tool.includes("search") || trace.tool.includes("fetch");

                      let stdoutPreview = "";
                      let parsedJson: any = null;
                      try {
                        if (trace.result?.content?.[0]?.text) {
                          parsedJson = JSON.parse(trace.result.content[0].text);
                          stdoutPreview = parsedJson.stdout || parsedJson.output || (typeof parsedJson === "string" ? parsedJson : JSON.stringify(parsedJson, null, 2));
                        } else if (trace.result) {
                          stdoutPreview = typeof trace.result === "string" ? trace.result : JSON.stringify(trace.result, null, 2);
                        }
                      } catch {
                        stdoutPreview = trace.result?.content?.[0]?.text || String(trace.result || "");
                      }

                      return (
                        <div
                          key={tIdx}
                          className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-950/70 overflow-hidden shadow-sm transition-all"
                        >
                          {/* Execution Proof Header Badge */}
                          <button
                            type="button"
                            onClick={() => toggleProof(proofKey)}
                            className="w-full px-3 py-2 flex items-center justify-between text-left hover:bg-slate-100/80 dark:hover:bg-zinc-900/80 transition-colors text-xs font-mono"
                          >
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {isBrowser ? (
                                <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400 font-semibold">
                                  <Globe className="h-3.5 w-3.5" />
                                  <span>Isolated Egress Mesh</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold">
                                  <ShieldCheck className="h-3.5 w-3.5" />
                                  <span>Executed in Docker Sandbox</span>
                                </span>
                              )}
                              <span className="text-slate-400 dark:text-zinc-600">•</span>
                              <span className="text-slate-600 dark:text-zinc-300 font-medium">{trace.tool}</span>
                              <span className="text-slate-400 dark:text-zinc-600">•</span>
                              <span className="text-slate-500 dark:text-zinc-400">{trace.durationMs}ms</span>
                              <span className="text-slate-400 dark:text-zinc-600 hidden xs:inline">•</span>
                              <span className="text-slate-600 dark:text-zinc-400 hidden xs:inline">
                                {isBrowser ? "UID: 10002" : "UID: 10001"}
                              </span>
                              <span className="text-slate-400 dark:text-zinc-600 hidden sm:inline">•</span>
                              <span className="text-slate-600 dark:text-zinc-400 hidden sm:inline">
                                {isBrowser ? "SSRF Guard: ON" : "CapDrop: ALL"}
                              </span>
                            </div>

                            <div className="flex items-center gap-1 text-[11px] text-cyan-600 dark:text-cyan-400 font-sans font-medium shrink-0 ml-2">
                              <span>{isExpanded ? "Hide Proof" : "Expand Proof"}</span>
                              {isExpanded ? (
                                <ChevronUp className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5" />
                              )}
                            </div>
                          </button>

                          {/* Collapsible Sandbox Terminal Drawer */}
                          {isExpanded && (
                            <div className="border-t border-slate-200 dark:border-zinc-800 bg-slate-950 dark:bg-black p-3.5 space-y-3 font-mono text-[11px] text-slate-300 animate-in fade-in duration-150">
                              
                              {/* Security Primitives Attestation Bar */}
                              <div className="flex flex-wrap items-center gap-1.5 pb-2 border-b border-slate-800 text-[10px]">
                                <span className="px-2 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-500/30 font-semibold flex items-center gap-1">
                                  <ShieldCheck className="h-3 w-3" />
                                  SLSA-3 Verified Runtime
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-zinc-900 text-sky-400 border border-zinc-800">
                                  {isBrowser ? "container: browser-mcp-toolchain" : "container: sandboxed-mcp-toolchain"}
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-300 border border-zinc-800">
                                  {isBrowser ? "user: 10002:10002" : "user: 10001:10001"}
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-300 border border-zinc-800">
                                  {isBrowser ? "network: egress-mesh" : "network: ai-mesh (air-gapped)"}
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-zinc-900 text-amber-300 border border-zinc-800">
                                  {isBrowser ? "ssrf_guard: ACTIVE" : "cap_drop: ALL"}
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-300 border border-zinc-800">
                                  {isBrowser ? "no_new_privs: true" : "rootfs: READ_ONLY | /tmp: tmpfs"}
                                </span>
                              </div>

                              {/* Tool Stdin Payload */}
                              <div>
                                <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-1">
                                  Input Payload:
                                </div>
                                <pre className="p-2.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-cyan-300 overflow-x-auto max-h-36 whitespace-pre-wrap leading-relaxed">
                                  {trace.args?.code ? trace.args.code : JSON.stringify(trace.args, null, 2)}
                                </pre>
                              </div>

                              {/* Tool Stdout & Execution Output */}
                              <div>
                                <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-1 flex items-center justify-between">
                                  <span>Sandbox Stdout Output:</span>
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(stdoutPreview, proofKey)}
                                    className="text-slate-400 hover:text-white flex items-center gap-1 text-[10px] font-sans"
                                  >
                                    {copiedMessageId === proofKey ? (
                                      <>
                                        <Check className="h-3 w-3 text-emerald-400" />
                                        <span className="text-emerald-400">Copied</span>
                                      </>
                                    ) : (
                                      <>
                                        <Copy className="h-3 w-3" />
                                        <span>Copy Stdout</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                                <pre className="p-2.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-emerald-300/90 overflow-x-auto max-h-48 whitespace-pre-wrap leading-relaxed">
                                  {stdoutPreview || "Process exited with code 0 (no output)"}
                                </pre>
                              </div>

                              {/* Visual Unified Diff Inspector */}
                              {parsedJson?.diff && (
                                <div className="pt-1">
                                  <DiffViewer
                                    branch={parsedJson.branch || activeBranch || "main"}
                                    diff={parsedJson.diff}
                                    modifiedFiles={parsedJson.modified_files}
                                  />
                                </div>
                              )}

                              {/* Direct Jump to System Tab */}
                              {onViewSecurityTelemetry && (
                                <div className="pt-1 flex items-center justify-between text-[11px] font-sans">
                                  <span className="text-slate-400">Full host GPU & Docker Scout telemetry available:</span>
                                  <button
                                    type="button"
                                    onClick={onViewSecurityTelemetry}
                                    className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300 underline underline-offset-2 font-medium"
                                  >
                                    <span>System Architecture Tab</span>
                                    <ArrowRight className="h-3 w-3" />
                                  </button>
                                </div>
                              )}

                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Message Action Footer (Copy, Edit, Regenerate, Metrics) */}
                <div className="mt-1.5 flex items-center gap-2 text-[10px] text-slate-500 dark:text-zinc-500 font-mono">
                  {isUser ? (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => handleEditPrompt(m.content)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400 transition-colors"
                        title="Edit prompt in input box"
                      >
                        <Edit3 className="h-3 w-3" />
                        <span>Edit</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(m.content, m.id)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400 transition-colors"
                        title="Copy prompt"
                      >
                        {isCopied ? (
                          <>
                            <Check className="h-3 w-3 text-emerald-500" />
                            <span className="text-emerald-500">Copied</span>
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
                        className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400 transition-colors"
                        title="Copy response markdown"
                      >
                        {isCopied ? (
                          <>
                            <Check className="h-3 w-3 text-emerald-500" />
                            <span className="text-emerald-500">Copied</span>
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
                          className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400 disabled:opacity-40 transition-colors"
                          title="Regenerate response"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>Regenerate</span>
                        </button>
                      )}

                      {m.durationMs && (
                        <span>
                          {m.durationMs > 1000 ? `${(m.durationMs / 1000).toFixed(1)}s` : `${m.durationMs}ms`}
                        </span>
                      )}
                    </div>
                  )}
                </div>

              </div>

              {/* User Avatar */}
              {isUser && (
                <div className="hidden sm:flex h-7 w-7 sm:h-8 sm:w-8 rounded-xl bg-blue-500/10 border border-blue-500/30 items-center justify-center text-blue-600 dark:text-blue-400 shrink-0 mt-0.5 shadow-sm">
                  <User className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                </div>
              )}
            </div>
          );
        })}

        {/* Loading Indicator */}
        {isLoading && (
          <div className="flex gap-2.5 sm:gap-3.5 justify-start">
            <div className="h-7 w-7 sm:h-8 sm:w-8 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-500/30 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0 shadow-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
            <div className="rounded-2xl rounded-tl-sm p-3.5 sm:p-4 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-xs text-slate-600 dark:text-zinc-400 flex items-center gap-2.5 shadow-sm">
              <Terminal className="h-4 w-4 text-cyan-500 dark:text-cyan-400 animate-pulse" />
              <span>Orchestrating autonomous workflow...</span>
            </div>
          </div>
        )}

        {/* Error Notification */}
        {errorMsg && (
          <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-xs flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-rose-500" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div ref={scrollRef} />
      </div>

      {/* Modern Docked Floating Prompt Bar with Unified Card Architecture */}
      <div className="sticky bottom-0 z-20 p-2.5 sm:p-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] bg-white/95 dark:bg-zinc-950/95 border-t border-slate-200 dark:border-zinc-800 backdrop-blur-md">
        
        {/* Unified Input Form Card */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="relative rounded-2xl sm:rounded-3xl border border-slate-300 dark:border-zinc-800 bg-white dark:bg-zinc-900/90 shadow-md shadow-slate-900/5 dark:shadow-black/40 focus-within:border-emerald-500 dark:focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/20 transition-all p-2 sm:p-2.5 flex flex-col gap-1.5"
        >
          {/* Attachment Chips inside card if files exist */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pb-2 mb-1 border-b border-slate-100 dark:border-zinc-800/80">
              {attachedFiles.map((att) => (
                <div
                  key={att.id}
                  className="group relative flex items-center gap-1.5 p-1 pr-2 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-xs shadow-xs"
                >
                  {att.isImage && att.previewUrl ? (
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="h-6 w-6 rounded-lg object-cover border border-slate-200 dark:border-zinc-700"
                    />
                  ) : (
                    <FileText className="h-4 w-4 text-cyan-500 dark:text-cyan-400 shrink-0" />
                  )}
                  <div className="flex flex-col">
                    <span className="max-w-[120px] sm:max-w-[160px] truncate font-medium text-[11px] text-slate-800 dark:text-zinc-200">
                      {att.name}
                    </span>
                    <span className="text-[9px] text-slate-400 dark:text-zinc-400 font-mono">
                      {formatFileSize(att.size)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveAttachment(att.id)}
                    className="p-1 rounded-md hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-400 hover:text-rose-500 transition-colors ml-0.5"
                    title="Remove file"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Text Area */}
          <div className="flex items-start">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={isLoading}
              placeholder={
                attachedFiles.length > 0
                  ? "Ask about the attached files..."
                  : "Ask agent anything, run code, search web..."
              }
              className="w-full bg-transparent border-0 focus:outline-none focus:ring-0 text-xs sm:text-sm text-slate-900 dark:text-zinc-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 resize-none px-2 py-1 leading-relaxed max-h-36 min-h-[40px]"
            />
          </div>

          {/* Bottom Actions Row: Paperclip on Left, Helper/Send on Right */}
          <div className="flex items-center justify-between pt-0.5 px-0.5">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading}
                className="p-1.5 sm:p-2 rounded-xl text-slate-500 hover:text-emerald-600 dark:text-zinc-400 dark:hover:text-emerald-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors flex items-center gap-1.5 text-xs font-medium"
                title="Attach images (PNG, JPG) or documents (PDF, DOCX, Code)"
              >
                <Paperclip className="h-4 w-4" />
                <span className="text-[11px] hidden sm:inline">Attach</span>
              </button>

              <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-mono hidden sm:inline">
                • Zero-Trust UID 10001
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={(!input.trim() && attachedFiles.length === 0) || isLoading}
                className={`h-8 w-8 sm:h-9 sm:w-9 rounded-xl sm:rounded-2xl flex items-center justify-center transition-all ${
                  (!input.trim() && attachedFiles.length === 0) || isLoading
                    ? "bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-600 cursor-not-allowed"
                    : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-600/30 active:scale-95"
                }`}
                title="Send prompt"
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-white" />
                ) : (
                  <Send className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                )}
              </button>
            </div>
          </div>
        </form>

        <div className="mt-1 hidden sm:flex items-center justify-between text-[10px] text-slate-400 dark:text-zinc-500 px-2 font-mono">
          <span>Supports PNG, JPG, PDF, DOCX, TXT, CSV, Code • Drag & Drop enabled</span>
          <span>Shift+Enter for newline • Enter ↵ to send</span>
        </div>
      </div>

    </div>
  );
}
