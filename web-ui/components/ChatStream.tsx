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
  ExternalLink,
  Download
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExecutionTraceItem } from "./ExecutionTrace";
import { copyText } from "../lib/clipboard";
import { latestRoundPromptTokens } from "../lib/tokenEconomics";
import { reconcilePollDelayMs, shouldStopReconcilePoll } from "../lib/reconcilePollPolicy";
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
import { parseThinkingAndContent, formatThinkingDisplay, formatHumanReadableTrace, formatChatErrorMessage, getServedByNote, extractFileWriteDiffsFromTraces } from "../lib/chatUtils";
import { DiffViewer } from "./DiffViewer";
import { TurnFileDiff, MAX_DIFF_LINES_CAP } from "../lib/chatDiffs";
import { resolveTurnStatusPhase, mergeStreamedTokens } from "../lib/chatStatus";
import { TaskManifest, TaskScope } from "../lib/subagents/types";
import type { HostRunnerState } from "../lib/hostMode";
import { ChatQueue, QueueItem, decideSendAction, drainNextForTurnEnd } from "../lib/chatQueue";
import {
  parseSimulateCommand,
  createSimulatedChatResponse,
  runSimulatedTask,
  getScenario,
  SimulationScenarioKey
} from "../lib/simulator";




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
  diffs?: TurnFileDiff[];
  modelUsed?: string;
  selectedModel?: string;
  durationMs?: number;
  taskId?: string;
  isStopped?: boolean;
  isStreaming?: boolean;
  timestamp?: string;
  compactedThisTurn?: boolean;
  tokensBeforeCompaction?: number;
  tokensAfterCompaction?: number;
  compactionActions?: string[];
  status?: "completed" | "incomplete" | "error" | "streaming";
}

export interface UiHostApproval {
  id: string;
  threadId?: string;
  tool: string;
  args: Record<string, any>;
  riskReason: string;
  createdAt?: number;
  expiresAt?: number;
  status: "pending" | "executed" | "denied" | "expired" | "error";
  result?: any;
  error?: string;
  isSubmitting?: boolean;
}

interface ChatStreamProps {
  onTracesUpdate: (traces: ExecutionTraceItem[]) => void;
  liveTraces?: ExecutionTraceItem[];
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
  threadHostAccess?: boolean;
  onHostAccessChanged?: (enabled: boolean, updatedThread?: any) => void;
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
  /**
   * UI-006b: whether ChatStream is the active view. app/page.tsx hides the
   * chat view via CSS while it stays mounted; the detached-turn reconcile
   * poll must stop entirely when this is false. Derived from the existing
   * active-view signal (activeNavView === "sessions" && viewMode === "unified").
   */
  isActiveView?: boolean;
  initialSimulation?: {
    scenarioKey: SimulationScenarioKey;
    speedMultiplier?: number;
  };
}

