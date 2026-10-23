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
  MoreHorizontal,
  Menu,
  Plus,
  ArrowDown,
  PanelLeft,
  FolderGit2,
  FileCode,
  ExternalLink
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExecutionTraceItem } from "./ExecutionTrace";
import { copyText } from "../lib/clipboard";
import { SvgViewer, SvgFileLink } from "./SvgViewer";
import { LiveRunBlock } from "./LiveRunBlock";
import { ThinkingPanel } from "./ThinkingPanel";
import { EngineStatusPill } from "./EngineStatusPill";
import { CodeBlock, CodeBlockWithCopy, SvgRendererBlock, MermaidBlock, highlightTokens } from "./ArtifactRenderers";
// CodeBlock handles long files with max-h-[400px] overflow-y-auto bg-gradient-to-t isExpanded Expand Collapse lines.length copyText(code)
export { CodeBlock, CodeBlockWithCopy, SvgRendererBlock, MermaidBlock };
import {
  isSvgCode,
  isSvgFilePath,
  resolveSvgUrl,
  wrapRawSvgInMarkdown,
  extractSvgsFromMessage,
  hasCompleteInlineSvg,
  extractCodeDeliverablesFromMessage
} from "../lib/svgUtils";
import { AgentMode, isReasoningEffortSupported } from "../config/models";
import { getInitialWelcomeMessage, clearChatHistory } from "../lib/chatHistory";
import { parseThinkingAndContent, formatThinkingDisplay, formatHumanReadableTrace, formatChatErrorMessage } from "../lib/chatUtils";
import { TaskManifest, TaskScope } from "../lib/subagents/types";




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
  isStreaming?: boolean;
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
  threadStatus?: "active" | "running" | "paused" | "stopped" | "completed" | "failed" | "needs_input";
  activeTask?: TaskManifest | null;
  initialScope?: TaskScope;
  threadScope?: TaskScope;
  onStopTask?: () => Promise<void> | void;
  onTaskUpdated?: (task?: TaskManifest, thread?: any) => void;
  onBackToList?: () => void;
  onOpenModelSheet?: () => void;
  onLaunchTask?: (goal: string, attachments?: any[], scope?: TaskScope, autoDeployOnGreen?: boolean) => Promise<void>;
  defaultComposerMode?: "chat" | "build";
  onNewThread?: () => void;
  onDeleteThread?: () => void;
  onSendMessage?: (content: string, attachments?: any[]) => Promise<void>;
  onDeployRun?: (taskId: string) => Promise<void> | void;
  onOpenDrawer?: () => void;
  onEnsureThread?: (initialTitle: string) => Promise<string | null>;
  placeholder?: string;
  onToggleSidebar?: () => void;
  isSidebarOpen?: boolean;
  onToggleWorkspace?: () => void;
  isWorkspaceOpen?: boolean;
  onOpenProjects?: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    // Check if raster image that benefits from high-performance client-side scaling
    if (file.type.startsWith("image/") && !file.type.includes("svg") && typeof window !== "undefined") {
      const reader = new FileReader();
      reader.onload = (e) => {
        const rawUrl = e.target?.result as string;
        if (!rawUrl) {
          resolve("");
          return;
        }
        const img = new Image();
        img.onload = () => {
          const MAX_DIM = 1600;
          let { width, height } = img;
          if (width > MAX_DIM || height > MAX_DIM) {
            if (width > height) {
              height = Math.round((height * MAX_DIM) / width);
              width = MAX_DIM;
            } else {
              width = Math.round((width * MAX_DIM) / height);
              height = MAX_DIM;
            }
          } else {
            resolve(rawUrl);
            return;
          }

          try {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.drawImage(img, 0, 0, width, height);
              resolve(canvas.toDataURL("image/jpeg", 0.88));
              return;
            }
          } catch {
            // fallback to original if canvas fails
          }
          resolve(rawUrl);
        };
        img.onerror = () => resolve(rawUrl);
        img.src = rawUrl;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
      return;
    }

    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });
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
  initialScope = "PROJECT",
  threadScope,
  onStopTask,
  onTaskUpdated,
  onBackToList,
  onOpenModelSheet,
  onLaunchTask,
  onNewThread,
  onDeleteThread,
  onSendMessage,
  onDeployRun,
  onOpenDrawer,
  onEnsureThread,
  placeholder,
  onToggleSidebar,
  isSidebarOpen = true,
  onToggleWorkspace,
  isWorkspaceOpen = false,
  defaultComposerMode,
  onOpenProjects
}: ChatStreamProps) {
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>(() => [
    getInitialWelcomeMessage(activeModel)
  ]);
  const messages = propsMessages ?? localMessages;
  const setMessages = propsSetMessages ?? setLocalMessages;

  // Composer Mode state (Chat | Build)
  const [composerMode, setComposerMode] = useState<"chat" | "build">(defaultComposerMode ?? "chat");
  const [autoDeployOnGreen, setAutoDeployOnGreen] = useState(false);

  // Single M3 input field: starts completely empty, no starter chips, no default prompt!
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isStoppingTask, setIsStoppingTask] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});
  const [expandedProofs, setExpandedProofs] = useState<Record<string, boolean>>({});
  const [expandedTraces, setExpandedTraces] = useState<Record<string, boolean>>({});
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);

  // Attached files state
  const [attachedFiles, setAttachedFiles] = useState<AttachedFileItem[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [previewModalImage, setPreviewModalImage] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);

  const isTaskActive = activeTask?.status === "active";
  const isGeneratingOrRunning = isLoading || isTaskActive;

  useEffect(() => {
    return () => {
      if (programmaticScrollTimerRef.current) {
        clearTimeout(programmaticScrollTimerRef.current);
      }
    };
  }, []);

  const handleContainerScroll = () => {
    if (isProgrammaticScrollRef.current) return;
    const el = chatContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    setIsUserScrolledUp(distanceFromBottom > 90);
  };

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    isProgrammaticScrollRef.current = true;
    setIsUserScrolledUp(false);
    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
    }
    programmaticScrollTimerRef.current = setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 600);
    scrollRef.current?.scrollIntoView({ behavior });
  };

  useEffect(() => {
    if (!isUserScrolledUp) {
      const el = chatContainerRef.current;
      if (el) {
        const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
        if (distanceFromBottom <= 100) {
          if (isLoading || isTaskActive) {
            el.scrollTop = el.scrollHeight;
          } else {
            scrollRef.current?.scrollIntoView({ behavior: "smooth" });
          }
        }
      } else {
        scrollRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    }
  }, [messages, isLoading, isTaskActive, isUserScrolledUp]);

  const toggleThought = (msgId: string) => {
    setExpandedThoughts((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  const toggleProof = (proofKey: string) => {
    setExpandedProofs((prev) => ({ ...prev, [proofKey]: !prev[proofKey] }));
  };

  const toggleTraces = (msgId: string) => {
    setExpandedTraces((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  const copyToClipboard = async (text: string, msgId: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopiedMessageId(msgId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    }
  };

  // Auto-expanding textarea: min 46px on mobile, grows smoothly with content, never truncates
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const scrollH = textareaRef.current.scrollHeight;
      const minH = typeof window !== "undefined" && window.innerWidth >= 640 ? 72 : 46;
      textareaRef.current.style.height = `${Math.max(scrollH, minH)}px`;
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

  const handleRunControlAction = async (action: "pause" | "resume" | "restart") => {
    if (!threadId) return;
    try {
      const res = await fetch(`/api/threads/${threadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      if (res.ok) {
        const data = await res.json();
        if (onTaskUpdated) {
          onTaskUpdated(data.task, data.thread);
        }
      }
    } catch {
      // Non-fatal
    }
  };

  const handleSend = async (textToSend?: string) => {
    const prompt = (textToSend || input).trim();
    if ((!prompt && attachedFiles.length === 0) || isGeneratingOrRunning) return;

    // Check if this is an engineering builder task (Build mode toggle or /build prefix)
    const isBuildPrefix = prompt.toLowerCase().startsWith("/build ");
    const cleanPrompt = isBuildPrefix ? prompt.slice(7).trim() : prompt;
    const isBuilder = composerMode === "build" || isBuildPrefix;

    if (isBuilder && onLaunchTask) {
      const currentAttachments = [...attachedFiles];
      setAttachedFiles([]);
      setInput("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
      setIsLoading(true);
      setStreamStatus("Planning autonomous milestones with real LLM model...");
      try {
        await onLaunchTask(cleanPrompt, currentAttachments, initialScope, autoDeployOnGreen);
      } catch (err: any) {
        setErrorMsg(err.message || "Failed to launch builder task");
      } finally {
        setIsLoading(false);
        setStreamStatus(null);
      }
      return;
    }

    setErrorMsg(null);
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    const currentAttachments = [...attachedFiles];
    setAttachedFiles([]);

    let activeThreadId = threadId;
    if (!activeThreadId && onEnsureThread) {
      activeThreadId = (await onEnsureThread(prompt.slice(0, 40))) || undefined;
    }

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

    // If inside a persistent thread, persist the user message
    if (activeThreadId) {
      try {
        fetch(`/api/threads/${activeThreadId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "addMessage",
            message: {
              id: userMsgId,
              role: "user",
              content: userMessage.content,
              timestamp: new Date().toISOString()
            }
          })
        }).catch((err) => console.warn("Failed to persist user message:", err));
      } catch {}
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
        if (res.status === 413) {
          errMessage = "Attachment is too large for upload (HTTP 413). Please choose a smaller file.";
        } else if (res.status === 504) {
          errMessage = "Gateway timeout (HTTP 504). The model took too long to respond.";
        } else if (res.status === 502) {
          errMessage = "Bad gateway (HTTP 502). The backend service is currently restarting.";
        } else {
          try {
            const errJson = await res.json();
            errMessage = errJson.error || errMessage;
          } catch {}
        }
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

      const upsertAssistant = (
        prev: ChatMessage[],
        patch: (existing: ChatMessage) => ChatMessage
      ): ChatMessage[] => {
        const exists = prev.some((msg) => msg.id === assistantMsgId);
        const base: ChatMessage = {
          id: assistantMsgId,
          role: "assistant",
          content: "",
          thought: "",
          traces: [],
          modelUsed: currentModel
        };
        if (!exists) {
          return [...prev, patch(base)];
        }
        return prev.map((msg) => (msg.id === assistantMsgId ? patch(msg) : msg));
      };

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
            } else if (event.type === "thought") {
              setMessages((prev) =>
                upsertAssistant(prev, (msg) => ({
                  ...msg,
                  thought: event.thought
                }))
              );
            } else if (event.type === "token") {
              accumulatedRawContent += event.content || "";
              const parsed = parseThinkingAndContent(accumulatedRawContent);
              setMessages((prev) =>
                upsertAssistant(prev, (msg) => ({
                  ...msg,
                  content: parsed.content,
                  thought: parsed.thought,
                  modelUsed: currentModel
                }))
              );
            } else if (event.type === "trace") {
              currentTraces = [...currentTraces, event.trace];
              onTracesUpdate(currentTraces);
              setMessages((prev) =>
                upsertAssistant(prev, (msg) => ({
                  ...msg,
                  traces: currentTraces
                }))
              );
            } else if (event.type === "done") {
              const durationMs = Math.round(performance.now() - startTime);
              const parsed = parseThinkingAndContent(event.content || accumulatedRawContent);
              const finalThought = event.thought !== undefined ? event.thought : parsed.thought;
              const finalModel = event.model || currentModel;

              const targetThreadId = activeThreadId || threadId;
              if (targetThreadId) {
                try {
                  fetch(`/api/threads/${targetThreadId}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      action: "addMessage",
                      message: {
                        id: assistantMsgId,
                        role: "assistant",
                        content: parsed.content,
                        thought: finalThought,
                        modelUsed: finalModel,
                        traces: event.traces || currentTraces,
                        durationMs,
                        timestamp: new Date().toISOString()
                      }
                    })
                  }).catch((err) => console.warn("Failed to persist assistant message:", err));
                } catch {}
              }

              setMessages((prev) =>
                upsertAssistant(prev, (msg) => ({
                  ...msg,
                  content: parsed.content,
                  thought: finalThought,
                  traces: event.traces || currentTraces,
                  modelUsed: finalModel,
                  durationMs: event.durationMs || durationMs
                }))
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

  const handleRetry = () => {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return;
    setErrorMsg(null);
    handleSend(lastUserMsg.content);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const modelSafe = activeModel || "swift-15-27b-mtp";
  const shortModelLabel = modelSafe.includes("IQ3") || modelSafe.includes("Qwen3.8")
    ? (modelSafe.includes("Swift-1.5") || modelSafe.includes("swift-15") ? "Swift-1.5 (IQ3_XS)" : "Swift-1.5")
    : modelSafe.includes("swift-15") || modelSafe.includes("swift-1.5")
    ? "Swift-1.5"
    : modelSafe.includes("swift")
    ? "Swift-27B"
    : modelSafe.includes("qwen")
    ? "Qwen3.8"
    : modelSafe.includes("gemma")
    ? "Gemma-4"
    : modelSafe.split(":")[0];

  // Deduplicate consecutive identical user messages in UI stream
  const deduplicatedMessages = messages.filter((m, i) => {
    if (i === 0) return true;
    const prev = messages[i - 1];
    if (m.role === "user" && prev.role === "user" && m.content === prev.content) {
      return false;
    }
    return true;
  });

  // Calculate the last linked task message index so LiveRunBlock is only hosted once
  const lastLinkedTaskMsgIndex = deduplicatedMessages
    .map((m, i) => m.taskId ? i : -1)
    .reduce((max, i) => Math.max(max, i), -1);

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative flex flex-col h-full bg-white dark:bg-zinc-950 transition-colors overflow-hidden ${
        isDraggingOver ? "bg-emerald-50/30 dark:bg-emerald-950/20" : ""
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

      {/* Top Bar matching Mockup 01 & Gemini Mobile Navigation Pattern */}
      <header className="px-2 sm:px-4 py-2 sm:py-3 border-b border-slate-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          {/* Mobile Hamburger menu button: opens drawer on mobile (< md:) */}
          {onOpenDrawer ? (
            <button
              type="button"
              onClick={onOpenDrawer}
              className="flex md:hidden min-h-[44px] min-w-[44px] items-center justify-center p-2 rounded-xl text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors shrink-0"
              title="Open navigation menu"
              aria-label="Open navigation menu"
            >
              <Menu className="h-6 w-6" />
            </button>
          ) : onBackToList ? (
            <button
              type="button"
              onClick={onBackToList}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-xl text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors shrink-0"
              title="Back to sessions"
              aria-label="Back to sessions"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          ) : null}

          {/* Direct Projects Navigation Button - accessible on both mobile and desktop */}
          {onOpenProjects && (
            <button
              type="button"
              onClick={onOpenProjects}
              className="panel-toggle-btn min-h-[44px] min-w-[44px] px-2.5 sm:px-3 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 shrink-0"
              title="Open Projects"
              aria-label="Open Projects"
            >
              <FolderGit2 className="h-5 w-5 sm:h-4 sm:w-4 text-emerald-600 dark:text-emerald-400" />
              <span className="hidden sm:inline">Projects</span>
            </button>
          )}

          {/* Desktop Sessions toggle: hidden on mobile (< md:), visible md: and up */}
          {onToggleSidebar && (
            <button
              type="button"
              onClick={onToggleSidebar}
              className={`panel-toggle-btn hidden md:flex min-h-[44px] min-w-[44px] px-2.5 sm:px-3 py-1.5 rounded-xl border text-xs font-semibold transition-colors items-center justify-center gap-1.5 shrink-0 ${
                isSidebarOpen
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
                  : "border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
              }`}
              title="Toggle Sessions Panel"
              aria-label="Toggle Sessions Panel"
            >
              <PanelLeft className="h-5 w-5 sm:h-4 sm:w-4" />
              <span className="hidden sm:inline">Sessions</span>
            </button>
          )}

          {/* Desktop Workspace Inspector Toggle Button - hidden on mobile (< md:) */}
          {onToggleWorkspace && (
            <button
              type="button"
              onClick={onToggleWorkspace}
              className={`panel-toggle-btn hidden md:flex min-h-[44px] min-w-[44px] px-2.5 sm:px-3 py-1.5 rounded-xl border text-xs font-semibold transition-colors items-center justify-center gap-1.5 shrink-0 ${
                isWorkspaceOpen
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
                  : "border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
              }`}
              title="Toggle Workspace Panel"
              aria-label="Toggle Workspace Panel"
            >
              <span className="text-sm">◨</span>
              <span className="hidden sm:inline">Workspace</span>
            </button>
          )}

          <h1
            className="hidden md:block text-base sm:text-lg font-bold tracking-tight text-slate-900 dark:text-zinc-100 max-w-[36vw] sm:max-w-md truncate"
            title={threadTitle || "New session"}
          >
            {threadTitle || "New session"}
          </h1>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {/* Scope Badge if available */}
          {(threadScope || activeTask?.scope) && (
            <span
              className="hidden sm:inline-flex px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60 text-xs font-semibold uppercase tracking-wider"
              title={`Task Scope: ${threadScope || activeTask?.scope}`}
            >
              {threadScope || activeTask?.scope}
            </span>
          )}

          {/* Engine Status Pill - desktop only (on mobile, Stop lives with turn in composer/stream) */}
          <div className="hidden md:flex items-center">
            <EngineStatusPill onOpenSettings={onOpenModelSheet} />
          </div>

          {/* Model Chip Button: opens ModelBottomSheet on tap */}
          <button
            type="button"
            onClick={onOpenModelSheet}
            className="min-h-[44px] flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-full bg-slate-50 dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-700 text-xs font-semibold text-emerald-700 dark:text-emerald-400 shadow-2xs hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            title={`Active model: ${activeModel || "swift-15-27b-mtp"} · Tap to configure`}
            aria-label={`Configure model: currently ${shortModelLabel}`}
          >
            <Sparkles className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="max-w-[85px] sm:max-w-[120px] truncate">{shortModelLabel}</span>
          </button>

          {/* New Session Button - desktop only */}
          {onNewThread && (
            <button
              type="button"
              onClick={onNewThread}
              className="hidden md:flex min-h-[44px] min-w-[44px] items-center justify-center p-2 rounded-full text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 transition-colors"
              title="Start new session"
              aria-label="Start new session"
            >
              <Plus className="h-5 w-5" />
            </button>
          )}

          {/* Overflow Menu Button - desktop only */}
          <div className="hidden md:block relative">
            <button
              type="button"
              onClick={() => setShowOverflowMenu(!showOverflowMenu)}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-full text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 transition-colors"
              title="More options"
              aria-label="More options"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>

            {showOverflowMenu && (
              <div
                className="absolute right-0 mt-2 w-56 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xl p-1 z-30"
                onClick={() => setShowOverflowMenu(false)}
              >
                {onOpenModelSheet && (
                  <button
                    type="button"
                    onClick={onOpenModelSheet}
                    className="w-full text-left px-3 py-2 text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 rounded-xl"
                  >
                    Engine &amp; model settings
                  </button>
                )}
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
      <div
        ref={chatContainerRef}
        onScroll={handleContainerScroll}
        data-scroll-container="true"
        className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 bg-white dark:bg-zinc-950 relative"
      >
        <div className="chat-track max-w-[840px] w-full mx-auto space-y-5">
        {deduplicatedMessages.length === 0 && !activeTask && (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 max-w-md mx-auto">
            <div className="h-12 w-12 rounded-2xl bg-slate-100 dark:bg-zinc-900 flex items-center justify-center text-slate-400 dark:text-zinc-500 mb-4 border border-slate-200/80 dark:border-zinc-800">
              <Sparkles className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h3 className="text-base font-bold text-slate-800 dark:text-zinc-200 mb-1">
              Start an autonomous session
            </h3>
            <p className="text-xs text-slate-500 dark:text-zinc-400 leading-relaxed">
              Ask questions, inspect the air-gapped sandbox, or build autonomous software artifacts.
            </p>
          </div>
        )}

        {deduplicatedMessages.map((m, idx) => {
          const isUser = m.role === "user";
          const isCopied = copiedMessageId === m.id;
          const isThoughtOpen = expandedThoughts[m.id] !== undefined ? expandedThoughts[m.id] : true;
          const isTaskHostMessage = idx === lastLinkedTaskMsgIndex && !!activeTask;
          const isSupersededTaskMessage = !!m.taskId && !isTaskHostMessage;

          if (isSupersededTaskMessage) {
            return null;
          }

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
                          <FileText className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                          <span className="max-w-[140px] truncate">{att.name}</span>
                          <span className="text-[10px] text-slate-400">({formatFileSize(att.size)})</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* User Bubble: soft blue glass matching AGENTS.md 2.A */}
              {isUser ? (
                <div className="flex flex-col items-end max-w-[88%] sm:max-w-lg">
                  <div className="bg-blue-50/90 border border-blue-200 text-blue-950 dark:bg-sky-950/40 dark:border-sky-500/30 dark:text-sky-100 rounded-3xl p-4 shadow-xs text-sm font-normal leading-relaxed">
                    <div className="prose dark:prose-invert max-w-none text-sm text-blue-950 dark:text-sky-100">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          code: ({ children }: any) => (
                            <code className="px-1.5 py-0.5 rounded bg-blue-100/80 dark:bg-sky-900/40 text-blue-950 dark:text-sky-200 font-mono text-xs">
                              {children}
                            </code>
                          ),
                          p: ({ children }: any) => <p className="mb-1 last:mb-0 leading-relaxed text-blue-950 dark:text-sky-100">{children}</p>
                        }}
                      >
                        {m.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                  {m.timestamp && (
                    <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-1 mr-1">
                      {(() => {
                        const d = new Date(m.timestamp);
                        return isNaN(d.getTime())
                          ? m.timestamp
                          : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
                      })()}
                    </div>
                  )}
                </div>
              ) : (
                /* Assistant Message View */
                <div className="w-full max-w-[840px] space-y-3">
                  {/* Worker Reasoning Panel (Prominent, Phased, Expanded by Default - Suppressed on task host message) */}
                  {!isTaskHostMessage && (m.thought || (isLoading && idx === deduplicatedMessages.length - 1 && !m.content)) && (() => {
                    const rawThought = m.thought || (isLoading && idx === deduplicatedMessages.length - 1 && !m.content ? "Analyzing prompt and formulating execution plan..." : "");
                    const isStreamingThis = isLoading && idx === deduplicatedMessages.length - 1;

                    return (
                      <div className="w-full">
                        <ThinkingPanel
                          rawThought={rawThought}
                          isStreaming={isStreamingThis}
                          defaultExpanded={Boolean(isStreamingThis || m.isStreaming)}
                        />
                      </div>
                    );
                  })()}

                  {/* Inline Expandable Sandbox & Telemetry Badges */}
                  {!isUser && m.traces && m.traces.length > 0 && (() => {
                    const hasManyTraces = m.traces.length > 3;
                    const isTracesExpanded = !!expandedTraces[m.id];
                    const visibleTraces = hasManyTraces && !isTracesExpanded ? m.traces.slice(0, 2) : m.traces;

                    return (
                      <div className="mt-2.5 space-y-2 w-full">
                        {visibleTraces.map((trace, tIdx) => {
                          const proofKey = `${m.id}-${tIdx}`;
                          const isExpanded = !!expandedProofs[proofKey];
                          const human = formatHumanReadableTrace(trace);
                          const isBrowser = human.badge === "browser";

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
                                <div className="flex items-center gap-1.5 flex-wrap min-w-0 pr-2">
                                  {isBrowser ? (
                                    <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400 font-semibold shrink-0">
                                      <Globe className="h-3.5 w-3.5" />
                                      <span>Web</span>
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold shrink-0">
                                      <ShieldCheck className="h-3.5 w-3.5" />
                                      <span>Sandbox</span>
                                    </span>
                                  )}
                                  <span className="text-slate-400 dark:text-zinc-600 shrink-0">•</span>
                                  <span className="text-slate-700 dark:text-zinc-200 font-medium font-sans line-clamp-2 sm:truncate">{human.title}</span>
                                  {human.duration && (
                                    <>
                                      <span className="text-slate-400 dark:text-zinc-600 shrink-0">•</span>
                                      <span className="text-slate-500 dark:text-zinc-400 shrink-0">{human.duration}</span>
                                    </>
                                  )}
                                </div>

                                <div className="flex items-center gap-1 text-[11px] text-cyan-600 dark:text-cyan-400 font-sans font-medium shrink-0 ml-auto">
                                  <span className="sm:hidden">{isExpanded ? "Hide" : "Proof"}</span>
                                  <span className="hidden sm:inline">{isExpanded ? "Hide Details (Proof)" : "Details · Expand Proof"}</span>
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

                        {hasManyTraces && (
                          <button
                            type="button"
                            onClick={() => toggleTraces(m.id)}
                            className="w-full py-1.5 px-3 text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-colors flex items-center justify-center gap-1.5"
                          >
                            {isTracesExpanded ? (
                              <>
                                <ChevronUp className="h-3.5 w-3.5" />
                                <span>Collapse tool steps</span>
                              </>
                            ) : (
                              <>
                                <ChevronDown className="h-3.5 w-3.5" />
                                <span>Show all {m.traces.length} tool steps</span>
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    );
                  })()}

                  {/* Inline Live Run Block if this message is the designated task host */}
                  {isTaskHostMessage && activeTask && (
                    <LiveRunBlock
                      task={activeTask}
                      onStopRun={onStopTask}
                      onPauseRun={() => handleRunControlAction("pause")}
                      onResumeRun={() => handleRunControlAction("resume")}
                      onRestartRun={() => handleRunControlAction("restart")}
                      onDeployRun={onDeployRun}
                      isStopping={isStoppingTask}
                    />
                  )}

                  {/* Text Markdown Content (Suppress if task host message or disconnected 'Started autonomous...') */}
                  {!isTaskHostMessage && m.content && (!m.taskId || !m.content.includes("Started autonomous engineering run.")) && (
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
                                className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-emerald-700 dark:text-emerald-400 font-mono text-xs border border-slate-200 dark:border-zinc-700"
                                {...props}
                              >
                                {children}
                              </code>
                            );
                          },
                          p: ({ children }: any) => (
                            <p className="mb-3 last:mb-0 leading-[1.6] text-slate-900 dark:text-zinc-100">
                              {children}
                            </p>
                          ),
                          ul: ({ children }: any) => (
                            <ul className="list-disc pl-5 my-3 space-y-1.5 leading-[1.6] text-slate-900 dark:text-zinc-100">
                              {children}
                            </ul>
                          ),
                          ol: ({ children }: any) => (
                            <ol className="list-decimal pl-5 my-3 space-y-1.5 leading-[1.6] text-slate-900 dark:text-zinc-100">
                              {children}
                            </ol>
                          ),
                          li: ({ children }: any) => (
                            <li className="leading-[1.6]">
                              {children}
                            </li>
                          ),
                          blockquote: ({ children }: any) => (
                            <blockquote className="border-l-4 border-emerald-500 bg-slate-50/80 dark:bg-zinc-900/60 pl-3.5 py-1.5 my-3 italic text-slate-700 dark:text-zinc-300 rounded-r-xl">
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
                    </div>
                  )}

                  {/* Tool Generated SVG Visual Artifacts & Code Deliverables */}
                  {!isTaskHostMessage && (
                    <>
                      {(() => {
                        if (hasCompleteInlineSvg(m.content)) return null;
                        const messageSvgs = extractSvgsFromMessage(m);
                        if (messageSvgs.length === 0) return null;
                        return (
                          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-zinc-800 space-y-4 not-prose w-full">
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

                      {(() => {
                        const codeDeliverables = extractCodeDeliverablesFromMessage(m);
                        if (codeDeliverables.length === 0) return null;
                        return (
                          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-zinc-800 space-y-4 not-prose w-full">
                            {codeDeliverables.map((item) => (
                              <div key={item.id} className="space-y-1.5">
                                <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 dark:text-zinc-400">
                                  <span className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                                    <FileCode className="h-3.5 w-3.5" />
                                    <span>Delivered Code File: {item.title}</span>
                                  </span>
                                  <a
                                    href={item.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="flex items-center gap-1 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
                                  >
                                    <span>Open Raw</span>
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                </div>
                                <CodeBlock
                                  language={item.language}
                                  code={item.code}
                                  filename={item.path}
                                />
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </>
                  )}

                  {/* Grounded File Citation Card matching Mockup 4 */}
                  {m.traces && m.traces.some((t: any) => t.tool?.includes("file") || t.args?.path || (t.name && String(t.name).includes(".ts"))) && (
                    <div className="flex flex-wrap gap-2 pt-1 max-w-sm">
                      {m.traces.filter((t: any) => t.args?.path || (t.name && String(t.name).includes(".ts"))).slice(0, 3).map((t: any, cIdx) => {
                        const pathLabel = t.args?.path || t.name;
                        if (!pathLabel) return null;
                        return (
                          <div
                            key={cIdx}
                            className="flex items-center justify-between w-full p-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200/90 dark:border-zinc-800 shadow-xs text-xs font-mono text-slate-800 dark:text-zinc-200"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <FileText className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                              <span className="font-semibold truncate">{pathLabel}</span>
                            </div>
                            <div className="flex items-center gap-1 shrink-0 ml-2">
                              <a
                                href={resolveSvgUrl(pathLabel)}
                                target="_blank"
                                rel="noreferrer"
                                className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200"
                                title="Open file"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                              <button
                                type="button"
                                onClick={() => copyToClipboard(pathLabel, `${m.id}-${cIdx}`)}
                                className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200"
                                title="Copy path"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </button>
                            </div>
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
        {activeTask && lastLinkedTaskMsgIndex === -1 && (
          <div className="w-full max-w-[840px]">
            <LiveRunBlock
              task={activeTask}
              onStopRun={onStopTask}
              onPauseRun={() => handleRunControlAction("pause")}
              onResumeRun={() => handleRunControlAction("resume")}
              onRestartRun={() => handleRunControlAction("restart")}
              onDeployRun={onDeployRun}
              isStopping={isStoppingTask}
            />
          </div>
        )}

        {/* Live Loading Indicator */}
        {isLoading && (
          <div className="flex items-center gap-3 text-xs text-slate-600 dark:text-zinc-400 p-3 rounded-2xl bg-slate-50 dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-800 w-fit">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-600 dark:text-emerald-400" />
            <span>{streamStatus || "Synthesizing response..."}</span>
          </div>
        )}

        {errorMsg && (() => {
          const formatted = formatChatErrorMessage(errorMsg);
          return (
            <div className="p-3.5 sm:p-4 rounded-2xl bg-rose-50/90 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-200 text-sm space-y-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                  <ShieldAlert className="h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400 mt-0.5" />
                  <div className="space-y-1 min-w-0">
                    <p className="font-semibold text-rose-900 dark:text-rose-100 text-sm leading-snug">
                      {formatted.summary}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="px-3 py-1 rounded-lg text-xs font-semibold bg-rose-100 hover:bg-rose-200 dark:bg-rose-900/80 dark:hover:bg-rose-800 text-rose-800 dark:text-rose-200 border border-rose-300 dark:border-rose-800 transition-colors shrink-0 flex items-center gap-1"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Retry</span>
                </button>
              </div>

              {formatted.details && (
                <details className="text-xs text-rose-700 dark:text-rose-300">
                  <summary className="cursor-pointer font-medium hover:underline select-none">
                    Technical details
                  </summary>
                  <pre className="mt-1.5 p-2 rounded bg-rose-100/65 dark:bg-zinc-900 text-rose-950 dark:text-rose-200 text-[11px] font-mono overflow-x-auto whitespace-pre-wrap">
                    {formatted.details}
                  </pre>
                </details>
              )}
            </div>
          );
        })()}

        <div ref={scrollRef} />
        </div>
      </div>

      {/* Floating "Jump to bottom" button (S5 Smart Autoscroll) */}
      {isUserScrolledUp && (
        <div className="flex justify-center -mt-12 mb-2 z-30 pointer-events-none">
          <button
            type="button"
            onClick={() => scrollToBottom("smooth")}
            className="pointer-events-auto min-h-[44px] px-4 py-2.5 rounded-full bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-100 text-xs font-semibold shadow-md hover:shadow-lg flex items-center gap-1.5 transition-all"
            title="Jump to bottom"
            aria-label="Jump to bottom"
          >
            <ArrowDown className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <span>Jump to bottom</span>
          </button>
        </div>
      )}

      {/* Docked Material 3 Single Input Bar matching Item 3, 4, 5, 6 & Mockup 1 & 4 */}
      <div className="sticky bottom-0 z-20 p-3 sm:p-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] bg-white/95 dark:bg-zinc-950/95 border-t border-slate-200/80 dark:border-zinc-800 backdrop-blur-md">
        
        {/* Attachment Chips above input */}
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pb-2.5 mb-2 border-b border-slate-100 dark:border-zinc-850 max-w-[840px] mx-auto">
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
                  <FileText className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
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

        {/* Unified Material 3 Two-Deck Composer Card */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="max-w-[840px] mx-auto rounded-3xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 p-3 shadow-xs transition-all focus-within:ring-2 focus-within:ring-emerald-500/20 focus-within:border-emerald-500"
        >
          {/* Top Deck: Auto-expanding Textarea */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (e.target.style) {
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
              }
            }}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={placeholder || "Describe the engineering task…"}
            className="w-full bg-transparent border-0 focus:outline-none focus:ring-0 text-[15px] sm:text-sm text-slate-900 dark:text-zinc-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 resize-none px-1.5 py-1 leading-relaxed min-h-[46px] sm:min-h-[72px] max-h-[140px]"
          />

          {/* Bottom Deck: Controls Bar */}
          <div className="flex items-center justify-between pt-2 mt-1 border-t border-slate-200/50 dark:border-zinc-800/80">
            {/* Paperclip Button on left */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="h-9 w-9 rounded-full text-slate-500 hover:text-emerald-600 dark:text-zinc-400 dark:hover:text-emerald-400 hover:bg-slate-200/60 dark:hover:bg-zinc-800 transition-colors shrink-0 flex items-center justify-center"
              title="Attach files (image/*,.pdf,.md,.txt,.drawio,.xml,.json,.csv)"
              aria-label="Attach files"
            >
              <Paperclip className="h-4.5 w-4.5 rotate-45" />
            </button>

            <div className="flex items-center gap-2">
              {/* Composer Mode Toggle (Chat | Build) */}
              <div
                role="radiogroup"
                aria-label="Composer Mode Selector"
                className="inline-flex rounded-full p-0.5 bg-slate-200/60 dark:bg-zinc-800/90 text-[11px] font-medium select-none"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={composerMode === "chat"}
                  onClick={() => setComposerMode("chat")}
                  className={`px-3 py-1 rounded-full transition-all ${
                    composerMode === "chat"
                      ? "bg-white dark:bg-zinc-900 text-emerald-700 dark:text-emerald-300 font-semibold shadow-xs"
                      : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                  }`}
                >
                  Chat
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={composerMode === "build"}
                  onClick={() => setComposerMode("build")}
                  className={`px-3 py-1 rounded-full transition-all ${
                    composerMode === "build"
                      ? "bg-white dark:bg-zinc-900 text-emerald-700 dark:text-emerald-300 font-semibold shadow-xs"
                      : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                  }`}
                >
                  Build
                </button>
              </div>

              {/* Opt-in Auto-Deploy on Green Gate Checkbox (Sprint A4 / CEO Decision 3) */}
              {composerMode === "build" && (
                <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-zinc-400 cursor-pointer select-none px-1">
                  <input
                    type="checkbox"
                    checked={autoDeployOnGreen}
                    onChange={(e) => setAutoDeployOnGreen(e.target.checked)}
                    className="rounded border-slate-300 dark:border-zinc-700 text-emerald-600 focus:ring-emerald-500 h-3.5 w-3.5"
                  />
                  <span className="hidden sm:inline">Auto-Deploy on Green Gate</span>
                  <span className="sm:hidden">Auto-Deploy</span>
                </label>
              )}

              {/* Send / Stop Morphed Button */}
              {isGeneratingOrRunning ? (
                <button
                  type="button"
                  onClick={handleStop}
                  className="h-9 w-9 rounded-full bg-zinc-900 hover:bg-black text-white flex items-center justify-center shadow-xs active:scale-95 transition-all shrink-0"
                  title="Stop generation / halt workers"
                  aria-label="Stop generation"
                >
                  <Square className="h-3.5 w-3.5 fill-current stroke-none" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim() && attachedFiles.length === 0}
                  className="h-9 w-9 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center shadow-xs active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition-all shrink-0"
                  title="Send message"
                  aria-label="Send message"
                >
                  <Send className="h-3.5 w-3.5 text-white fill-white ml-0.5" />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
