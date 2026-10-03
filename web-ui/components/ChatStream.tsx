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
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Globe,
  Trash2,
  Paperclip,
  FileText,
  X,
  Square,
  ChevronLeft,
  MoreHorizontal
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExecutionTraceItem } from "./ExecutionTrace";
import { copyText } from "../lib/clipboard";
import { DiffViewer } from "./DiffViewer";
import { SvgViewer, SvgFileLink } from "./SvgViewer";
import { LiveRunBlock } from "./LiveRunBlock";
import { isSvgCode, isSvgFilePath, resolveSvgUrl, wrapRawSvgInMarkdown, extractSvgsFromMessage } from "../lib/svgUtils";
import { AgentMode, isReasoningEffortSupported } from "../config/models";
import { getInitialWelcomeMessage, clearChatHistory } from "../lib/chatHistory";
import { parseThinkingAndContent } from "../lib/chatUtils";
import { TaskManifest } from "../lib/subagents/types";

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
  taskId?: string;
  isStopped?: boolean;
  timestamp?: string;
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
  threadId?: string;
  threadTitle?: string;
  threadStatus?: "active" | "stopped" | "completed" | "failed";
  activeTask?: TaskManifest | null;
  onStopTask?: () => Promise<void> | void;
  onBackToList?: () => void;
  onOpenModelSheet?: () => void;
  onLaunchTask?: (goal: string, attachments?: any[]) => Promise<void>;
  onNewThread?: () => void;
  onDeleteThread?: () => void;
  onSendMessage?: (content: string, attachments?: any[]) => Promise<void>;
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

  if (isSvgCode(code, language)) {
    return (
      <div className="my-3">
        <SvgViewer
          code={code}
          title={language ? `${language.toUpperCase()} Vector Graphic` : "SVG Vector Graphic"}
          initialTab="preview"
          allowFullscreen={true}
        />
      </div>
    );
  }

  const handleCopy = async () => {
    const ok = await copyText(code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="my-3 rounded-2xl border border-slate-200/90 dark:border-zinc-800 bg-[#f4eff4] dark:bg-[#201a24] overflow-hidden shadow-xs">
      <div className="flex items-center justify-between px-3.5 py-2 bg-[#ece6f0] dark:bg-[#2b2930] border-b border-slate-200 dark:border-zinc-800 text-[11px] font-mono text-slate-600 dark:text-zinc-400">
        <span className="text-[#6750a4] dark:text-[#d0bcff] font-semibold">{language || "bash"}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 hover:text-[#1d1b20] dark:hover:text-white transition-colors"
          title="Copy code"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-3.5 text-xs font-mono text-[#1d1b20] dark:text-[#e6e0e9] overflow-x-auto leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function ChatStream({
  onTracesUpdate,
  activeModel,
  agentMode = "auto",
  reasoningEffort,
  onViewSecurityTelemetry,
  activeBranch,
  messages: propsMessages,
  setMessages: propsSetMessages,
  threadId,
  threadTitle,
  threadStatus,
  activeTask,
  onStopTask,
  onBackToList,
  onOpenModelSheet,
  onLaunchTask,
  onNewThread,
  onDeleteThread,
  onSendMessage
}: ChatStreamProps) {
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>(() => [
    getInitialWelcomeMessage(activeModel)
  ]);
  const messages = propsMessages ?? localMessages;
  const setMessages = propsSetMessages ?? setLocalMessages;

  // Single M3 input field: starts completely empty, no starter chips, no default prompt!
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isStoppingTask, setIsStoppingTask] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});
  const [expandedProofs, setExpandedProofs] = useState<Record<string, boolean>>({});
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);

  // Attached files state
  const [attachedFiles, setAttachedFiles] = useState<AttachedFileItem[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [previewModalImage, setPreviewModalImage] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const isTaskActive = activeTask?.status === "active";
  const isGeneratingOrRunning = isLoading || isTaskActive;

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading, isTaskActive]);

  const toggleThought = (msgId: string) => {
    setExpandedThoughts((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  const toggleProof = (proofKey: string) => {
    setExpandedProofs((prev) => ({ ...prev, [proofKey]: !prev[proofKey] }));
  };

  const copyToClipboard = async (text: string, msgId: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopiedMessageId(msgId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    }
  };

  // Auto-expanding textarea: min 3 rows (72px), grows smoothly with content, never truncates
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const scrollH = textareaRef.current.scrollHeight;
      textareaRef.current.style.height = `${Math.max(scrollH, 72)}px`;
    }
  }, [input]);

  const processFiles = async (fileList: FileList) => {
    const newItems: AttachedFileItem[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const isImg = f.type.startsWith("image/");
      try {
        const b64 = await fileToBase64(f);
        newItems.push({
          id: `att-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          name: f.name,
          type: f.type || "application/octet-stream",
          size: f.size,
          previewUrl: isImg ? b64 : undefined,
          base64: b64,
          isImage: isImg
        });
      } catch (err) {
        console.error("Failed to read attached file:", f.name, err);
      }
    }
    setAttachedFiles((prev) => [...prev, ...newItems]);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      e.target.value = "";
    }
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachedFiles((prev) => prev.filter((a) => a.id !== id));
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

  // Stop Generation / Abort Controller
  const handleStop = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (onStopTask && isTaskActive) {
      setIsStoppingTask(true);
      try {
        await onStopTask();
      } finally {
        setIsStoppingTask(false);
      }
    }
    setIsLoading(false);
    setStreamStatus(null);
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role === "assistant") {
        return [
          ...prev.slice(0, -1),
          {
            ...last,
            isStopped: true,
            content: last.content ? `${last.content}\n\n*[Stopped by user]*` : "*[Stopped by user]*"
          }
        ];
      }
      return prev;
    });
  };

  const handleSend = async (textToSend?: string) => {
    const prompt = (textToSend || input).trim();
    if ((!prompt && attachedFiles.length === 0) || isGeneratingOrRunning) return;

    setErrorMsg(null);
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "72px";
    }

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

    // Check if this is an engineering builder task (e.g. "Rebuild...", "Build...", "Implement...", etc.)
    const isBuilderPrompt = /^(rebuild|build|implement|create|refactor|migrate|generate diagram|run regression|audit)\b/i.test(prompt);

    if (isBuilderPrompt && onLaunchTask) {
      setIsLoading(true);
      setStreamStatus("Planning autonomous milestones with real Ollama model...");
      try {
        await onLaunchTask(prompt, currentAttachments);
      } catch (err: any) {
        setErrorMsg(err.message || "Failed to launch builder task");
      } finally {
        setIsLoading(false);
        setStreamStatus(null);
      }
      return;
    }

    // Otherwise, dispatch to standard streaming chat path
    setIsLoading(true);
    setStreamStatus("Connecting to model...");

    const startTime = performance.now();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          messages: updatedMessages.map((m) => ({ role: m.role, content: m.content })),
          model: activeModel,
          mode: agentMode,
          reasoning_effort: reasoningEffort,
          threadId,
          attachments: currentAttachments.map(a => ({
            name: a.name,
            type: a.type,
            size: a.size,
            base64: a.base64
          }))
        })
      });

      if (!res.ok) {
        let errMessage = "Failed to orchestrate request";
        try {
          const errJson = await res.json();
          errMessage = errJson.error || errMessage;
        } catch {}
        throw new Error(errMessage);
      }

      const assistantMsgId = `assistant-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: assistantMsgId,
          role: "assistant",
          content: "",
          thought: "",
          traces: [],
          modelUsed: activeModel
        }
      ]);

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error("No readable stream received from server");
      }

      const decoder = new TextDecoder();
      let streamBuffer = "";
      let accumulatedRawContent = "";
      let currentTraces: ExecutionTraceItem[] = [];
      let currentModel = activeModel;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        streamBuffer += decoder.decode(value, { stream: true });
        const blocks = streamBuffer.split("\n\n");
        streamBuffer = blocks.pop() || "";

        for (const block of blocks) {
          const trimmed = block.trim();
          if (!trimmed.startsWith("data:")) continue;
          const jsonStr = trimmed.replace(/^data:\s*/, "");
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);

            if (event.type === "meta") {
              if (event.model) currentModel = event.model;
            } else if (event.type === "status") {
              setStreamStatus(event.status);
            } else if (event.type === "token") {
              accumulatedRawContent += event.content || "";
              const parsed = parseThinkingAndContent(accumulatedRawContent);
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMsgId
                    ? {
                        ...msg,
                        content: parsed.content,
                        thought: parsed.thought,
                        modelUsed: currentModel
                      }
                    : msg
                )
              );
            } else if (event.type === "trace") {
              currentTraces = [...currentTraces, event.trace];
              onTracesUpdate(currentTraces);
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMsgId
                    ? {
                        ...msg,
                        traces: currentTraces
                      }
                    : msg
                )
              );
            } else if (event.type === "done") {
              const durationMs = Math.round(performance.now() - startTime);
              const parsed = parseThinkingAndContent(event.content || accumulatedRawContent);
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMsgId
                    ? {
                        ...msg,
                        content: parsed.content,
                        thought: event.thought !== undefined ? event.thought : parsed.thought,
                        traces: event.traces || currentTraces,
                        modelUsed: event.model || currentModel,
                        durationMs: event.durationMs || durationMs
                      }
                    : msg
                )
              );
            } else if (event.type === "error") {
              throw new Error(event.error || "Streaming error encountered");
            }
          } catch (parseErr: any) {
            if (parseErr.message && !parseErr.message.includes("JSON.parse")) {
              throw parseErr;
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.log("Chat stream aborted by user");
      } else {
        console.error(err);
        setErrorMsg(err.message || "Failed to communicate with agent orchestrator");
      }
    } finally {
      setIsLoading(false);
      setStreamStatus(null);
      abortControllerRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const modelSafe = activeModel || "qwen3.8:27b-q3_k_m";
  const shortModelLabel = modelSafe.includes("qwen")
    ? "qwen3.8"
    : modelSafe.includes("gemma")
    ? "gemma4:e4b"
    : modelSafe.split(":")[0];

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative flex flex-col h-full bg-white dark:bg-zinc-950 transition-colors overflow-hidden ${
        isDraggingOver ? "bg-purple-50/30 dark:bg-indigo-950/20" : ""
      }`}
    >
      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.md,.txt,.drawio,.xml,.json,.csv"
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

      {/* Top Bar matching Mockup 1 & 3 */}
      <header className="px-4 py-3 border-b border-slate-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {onBackToList && (
            <button
              type="button"
              onClick={onBackToList}
              className="p-1.5 -ml-1 rounded-full text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors shrink-0"
              title="Back to sessions"
              aria-label="Back to sessions"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          )}

          <h1 className="text-base sm:text-lg font-bold tracking-tight text-slate-900 dark:text-zinc-100 truncate">
            {threadTitle || "New task"}
          </h1>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Model Chip Button: opens ModelBottomSheet on tap */}
          <button
            type="button"
            onClick={onOpenModelSheet}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white dark:bg-zinc-900 border border-[#c4b5fd] dark:border-indigo-800 text-xs font-semibold text-[#5b32e6] dark:text-indigo-400 shadow-xs hover:bg-[#fbfbfe] transition-colors"
            title="Configure model and thinking effort"
          >
            <Sparkles className="h-3.5 w-3.5 text-[#5b32e6] dark:text-indigo-400" />
            <span>{shortModelLabel}</span>
          </button>

          {/* Overflow Menu Button */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowOverflowMenu(!showOverflowMenu)}
              className="p-1.5 rounded-full text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 transition-colors"
              title="More options"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>

            {showOverflowMenu && (
              <div
                className="absolute right-0 mt-1 w-52 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xl p-1 z-30 animate-in fade-in zoom-in-95 duration-100"
                onClick={() => setShowOverflowMenu(false)}
              >
                {onNewThread && (
                  <button
                    type="button"
                    onClick={onNewThread}
                    className="w-full text-left px-3 py-2 text-xs font-medium text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-xl"
                  >
                    New thread
                  </button>
                )}
                {onViewSecurityTelemetry && (
                  <button
                    type="button"
                    onClick={onViewSecurityTelemetry}
                    className="w-full text-left px-3 py-2 text-xs font-medium text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-xl"
                  >
                    Security telemetry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      const isDark = document.documentElement.classList.contains("dark");
                      const next = isDark ? "light" : "dark";
                      document.documentElement.classList.toggle("dark", next === "dark");
                      document.documentElement.classList.toggle("light", next === "light");
                      document.documentElement.setAttribute("data-theme", next);
                      document.documentElement.style.colorScheme = next;
                      document.body.classList.toggle("dark", next === "dark");
                      document.body.classList.toggle("light", next === "light");
                      localStorage.setItem("app-theme", next);
                    }
                  }}
                  className="w-full text-left px-3 py-2 text-xs font-medium text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-xl flex items-center justify-between"
                >
                  <span>Toggle theme</span>
                  <span className="text-[10px] text-[#6750a4] dark:text-[#d0bcff] font-semibold">Light / Dark</span>
                </button>
                {onDeleteThread && (
                  <button
                    type="button"
                    onClick={onDeleteThread}
                    className="w-full text-left px-3 py-2 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-xl"
                  >
                    Delete session
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const seed = clearChatHistory(activeModel);
                    setMessages(seed);
                  }}
                  className="w-full text-left px-3 py-2 text-xs font-medium text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-xl"
                >
                  Clear messages
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Conversation Thread Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-5 bg-white dark:bg-zinc-950">
        {messages.map((m, idx) => {
          const isUser = m.role === "user";
          const isCopied = copiedMessageId === m.id;
          const isThoughtOpen = expandedThoughts[m.id] !== undefined ? expandedThoughts[m.id] : true;
          const hasLinkedTask = m.taskId || (activeTask && idx === messages.length - 1 && activeTask.status === "active");

          return (
            <div
              key={m.id}
              className={`flex flex-col ${isUser ? "items-end" : "items-start"} space-y-1.5`}
            >
              {/* Attached Files rendering in user message */}
              {isUser && m.attachments && m.attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 justify-end max-w-md">
                  {m.attachments.map((att, aIdx) => (
                    <div key={aIdx} className="relative group/att">
                      {att.isImage && att.previewUrl ? (
                        <div
                          onClick={() => setPreviewModalImage(att.previewUrl || null)}
                          className="cursor-pointer overflow-hidden rounded-2xl border border-slate-200 dark:border-zinc-700 shadow-xs"
                        >
                          <img
                            src={att.previewUrl}
                            alt={att.name}
                            className="h-20 w-20 object-cover hover:scale-105 transition-transform"
                          />
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-zinc-850 border border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-200 text-xs font-medium shadow-xs">
                          <FileText className="h-4 w-4 text-[#5b32e6] dark:text-indigo-400" />
                          <span className="max-w-[140px] truncate">{att.name}</span>
                          <span className="text-[10px] text-slate-400">({formatFileSize(att.size)})</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* User Bubble: vibrant rounded purple pill matching Mockup 1 & 3 */}
              {isUser ? (
                <div className="flex flex-col items-end max-w-[88%] sm:max-w-lg">
                  <div className="bg-[#3b0799] text-white rounded-2xl rounded-tr-sm p-4 shadow-sm text-sm font-normal leading-relaxed">
                    <div className="prose prose-invert max-w-none text-sm text-white">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          code: ({ children }: any) => (
                            <code className="px-1.5 py-0.5 rounded bg-white/20 text-white font-mono text-xs">
                              {children}
                            </code>
                          ),
                          p: ({ children }: any) => <p className="mb-1 last:mb-0 leading-relaxed text-white">{children}</p>
                        }}
                      >
                        {m.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                  {m.timestamp && (
                    <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-1 mr-1">
                      {m.timestamp}
                    </div>
                  )}
                </div>
              ) : (
                /* Assistant Message View */
                <div className="w-full max-w-2xl space-y-3">
                  {/* Reasoning Thought Accordion */}
                  {(m.thought || (isLoading && idx === messages.length - 1 && !m.content)) && (
                    <div className="w-full">
                      <button
                        type="button"
                        onClick={() => toggleThought(m.id)}
                        className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-zinc-200 bg-slate-100 hover:bg-slate-200/80 dark:bg-zinc-900 dark:hover:bg-zinc-850 px-3.5 py-2 rounded-2xl border border-slate-200/80 dark:border-zinc-800 transition-colors"
                      >
                        <Sparkles className="h-4 w-4 text-[#5b32e6] dark:text-indigo-400" />
                        <span>Thinking · 3 steps</span>
                        {isThoughtOpen ? (
                          <ChevronUp className="h-3.5 w-3.5 text-slate-500 ml-1" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 text-slate-500 ml-1" />
                        )}
                      </button>

                      {isThoughtOpen && (
                        <div className="mt-2 p-3.5 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-900/60 text-slate-600 dark:text-zinc-400 text-xs font-mono leading-relaxed whitespace-pre-wrap">
                          {m.thought || "Analyzing prompt and formulating execution plan..."}
                          {isLoading && idx === messages.length - 1 && !m.content && (
                            <span className="inline-block w-2 h-3.5 ml-1 bg-[#5b32e6] animate-pulse align-middle" />
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Inline Live Run Block if this message represents a builder task */}
                  {hasLinkedTask && activeTask && (
                    <LiveRunBlock
                      task={activeTask}
                      onStopRun={onStopTask}
                      isStopping={isStoppingTask}
                    />
                  )}

                  {/* Text Markdown Content */}
                  {m.content && (
                    <div className="text-[15px] leading-[1.6] max-w-[72ch] text-[#1d1b20] dark:text-[#e6e0e9] font-sans">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          code: ({ inline, className, children, ...props }: any) => {
                            const match = /language-(\w+)/.exec(className || "");
                            const codeString = String(children).replace(/\n$/, "");
                            const isSvg = isSvgCode(codeString, match ? match[1] : undefined);
                            if (!inline && (match || codeString.includes("\n") || isSvg)) {
                              return (
                                <CodeBlock
                                  language={match ? match[1] : (isSvg ? "svg" : "bash")}
                                  code={codeString}
                                />
                              );
                            }
                            if (inline && isSvgFilePath(codeString)) {
                              return (
                                <SvgFileLink href={resolveSvgUrl(codeString)} rawHref={codeString}>
                                  {children}
                                </SvgFileLink>
                              );
                            }
                            return (
                              <code
                                className="px-1.5 py-0.5 rounded bg-[#f4eff4] dark:bg-[#2b2930] text-[#6750a4] dark:text-[#d0bcff] font-mono text-xs border border-slate-200 dark:border-zinc-700"
                                {...props}
                              >
                                {children}
                              </code>
                            );
                          },
                          p: ({ children }: any) => (
                            <p className="mb-3 last:mb-0 leading-[1.6] text-[#1d1b20] dark:text-[#e6e0e9]">
                              {children}
                            </p>
                          ),
                          ul: ({ children }: any) => (
                            <ul className="list-disc pl-5 my-3 space-y-1.5 leading-[1.6] text-[#1d1b20] dark:text-[#e6e0e9]">
                              {children}
                            </ul>
                          ),
                          ol: ({ children }: any) => (
                            <ol className="list-decimal pl-5 my-3 space-y-1.5 leading-[1.6] text-[#1d1b20] dark:text-[#e6e0e9]">
                              {children}
                            </ol>
                          ),
                          li: ({ children }: any) => (
                            <li className="leading-[1.6]">
                              {children}
                            </li>
                          ),
                          blockquote: ({ children }: any) => (
                            <blockquote className="border-l-4 border-[#6750a4] bg-[#fdf8fd]/80 dark:bg-[#1d1b20]/60 pl-3.5 py-1.5 my-3 italic text-slate-700 dark:text-zinc-300 rounded-r-xl">
                              {children}
                            </blockquote>
                          ),
                          table: ({ children }: any) => (
                            <div className="overflow-x-auto my-3 rounded-xl border border-slate-200 dark:border-zinc-800">
                              <table className="min-w-full text-left text-xs divide-y divide-slate-200 dark:divide-zinc-800">
                                {children}
                              </table>
                            </div>
                          ),
                          thead: ({ children }: any) => (
                            <thead className="bg-[#f4eff4] dark:bg-[#2b2930] text-slate-900 dark:text-zinc-100 font-semibold">
                              {children}
                            </thead>
                          ),
                          tbody: ({ children }: any) => (
                            <tbody className="divide-y divide-slate-100 dark:divide-zinc-800 bg-white dark:bg-zinc-900">
                              {children}
                            </tbody>
                          ),
                          tr: ({ children }: any) => (
                            <tr className="hover:bg-slate-50/50 dark:hover:bg-zinc-850/50 transition-colors">
                              {children}
                            </tr>
                          ),
                          th: ({ children }: any) => (
                            <th className="px-3.5 py-2 font-semibold text-xs tracking-wider">
                              {children}
                            </th>
                          ),
                          td: ({ children }: any) => (
                            <td className="px-3.5 py-2 text-xs leading-relaxed text-slate-800 dark:text-zinc-200">
                              {children}
                            </td>
                          ),
                          h1: ({ children }: any) => (
                            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-zinc-100 mt-4 mb-2 first:mt-0">
                              {children}
                            </h1>
                          ),
                          h2: ({ children }: any) => (
                            <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-zinc-100 mt-3.5 mb-1.5">
                              {children}
                            </h2>
                          ),
                          h3: ({ children }: any) => (
                            <h3 className="text-base font-semibold tracking-tight text-slate-900 dark:text-zinc-100 mt-3 mb-1">
                              {children}
                            </h3>
                          )
                        }}
                      >
                        {wrapRawSvgInMarkdown(m.content)}
                      </ReactMarkdown>

                      {/* Tool Generated SVG Visual Artifacts */}
                      {(() => {
                        const messageSvgs = extractSvgsFromMessage(m);
                        if (messageSvgs.length === 0) return null;
                        return (
                          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-zinc-800 space-y-4 not-prose">
                            {messageSvgs.map((svg) => (
                              <div key={svg.id} className="space-y-1.5">
                                <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 dark:text-zinc-400">
                                  <span className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                                    <Sparkles className="h-3.5 w-3.5" />
                                    <span>Rendered Vector Diagram: {svg.title}</span>
                                  </span>
                                </div>
                                <SvgViewer
                                  code={svg.code}
                                  url={svg.url}
                                  title={svg.title}
                                  initialTab="preview"
                                  allowFullscreen={true}
                                />
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* Inline Expandable Sandbox & Telemetry Badges */}
                  {!isUser && m.traces && m.traces.length > 0 && (
                    <div className="mt-2.5 space-y-2 w-full">
                      {m.traces.map((trace, tIdx) => {
                        const proofKey = `${m.id}-${tIdx}`;
                        const isExpanded = !!expandedProofs[proofKey];
                        const isBrowser = trace.tier === "browser" || trace.tool.includes("search") || trace.tool.includes("fetch");

                        return (
                          <div
                            key={tIdx}
                            className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-900/60 overflow-hidden shadow-xs transition-all"
                          >
                            <button
                              type="button"
                              onClick={() => toggleProof(proofKey)}
                              className="w-full px-3.5 py-2 flex items-center justify-between text-left hover:bg-slate-100/80 dark:hover:bg-zinc-850/80 transition-colors text-xs font-mono"
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

                            {isExpanded && (
                              <div className="border-t border-slate-200 dark:border-zinc-800 bg-slate-950 p-3 font-mono text-[11px] text-slate-300">
                                <pre className="p-2 rounded bg-zinc-900 text-cyan-300 overflow-x-auto whitespace-pre-wrap">
                                  {trace.args ? JSON.stringify(trace.args, null, 2) : ""}
                                </pre>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Grounded File Citation Card matching Mockup 4 */}
                  {m.traces && m.traces.some((t: any) => t.tool?.includes("file") || t.args?.path || (t.name && String(t.name).includes(".ts"))) && (
                    <div className="flex flex-wrap gap-2 pt-1 max-w-sm">
                      {m.traces.filter((t: any) => t.args?.path || (t.name && String(t.name).includes(".ts"))).slice(0, 3).map((t: any, cIdx) => {
                        const pathLabel = t.args?.path || t.name || "workerPool.ts:342";
                        return (
                          <div
                            key={cIdx}
                            className="flex items-center justify-between w-full p-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200/90 dark:border-zinc-800 shadow-xs text-xs font-mono text-slate-800 dark:text-zinc-200"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <FileText className="h-4 w-4 text-[#5b32e6] dark:text-indigo-400 shrink-0" />
                              <span className="font-semibold truncate">{pathLabel}</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(pathLabel, `${m.id}-${cIdx}`)}
                              className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 shrink-0 ml-2"
                              title="Copy path"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Partial output stopped indicator */}
                  {m.isStopped && (
                    <div className="inline-block px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-850 text-slate-600 dark:text-zinc-400 text-xs font-mono border border-slate-200 dark:border-zinc-800">
                      • Stopped
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Render LiveRunBlock if activeTask is present and not already embedded in an assistant message */}
        {activeTask && !messages.some(m => m.taskId === activeTask.taskId && m.role === 'assistant') && (
          <div className="w-full max-w-2xl">
            <LiveRunBlock
              task={activeTask}
              onStopRun={onStopTask}
              isStopping={isStoppingTask}
            />
          </div>
        )}

        {/* Live Loading Indicator */}
        {isLoading && (
          <div className="flex items-center gap-3 text-xs text-slate-600 dark:text-zinc-400 p-3 rounded-2xl bg-slate-50 dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-800 w-fit">
            <Loader2 className="h-4 w-4 animate-spin text-[#5b32e6] dark:text-indigo-400" />
            <span>{streamStatus || "Synthesizing response..."}</span>
          </div>
        )}

        {errorMsg && (
          <div className="p-3 rounded-2xl bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-xs flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-rose-500" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div ref={scrollRef} />
      </div>

      {/* Docked Material 3 Single Input Bar matching Item 3, 4, 5, 6 & Mockup 1 & 4 */}
      <div className="sticky bottom-0 z-20 p-3 sm:p-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] bg-white/95 dark:bg-zinc-950/95 border-t border-slate-200/80 dark:border-zinc-800 backdrop-blur-md">
        
        {/* Attachment Chips above input */}
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pb-2.5 mb-2 border-b border-slate-100 dark:border-zinc-850 max-w-2xl mx-auto">
            {attachedFiles.map((att) => (
              <div
                key={att.id}
                className="group relative flex items-center gap-1.5 p-1.5 pr-2.5 rounded-xl bg-slate-100 dark:bg-zinc-850 border border-slate-200 dark:border-zinc-700 text-xs shadow-xs"
              >
                {att.isImage && att.previewUrl ? (
                  <img
                    src={att.previewUrl}
                    alt={att.name}
                    className="h-6 w-6 rounded-lg object-cover border border-slate-200 dark:border-zinc-700"
                  />
                ) : (
                  <FileText className="h-4 w-4 text-[#5b32e6] dark:text-indigo-400 shrink-0" />
                )}
                <div className="flex flex-col">
                  <span className="max-w-[130px] truncate font-medium text-[11px] text-slate-800 dark:text-zinc-200">
                    {att.name}
                  </span>
                  <span className="text-[9px] text-slate-400 font-mono">
                    {formatFileSize(att.size)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveAttachment(att.id)}
                  className="p-1 rounded-md hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-400 hover:text-rose-500 transition-colors ml-1"
                  title="Remove file"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input Bar Card: rounded-full pill matching Mockup 1 & 4 */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="max-w-2xl mx-auto relative rounded-full bg-[#f1f3f9] dark:bg-zinc-900 border border-slate-200/60 dark:border-zinc-800 px-3.5 py-1.5 flex items-center gap-2 shadow-xs transition-all focus-within:ring-2 focus-within:ring-[#5b32e6]/20 focus-within:border-[#5b32e6]"
        >
          {/* Paperclip Button on left */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="p-1.5 rounded-full text-slate-500 hover:text-[#5b32e6] dark:text-zinc-400 dark:hover:text-indigo-400 transition-colors shrink-0"
            title="Attach files (image/*,.pdf,.md,.txt,.drawio,.xml,.json,.csv)"
          >
            <Paperclip className="h-5 w-5 rotate-45" />
          </button>

          {/* Auto-expanding Filled Textarea */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            placeholder="Describe the engineering task…"
            className="flex-1 bg-transparent border-0 focus:outline-none focus:ring-0 text-xs sm:text-sm text-slate-900 dark:text-zinc-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 resize-none py-1.5 leading-relaxed min-h-[72px] max-h-[160px]"
          />

          {/* Send / Stop Morphed Button */}
          <div className="shrink-0">
            {isGeneratingOrRunning ? (
              /* Morph into dark stop button (■) while generating or running */
              <button
                type="button"
                onClick={handleStop}
                className="h-9 w-9 rounded-full bg-zinc-900 hover:bg-black text-white flex items-center justify-center shadow-md active:scale-95 transition-all"
                title="Stop generation / halt workers"
              >
                <Square className="h-3.5 w-3.5 fill-current stroke-none" />
              </button>
            ) : (
              /* Normal purple circle send button with paper airplane */
              <button
                type="submit"
                disabled={!input.trim() && attachedFiles.length === 0}
                className="h-9 w-9 rounded-full bg-[#3b0799] hover:bg-[#2d0577] text-white flex items-center justify-center shadow-md active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition-all"
                title="Send task or message"
              >
                <Send className="h-4 w-4 text-white fill-white ml-0.5" />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