// Human-readable labels for the CompactionAction union emitted by
// fitConversationToBudget (web-ui/lib/contextBudget.ts:816-820) and persisted on
// thread messages as compactionActions (web-ui/lib/threads/threadStore.ts:66).
const COMPACTION_ACTION_LABELS: Record<string, string> = {
  compaction: "Compaction",
  elide_tool_outputs: "Elide tool outputs",
  drop_old_turns: "Drop old turns",
  truncate_oversize: "Truncate oversize"
};

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
  liveTraces,
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
  threadHostAccess,
  onHostAccessChanged,
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
  onOpenProjects,
  isActiveView = true,
  initialSimulation
}: ChatStreamProps) {
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>(() => [
    getInitialWelcomeMessage(activeModel)
  ]);
  const messages = propsMessages ?? localMessages;
  const setMessages = propsSetMessages ?? setLocalMessages;

  // Composer Mode state (Chat | Build)
  const [composerMode, setComposerMode] = useState<"chat" | "build">(defaultComposerMode ?? "chat");
  const [autoDeployOnGreen, setAutoDeployOnGreen] = useState(false);
  const [midTurnAction, setMidTurnAction] = useState<"queue" | "steer">(() => {
    if (typeof window !== "undefined" && threadId) {
      const saved = window.localStorage.getItem(`chat-followup-action:${threadId}`);
      if (saved === "queue" || saved === "steer") return saved;
    }
    return "queue";
  });
  const [pendingSteers, setPendingSteers] = useState<string[]>([]);
  const [isSubmittingSteer, setIsSubmittingSteer] = useState(false);

  // Single M3 input field: starts completely empty, no starter chips, no default prompt!
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isStoppingTask, setIsStoppingTask] = useState(false);
  const [activeThreadState, setActiveThreadId] = useState<string | undefined>(threadId);
  const activeThreadIdRef = useRef<string | undefined>(threadId);
  const activeThreadId = activeThreadIdRef.current || activeThreadState || threadId;

  useEffect(() => {
    setActiveThreadId(threadId);
    activeThreadIdRef.current = threadId;
  }, [threadId]);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  // UI-003 / UI-011b: trace rows accumulated during the current turn, held in
  // ChatStream's own state so rows received before a stream cut stay on screen
  // even when the messages prop/setMessages cannot reflect them.
  const [liveTurnTraces, setLiveTurnTraces] = useState<ExecutionTraceItem[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});
  const [expandedProofs, setExpandedProofs] = useState<Record<string, boolean>>({});
  const [expandedTraces, setExpandedTraces] = useState<Record<string, boolean>>({});
  const [expandedDiffCards, setExpandedDiffCards] = useState<Record<string, boolean>>({});
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);

  // Host Mode & Approvals state
  const [hostAccess, setHostAccess] = useState<boolean>(threadHostAccess ?? true);
  const [runnerAvailable, setRunnerAvailable] = useState<boolean | null>(null);
  const [runnerState, setRunnerState] = useState<HostRunnerState | null>(null);
  const [runnerReason, setRunnerReason] = useState<string | null>(null);
  const [hostApprovals, setHostApprovals] = useState<UiHostApproval[]>([]);

  useEffect(() => {
    if (threadHostAccess !== undefined) {
      setHostAccess(Boolean(threadHostAccess));
    }
  }, [threadHostAccess]);

  useEffect(() => {
    let active = true;
    const url = threadId ? `/api/host/status?threadId=${encodeURIComponent(threadId)}` : "/api/host/status";
    fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active || !data) return;
        if (typeof data.hostAccess === "boolean" && threadHostAccess === undefined) {
          setHostAccess(data.hostAccess);
        }
        if (typeof data.runnerAvailable === "boolean") {
          setRunnerAvailable(data.runnerAvailable);
        }
        if (data.runnerState) {
          setRunnerState(data.runnerState);
        } else if (typeof data.runnerAvailable === "boolean") {
          setRunnerState(data.runnerAvailable ? "READY" : "UNAVAILABLE");
        }
        if (data.reason) {
          setRunnerReason(data.reason);
        }
      })
      .catch(() => {
        if (active) {
          setRunnerAvailable(false);
          setRunnerState("UNAVAILABLE");
          setRunnerReason("Host runner daemon not responding on port 8765");
        }
      });

    return () => {
      active = false;
    };
  }, [threadId, threadHostAccess]);

  // Rehydration of pending host approvals on thread load
  useEffect(() => {
    if (!threadId) {
      setHostApprovals([]);
      return;
    }
    let active = true;

    fetch(`/api/host/approvals?threadId=${encodeURIComponent(threadId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active || !data?.approvals) return;
        const now = Date.now();
        const unexpired = data.approvals.filter(
          (a: any) => (!a.expiresAt || a.expiresAt > now) && a.status === "pending"
        );

        setHostApprovals((prev) => {
          const merged = [...prev];
          for (const app of unexpired) {
            const idx = merged.findIndex((m) => m.id === app.id);
            const uiApp: UiHostApproval = {
              id: app.id,
              threadId: app.threadId,
              tool: app.tool,
              args: app.args || {},
              riskReason: app.riskReason || "Destructive action requires approval",
              createdAt: app.createdAt,
              expiresAt: app.expiresAt,
              status: "pending"
            };
            if (idx >= 0) {
              merged[idx] = { ...merged[idx], ...uiApp };
            } else {
              merged.push(uiApp);
            }
          }
          return merged;
        });
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [threadId]);

  // Rehydration of thread compaction boundary on thread switch
  useEffect(() => {
    if (!threadId) {
      setThreadCompaction(null);
      return;
    }
    let active = true;
    fetch(`/api/threads/${encodeURIComponent(threadId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active) return;
        setThreadCompaction(data?.thread?.compaction || null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [threadId]);

  const handleToggleHostAccess = async () => {
    let targetThreadId = activeThreadId || threadId;
    if (!targetThreadId && onEnsureThread) {
      targetThreadId = (await onEnsureThread("New session")) || undefined;
      if (targetThreadId) {
        activeThreadIdRef.current = targetThreadId;
        setActiveThreadId(targetThreadId);
      }
    }
    if (!targetThreadId) {
      return;
    }

    const nextHostAccess = !hostAccess;
    try {
      const res = await fetch(`/api/threads/${targetThreadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setHostAccess", hostAccess: nextHostAccess })
      });

      if (res.ok) {
        const data = await res.json();
        setHostAccess(nextHostAccess);
        if (onTaskUpdated && data.thread) {
          onTaskUpdated(undefined, data.thread);
        }
        if (onHostAccessChanged && data.thread) {
          onHostAccessChanged(nextHostAccess, data.thread);
        }

        // Fresh check of runner availability
        try {
          const statusRes = await fetch(`/api/host/status?threadId=${encodeURIComponent(targetThreadId)}`);
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (typeof statusData.runnerAvailable === "boolean") {
              setRunnerAvailable(statusData.runnerAvailable);
            }
            if (statusData.runnerState) {
              setRunnerState(statusData.runnerState);
            } else if (typeof statusData.runnerAvailable === "boolean") {
              setRunnerState(statusData.runnerAvailable ? "READY" : "UNAVAILABLE");
            }
            if (statusData.reason) {
              setRunnerReason(statusData.reason);
            }
          }
        } catch {}
      }
    } catch (err) {
      console.warn("Failed to toggle host access:", err);
    }
  };
  const [activeSimulation, setActiveSimulation] = useState<{
    scenarioKey: SimulationScenarioKey;
    speedMultiplier?: number;
  } | null>(initialSimulation ?? null);
  const activeSimTaskCancelRef = useRef<(() => void) | null>(null);
  const initialSimulationTriggeredRef = useRef(false);

  useEffect(() => {
    if (initialSimulation && !initialSimulationTriggeredRef.current) {
      initialSimulationTriggeredRef.current = true;
      setActiveSimulation(initialSimulation);
      const cmd = `/simulate ${initialSimulation.scenarioKey}${
        initialSimulation.speedMultiplier ? ` ${initialSimulation.speedMultiplier}` : ""
      }`;
      handleSend(cmd);
    }
  }, [initialSimulation]);

  // Attached files state
  const [attachedFiles, setAttachedFiles] = useState<AttachedFileItem[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [previewModalImage, setPreviewModalImage] = useState<string | null>(null);

  // Context budget meter & compaction state
  const [contextStats, setContextStats] = useState<{
    estimatedTokens: number;
    budgetTokens: number;
    compactedThisTurn?: boolean;
    tokensBeforeCompaction?: number;
    tokensAfterCompaction?: number;
  }>({
    estimatedTokens: 0,
    budgetTokens: 100000
  });
  const [threadCompaction, setThreadCompaction] = useState<{
    throughMessageId: string;
    summary: string;
    compactedAt: string;
    tokensBefore: number;
    tokensAfter: number;
  } | null>(null);
  const [isCompactingManually, setIsCompactingManually] = useState(false);
  const [showCompactionModal, setShowCompactionModal] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  const isFollowPinnedRef = useRef(true);
  const programmaticScrollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const activeAssistantMsgIdRef = useRef<string | null>(null);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [reconcilingThreadId, setReconcilingThreadId] = useState<string | null>(null);
  const [isTransientDisconnected, setIsTransientDisconnected] = useState<boolean>(false);
  const [hasResolvedDetachedTurn, setHasResolvedDetachedTurn] = useState<boolean>(false);

  const upsertAssistant = (
    prev: ChatMessage[],
    patch: (existing: ChatMessage) => ChatMessage,
    targetId?: string
  ): ChatMessage[] => {
    const id =
      targetId ||
      activeAssistantMsgIdRef.current ||
      [...prev].reverse().find((m) => m.role === "assistant")?.id ||
      `assistant-${Date.now()}`;
    const exists = prev.some((msg) => msg.id === id);
    const base: ChatMessage = {
      id,
      role: "assistant",
      content: "",
      thought: "",
      traces: [],
      modelUsed: activeModel,
      selectedModel: activeModel
    };
    if (!exists) {
      return [...prev, patch(base)];
    }
    return prev.map((msg) => (msg.id === id ? patch(msg) : msg));
  };

  const isTaskActive = activeTask?.status === "active";
  const isGeneratingOrRunning = isLoading || isTaskActive;

  // qa-7 / UI-013: the context meter shows the latest round's ACTUAL prompt
  // tokens from the thread record (roundPromptTokens persisted per assistant
  // message, snapshots included), so watching clients and refreshed views
  // never sit at 0K. The SSE estimate remains the fallback on the initiating
  // client before the first round persists.
  const recordContextTokens = latestRoundPromptTokens(
    messages as unknown as Array<{ roundPromptTokens?: number[] }>
  );
  const displayContextTokens =
    recordContextTokens > 0 ? recordContextTokens : contextStats.estimatedTokens;

  // CHAT-QUEUE: Client-side message queue during active turns
  const turnActiveRef = useRef<boolean>(false);
  useEffect(() => {
    turnActiveRef.current = isGeneratingOrRunning;
  }, [isGeneratingOrRunning]);

  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const chatQueueRef = useRef<ChatQueue | null>(null);

  // Poll and reconcile thread records if a stream disconnected mid-turn.
  // UI-006/UI-006b (docs/ui-qa-findings-2026-11-10.md): the re-arm was a fixed
  // 1s setTimeout with no backoff, no attempt cap, no total-time cap, and it
  // kept polling while ChatStream was hidden (page.tsx hides via CSS; the
  // component stays mounted). Now: exponential backoff, attempt + total-time
  // caps, and no polling while ChatStream is not the active view.
  useEffect(() => {
    if (!reconcilingThreadId) return;
    if (!isActiveView) return;
    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const startedAt = Date.now();

    const pollDetachedTurn = async () => {
      try {
        const res = await fetch(`/api/threads/${reconcilingThreadId}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" }
        });
        if (!res.ok || !active) return;
        const data = await res.json();
        if (Array.isArray(data?.thread?.messages)) {
          const threadMsgs: ChatMessage[] = data.thread.messages;
          const lastAsst = [...threadMsgs].reverse().find((m) => m.role === "assistant");
          if (lastAsst) {
            setMessages(threadMsgs);
            if (lastAsst.status !== "streaming") {
              setIsTransientDisconnected(false);
              setReconcilingThreadId(null);
              setHasResolvedDetachedTurn(true);
              return;
            }
          }
        }
      } catch (err) {
        console.warn("[ChatStream] Detached turn reconciliation poll error:", err);
      }
      attempts += 1;
      if (
        active &&
        !shouldStopReconcilePoll({
          attempts,
          elapsedMs: Date.now() - startedAt,
          isActiveView
        })
      ) {
        pollTimer = setTimeout(pollDetachedTurn, reconcilePollDelayMs(attempts));
      }
    };

    pollTimer = setTimeout(pollDetachedTurn, reconcilePollDelayMs(0));
    return () => {
      active = false;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [reconcilingThreadId, isActiveView]);
  useEffect(() => {
    const tid = activeThreadId || threadId;
    if (typeof window !== "undefined" && tid) {
      const q = new ChatQueue(window.localStorage, tid);
      chatQueueRef.current = q;
      setQueueItems(q.items());
      const saved = window.localStorage.getItem(`chat-followup-action:${tid}`);
      if (saved === "queue" || saved === "steer") {
        setMidTurnAction(saved);
      }
    } else {
      chatQueueRef.current = null;
      setQueueItems([]);
    }
  }, [activeThreadId, threadId]);

  const handleSelectMidTurnAction = (action: "queue" | "steer") => {
    setMidTurnAction(action);
    const tid = activeThreadId || threadId;
    if (typeof window !== "undefined" && tid) {
      window.localStorage.setItem(`chat-followup-action:${tid}`, action);
    }
  };

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
    const unpinned = distanceFromBottom > 90;
    if (unpinned) {
      isFollowPinnedRef.current = false;
    } else {
      isFollowPinnedRef.current = true;
    }
    setIsUserScrolledUp(unpinned);
  };

  const handleContainerWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      isFollowPinnedRef.current = false;
      setIsUserScrolledUp(true);
    }
  };

  const handleContainerTouchMove = () => {
    const el = chatContainerRef.current;
    if (!el || isProgrammaticScrollRef.current) return;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    if (distanceFromBottom > 90) {
      isFollowPinnedRef.current = false;
      setIsUserScrolledUp(true);
    }
  };

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    isFollowPinnedRef.current = true;
    isProgrammaticScrollRef.current = true;
    setIsUserScrolledUp(false);
    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
    }
    programmaticScrollTimerRef.current = setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 600);
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
    scrollRef.current?.scrollIntoView({ behavior });
  };

  useEffect(() => {
    if (!isFollowPinnedRef.current || isUserScrolledUp) {
      return;
    }
    const el = chatContainerRef.current;
    if (el) {
      const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
      if (distanceFromBottom <= 100) {
        if (isLoading || isTaskActive) {
          isProgrammaticScrollRef.current = true;
          el.scrollTop = el.scrollHeight;
          if (programmaticScrollTimerRef.current) {
            clearTimeout(programmaticScrollTimerRef.current);
          }
          programmaticScrollTimerRef.current = setTimeout(() => {
            isProgrammaticScrollRef.current = false;
          }, 50);
        } else {
          scrollRef.current?.scrollIntoView({ behavior: "smooth" });
        }
      }
    } else {
      scrollRef.current?.scrollIntoView({ behavior: "smooth" });
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

  const handleManualCompact = async () => {
    const currentThreadId = activeThreadId || threadId;
    if (!currentThreadId || isCompactingManually) return;
    setIsCompactingManually(true);
    try {
      const res = await fetch(`/api/threads/${currentThreadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.thread?.compaction) {
          setThreadCompaction(data.thread.compaction);
          setContextStats((prev) => ({
            ...prev,
            estimatedTokens: data.tokensAfter ?? prev.estimatedTokens
          }));
        }
      }
    } catch (err) {
      console.error("Manual compaction error:", err);
    } finally {
      setIsCompactingManually(false);
    }
  };

  const handleRestoreCompaction = async () => {
    const currentThreadId = activeThreadId || threadId;
    if (!currentThreadId) return;
    try {
      const res = await fetch(`/api/threads/${currentThreadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restoreCompaction" })
      });
      if (res.ok) {
        setThreadCompaction(null);
        setShowCompactionModal(false);
      }
    } catch (err) {
      console.error("Restore compaction error:", err);
    }
  };

  const handleRunControlAction = async (action: "pause" | "resume" | "restart") => {
    const currentThreadId = activeThreadId || threadId;
    if (!currentThreadId) return;
    try {
      const res = await fetch(`/api/threads/${currentThreadId}`, {
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

  const readStreamResponse = async (
    res: Response,
    targetThreadId?: string,
    startTime: number = performance.now(),
    providedAssistantMsgId?: string
  ) => {
    const assistantMsgId = providedAssistantMsgId || activeAssistantMsgIdRef.current || `assistant-${Date.now()}`;
    activeAssistantMsgIdRef.current = assistantMsgId;
    setMessages((prev) => {
      const exists = prev.some((m) => m.id === assistantMsgId);
      if (exists) return prev;
      return [
        ...prev,
        {
          id: assistantMsgId,
          role: "assistant",
          content: "",
          thought: "",
          traces: [],
          modelUsed: activeModel,
          selectedModel: activeModel
        }
      ];
    });

    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("No readable stream received from server");
    }

    const decoder = new TextDecoder();
    let streamBuffer = "";
    let accumulatedRawContent = "";
    let currentTraces: ExecutionTraceItem[] = [];
    let currentModel = activeModel;
    let compactedThisTurn = false;
    let tokensBeforeCompaction: number | undefined = undefined;
    let tokensAfterCompaction: number | undefined = undefined;

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
        modelUsed: currentModel,
        selectedModel: activeModel
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
            if (event.context) {
              setContextStats((prev) => ({
                ...prev,
                estimatedTokens: event.context.estimatedTokens ?? prev.estimatedTokens,
                budgetTokens: event.context.budgetTokens ?? prev.budgetTokens,
                compactedThisTurn: event.context.compactedThisTurn,
                tokensBeforeCompaction: event.context.tokensBeforeCompaction,
                tokensAfterCompaction: event.context.tokensAfterCompaction
              }));
              if (event.context.compactedThisTurn) {
                compactedThisTurn = true;
                tokensBeforeCompaction = event.context.tokensBeforeCompaction;
                tokensAfterCompaction = event.context.tokensAfterCompaction;
                setMessages((prev) =>
                  upsertAssistant(prev, (msg) => ({
                    ...msg,
                    compactedThisTurn: true,
                    tokensBeforeCompaction,
                    tokensAfterCompaction
                  }))
                );
              }
            }
          } else if (event.type === "compaction") {
            compactedThisTurn = true;
            tokensBeforeCompaction = event.tokensBefore;
            tokensAfterCompaction = event.tokensAfter;
            setContextStats((prev) => ({
              ...prev,
              estimatedTokens: event.tokensAfter,
              compactedThisTurn: true,
              tokensBeforeCompaction: event.tokensBefore,
              tokensAfterCompaction: event.tokensAfter
            }));
            setMessages((prev) =>
              upsertAssistant(prev, (msg) => ({
                ...msg,
                compactedThisTurn: true,
                tokensBeforeCompaction: event.tokensBefore,
                tokensAfterCompaction: event.tokensAfter,
                compactionActions: event.actions
              }))
            );
          } else if (event.type === "status") {
            setStreamStatus(event.status);
          } else if (event.type === "thought") {
            setMessages((prev) =>
              upsertAssistant(prev, (msg) => ({
                ...msg,
                thought: event.thought
              }))
            );
          } else if (event.type === "thinking") {
            setMessages((prev) =>
              upsertAssistant(prev, (msg) => ({
                ...msg,
                thought: msg.thought ? msg.thought + (event.content || "") : (event.content || "")
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
            // UI-003 / UI-011b: mirror the trace into ChatStream's own live-turn
            // state so rows survive a mid-turn stream cut even if the messages
            // prop cannot reflect them (severed-stream end-state assertion).
            setLiveTurnTraces((prev) => [...prev, event.trace]);
            setMessages((prev) =>
              upsertAssistant(prev, (msg) => ({
                ...msg,
                traces: currentTraces
              }))
            );
          } else if (event.type === "approval_required") {
            const approval = event.approval;
            if (approval && approval.id) {
              setHostApprovals((prev) => {
                const idx = prev.findIndex((a) => a.id === approval.id);
                const item: UiHostApproval = {
                  id: approval.id,
                  threadId: approval.threadId || targetThreadId || activeThreadId || threadId,
                  tool: approval.tool,
                  args: approval.args || {},
                  riskReason: approval.riskReason || "Destructive action requires approval",
                  createdAt: approval.createdAt || Date.now(),
                  expiresAt: approval.expiresAt || (Date.now() + 10 * 60 * 1000),
                  status: "pending"
                };
                if (idx >= 0) {
                  const copy = [...prev];
                  copy[idx] = { ...copy[idx], ...item };
                  return copy;
                }
                return [...prev, item];
              });
            }
          } else if (event.type === "done") {
            const durationMs = Math.round(performance.now() - startTime);
            const mergedRaw = mergeStreamedTokens(accumulatedRawContent, event.content);
            const parsed = parseThinkingAndContent(mergedRaw);
            const finalThought = event.thought !== undefined ? event.thought : parsed.thought;
            const finalModel = event.model || currentModel;
            const finalCompacted = Boolean(event.compactedThisTurn || compactedThisTurn);
            const finalTokensBefore = event.tokensBeforeCompaction ?? tokensBeforeCompaction;
            const finalTokensAfter = event.tokensAfterCompaction ?? tokensAfterCompaction;
            const finalStatus =
              event.status ||
              (event.isIncomplete ? "incomplete" : undefined) ||
              (event.content?.includes("⚠️ [Turn paused:") || event.content?.includes("⚠️ [Turn incomplete:")
                ? "incomplete"
                : undefined);

            const effectiveThreadId = targetThreadId || activeThreadId || threadId;
            if (effectiveThreadId && !activeSimulation) {
              try {
                fetch(`/api/threads/${effectiveThreadId}`, {
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
                      selectedModel: activeModel,
                      traces: event.traces || currentTraces,
                      attachments: event.attachments,
                      diffs: event.diffs,
                      durationMs,
                      timestamp: new Date().toISOString(),
                      compactedThisTurn: finalCompacted || undefined,
                      tokensBeforeCompaction: finalTokensBefore,
                      tokensAfterCompaction: finalTokensAfter,
                      compactionActions: event.compactionActions,
                      status: finalStatus
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
                attachments: event.attachments || msg.attachments,
                diffs: event.diffs || msg.diffs,
                modelUsed: finalModel,
                selectedModel: msg.selectedModel || activeModel,
                durationMs: event.durationMs || durationMs,
                compactedThisTurn: finalCompacted || undefined,
                tokensBeforeCompaction: finalTokensBefore,
                tokensAfterCompaction: finalTokensAfter,
                compactionActions: event.compactionActions || msg.compactionActions,
                status: finalStatus
              }))
            );

            // CHAT-STEER: clear pending steers indicator when turn ends or steers are acknowledged
            setPendingSteers([]);
            if (Array.isArray(event.pendingSteers) && event.pendingSteers.length > 0 && chatQueueRef.current) {
              for (const s of event.pendingSteers) {
                chatQueueRef.current.enqueue(s);
              }
              setQueueItems(chatQueueRef.current.items());
            }
          } else if (event.type === "steer") {
            // Render mid-turn consumed steer into messages in place and remove from pendingSteers
            if (Array.isArray(event.texts) && event.texts.length > 0) {
              setPendingSteers((prev) => prev.filter((p) => !event.texts.includes(p)));
              const steerMessages: ChatMessage[] = event.texts.map((t: string) => ({
                id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                role: "user",
                content: `[Steer from user, mid-turn] ${t}`
              }));
              setMessages((prev) => [...prev, ...steerMessages]);
            }
          } else if (event.type === "error") {
            setMessages((prev) =>
              upsertAssistant(prev, (msg) => ({
                ...msg,
                status: "error"
              }))
            );
            // Server explicitly reported a terminal turn error (e.g. engine offline,
            // simulation error event). This is a verdict, not a disconnect: never
            // route it into the detached-turn reconciliation path.
            const terminalErr = new Error(event.error || "Streaming error encountered");
            (terminalErr as any).isTerminalServerError = true;
            throw terminalErr;
          }
        } catch (parseErr: any) {
          if (parseErr.message && !parseErr.message.includes("JSON.parse")) {
            throw parseErr;
          }
        }
      }
    }
  };

  const runApprovalContinuation = async (approvalId: string) => {
    const targetThreadId = activeThreadId || threadId;
    setIsLoading(true);
    setStreamStatus("Continuing after host approval...");
    setErrorMsg(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const startTime = performance.now();
    const assistantMsgId = `assistant-${Date.now()}`;
    activeAssistantMsgIdRef.current = assistantMsgId;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          assistantMessageId: assistantMsgId,
          model: activeModel,
          mode: agentMode,
          reasoning_effort: reasoningEffort,
          threadId: targetThreadId,
          approvalContinuationId: approvalId
        })
      });

      if (!res.ok) {
        let errMessage = "Failed to continue after host approval";
        try {
          const errJson = await res.json();
          errMessage = errJson.error || errMessage;
        } catch {}
        const httpErr = new Error(errMessage);
        (httpErr as any).terminalServerError = true;
        throw httpErr;
      }

      await readStreamResponse(res, targetThreadId, startTime, assistantMsgId);
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.log("Approval continuation aborted by user");
        setMessages((prev) =>
          upsertAssistant(prev, (msg) => ({
            ...msg,
            status: "incomplete",
            isStopped: true
          }))
        );
      } else {
        console.error("[ChatStream] Stream interrupted mid-approval:", err);
        if (targetThreadId && err.isTerminalServerError !== true) {
          setIsTransientDisconnected(true);
          setReconcilingThreadId(targetThreadId);
          setStreamStatus("Connection interrupted — turn continuing server-side...");
          setMessages((prev) =>
            upsertAssistant(prev, (msg) => ({
              ...msg,
              status: "streaming"
            }))
          );
        } else {
          setErrorMsg(err.message || "Failed to continue chat after host approval");
          setMessages((prev) =>
            upsertAssistant(prev, (msg) => ({
              ...msg,
              status: "error"
            }))
          );
        }
      }
    } finally {
      setIsLoading(false);
      setStreamStatus(null);
      abortControllerRef.current = null;
      activeAssistantMsgIdRef.current = null;
    }
  };

  const handleApprovalDecision = async (approvalId: string, action: "approved" | "rejected") => {
    setHostApprovals((prev) =>
      prev.map((item) => (item.id === approvalId ? { ...item, isSubmitting: true } : item))
    );

    try {
      const res = await fetch("/api/host/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId, action })
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 410) {
        setHostApprovals((prev) =>
          prev.map((item) =>
            item.id === approvalId
              ? { ...item, status: "expired", isSubmitting: false }
              : item
          )
        );
        runApprovalContinuation(approvalId);
        return;
      }

      if (res.ok) {
        setHostApprovals((prev) =>
          prev.map((item) =>
            item.id === approvalId
              ? {
                  ...item,
                  status: action === "approved" ? "executed" : "denied",
                  result: data.result,
                  isSubmitting: false
                }
              : item
          )
        );
        runApprovalContinuation(approvalId);
        return;
      }

      if (res.status === 500) {
        setHostApprovals((prev) =>
          prev.map((item) =>
            item.id === approvalId
              ? {
                  ...item,
                  status: "error",
                  error: data.error || "Host tool execution failed",
                  isSubmitting: false
                }
              : item
          )
        );
        runApprovalContinuation(approvalId);
        return;
      }

      setHostApprovals((prev) =>
        prev.map((item) =>
          item.id === approvalId
            ? {
                ...item,
                status: "error",
                error: data.error || `Request failed with HTTP ${res.status}`,
                isSubmitting: false
              }
            : item
        )
      );
    } catch (err: any) {
      setHostApprovals((prev) =>
        prev.map((item) =>
          item.id === approvalId
            ? {
                ...item,
                status: "error",
                error: err?.message || "Failed to submit approval",
                isSubmitting: false
              }
            : item
        )
      );
    }
  };

  const handleSend = async (textToSend?: string) => {
    const rawPrompt = (textToSend !== undefined ? textToSend : input);
    const prompt = rawPrompt.trim();
    const hasAttachments = attachedFiles.length > 0;

    const action = decideSendAction({
      running: isGeneratingOrRunning,
      hasAttachments,
      text: prompt
    });

    if (action === "blocked-attachments") {
      if (isGeneratingOrRunning && hasAttachments) {
        setErrorMsg("Attachments cannot be queued while a turn is active. Please wait or send text only.");
      }
      return;
    }

    if (action === "enqueue") {
      let currentActiveThreadId = activeThreadIdRef.current || activeThreadState || threadId;
      if (!currentActiveThreadId && onEnsureThread) {
        currentActiveThreadId = (await onEnsureThread(prompt.slice(0, 40))) || undefined;
        if (currentActiveThreadId) {
          activeThreadIdRef.current = currentActiveThreadId;
          setActiveThreadId(currentActiveThreadId);
        }
      }

      // If midTurnAction is "steer", POST to /api/threads/[id]/steer
      if (midTurnAction === "steer" && currentActiveThreadId) {
        setIsSubmittingSteer(true);
        setErrorMsg(null);
        try {
          const steerRes = await fetch(`/api/threads/${encodeURIComponent(currentActiveThreadId)}/steer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: prompt, interrupt: true })
          });
          if (!steerRes.ok) {
            const errJson = await steerRes.json().catch(() => ({}));
            throw new Error(errJson.error || "Failed to deliver steer");
          }
          setPendingSteers((prev) => [...prev, prompt]);
          setInput("");
          if (textareaRef.current) textareaRef.current.style.height = "auto";
        } catch (steerErr: any) {
          setErrorMsg(steerErr.message || "Failed to deliver steer to turn");
          // Requirement 4: On steer POST failure, restore text into composer - never silently eaten
          setInput(prompt);
        } finally {
          setIsSubmittingSteer(false);
        }
        return;
      }

      // Default: Queue client-side
      if (typeof window !== "undefined" && currentActiveThreadId) {
        const q = chatQueueRef.current || new ChatQueue(window.localStorage, currentActiveThreadId);
        chatQueueRef.current = q;
        q.enqueue(prompt);
        setQueueItems(q.items());
        setInput("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
      }
      return;
    }

    if (!prompt && !hasAttachments) return;

    // Check if this is a simulation command (/simulate <scenario> [speed])
    const simCmd = parseSimulateCommand(prompt);
    const isSimulating = Boolean(simCmd || activeSimulation);
    const simKey = (simCmd?.scenarioKey || activeSimulation?.scenarioKey) as SimulationScenarioKey | undefined;
    const simSpeed = simCmd?.speed || activeSimulation?.speedMultiplier || 1;

    if (simCmd) {
      setActiveSimulation({ scenarioKey: simCmd.scenarioKey, speedMultiplier: simCmd.speed });
    }

    if (isSimulating && simKey) {
      const simScenario = getScenario(simKey);
      const isBuildScenario = simScenario?.mode === "build" || simKey === "project-task";

      if (isBuildScenario && simScenario?.initialTask) {
        setErrorMsg(null);
        setInput("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        setAttachedFiles([]);

        const userMsgId = `user-${Date.now()}`;
        const userMsg: ChatMessage = {
          id: userMsgId,
          role: "user",
          content: prompt
        };

        const taskInit = { ...simScenario.initialTask };
        const assistantMsgId = `assistant-${Date.now()}`;
        const assistantMsg: ChatMessage = {
          id: assistantMsgId,
          role: "assistant",
          content: "Started autonomous engineering run.",
          taskId: taskInit.taskId
        };

        setMessages((prev) => [...prev, userMsg, assistantMsg]);
        setIsLoading(true);
        setStreamStatus("Autonomous milestones scheduled. Workers active...");
        if (onTaskUpdated) {
          onTaskUpdated(taskInit);
        }

        if (activeSimTaskCancelRef.current) {
          activeSimTaskCancelRef.current();
          activeSimTaskCancelRef.current = null;
        }

        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        activeSimTaskCancelRef.current = runSimulatedTask(
          simKey,
          simSpeed,
          {
            onTaskUpdate: (updatedTask) => {
              if (onTaskUpdated) onTaskUpdated(updatedTask);
              if (updatedTask.status === "completed" || updatedTask.status === "cancelled" || updatedTask.status === "failed") {
                setIsLoading(false);
                setStreamStatus(null);
              }
            },
            onComplete: () => {
              setIsLoading(false);
              setStreamStatus(null);
              activeSimTaskCancelRef.current = null;
            },
            onError: (err) => {
              setErrorMsg(err.message);
              setIsLoading(false);
              setStreamStatus(null);
              activeSimTaskCancelRef.current = null;
            }
          },
          abortController.signal
        );
        return;
      }
    }

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

    let activeThreadId = activeThreadIdRef.current || activeThreadState || threadId;
    if (!activeThreadId && onEnsureThread) {
      activeThreadId = (await onEnsureThread(prompt.slice(0, 40))) || undefined;
      if (activeThreadId) {
        activeThreadIdRef.current = activeThreadId;
        setActiveThreadId(activeThreadId);
      }
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

    isFollowPinnedRef.current = true;
    setIsUserScrolledUp(false);
    scrollToBottom("auto");
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);

    // If inside a persistent thread, persist the user message (skip in offline simulation)
    if (activeThreadId && !isSimulating) {
      try {
        await fetch(`/api/threads/${activeThreadId}`, {
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
    // UI-003 / UI-011b: fresh live-turn trace rows for this turn.
    setLiveTurnTraces([]);

    const startTime = performance.now();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const assistantMsgId = `assistant-${Date.now()}`;
    activeAssistantMsgIdRef.current = assistantMsgId;
    let turnEndedNormally = false;

    try {
      const res = isSimulating && simKey
        ? await createSimulatedChatResponse(simKey, simSpeed, abortController.signal)
        : await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: abortController.signal,
            body: JSON.stringify({
              messages: updatedMessages.map((m) => ({ role: m.role, content: m.content })),
              userMessageId: userMsgId,
              assistantMessageId: assistantMsgId,
              model: activeModel,
              mode: agentMode,
              reasoning_effort: reasoningEffort,
              threadId: activeThreadId || threadId,
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
        // HTTP-level failure is a terminal verdict (503 backend-down, 413, 504),
        // not a mid-stream disconnect: never reconcile it server-side.
        const httpErr = new Error(errMessage);
        (httpErr as any).isTerminalServerError = true;
        throw httpErr;
      }

      await readStreamResponse(res, activeThreadId || threadId, startTime, assistantMsgId);
      turnEndedNormally = true;
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.log("Chat stream aborted by user");
        setMessages((prev) =>
          upsertAssistant(prev, (msg) => ({
            ...msg,
            status: "incomplete",
            isStopped: true
          }))
        );
      } else {
        console.error("[ChatStream] Stream interrupted mid-turn:", err);
        const currentTid = activeThreadId || threadId;
        // Transient reconciliation applies only to genuine client-side disconnects
        // on real threads. Terminal server errors (engine offline, HTTP 503) and
        // offline simulations must render the error banner + Retry surface instead.
        if (currentTid && err.isTerminalServerError !== true && !isSimulating) {
          // Deliverable 3: Mid-turn stream failure becomes a TRANSIENT state, never a terminal verdict.
          setIsTransientDisconnected(true);
          setReconcilingThreadId(currentTid);
          setStreamStatus("Connection interrupted — turn continuing server-side...");
          setMessages((prev) =>
            upsertAssistant(prev, (msg) => ({
              ...msg,
              status: "streaming"
            }))
          );
        } else {
          setErrorMsg(err.message || "Failed to communicate with agent orchestrator");
          setMessages((prev) =>
            upsertAssistant(prev, (msg) => ({
              ...msg,
              status: "error"
            }))
          );
        }
      }
    } finally {
      setIsLoading(false);
      setStreamStatus(null);
      abortControllerRef.current = null;
      activeAssistantMsgIdRef.current = null;

      // Drain exactly ONE queued item on normal DONE (never on abort/error)
      if (turnEndedNormally && chatQueueRef.current) {
        const nextItem = drainNextForTurnEnd(chatQueueRef.current, "done");
        if (nextItem) {
          setQueueItems(chatQueueRef.current.items());
          // Schedule next turn via handleSend
          setTimeout(() => {
            handleSend(nextItem.text);
          }, 50);
        }
      }
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
  const shortModelLabel = modelSafe.includes("flash-next") || modelSafe.includes("gyro")
    ? "Flash-Next"
    : modelSafe.includes("IQ3") || modelSafe.includes("Qwen3.8")
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

  // Anchor for the reconciled detached-turn notification: the last assistant message,
  // not the literal tail, so a steer bubble appended after reconciliation does not hide it.
  const lastAssistantIndex = deduplicatedMessages.reduce(
    (last, m, i) => (m.role === "assistant" ? i : last),
    -1
  );

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

      {/* Compaction Details & Restore Modal */}
      {showCompactionModal && threadCompaction && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowCompactionModal(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Conversation Compaction"
            data-testid="compaction-modal"
            className="relative max-w-lg w-full rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 p-5 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <h3 className="text-sm font-bold text-slate-900 dark:text-zinc-100">
                  Conversation Compaction
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCompactionModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="text-xs text-slate-600 dark:text-zinc-300 space-y-2">
              <div className="flex justify-between font-mono text-[11px] bg-slate-50 dark:bg-zinc-800/50 p-2.5 rounded-xl border border-slate-100 dark:border-zinc-800">
                <span>Before: ~{threadCompaction.tokensBefore} tokens</span>
                <span>After: ~{threadCompaction.tokensAfter} tokens</span>
              </div>
              <p className="font-semibold text-slate-800 dark:text-zinc-200">Retained Digest:</p>
              <pre className="max-h-56 overflow-y-auto p-3 rounded-xl bg-slate-50 dark:bg-zinc-950 font-mono text-[11px] whitespace-pre-wrap border border-slate-200/80 dark:border-zinc-800">
                {threadCompaction.summary}
              </pre>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-zinc-800">
              <button
                type="button"
                onClick={handleRestoreCompaction}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-900/60 transition-colors"
              >
                Restore full history
              </button>
              <button
                type="button"
                onClick={() => setShowCompactionModal(false)}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

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
      <header className="sticky top-0 z-30 px-2 sm:px-4 py-2 sm:py-3 border-b border-slate-200/80 dark:border-zinc-800 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md flex items-center justify-between shrink-0">
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
              <span className="hidden 2xl:inline">Projects</span>
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
              <span className="hidden 2xl:inline">Sessions</span>
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
            className="hidden 2xl:block text-base font-bold tracking-tight text-slate-900 dark:text-zinc-100 max-w-[160px] truncate"
            title={threadTitle || "New session"}
          >
            {threadTitle || "New session"}
          </h1>
        </div>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          {/* Simulation Mode Badge */}
          {activeSimulation && (
            <div
              data-testid="simulation-badge"
              className="inline-flex items-center gap-1 sm:gap-1.5 pl-2 pr-0.5 py-0.5 rounded-full bg-amber-500/10 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/40 text-[10px] sm:text-xs font-bold uppercase tracking-wider shrink-0"
              title={`Simulation active: ${activeSimulation.scenarioKey} (${activeSimulation.speedMultiplier || 1}x speed)`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block shrink-0" />
              <span className="sr-only sm:not-sr-only">SIMULATION</span>
              <span aria-hidden="true" className="sm:hidden">SIM</span>
              <span className="hidden 2xl:inline font-mono text-[10px] lowercase text-amber-600 dark:text-amber-300">
                (${activeSimulation.scenarioKey})
              </span>
              <button
                type="button"
                onClick={() => {
                  if (activeSimTaskCancelRef.current) {
                    activeSimTaskCancelRef.current();
                    activeSimTaskCancelRef.current = null;
                  }
                  setActiveSimulation(null);
                }}
                className="min-h-[40px] min-w-[40px] -my-1 -mr-0.5 flex items-center justify-center rounded-full hover:bg-amber-500/20 text-amber-800 dark:text-amber-200 transition-colors"
                title="Exit simulation mode"
                aria-label="Exit simulation mode"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Scope Badge if available */}
          {(threadScope || activeTask?.scope) && (
            <span
              className="hidden xl:inline-flex px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60 text-xs font-semibold uppercase tracking-wider"
              title={`Task Scope: ${threadScope || activeTask?.scope}`}
            >
              {threadScope || activeTask?.scope}
            </span>
          )}

          {/* Context Meter Pill - visible on both mobile and desktop */}
          <div
            data-testid="context-meter-pill"
            className="flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2.5 py-1 rounded-full bg-slate-50 dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-800 text-[10px] sm:text-[11px] font-mono shrink-0"
            title={`Context budget: ${displayContextTokens} / ${contextStats.budgetTokens} tokens (${Math.round((displayContextTokens / contextStats.budgetTokens) * 100)}%)`}
          >
            <span
              className={`font-semibold ${
                displayContextTokens > 85000
                  ? "text-rose-600 dark:text-rose-400"
                  : displayContextTokens > 70000
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-slate-600 dark:text-zinc-400"
              }`}
            >
              {Math.round(displayContextTokens / 1000)}K / {Math.round(contextStats.budgetTokens / 1000)}K
            </span>
            <div className="hidden 2xl:block w-10 h-1.5 rounded-full bg-slate-200 dark:bg-zinc-800 overflow-hidden">
              <div
                className={`h-full transition-all ${
                  displayContextTokens > 85000
                    ? "bg-rose-500"
                    : displayContextTokens > 70000
                    ? "bg-amber-500"
                    : "bg-emerald-500"
                }`}
                style={{
                  width: `${Math.min(100, Math.round((displayContextTokens / contextStats.budgetTokens) * 100))}%`
                }}
              />
            </div>
            {threadCompaction ? (
              <button
                type="button"
                onClick={() => setShowCompactionModal(true)}
                className="min-h-[40px] min-w-[40px] -my-1.5 ml-0.5 px-2 py-1 inline-flex items-center justify-center rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
                title="View compaction summary and restore options"
              >
                Compacted
              </button>
            ) : null}
          </div>

          {/* Engine Status Pill - desktop only (on mobile, Stop lives with turn in composer/stream) */}
          <div className="hidden xl:flex items-center">
            <EngineStatusPill onOpenSettings={onOpenModelSheet} />
          </div>

          {/* Host Read-Only Status Chip (controlled via global Settings switch) */}
          {(() => {
            if (!hostAccess) {
              return (
                <div
                  data-testid="host-access-chip"
                  className="inline-flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full bg-slate-500/10 text-slate-600 dark:text-zinc-400 border border-slate-500/30 text-[10px] sm:text-xs font-semibold shrink-0"
                  title="Host access disabled in Settings"
                  aria-label="Host offline"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 inline-block" />
                  <span className="hidden sm:inline">Host offline</span>
                  <span className="sm:hidden">Offline</span>
                </div>
              );
            }
            if (runnerState === "READY" || (runnerState === null && runnerAvailable === true)) {
              return (
                <div
                  data-testid="host-access-chip"
                  className="inline-flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 text-[10px] sm:text-xs font-semibold shrink-0"
                  title="Host access ON"
                  aria-label="Host access ON"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block animate-pulse" />
                  <span className="hidden sm:inline">Host access ON</span>
                  <span className="sm:hidden">ON</span>
                </div>
              );
            }
            if (runnerState === "MISMATCH") {
              return (
                <div
                  data-testid="host-access-chip"
                  className="inline-flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full bg-rose-500/10 text-rose-800 dark:text-rose-300 border border-rose-500/30 text-[10px] sm:text-xs font-semibold shrink-0"
                  title={runnerReason || "Host runner daemon version/digest mismatch. Run AI-ON.ps1 to update."}
                  aria-label="Host update required"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500 inline-block" />
                  <span className="hidden sm:inline">Host update required</span>
                  <span className="sm:hidden">Update</span>
                </div>
              );
            }
            return (
              <div
                data-testid="host-access-chip"
                className="inline-flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full bg-amber-500/10 text-amber-800 dark:text-amber-300 border border-amber-500/30 text-[10px] sm:text-xs font-semibold shrink-0"
                title={runnerReason || "Host runner is unreachable (Host offline)"}
                aria-label="Host offline"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
                <span className="hidden sm:inline">Host offline</span>
                <span className="sm:hidden">Offline</span>
              </div>
            );
          })()}

          {/* Model Chip Button: opens ModelBottomSheet on tap */}
          <button
            type="button"
            onClick={onOpenModelSheet}
            className="min-h-[44px] flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full bg-slate-50 dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-700 text-xs font-semibold text-emerald-700 dark:text-emerald-400 shadow-2xs hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            title={`Active model: ${activeModel || "swift-15-27b-mtp"} · Tap to configure`}
            aria-label={`Configure model: currently ${shortModelLabel}`}
          >
            <Sparkles className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="max-w-[54px] sm:max-w-[88px] xl:max-w-[110px] truncate">{shortModelLabel}</span>
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
                {(activeThreadId || threadId) && (
                  <button
                    type="button"
                    onClick={handleManualCompact}
                    disabled={isCompactingManually}
                    className="w-full text-left px-3 py-2 text-xs font-medium text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-xl disabled:opacity-50"
                  >
                    {isCompactingManually ? "Compacting history..." : "Compact history now"}
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
        onWheel={handleContainerWheel}
        onTouchMove={handleContainerTouchMove}
        data-scroll-container="true"
        className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 bg-white dark:bg-zinc-950 relative"
      >
        <div className="chat-track max-w-[840px] w-full mx-auto space-y-5 pb-8">
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
                  <div className="flex items-center gap-2 mt-1 mr-1 text-[11px] text-slate-400 dark:text-zinc-500">
                    <button
                      type="button"
                      data-testid="copy-user-message-btn"
                      onClick={() => copyToClipboard(m.content, m.id)}
                      className="inline-flex items-center gap-1 hover:text-slate-800 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                      title={copiedMessageId === m.id ? "Copied" : "Copy prompt"}
                      aria-label={copiedMessageId === m.id ? "Copied" : "Copy prompt"}
                    >
                      {copiedMessageId === m.id ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                          <span className="text-emerald-600 dark:text-emerald-400 font-medium">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                    {m.timestamp && (
                      <span>
                        {(() => {
                          const d = new Date(m.timestamp);
                          return isNaN(d.getTime())
                            ? m.timestamp
                            : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
                        })()}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                /* Assistant Message View */
                <div className="w-full max-w-[840px] space-y-3">
                  {((!isUser && m.compactedThisTurn && m.tokensBeforeCompaction !== undefined && m.tokensAfterCompaction !== undefined) || m.status === "incomplete" || m.status === "error" || m.status === "streaming") && (
                    <div className="flex flex-wrap items-center gap-2">
                      {!isUser && m.compactedThisTurn && m.tokensBeforeCompaction !== undefined && m.tokensAfterCompaction !== undefined && (
                        <div className="flex flex-col gap-1 w-fit">
                          <div
                            data-testid="compaction-turn-note"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-800 text-[11px] font-mono text-slate-600 dark:text-zinc-400 w-fit"
                          >
                            <span>
                              History compacted: {m.tokensBeforeCompaction.toLocaleString()} → {m.tokensAfterCompaction.toLocaleString()} tokens
                            </span>
                          </div>
                          {/* COMPACTION ACTIONS (compaction-pill): the chat route stores the real
                              CompactionAction[] from fitConversationToBudget (contextBudget.ts:816-820)
                              on the thread record; render them as capped chips under the pill line. */}
                          {m.compactionActions && m.compactionActions.length > 0 && (() => {
                            const CAP = 3;
                            const shown = m.compactionActions.slice(0, CAP);
                            const overflow = m.compactionActions.length - shown.length;
                            return (
                              <div data-testid="compaction-action-chips" className="flex flex-wrap items-center gap-1.5">
                                {shown.map((action, i) => (
                                  <span
                                    key={`${action}-${i}`}
                                    data-testid="compaction-action-chip"
                                    className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-50 dark:bg-zinc-800/60 border border-slate-200/70 dark:border-zinc-700 text-[10px] font-mono text-slate-500 dark:text-zinc-500"
                                  >
                                    {COMPACTION_ACTION_LABELS[action] ?? action}
                                  </span>
                                ))}
                                {overflow > 0 && (
                                  <span
                                    data-testid="compaction-action-overflow"
                                    className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-50 dark:bg-zinc-800/60 border border-slate-200/70 dark:border-zinc-700 text-[10px] font-mono text-slate-500 dark:text-zinc-500"
                                  >
                                    +{overflow} more
                                  </span>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                      {m.status === "streaming" && (
                        <div
                          data-testid="message-status-badge"
                          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-cyan-50 dark:bg-cyan-950/60 border border-cyan-300 dark:border-cyan-800 text-[11px] font-mono font-medium text-cyan-800 dark:text-cyan-300 w-fit"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-pulse" />
                          <span>Streaming</span>
                        </div>
                      )}
                      {m.status === "incomplete" && (
                        <div
                          data-testid="message-status-badge"
                          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-800 text-[11px] font-mono font-medium text-amber-800 dark:text-amber-300 w-fit"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                          <span>Incomplete</span>
                        </div>
                      )}
                      {m.status === "error" && (
                        <div
                          data-testid="message-status-badge"
                          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-red-50 dark:bg-red-950/60 border border-red-300 dark:border-red-800 text-[11px] font-mono font-medium text-red-800 dark:text-red-300 w-fit"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                          <span>Error</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Worker Reasoning Panel (Prominent, Phased, Expanded by Default - Suppressed on task host message) */}
                  {!isTaskHostMessage && (() => {
                    const isStreamingThis = Boolean(
                      m.status === "streaming" ||
                      (isLoading && m.id === activeAssistantMsgIdRef.current)
                    );
                    const shouldRenderThinking = Boolean(m.thought || isStreamingThis);
                    if (!shouldRenderThinking) return null;

                    const rawThought = m.thought || (isStreamingThis && !m.content ? "Analyzing prompt and formulating execution plan..." : "");

                    return (
                      <div className="w-full">
                        <ThinkingPanel
                          rawThought={rawThought}
                          isStreaming={isStreamingThis}
                          streamStatus={isStreamingThis ? streamStatus : null}
                          hasContent={Boolean(m.content && m.content.trim())}
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

                          return (
                            <div
                              key={tIdx}
                              className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-900/60 overflow-hidden shadow-xs transition-all"
                            >
                              <button
                                type="button"
                                onClick={() => toggleProof(proofKey)}
                                aria-label={`Tool: ${trace.tool}`}
                                className="w-full px-3.5 py-2 flex items-center justify-between text-left hover:bg-slate-100/80 dark:hover:bg-zinc-850/80 transition-colors text-xs font-mono"
                              >
                                <div className="flex items-center gap-1.5 flex-wrap min-w-0 pr-2">
                                  {human.badge === "browser" && (
                                    <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400 font-semibold shrink-0">
                                      <Globe className="h-3.5 w-3.5" />
                                      <span>Web</span>
                                    </span>
                                  )}
                                  {human.badge === "host" && (
                                    <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300 font-semibold shrink-0">
                                      <Terminal className="h-3.5 w-3.5" />
                                      <span>Host</span>
                                    </span>
                                  )}
                                  {human.badge === "workspace" && (
                                    <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 font-semibold shrink-0">
                                      <FolderGit2 className="h-3.5 w-3.5" />
                                      <span>Workspace</span>
                                    </span>
                                  )}
                                  {human.badge === "sandbox" && (
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
                      liveTraces={liveTraces}
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
                    <>
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

                    {/* Copy Response Action: phone-tappable button copying raw assistant markdown */}
                    <div className="flex items-center gap-2 pt-1 text-xs">
                      <button
                        type="button"
                        data-testid="copy-response-btn"
                        onClick={() => copyToClipboard(m.content, m.id)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-colors text-xs font-medium cursor-pointer"
                        title={isCopied ? "Copied" : "Copy response"}
                        aria-label={isCopied ? "Copied" : "Copy response"}
                      >
                        {isCopied ? (
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
                  </>
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

                  {/* Generated File Cards (Download / Open) */}
                  {!isUser && m.attachments && m.attachments.length > 0 && (
                    <div className="flex flex-col gap-2.5 pt-1 w-full max-w-lg">
                      {m.attachments.map((att, aIdx) => {
                        const fileRelPath = att.previewUrl || att.name;
                        const isHtml = att.name.toLowerCase().endsWith(".html") || att.type === "text/html";
                        const isSvg = att.name.toLowerCase().endsWith(".svg") || att.type === "image/svg+xml";
                        const canOpenInTab = isHtml || isSvg;
                        const downloadUrl = `/api/files?path=${encodeURIComponent(fileRelPath)}&download=1`;
                        const openUrl = `/api/files?path=${encodeURIComponent(fileRelPath)}`;

                        return (
                          <div
                            key={aIdx}
                            className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xs"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="p-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 text-emerald-600 dark:text-emerald-400 shrink-0">
                                <FileCode className="h-5 w-5" />
                              </div>
                              <div className="flex flex-col min-w-0">
                                <span className="font-semibold text-sm text-slate-900 dark:text-zinc-100 truncate" title={att.name}>
                                  {att.name}
                                </span>
                                <span className="text-xs text-slate-500 dark:text-zinc-400">
                                  {formatFileSize(att.size)}
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {canOpenInTab && (
                                <a
                                  href={openUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="min-h-[44px] min-w-[44px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                                  title="Open in new tab"
                                >
                                  <ExternalLink className="h-4 w-4" />
                                  <span>Open</span>
                                </a>
                              )}
                              <a
                                href={downloadUrl}
                                download={att.name}
                                className="min-h-[44px] min-w-[44px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 shadow-xs transition-colors"
                                title="Download file"
                              >
                                <Download className="h-4 w-4" />
                                <span>Download</span>
                              </a>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Chat Diff Cards for File Writes & Patches */}
                  {(() => {
                    if (isUser) return null;

                    const fileDiffs: Array<{
                      path: string;
                      diff: string;
                      addedLines: number;
                      removedLines: number;
                      truncated?: boolean;
                      totalDiffLines?: number;
                      omittedLines?: number;
                    }> = Array.isArray(m.diffs) && m.diffs.length > 0
                      ? m.diffs
                      : extractFileWriteDiffsFromTraces(m.traces).map((d) => ({
                          path: d.path,
                          diff: d.diffPreview,
                          addedLines: d.addedLines,
                          removedLines: d.removedLines,
                          truncated: d.diffPreview.includes("more lines")
                        }));

                    if (fileDiffs.length === 0) return null;

                    return (
                      <div className="flex flex-col gap-2 pt-1 w-full max-w-xl">
                        {fileDiffs.map((diffItem, diffIdx) => (
                          <div
                            key={`${m.id}-diff-${diffIdx}-${diffItem.path}`}
                            data-testid="chat-diff-card"
                            className="w-full max-w-xl space-y-1"
                          >
                            <div className="flex items-center justify-end px-1">
                              <button
                                type="button"
                                onClick={() => copyToClipboard(diffItem.path, `${m.id}-${diffIdx}`)}
                                className="px-2 py-0.5 rounded text-[11px] font-mono text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200 flex items-center gap-1 transition-colors"
                                title="Copy path"
                              >
                                <Copy className="h-3 w-3" />
                                <span>Copy path</span>
                              </button>
                            </div>
                            <DiffViewer
                              branch={diffItem.path}
                              diff={diffItem.diff}
                              modifiedFiles={[diffItem.path]}
                            />
                            {diffItem.truncated && (diffItem.omittedLines ?? 0) > 0 ? (
                              <div className="px-3 py-1.5 text-[11px] font-mono rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                                Truncated: showing {MAX_DIFF_LINES_CAP} of {diffItem.totalDiffLines} diff lines ({diffItem.omittedLines} omitted)
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    );
                  })()}

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

                  {/* Detached turn resolved notification */}
                  {hasResolvedDetachedTurn && idx === lastAssistantIndex && (
                    <div
                      data-testid="turn-resolved-detached"
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60 text-xs font-medium"
                    >
                      <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      <span>Turn completed server-side and reconciled</span>
                    </div>
                  )}

                  {/* Per-message served model indicator: only display when served model differs from selected */}
                  {(() => {
                    if (m.id === "initial-welcome") return null;
                    const note = getServedByNote(m.modelUsed, m.selectedModel ?? activeModel);
                    if (!note) return null;
                    return (
                      <div
                        data-testid="served-by-note"
                        className="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-zinc-500 pt-0.5"
                      >
                        <Sparkles className="h-2.5 w-2.5 text-emerald-500/70" />
                        <span>{note}</span>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })}

        {/* UI-003 / UI-011b: live tool-call trace rows for the current turn.
            Rendered from ChatStream's own liveTurnTraces state so rows received
            before a stream cut remain visible on the live screen. */}
        {liveTurnTraces.length > 0 && (
          <div className="w-full max-w-[840px]" data-testid="live-trace-rows">
            <div className="rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50/60 dark:bg-zinc-900/60 overflow-hidden">
              <div className="px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-zinc-400 border-b border-slate-200 dark:border-zinc-800">
                Live tool steps ({liveTurnTraces.length})
              </div>
              {liveTurnTraces.map((t, i) => {
                const readable = formatHumanReadableTrace(t);
                return (
                  <button
                    key={`${t.tool}-${i}`}
                    type="button"
                    aria-label={`Tool: ${t.tool}`}
                    className="w-full px-3.5 py-2 flex items-center justify-between text-left hover:bg-slate-100/80 dark:hover:bg-zinc-850/80 transition-colors text-xs font-mono"
                  >
                    <span className="flex items-center gap-2 text-slate-700 dark:text-zinc-300">
                      <Check size={10} className="text-emerald-500" />
                      <span>{readable.title || t.tool}</span>
                    </span>
                    <span className="text-slate-400 dark:text-zinc-500">{readable.duration || ""}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Render LiveRunBlock if activeTask is present and not already embedded in an assistant message */}
        {activeTask && lastLinkedTaskMsgIndex === -1 && (
          <div className="w-full max-w-[840px]">
            <LiveRunBlock
              task={activeTask}
              liveTraces={liveTraces}
              onStopRun={onStopTask}
              onPauseRun={() => handleRunControlAction("pause")}
              onResumeRun={() => handleRunControlAction("resume")}
              onRestartRun={() => handleRunControlAction("restart")}
              onDeployRun={onDeployRun}
              isStopping={isStoppingTask}
            />
          </div>
        )}

        {/* Host Mode Approvals (Cards & Receipts) */}
        {hostApprovals.length > 0 && (
          <div className="w-full max-w-[840px] space-y-3">
            {hostApprovals.map((approval) => {
              const isPending =
                approval.status === "pending" &&
                (!approval.expiresAt || approval.expiresAt > Date.now());

              if (isPending) {
                return (
                  <div
                    key={approval.id}
                    data-testid="host-approval-card"
                    className="w-full rounded-2xl border border-amber-500/40 bg-white dark:bg-zinc-900 shadow-md p-4 sm:p-5 space-y-3"
                  >
                    <div className="flex items-center justify-between gap-2 border-b border-slate-100 dark:border-zinc-800 pb-2.5">
                      <div className="flex items-center gap-2">
                        <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                        <span className="text-xs font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                          Security Approval Required
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-[11px] font-mono font-medium text-slate-700 dark:text-zinc-300">
                          {approval.tool}
                        </span>
                      </div>
                      {approval.expiresAt && (
                        <span className="text-[11px] text-slate-500 dark:text-zinc-400 font-mono">
                          Expires: {new Date(approval.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      )}
                    </div>

                    <div className="text-xs text-slate-700 dark:text-zinc-300 font-medium">
                      {approval.riskReason}
                    </div>

                    {(approval.args?.command || approval.args?.path) && (
                      <div className="rounded-xl bg-slate-950 p-3 overflow-x-auto text-xs text-zinc-200 font-mono">
                        <pre className="whitespace-pre-wrap break-all">
                          <code>{approval.args?.command || approval.args?.path}</code>
                        </pre>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      {approval.args?.cwd && (
                        <span className="text-slate-500 dark:text-zinc-400 font-mono">
                          cwd: <span className="text-slate-700 dark:text-zinc-200">{approval.args.cwd}</span>
                        </span>
                      )}
                      {approval.args?.recursive && (
                        <span className="px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20 font-mono font-semibold">
                          recursive: true
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-end gap-2.5 pt-1">
                      <button
                        type="button"
                        data-testid="host-deny-btn"
                        disabled={approval.isSubmitting}
                        onClick={() => handleApprovalDecision(approval.id, "rejected")}
                        className="min-h-[38px] px-4 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-700 text-xs font-semibold transition-colors disabled:opacity-50"
                      >
                        {approval.isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" /> : null}
                        Deny
                      </button>
                      <button
                        type="button"
                        data-testid="host-approve-btn"
                        disabled={approval.isSubmitting}
                        onClick={() => handleApprovalDecision(approval.id, "approved")}
                        className="min-h-[38px] px-4 py-1.5 rounded-xl border border-emerald-600 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-sm transition-colors disabled:opacity-50"
                      >
                        {approval.isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" /> : null}
                        Approve
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={approval.id}
                  data-testid="host-approval-receipt"
                  className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-900/60 p-3 sm:p-4 text-xs space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider ${
                          approval.status === "executed"
                            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20"
                            : approval.status === "denied"
                            ? "bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20"
                            : approval.status === "expired"
                            ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20"
                            : "bg-red-500/10 text-red-700 dark:text-red-400 border border-red-500/20"
                        }`}
                      >
                        {approval.status === "executed"
                          ? "Executed"
                          : approval.status === "denied"
                          ? "Denied"
                          : approval.status === "expired"
                          ? "Expired"
                          : "Error"}
                      </span>
                      <span className="font-mono text-slate-700 dark:text-zinc-300 font-semibold">
                        {approval.tool}
                      </span>
                    </div>
                  </div>

                  <div className="text-slate-600 dark:text-zinc-400 font-mono text-[11px] truncate">
                    {approval.args?.command || approval.args?.path}
                  </div>

                  {approval.error && (
                    <div className="text-rose-600 dark:text-rose-400 text-[11px]">
                      {approval.error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Standalone turn status slot only when isLoading is true and no assistant ThinkingPanel is rendered at the tail */}
        {isLoading && (() => {
          const tailIdx = deduplicatedMessages.length - 1;
          const tailMsg = tailIdx >= 0 ? deduplicatedMessages[tailIdx] : null;
          const tailIsTaskHost = tailIdx === lastLinkedTaskMsgIndex && !!activeTask;
          const tailRendersThinkingPanel = Boolean(tailMsg && tailMsg.role === "assistant" && !tailIsTaskHost);
          if (tailRendersThinkingPanel) return null;
          const phaseLabel = resolveTurnStatusPhase({
            isStreaming: true,
            streamStatus,
            hasThought: false,
            hasContent: false
          });
          if (!phaseLabel) return null;
          return (
            <div
              data-testid="turn-status-slot"
              className="inline-flex items-center gap-2 h-7 px-3 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800/50 text-emerald-800 dark:text-emerald-300 w-fit"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>{phaseLabel}</span>
            </div>
          );
        })()}

        {/* Deliverable 3: Transient stream disconnected indicator */}
        {isTransientDisconnected && (
          <div
            data-testid="turn-transient-disconnected"
            className="flex items-center gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-200 text-xs font-medium w-full max-w-xl"
          >
            <Loader2 className="h-4 w-4 animate-spin text-amber-600 dark:text-amber-400 shrink-0" />
            <span>Connection interrupted — turn continuing server-side...</span>
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
        <div className="flex justify-center -mt-14 mb-3 z-30 pointer-events-none">
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
        
        {/* CHAT-STEER: Pending Steer indicator above composer */}
        {pendingSteers.length > 0 && (
          <div data-testid="chat-steer-pending-deck" className="flex items-center gap-2 pb-2 mb-2 border-b border-sky-100 dark:border-sky-950/60 max-w-[840px] mx-auto overflow-x-auto scrollbar-none">
            <span className="text-[11px] font-semibold text-sky-700 dark:text-sky-400 shrink-0 uppercase tracking-wider flex items-center gap-1">
              <span>Steer pending ({pendingSteers.length}):</span>
            </span>
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              {pendingSteers.map((st, idx) => (
                <div
                  key={idx}
                  data-testid="chat-steer-pending-chip"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sky-50 dark:bg-sky-950/50 border border-sky-200 dark:border-sky-800 text-[11px] font-medium text-sky-950 dark:text-sky-200 shrink-0 max-w-[280px]"
                >
                  <span className="truncate" title={st}>
                    {st}
                  </span>
                  <span className="text-[9px] text-sky-600 dark:text-sky-400 italic shrink-0">
                    (lands at next step)
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* CHAT-QUEUE: Queue Chips above composer with per-item × and clear all */}
        {queueItems.length > 0 && (
          <div data-testid="chat-queue-deck" className="flex items-center gap-2 pb-2 mb-2 border-b border-slate-100 dark:border-zinc-850 max-w-[840px] mx-auto overflow-x-auto scrollbar-none">
            <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 shrink-0 uppercase tracking-wider flex items-center gap-1">
              <span>Queue ({queueItems.length}):</span>
            </span>
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              {queueItems.map((item, idx) => (
                <div
                  key={item.id}
                  data-testid="chat-queue-chip"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-[11px] font-medium text-emerald-950 dark:text-emerald-200 shrink-0 max-w-[220px]"
                >
                  <span className="truncate" title={item.text}>
                    {idx + 1}. {item.text}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove queued item ${idx + 1}`}
                    onClick={() => {
                      if (chatQueueRef.current) {
                        chatQueueRef.current.remove(item.id);
                        setQueueItems(chatQueueRef.current.items());
                      }
                    }}
                    className="p-0.5 rounded-full hover:bg-emerald-200 dark:hover:bg-emerald-800 text-emerald-600 dark:text-emerald-400 hover:text-emerald-950 transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              data-testid="chat-queue-clear-all"
              onClick={() => {
                if (chatQueueRef.current) {
                  chatQueueRef.current.clearAll();
                  setQueueItems([]);
                }
              }}
              className="text-[11px] text-slate-500 hover:text-rose-600 dark:text-zinc-400 dark:hover:text-rose-400 underline shrink-0 px-1"
            >
              Clear all
            </button>
          </div>
        )}

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
              {/* Mid-Turn Action Selector (Queue vs Steer) when turn is active */}
              {isGeneratingOrRunning && (
                <div
                  role="radiogroup"
                  aria-label="Mid-Turn Action Selector"
                  className="inline-flex rounded-full p-0.5 bg-slate-200/60 dark:bg-zinc-850 text-[11px] font-medium select-none"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={midTurnAction === "queue"}
                    onClick={() => handleSelectMidTurnAction("queue")}
                    className={`px-2.5 py-0.5 rounded-full transition-all ${
                      midTurnAction === "queue"
                        ? "bg-white dark:bg-zinc-900 text-emerald-700 dark:text-emerald-300 font-semibold shadow-xs"
                        : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                    }`}
                  >
                    Queue
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={midTurnAction === "steer"}
                    onClick={() => handleSelectMidTurnAction("steer")}
                    className={`px-2.5 py-0.5 rounded-full transition-all ${
                      midTurnAction === "steer"
                        ? "bg-white dark:bg-zinc-900 text-sky-700 dark:text-sky-300 font-semibold shadow-xs"
                        : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                    }`}
                  >
                    Steer
                  </button>
                </div>
              )}

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

              {/* Action Buttons Deck */}
              {isGeneratingOrRunning && (
                <button
                  type="button"
                  onClick={handleStop}
                  data-testid="stop-button"
                  className="h-9 w-9 rounded-full bg-zinc-900 hover:bg-black text-white flex items-center justify-center shadow-xs active:scale-95 transition-all shrink-0"
                  title="Stop generation / halt workers"
                  aria-label="Stop generation"
                >
                  <Square className="h-3.5 w-3.5 fill-current stroke-none" />
                </button>
              )}

              {/* Send Button: Always visible and enabled whenever input text is present, even during an active run */}
              {(!isGeneratingOrRunning || input.trim().length > 0) && (
                <button
                  type="submit"
                  disabled={isSubmittingSteer || (!input.trim() && attachedFiles.length === 0)}
                  data-testid="send-button"
                  className={`h-9 w-9 rounded-full text-white flex items-center justify-center shadow-xs active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition-all shrink-0 ${
                    isGeneratingOrRunning && midTurnAction === "steer"
                      ? "bg-sky-600 hover:bg-sky-700"
                      : "bg-emerald-600 hover:bg-emerald-700"
                  }`}
                  title={
                    isGeneratingOrRunning
                      ? midTurnAction === "steer"
                        ? "Submit steer to current turn"
                        : "Enqueue message for after turn"
                      : "Send message"
                  }
                  aria-label={
                    isGeneratingOrRunning
                      ? midTurnAction === "steer"
                        ? "Submit steer"
                        : "Enqueue message"
                      : "Send message"
                  }
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
