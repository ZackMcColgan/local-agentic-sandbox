"use client";

import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import NextImage from "next/image";
import { SupervisorStatusBadge } from "./SupervisorStatusBadge";
import { deriveSupervisorBadgeState, type SupervisorBadgeInput } from "./supervisorBadgeState";
import {
  Send,
  Sparkles,
  Loader2,
  ShieldAlert,
  RotateCcw,
  ChevronDown,
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
} from "lucide-react";
import { ExecutionTraceItem } from "./ExecutionTrace";
import type { CompletionStamp, VerificationGap } from "@/lib/finishVerification";
import { copyText } from "../lib/clipboard";
import { formatContextK, latestRoundPromptTokens } from "../lib/tokenEconomics";
import {
  RECONCILE_POLL_MAX_ATTEMPTS,
  reconcilePollDelayMs,
  shouldStopReconcilePoll,
} from "../lib/reconcilePollPolicy";
import { LiveRunBlock } from "./LiveRunBlock";
import {
  appendNarrationChunk,
  deriveEffectiveLastActivityMs,
  hostDisconnectChipVisible,
  streamBannerKind,
} from "../lib/liveActivity";
import { CodeBlock, CodeBlockWithCopy, SvgRendererBlock, MermaidBlock } from "./ArtifactRenderers";
// CodeBlock handles long files with max-h-[400px] overflow-y-auto bg-gradient-to-t isExpanded Expand Collapse lines.length copyText(code)
export { CodeBlock, CodeBlockWithCopy, SvgRendererBlock, MermaidBlock };
import { AgentMode } from "../config/models";
import { getInitialWelcomeMessage, clearChatHistory } from "../lib/chatHistory";
import { parseThinkingAndContent, formatChatErrorMessage } from "../lib/chatUtils";
import { CanvasProvider } from "./CanvasContext";
import { ArtifactCanvasPane } from "./ArtifactCanvas";
import { TurnFileDiff } from "../lib/chatDiffs";
import { resolveTurnStatusPhase, mergeStreamedTokens } from "../lib/chatStatus";
import { TaskManifest, TaskScope } from "../lib/subagents/types";
import type { HostRunnerState } from "../lib/hostMode";
import type { ActiveTurnInfo, ThreadCompactionBoundary } from "../lib/threads/types";
import { ChatQueue, QueueItem, decideSendAction, drainNextForTurnEnd } from "../lib/chatQueue";
import {
  parseSimulateCommand,
  createSimulatedChatResponse,
  runSimulatedTask,
  getScenario,
  SimulationScenarioKey,
} from "../lib/simulator";

import { deduplicateStreamMessages } from "../lib/chat/streamMessages";
export { deduplicateStreamMessages };
import { ChatMessageItem, UserMessageContent } from "./chat/messageRender";
import { NowLineBar } from "./NowLineBar";
import { ActivityTimeline } from "./ActivityTimeline";
import { CanvasDiffSheet } from "./CanvasDiffSheet";
import type { TimelineWriteDiff } from "../lib/activityTimeline";
import { computeFollowState, shouldAutoScrollOnUpdate } from "../lib/autoFollow";
import { computeLiveTokPerSec } from "../lib/turnSpeed";
export { UserMessageContent };
import { HostApprovalsPanel } from "./chat/approvals";
import {
  formatFileSize,
  fileToBase64,
  buildAttachedFileItem,
  type AttachedFileItem,
} from "../lib/chat/attachments";
export { formatFileSize, fileToBase64, type AttachedFileItem };

const EMPTY_LIVE_TRACES: ExecutionTraceItem[] = [];

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thought?: string;
  traces?: ExecutionTraceItem[];
  completionStamp?: CompletionStamp;
  verificationGaps?: VerificationGap[];
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
  thinkingDurationMs?: number;
  phaseTimings?: {
    contextPrepMs?: number;
    thinkingMs?: number;
    toolsMs?: number;
    writingMs?: number;
  };
  taskId?: string;
  isStopped?: boolean;
  isStreaming?: boolean;
  timestamp?: string;
  compactedThisTurn?: boolean;
  tokensBeforeCompaction?: number;
  tokensAfterCompaction?: number;
  roundPromptTokens?: number[];
  roundGenerationMs?: number[];
  thinkingSegments?: Array<{ round: number; text: string }>;
  roundNarrations?: Array<{ round: number; text: string }>;
  outputTokens?: number;
  compactionActions?: string[];
  status?: "completed" | "incomplete" | "error" | "streaming";
}

export interface UiHostApproval {
  id: string;
  threadId?: string;
  tool: string;
  args: {
    command?: string;
    path?: string;
    cwd?: string;
    recursive?: boolean;
    [key: string]: unknown;
  };
  riskReason: string;
  createdAt?: number;
  expiresAt?: number;
  status: "pending" | "executed" | "denied" | "expired" | "error";
  result?: unknown;
  error?: string;
  isSubmitting?: boolean;
}

interface ChatStreamProps {
  draftPrompt?: string | null;
  onClearDraftPrompt?: () => void;
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
  activeTurn?: ActiveTurnInfo | null;
  threadUpdatedAt?: string | null;
  supervisorState?: SupervisorBadgeInput;
  threadStatus?:
    "active" | "running" | "paused" | "stopped" | "completed" | "failed" | "needs_input";
  threadHostAccess?: boolean;
  onHostAccessChanged?: (
    enabled: boolean,
    updatedThread?: { id: string; [key: string]: unknown }
  ) => void;
  activeTask?: TaskManifest | null;
  initialScope?: TaskScope;
  threadScope?: TaskScope;
  onStopTask?: () => Promise<void> | void;
  onTaskUpdated?: (task?: TaskManifest, thread?: { id: string; [key: string]: unknown }) => void;
  onBackToList?: () => void;
  onOpenModelSheet?: () => void;
  onOpenSettings?: () => void;
  onLaunchTask?: (
    goal: string,
    attachments?: unknown[],
    scope?: TaskScope,
    autoDeployOnGreen?: boolean
  ) => Promise<void>;
  defaultComposerMode?: "chat" | "build";
  onNewThread?: () => void;
  onDeleteThread?: () => void;
  onSendMessage?: (content: string, attachments?: unknown[]) => Promise<void>;
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
  onLocalSseOpenChange?: (open: boolean) => void;
  threadCompaction?: ThreadCompactionBoundary | null;
  initialSimulation?: {
    scenarioKey: SimulationScenarioKey;
    speedMultiplier?: number;
  };
}

export function ChatStream({
  draftPrompt,
  onClearDraftPrompt,
  onTracesUpdate,
  liveTraces,
  activeModel,
  agentMode = "auto",
  reasoningEffort,
  onViewSecurityTelemetry,
  messages: propsMessages,
  setMessages: propsSetMessages,
  threadId,
  threadTitle,
  activeTurn,
  threadUpdatedAt,
  supervisorState,
  threadHostAccess,
  activeTask,
  initialScope = "PROJECT",
  threadScope,
  onStopTask,
  onTaskUpdated,
  onBackToList,
  onOpenModelSheet,
  onOpenSettings,
  onLaunchTask,
  onNewThread,
  onDeleteThread,
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
  onLocalSseOpenChange,
  threadCompaction: propThreadCompaction,
  initialSimulation,
}: ChatStreamProps) {
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>(() => [
    getInitialWelcomeMessage(activeModel),
  ]);
  const messages = propsMessages ?? localMessages;
  const setMessages = propsSetMessages ?? setLocalMessages;

  // Composer Mode state: the Chat|Build toggle is removed (uir-0), so the
  // mode is fixed at mount from defaultComposerMode; Build is entered via
  // the /build prefix or the Builds view, never a composer toggle.
  const [composerMode] = useState<"chat" | "build">(defaultComposerMode ?? "chat");
  const [activeCanvasDiff, setActiveCanvasDiff] = useState<{
    current: TimelineWriteDiff;
    all: TimelineWriteDiff[];
  } | null>(null);
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

  useEffect(() => {
    if (draftPrompt) {
      setInput(draftPrompt);
      onClearDraftPrompt?.();
    }
  }, [draftPrompt, onClearDraftPrompt]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStoppingTask, setIsStoppingTask] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
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
  // uir-1 / U2: turn start, last observed stream activity, live measured tok/s,
  // recovery timestamp, and the just-completed turn whose DONE chip renders.
  const turnStartedAtRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const streamRafCancelRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      streamRafCancelRef.current?.();
      streamRafCancelRef.current = null;
    };
  }, []);
  const [lastActivityAtMs, setLastActivityAtMs] = useState<number>(() => Date.now());
  const [liveTokPerSec, setLiveTokPerSec] = useState<number | null>(null);
  const [recoveredAtMs, setRecoveredAtMs] = useState<number | null>(null);
  const [disconnectedAtMs, setDisconnectedAtMs] = useState<number | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState<number>(1);
  const [recoveredAfterSec, setRecoveredAfterSec] = useState<number>(1);
  const [completedTurnMsgId, setCompletedTurnMsgId] = useState<string | null>(null);

  // Any local stream-visible change counts as activity for the freshness readout.
  useEffect(() => {
    if (isLoading) setLastActivityAtMs(Date.now());
  }, [isLoading, streamStatus, messages, liveTurnTraces]);

  // The RECOVERED banner clears itself after its display window.
  useEffect(() => {
    if (recoveredAtMs === null) return;
    const timer = setTimeout(() => setRecoveredAtMs(null), 10500);
    return () => clearTimeout(timer);
  }, [recoveredAtMs]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [expandedProofs, setExpandedProofs] = useState<Record<string, boolean>>({});
  const [expandedTraces, setExpandedTraces] = useState<Record<string, boolean>>({});
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);

  useEffect(() => {
    const handleOverlayOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ source?: string }>).detail;
      if (detail?.source !== "header-overflow") {
        setShowOverflowMenu(false);
      }
    };
    window.addEventListener("ui:overlay-open", handleOverlayOpen);
    return () => window.removeEventListener("ui:overlay-open", handleOverlayOpen);
  }, []);

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
    const url = threadId
      ? `/api/host/status?threadId=${encodeURIComponent(threadId)}`
      : "/api/host/status";
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
        const unexpired = (data.approvals as UiHostApproval[]).filter(
          (a) => (!a.expiresAt || a.expiresAt > now) && a.status === "pending"
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
              status: "pending",
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

  const onLocalSseOpenChangeRef = useRef(onLocalSseOpenChange);
  onLocalSseOpenChangeRef.current = onLocalSseOpenChange;

  useEffect(() => {
    return () => {
      onLocalSseOpenChangeRef.current?.(false);
    };
  }, []);

  // Rehydration of thread compaction boundary on thread switch (skipped when parent already fetched the thread)
  useEffect(() => {
    if (!threadId) {
      setThreadCompaction(null);
      return;
    }
    if (propThreadCompaction !== undefined) {
      setThreadCompaction(propThreadCompaction);
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
  }, [threadId, propThreadCompaction]);

  const [activeSimulation, setActiveSimulation] = useState<{
    scenarioKey: SimulationScenarioKey;
    speedMultiplier?: number;
  } | null>(initialSimulation ?? null);
  const activeSimTaskCancelRef = useRef<(() => void) | null>(null);
  const initialSimulationTriggeredRef = useRef(false);

  const handleSendRef = useRef<((overridePrompt?: string) => void) | null>(null);

  useEffect(() => {
    if (initialSimulation && !initialSimulationTriggeredRef.current) {
      initialSimulationTriggeredRef.current = true;
      setActiveSimulation(initialSimulation);
      const cmd = `/simulate ${initialSimulation.scenarioKey}${
        initialSimulation.speedMultiplier ? ` ${initialSimulation.speedMultiplier}` : ""
      }`;
      handleSendRef.current?.(cmd);
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
    budgetTokens: 100000,
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
      selectedModel: activeModel,
    };
    if (!exists) {
      return [...prev, patch(base)];
    }
    return prev.map((msg) => (msg.id === id ? patch(msg) : msg));
  };

  // U2: unified liveness for local turns and observed Board/cross-device turns.
  const lastRunAssistant = [...messages]
    .reverse()
    .find(
      (msg) => msg.role === "assistant" && msg.id !== "welcome" && msg.id !== "initial-welcome"
    );
  const isTaskActive = activeTask?.status === "active";
  const isTurnLive = Boolean(
    isLoading ||
    isTaskActive ||
    activeTurn ||
    (!isTransientDisconnected && lastRunAssistant?.status === "streaming")
  );
  const isGeneratingOrRunning = isTurnLive;

  const lastTraceTimestamp =
    lastRunAssistant?.traces && lastRunAssistant.traces.length > 0
      ? lastRunAssistant.traces[lastRunAssistant.traces.length - 1]?.timestamp
      : undefined;
  const effectiveLastActivityAtMs = deriveEffectiveLastActivityMs({
    isLocalStreaming: isLoading,
    localLastActivityAtMs: lastActivityAtMs,
    threadUpdatedAt,
    lastTraceTimestamp,
    activeTurnStartedAt: activeTurn?.startedAt,
    assistantTimestamp: lastRunAssistant?.timestamp,
  });
  const parsedActiveTurnStartMs =
    activeTurn?.startedAt && Number.isFinite(Date.parse(activeTurn.startedAt))
      ? Date.parse(activeTurn.startedAt)
      : null;
  const effectiveStartedAtMs = isLoading
    ? turnStartedAtRef.current
    : (turnStartedAtRef.current ?? parsedActiveTurnStartMs);

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
  // UI-006/UI-006b: the re-arm was a fixed
  // 1s setTimeout with no backoff, no attempt cap, no total-time cap, and it
  // kept polling while ChatStream was hidden (page.tsx hides via CSS; the
  // component stays mounted). Now: exponential backoff, attempt + total-time
  // caps, and no polling while ChatStream is not the active view.
  const disconnectedAtMsRef = useRef<number | null>(disconnectedAtMs);
  disconnectedAtMsRef.current = disconnectedAtMs;
  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;

  useEffect(() => {
    if (!reconcilingThreadId) return;
    if (!isActiveView) return;
    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const startedAt = Date.now();
    setReconnectAttempt(1);

    const pollDetachedTurn = async () => {
      try {
        const res = await fetch(`/api/threads/${reconcilingThreadId}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        });
        if (!res.ok || !active) return;
        const data = await res.json();
        if (Array.isArray(data?.thread?.messages)) {
          const threadMsgs: ChatMessage[] = data.thread.messages;
          const lastAsst = [...threadMsgs].reverse().find((m) => m.role === "assistant");
          if (lastAsst) {
            setMessagesRef.current(threadMsgs);
            if (lastAsst.status !== "streaming") {
              setIsTransientDisconnected(false);
              setReconcilingThreadId(null);
              setHasResolvedDetachedTurn(true);
              // uir-1: surface the RECOVERED banner where the DISCONNECTED
              // banner stood, so the drop and the recovery are both visible.
              const now = Date.now();
              setRecoveredAtMs(now);
              setRecoveredAfterSec(
                Math.max(1, Math.round((now - (disconnectedAtMsRef.current ?? startedAt)) / 1000))
              );
              setDisconnectedAtMs(null);
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
          isActiveView,
        })
      ) {
        setReconnectAttempt(attempts + 1);
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
    const { isAtBottom, shouldShowLivePill } = computeFollowState({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    isFollowPinnedRef.current = isAtBottom;
    setIsUserScrolledUp(shouldShowLivePill);
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

  const tailMessage = messages[messages.length - 1];
  const lastMsg = tailMessage;
  const lastMsgTraceCount = lastMsg?.traces?.length ?? 0;
  const lastMsgThinkingCount = lastMsg?.thinkingSegments?.length ?? 0;
  const lastMsgNarrationCount = lastMsg?.roundNarrations?.length ?? 0;
  const liveTurnTraceCount = liveTurnTraces.length;

  useEffect(() => {
    if (!isFollowPinnedRef.current) {
      return;
    }
    if (!isUserScrolledUp) {
      const el = chatContainerRef.current;
      if (
        shouldAutoScrollOnUpdate({
          isFollowPinned: isFollowPinnedRef.current,
          isStreaming: isTurnLive,
          isUserScrolledUp,
        })
      ) {
        if (el) {
          isProgrammaticScrollRef.current = true;
          el.scrollTop = el.scrollHeight;
          if (programmaticScrollTimerRef.current) {
            clearTimeout(programmaticScrollTimerRef.current);
          }
          programmaticScrollTimerRef.current = setTimeout(() => {
            isProgrammaticScrollRef.current = false;
          }, 50);
        } else {
          scrollRef.current?.scrollIntoView({ behavior: "auto" });
        }
        return;
      }

      if (el) {
        const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
        if (distanceFromBottom <= 100) {
          scrollRef.current?.scrollIntoView({ behavior: "smooth" });
        }
      } else {
        scrollRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    }
  }, [
    messages,
    lastMsg?.content,
    lastMsg?.thought,
    lastMsg?.role,
    lastMsgTraceCount,
    lastMsgThinkingCount,
    lastMsgNarrationCount,
    liveTurnTraceCount,
    isTurnLive,
    isUserScrolledUp,
  ]);

  const toggleProof = useCallback((proofKey: string) => {
    setExpandedProofs((prev) => ({ ...prev, [proofKey]: !prev[proofKey] }));
  }, []);

  const toggleTraces = useCallback((msgId: string) => {
    setExpandedTraces((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
  }, []);

  const copyToClipboard = useCallback(async (text: string, msgId: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopiedMessageId(msgId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    }
  }, []);

  const handleOpenCanvasDiff = useCallback((diff: TimelineWriteDiff, all: TimelineWriteDiff[]) => {
    setActiveCanvasDiff({ current: diff, all });
  }, []);

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
      try {
        const b64 = await fileToBase64(f);
        newItems.push(
          buildAttachedFileItem({
            id: `att-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
            name: f.name,
            type: f.type,
            size: f.size,
            base64: b64,
          })
        );
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
    const effectiveThreadId = activeThreadId || threadId;
    if (effectiveThreadId) {
      fetch(`/api/threads/${effectiveThreadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      }).catch((err) => console.error("Failed to stop server turn:", err));
    }
    setIsLoading(false);
    setStreamStatus(null);
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role === "assistant") {
        const existing = last.content || "";
        const nextContent = existing.includes("*[Stopped by user]*")
          ? existing
          : existing
            ? `${existing}\n\n*[Stopped by user]*`
            : "*[Stopped by user]*";
        return [
          ...prev.slice(0, -1),
          {
            ...last,
            isStopped: true,
            isStreaming: false,
            content: nextContent,
          },
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "compact" }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.thread?.compaction) {
          setThreadCompaction(data.thread.compaction);
          setContextStats((prev) => ({
            ...prev,
            estimatedTokens: data.tokensAfter ?? prev.estimatedTokens,
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
        body: JSON.stringify({ action: "restoreCompaction" }),
      });
      if (res.ok) {
        setThreadCompaction(null);
        setShowCompactionModal(false);
      }
    } catch (err) {
      console.error("Restore compaction error:", err);
    }
  };

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const onTaskUpdatedRef = useRef(onTaskUpdated);
  onTaskUpdatedRef.current = onTaskUpdated;

  const handleRunControlAction = useCallback(async (action: "pause" | "resume" | "restart") => {
    const currentThreadId = activeThreadIdRef.current || threadIdRef.current;
    if (!currentThreadId) return;
    try {
      const res = await fetch(`/api/threads/${currentThreadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        const data = await res.json();
        if (onTaskUpdatedRef.current) {
          onTaskUpdatedRef.current(data.task, data.thread);
        }
      }
    } catch {
      // Non-fatal
    }
  }, []);

  const readStreamResponse = async (
    res: Response,
    targetThreadId?: string,
    startTime: number = performance.now(),
    providedAssistantMsgId?: string
  ) => {
    const assistantMsgId =
      providedAssistantMsgId || activeAssistantMsgIdRef.current || `assistant-${Date.now()}`;
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
          selectedModel: activeModel,
        },
      ];
    });

    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("No readable stream received from server");
    }

    onLocalSseOpenChangeRef.current?.(true);
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
        selectedModel: activeModel,
      };
      if (!exists) {
        return [...prev, patch(base)];
      }
      return prev.map((msg) => (msg.id === assistantMsgId ? patch(msg) : msg));
    };

    let pendingThinkingDelta = "";
    let pendingTokenCommit = false;
    let pendingActivityTs: number | null = null;

    const cancelScheduledStreamRaf = () => {
      streamRafCancelRef.current?.();
      streamRafCancelRef.current = null;
    };

    const flushBufferedStreamUpdates = () => {
      cancelScheduledStreamRaf();
      if (!isMountedRef.current) return;
      if (!pendingThinkingDelta && !pendingTokenCommit && pendingActivityTs === null) return;

      const thinkingDelta = pendingThinkingDelta;
      const shouldCommitToken = pendingTokenCommit;
      const activityTs = pendingActivityTs;
      pendingThinkingDelta = "";
      pendingTokenCommit = false;
      pendingActivityTs = null;

      if (activityTs !== null) {
        setLastActivityAtMs(activityTs);
      }

      if (thinkingDelta || shouldCommitToken) {
        const parsed = shouldCommitToken ? parseThinkingAndContent(accumulatedRawContent) : null;
        setMessages((prev) =>
          upsertAssistant(prev, (msg) => {
            const nextThought = thinkingDelta
              ? msg.thought
                ? msg.thought + thinkingDelta
                : thinkingDelta
              : msg.thought;
            if (parsed) {
              return {
                ...msg,
                content: parsed.content,
                thought: parsed.thought,
                modelUsed: currentModel,
              };
            }
            return {
              ...msg,
              thought: nextThought,
            };
          })
        );
      }
    };

    const scheduleBufferedStreamFlush = () => {
      if (streamRafCancelRef.current) return;
      const rafFn =
        typeof globalThis.requestAnimationFrame === "function"
          ? globalThis.requestAnimationFrame.bind(globalThis)
          : typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
            ? window.requestAnimationFrame.bind(window)
            : null;
      const cancelRafFn =
        typeof globalThis.cancelAnimationFrame === "function"
          ? globalThis.cancelAnimationFrame.bind(globalThis)
          : typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function"
            ? window.cancelAnimationFrame.bind(window)
            : null;

      if (!rafFn) {
        flushBufferedStreamUpdates();
        return;
      }

      const rafId = rafFn(() => {
        streamRafCancelRef.current = null;
        flushBufferedStreamUpdates();
      });
      streamRafCancelRef.current = () => {
        cancelRafFn?.(rafId);
      };
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        streamBuffer += decoder.decode(value, { stream: true });
        const blocks = streamBuffer.split("\n\n");
        streamBuffer = blocks.pop() || "";

        for (const block of blocks) {
          const trimmed = block.trim();
          if (trimmed.startsWith(":")) {
            // SSE comment keepalive counts as heartbeat activity
            setLastActivityAtMs(Date.now());
            continue;
          }
          if (!trimmed.startsWith("data:")) continue;
          const jsonStr = trimmed.replace(/^data:\s*/, "");
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);
            const eventActivityTs = typeof event.ts === "number" ? event.ts : Date.now();

            if (event.type === "ping") {
              setLastActivityAtMs(eventActivityTs);
              continue;
            } else if (event.type === "thinking") {
              pendingThinkingDelta += event.content || "";
              pendingActivityTs = eventActivityTs;
              scheduleBufferedStreamFlush();
              continue;
            } else if (event.type === "token") {
              accumulatedRawContent = appendNarrationChunk(
                accumulatedRawContent,
                event.content || ""
              );
              pendingTokenCommit = true;
              pendingActivityTs = eventActivityTs;
              scheduleBufferedStreamFlush();
              continue;
            }

            // Flush any buffered rAF token/thinking deltas before non-delta events
            flushBufferedStreamUpdates();
            setLastActivityAtMs(eventActivityTs);

            if (event.type === "metrics") {
              if (
                typeof event.roundOutputTokens === "number" &&
                typeof event.roundElapsedMs === "number"
              ) {
                setLiveTokPerSec((prev) =>
                  computeLiveTokPerSec(event.roundOutputTokens, event.roundElapsedMs, prev)
                );
              }
              setMessages((prev) =>
                upsertAssistant(prev, (msg) => ({
                  ...msg,
                  outputTokens:
                    typeof event.outputTokens === "number" ? event.outputTokens : msg.outputTokens,
                  roundGenerationMs: Array.isArray(event.roundGenerationMs)
                    ? event.roundGenerationMs
                    : msg.roundGenerationMs,
                }))
              );
            } else if (event.type === "round_narration") {
              // U1: commit intermediate round commentary to the timeline and reset
              // the live tail buffer so final summary text stays cleanly separated.
              accumulatedRawContent = "";
              setMessages((prev) =>
                upsertAssistant(prev, (msg) => ({
                  ...msg,
                  content: "",
                  roundNarrations: Array.isArray(event.roundNarrations)
                    ? event.roundNarrations
                    : [
                        ...(msg.roundNarrations || []),
                        {
                          round: typeof event.round === "number" ? event.round : 1,
                          text: String(event.text || ""),
                        },
                      ],
                }))
              );
            } else if (event.type === "meta") {
              if (event.model) currentModel = event.model;
              if (event.context) {
                setContextStats((prev) => ({
                  ...prev,
                  estimatedTokens: event.context.estimatedTokens ?? prev.estimatedTokens,
                  budgetTokens: event.context.budgetTokens ?? prev.budgetTokens,
                  compactedThisTurn: event.context.compactedThisTurn,
                  tokensBeforeCompaction: event.context.tokensBeforeCompaction,
                  tokensAfterCompaction: event.context.tokensAfterCompaction,
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
                      tokensAfterCompaction,
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
                tokensAfterCompaction: event.tokensAfter,
              }));
              setMessages((prev) =>
                upsertAssistant(prev, (msg) => ({
                  ...msg,
                  compactedThisTurn: true,
                  tokensBeforeCompaction: event.tokensBefore,
                  tokensAfterCompaction: event.tokensAfter,
                  compactionActions: event.actions,
                }))
              );
            } else if (event.type === "status") {
              setStreamStatus(event.status);
            } else if (event.type === "thought") {
              setMessages((prev) =>
                upsertAssistant(prev, (msg) => ({
                  ...msg,
                  thought: event.thought,
                  thinkingSegments: Array.isArray(event.thinkingSegments)
                    ? event.thinkingSegments
                    : msg.thinkingSegments,
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
                  traces: currentTraces,
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
                    expiresAt: approval.expiresAt || Date.now() + 10 * 60 * 1000,
                    status: "pending",
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
              const hasRoundNarrations =
                Array.isArray(event.roundNarrations) && event.roundNarrations.length > 0;
              const mergedRaw = hasRoundNarrations
                ? typeof event.content === "string"
                  ? event.content
                  : accumulatedRawContent
                : mergeStreamedTokens(accumulatedRawContent, event.content);
              const parsed = parseThinkingAndContent(mergedRaw);
              const finalThought = event.thought !== undefined ? event.thought : parsed.thought;
              const finalModel = event.model || currentModel;
              const finalCompacted = Boolean(event.compactedThisTurn || compactedThisTurn);
              const finalTokensBefore = event.tokensBeforeCompaction ?? tokensBeforeCompaction;
              const finalTokensAfter = event.tokensAfterCompaction ?? tokensAfterCompaction;
              const finalStatus =
                event.status ||
                (event.isIncomplete ? "incomplete" : undefined) ||
                (event.content?.includes("⚠️ [Turn paused:") ||
                event.content?.includes("⚠️ [Turn incomplete:")
                  ? "incomplete"
                  : undefined);

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
                  thinkingDurationMs:
                    typeof event.thinkingDurationMs === "number"
                      ? event.thinkingDurationMs
                      : msg.thinkingDurationMs,
                  phaseTimings: event.phaseTimings || msg.phaseTimings,
                  compactedThisTurn: finalCompacted || undefined,
                  tokensBeforeCompaction: finalTokensBefore,
                  tokensAfterCompaction: finalTokensAfter,
                  compactionActions: event.compactionActions || msg.compactionActions,
                  roundPromptTokens: Array.isArray(event.roundPromptTokens)
                    ? event.roundPromptTokens
                    : msg.roundPromptTokens,
                  roundGenerationMs: Array.isArray(event.roundGenerationMs)
                    ? event.roundGenerationMs
                    : msg.roundGenerationMs,
                  thinkingSegments: Array.isArray(event.thinkingSegments)
                    ? event.thinkingSegments
                    : msg.thinkingSegments,
                  roundNarrations: Array.isArray(event.roundNarrations)
                    ? event.roundNarrations
                    : msg.roundNarrations,
                  outputTokens:
                    typeof event.outputTokens === "number" ? event.outputTokens : msg.outputTokens,
                  status: finalStatus,
                }))
              );

              // uir-1: the DONE chip replaces the Live Activity Header on the
              // message this turn just completed.
              setCompletedTurnMsgId(assistantMsgId);

              // CHAT-STEER: clear pending steers indicator when turn ends or steers are acknowledged
              setPendingSteers([]);
              if (
                Array.isArray(event.pendingSteers) &&
                event.pendingSteers.length > 0 &&
                chatQueueRef.current
              ) {
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
                  content: `[Steer from user, mid-turn] ${t}`,
                }));
                setMessages((prev) => [...prev, ...steerMessages]);
              }
            } else if (event.type === "error") {
              setMessages((prev) =>
                upsertAssistant(prev, (msg) => ({
                  ...msg,
                  status: "error",
                }))
              );
              // Server explicitly reported a terminal turn error (e.g. engine offline,
              // simulation error event). This is a verdict, not a disconnect: never
              // route it into the detached-turn reconciliation path.
              const terminalErr = new Error(
                event.error || "Streaming error encountered"
              ) as Error & {
                isTerminalServerError?: boolean;
              };
              terminalErr.isTerminalServerError = true;
              throw terminalErr;
            }
          } catch (parseErr: unknown) {
            if (
              parseErr instanceof Error &&
              parseErr.message &&
              !parseErr.message.includes("JSON.parse")
            ) {
              throw parseErr;
            }
          }
        }
      }
      flushBufferedStreamUpdates();
    } finally {
      cancelScheduledStreamRaf();
      onLocalSseOpenChangeRef.current?.(false);
    }
  };

  const runApprovalContinuation = async (approvalId: string) => {
    const targetThreadId = activeThreadId || threadId;
    setIsLoading(true);
    setStreamStatus("Continuing after host approval...");
    setErrorMsg(null);
    turnStartedAtRef.current = Date.now();
    setCompletedTurnMsgId(null);

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
          approvalContinuationId: approvalId,
        }),
      });

      if (!res.ok) {
        let errMessage = "Failed to continue after host approval";
        try {
          const errJson = await res.json();
          errMessage = errJson.error || errMessage;
        } catch {}
        const httpErr = new Error(errMessage) as Error & { terminalServerError?: boolean };
        httpErr.terminalServerError = true;
        throw httpErr;
      }

      await readStreamResponse(res, targetThreadId, startTime, assistantMsgId);
      setLiveTurnTraces([]);
    } catch (err: unknown) {
      const streamErr = err as Error & { isTerminalServerError?: boolean };
      if (streamErr.name === "AbortError") {
        console.log("Approval continuation aborted by user");
        setMessages((prev) =>
          upsertAssistant(prev, (msg) => ({
            ...msg,
            status: "incomplete",
            isStopped: true,
          }))
        );
      } else {
        console.error("[ChatStream] Stream interrupted mid-approval:", err);
        if (targetThreadId && streamErr.isTerminalServerError !== true) {
          setDisconnectedAtMs((prev) => prev ?? Date.now());
          setIsTransientDisconnected(true);
          setReconcilingThreadId(targetThreadId);
          setStreamStatus("Connection interrupted — turn continuing server-side...");
          setMessages((prev) =>
            upsertAssistant(prev, (msg) => ({
              ...msg,
              status: "streaming",
            }))
          );
        } else {
          setErrorMsg(streamErr.message || "Failed to continue chat after host approval");
          setMessages((prev) =>
            upsertAssistant(prev, (msg) => ({
              ...msg,
              status: "error",
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
        body: JSON.stringify({ approvalId, action }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 410) {
        setHostApprovals((prev) =>
          prev.map((item) =>
            item.id === approvalId ? { ...item, status: "expired", isSubmitting: false } : item
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
                  isSubmitting: false,
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
                  isSubmitting: false,
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
                isSubmitting: false,
              }
            : item
        )
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : undefined;
      setHostApprovals((prev) =>
        prev.map((item) =>
          item.id === approvalId
            ? {
                ...item,
                status: "error",
                error: message || "Failed to submit approval",
                isSubmitting: false,
              }
            : item
        )
      );
    }
  };

  const handleSend = async (textToSend?: string) => {
    const rawPrompt = textToSend !== undefined ? textToSend : input;
    const prompt = rawPrompt.trim();
    const hasAttachments = attachedFiles.length > 0;

    const action = decideSendAction({
      running: isGeneratingOrRunning,
      hasAttachments,
      text: prompt,
    });

    if (action === "blocked-attachments") {
      if (isGeneratingOrRunning && hasAttachments) {
        setErrorMsg(
          "Attachments cannot be queued while a turn is active. Please wait or send text only."
        );
      }
      return;
    }

    if (action === "enqueue") {
      let currentActiveThreadId = activeThreadIdRef.current || activeThreadState || threadId;
      if (!currentActiveThreadId && onEnsureThread) {
        currentActiveThreadId = (await onEnsureThread(prompt)) || undefined;
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
          const steerRes = await fetch(
            `/api/threads/${encodeURIComponent(currentActiveThreadId)}/steer`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: prompt, interrupt: true }),
            }
          );
          if (!steerRes.ok) {
            const errJson = await steerRes.json().catch(() => ({}));
            throw new Error(errJson.error || "Failed to deliver steer");
          }
          setPendingSteers((prev) => [...prev, prompt]);
          setInput("");
          if (textareaRef.current) textareaRef.current.style.height = "auto";
        } catch (steerErr: unknown) {
          const message = steerErr instanceof Error ? steerErr.message : undefined;
          setErrorMsg(message || "Failed to deliver steer to turn");
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
    const simKey = (simCmd?.scenarioKey || activeSimulation?.scenarioKey) as
      SimulationScenarioKey | undefined;
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
          content: prompt,
        };

        const taskInit = { ...simScenario.initialTask };
        const assistantMsgId = `assistant-${Date.now()}`;
        const assistantMsg: ChatMessage = {
          id: assistantMsgId,
          role: "assistant",
          content: "Started autonomous engineering run.",
          taskId: taskInit.taskId,
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
              if (
                updatedTask.status === "completed" ||
                updatedTask.status === "cancelled" ||
                updatedTask.status === "failed"
              ) {
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
            },
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
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : undefined;
        setErrorMsg(message || "Failed to launch builder task");
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
      activeThreadId = (await onEnsureThread(prompt)) || undefined;
      if (activeThreadId) {
        activeThreadIdRef.current = activeThreadId;
        setActiveThreadId(activeThreadId);
      }
    }

    const userMsgId = `user-${Date.now()}`;
    const userMessage: ChatMessage = {
      id: userMsgId,
      role: "user",
      content:
        prompt ||
        (currentAttachments.length > 0
          ? `Analyzed attached files: ${currentAttachments.map((a) => a.name).join(", ")}`
          : ""),
      attachments: currentAttachments.map((a) => ({
        name: a.name,
        type: a.type,
        size: a.size,
        previewUrl: a.previewUrl,
        isImage: a.isImage,
      })),
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
              timestamp: new Date().toISOString(),
            },
          }),
        }).catch((err) => console.warn("Failed to persist user message:", err));
      } catch {}
    }

    // Otherwise, dispatch to standard streaming chat path
    setIsLoading(true);
    setStreamStatus("Connecting to model...");
    // UI-003 / UI-011b: fresh live-turn trace rows for this turn.
    setLiveTurnTraces([]);
    setLiveTokPerSec(null);
    // uir-1: a new turn starts the activity clock and retires the DONE chip.
    turnStartedAtRef.current = Date.now();
    setCompletedTurnMsgId(null);
    setRecoveredAtMs(null);

    const startTime = performance.now();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const assistantMsgId = `assistant-${Date.now()}`;
    activeAssistantMsgIdRef.current = assistantMsgId;
    let turnEndedNormally = false;

    try {
      const res =
        isSimulating && simKey
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
                attachments: currentAttachments.map((a) => ({
                  name: a.name,
                  type: a.type,
                  size: a.size,
                  base64: a.base64,
                })),
              }),
            });

      if (!res.ok) {
        let errMessage = "Failed to orchestrate request";
        if (res.status === 413) {
          errMessage =
            "Attachment is too large for upload (HTTP 413). Please choose a smaller file.";
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
        const httpErr = new Error(errMessage) as Error & { isTerminalServerError?: boolean };
        httpErr.isTerminalServerError = true;
        throw httpErr;
      }

      await readStreamResponse(res, activeThreadId || threadId, startTime, assistantMsgId);
      turnEndedNormally = true;
    } catch (err: unknown) {
      const streamErr = err as Error & { isTerminalServerError?: boolean };
      if (streamErr.name === "AbortError") {
        console.log("Chat stream aborted by user");
        setMessages((prev) =>
          upsertAssistant(prev, (msg) => ({
            ...msg,
            status: "incomplete",
            isStopped: true,
          }))
        );
      } else {
        console.error("[ChatStream] Stream interrupted mid-turn:", err);
        const currentTid = activeThreadId || threadId;
        // Transient reconciliation applies only to genuine client-side disconnects
        // on real threads. Terminal server errors (engine offline, HTTP 503) and
        // offline simulations must render the error banner + Retry surface instead.
        if (currentTid && streamErr.isTerminalServerError !== true && !isSimulating) {
          // Deliverable 3: Mid-turn stream failure becomes a TRANSIENT state, never a terminal verdict.
          setDisconnectedAtMs((prev) => prev ?? Date.now());
          setIsTransientDisconnected(true);
          setReconcilingThreadId(currentTid);
          setStreamStatus("Connection interrupted — turn continuing server-side...");
          setMessages((prev) =>
            upsertAssistant(prev, (msg) => ({
              ...msg,
              status: "streaming",
            }))
          );
        } else {
          setErrorMsg(streamErr.message || "Failed to communicate with agent orchestrator");
          setMessages((prev) =>
            upsertAssistant(prev, (msg) => ({
              ...msg,
              status: "error",
            }))
          );
        }
      }
    } finally {
      setIsLoading(false);
      setStreamStatus(null);
      setLiveTokPerSec(null);
      if (turnEndedNormally) {
        setLiveTurnTraces([]);
      }
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

  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messagesRef.current].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return;
    setErrorMsg(null);
    handleSendRef.current?.(lastUserMsg.content);
  }, []);

  handleSendRef.current = handleSend;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const modelSafe = activeModel || "swift-15-27b-mtp";
  const shortModelLabel =
    modelSafe.includes("flash-next") || modelSafe.includes("gyro")
      ? "Flash-Next"
      : modelSafe.includes("IQ3") || modelSafe.includes("Qwen3.8")
        ? modelSafe.includes("Swift-1.5") || modelSafe.includes("swift-15")
          ? "Swift-1.5 (IQ3_XS)"
          : "Swift-1.5"
        : modelSafe.includes("swift-15") || modelSafe.includes("swift-1.5")
          ? "Swift-1.5"
          : modelSafe.includes("swift")
            ? "Swift-27B"
            : modelSafe.includes("qwen")
              ? "Qwen3.8"
              : modelSafe.includes("gemma")
                ? "Gemma-4"
                : modelSafe.split(":")[0];

  const deduplicatedMessages = useMemo(() => deduplicateStreamMessages(messages), [messages]);

  // Anchor for the reconciled detached-turn notification: the last assistant message,
  // not the literal tail, so a steer bubble appended after reconciliation does not hide it.
  const lastAssistantIndex = useMemo(
    () => deduplicatedMessages.reduce((last, m, i) => (m.role === "assistant" ? i : last), -1),
    [deduplicatedMessages]
  );

  // Calculate the last linked task message index so LiveRunBlock is only hosted once
  const lastLinkedTaskMsgIndex = deduplicatedMessages
    .map((m, i) => (m.taskId ? i : -1))
    .reduce((max, i) => Math.max(max, i), -1);

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative flex h-full bg-white dark:bg-black transition-colors overflow-hidden ${
        isDraggingOver ? "bg-emerald-50/30 dark:bg-emerald-950/20" : ""
      }`}
    >
      <CanvasProvider scrollElRef={chatContainerRef}>
        <div className="@container/chat flex flex-col flex-1 min-w-0 min-h-0 h-full relative">
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
                    className="p-1 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="text-xs text-slate-600 dark:text-zinc-300 space-y-2">
                  <div className="flex justify-between font-mono text-[11px] bg-slate-50 dark:bg-zinc-800/50 p-2.5 rounded-xl border border-slate-100 dark:border-zinc-800">
                    <span>Before: ~{threadCompaction.tokensBefore} tokens</span>
                    <span>After: ~{threadCompaction.tokensAfter} tokens</span>
                  </div>
                  <p className="font-semibold text-slate-800 dark:text-zinc-200">
                    Retained Digest:
                  </p>
                  <pre className="max-h-56 overflow-y-auto p-3 rounded-xl bg-slate-50 dark:bg-black font-mono text-[11px] whitespace-pre-wrap border border-slate-200/80 dark:border-zinc-800">
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
                <NextImage
                  src={previewModalImage}
                  alt="Fullscreen preview"
                  width={0}
                  height={0}
                  sizes="100vw"
                  unoptimized
                  className="w-auto h-auto rounded-2xl shadow-2xl max-w-full max-h-[85vh] object-contain border border-white/10"
                />
                <button
                  onClick={() => setPreviewModalImage(null)}
                  className="absolute top-2 right-2 p-1.5 rounded-full bg-zinc-900/90 text-white hover:bg-zinc-800 border border-white/20"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Top Bar — Frosted Header */}
          <header className="sticky top-0 z-30 min-h-[56px] py-1.5 px-2 sm:px-4 border-b border-stone-200/80 dark:border-white/[0.08] bg-stone-50/90 dark:bg-black/85 backdrop-blur-xl flex items-center justify-between shrink-0">
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              {/* Mobile Hamburger menu button: opens drawer on mobile (< md:) */}
              {onOpenDrawer ? (
                <button
                  type="button"
                  onClick={onOpenDrawer}
                  className="flex md:hidden min-h-[44px] min-w-[44px] items-center justify-center p-2 rounded-xl border border-stone-200 dark:border-white/[0.10] bg-white dark:bg-[#15151b] text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-[#1f1f28] transition-colors shrink-0"
                  title="Open navigation menu"
                  aria-label="Open navigation menu"
                >
                  <Menu className="h-6 w-6" />
                </button>
              ) : onBackToList ? (
                <button
                  type="button"
                  onClick={onBackToList}
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-xl text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-white/[0.08] transition-colors shrink-0"
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
                  className="panel-toggle-btn hidden md:flex min-h-[44px] min-w-[44px] px-2.5 sm:px-3 py-1.5 rounded-xl border border-stone-200 dark:border-white/[0.10] bg-white dark:bg-[#15151b] text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-[#1f1f28] text-xs font-semibold transition-colors items-center justify-center gap-1.5 shrink-0"
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
                      ? "border-emerald-500/45 bg-emerald-500/15 text-emerald-900 dark:text-emerald-300"
                      : "border-stone-200 dark:border-white/[0.10] bg-white dark:bg-[#15151b] text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-[#1f1f28]"
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
                      ? "border-emerald-500/45 bg-emerald-500/15 text-emerald-900 dark:text-emerald-300"
                      : "border-stone-200 dark:border-white/[0.10] bg-white dark:bg-[#15151b] text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-[#1f1f28]"
                  }`}
                  title="Toggle Workspace Panel"
                  aria-label="Toggle Workspace Panel"
                >
                  <span className="text-sm">◨</span>
                  <span className="hidden sm:inline">Workspace</span>
                </button>
              )}

              <h1
                className="hidden 2xl:block text-base font-bold tracking-tight text-stone-900 dark:text-stone-50 max-w-[320px] truncate"
                title={threadTitle || "New session"}
              >
                {threadTitle || "New session"}
              </h1>
            </div>

            <div className="flex items-center gap-1 sm:gap-2 min-w-0">
              {/* Context Meter Pill - visible on both mobile and desktop */}
              <div
                data-testid="context-meter-pill"
                className="flex items-center gap-2 shrink-0"
                title={`Context budget: ${displayContextTokens} / ${contextStats.budgetTokens} tokens (${Math.round((displayContextTokens / contextStats.budgetTokens) * 100)}%)`}
              >
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-[12.3px] leading-none whitespace-nowrap">
                    <span className="font-normal text-slate-700 dark:text-zinc-100">
                      {formatContextK(displayContextTokens)}
                    </span>{" "}
                    <span className="font-normal text-slate-600 dark:text-zinc-400">
                      / {Math.round(contextStats.budgetTokens / 1000)}K
                    </span>
                  </span>
                  <div
                    data-testid="context-meter-track"
                    className="relative h-[5px] w-[128px] @lg/chat:w-[240px] rounded-[3px] bg-slate-200 dark:bg-zinc-800 shrink-0"
                  >
                    <div
                      data-testid="context-meter-fill"
                      className="h-full rounded-[3px] transition-all bg-gradient-to-r from-[#10b981] to-[#34d399]"
                      style={{
                        width: `${Math.min(100, Math.round((displayContextTokens / contextStats.budgetTokens) * 100))}%`,
                        minWidth: displayContextTokens > 0 ? "4px" : "0px",
                      }}
                    />
                    <span
                      data-testid="context-meter-tick"
                      aria-hidden="true"
                      title="85K compaction trigger"
                      className="absolute left-[85%] -top-[3px] w-[2px] h-[11px] bg-[#f87171]"
                    />
                  </div>
                </div>
              </div>

              {/* Model Chip Button: opens ModelBottomSheet on tap (Form A / Form B toggle — OWNER DECISION) */}
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={onOpenModelSheet}
                  className="min-h-[44px] md:min-h-[32px] justify-center flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 rounded-full border text-xs font-semibold transition-colors whitespace-nowrap bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-[#f4f4f5] hover:bg-slate-50 dark:hover:bg-zinc-800"
                  title={`Active model: ${activeModel || "swift-15-27b-mtp"} · Tap to configure`}
                  aria-label={`Configure model: currently ${shortModelLabel}`}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="whitespace-nowrap">{shortModelLabel}</span>
                  <ChevronDown className="h-3.5 w-3.5 opacity-70 shrink-0" aria-hidden="true" />
                </button>
              </div>

              {/* New Session Button - desktop only */}
              {onNewThread && (
                <button
                  type="button"
                  onClick={onNewThread}
                  className="hidden @md/chat:flex min-h-[44px] min-w-[44px] items-center justify-center p-2 rounded-full text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 transition-colors"
                  title="Start new session"
                  aria-label="Start new session"
                >
                  <Plus className="h-5 w-5" />
                </button>
              )}

              {/* Overflow Menu Button - desktop only */}
              <div className="hidden @md/chat:block relative">
                <button
                  type="button"
                  onClick={() => {
                    const next = !showOverflowMenu;
                    if (next && typeof window !== "undefined") {
                      const Evt = window.CustomEvent ?? globalThis.CustomEvent;
                      if (Evt) {
                        window.dispatchEvent(
                          new Evt("ui:overlay-open", { detail: { source: "header-overflow" } })
                        );
                      }
                    }
                    setShowOverflowMenu(next);
                  }}
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
                        onClick={() => {
                          setShowOverflowMenu(false);
                          setShowDeleteConfirm(true);
                        }}
                        className="w-full text-left px-3 py-2 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-xl"
                      >
                        Delete session
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={async () => {
                        const targetThreadId = activeThreadId || threadId;
                        if (targetThreadId) {
                          try {
                            await fetch("/api/threads", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                action: "clearMessages",
                                threadId: targetThreadId,
                              }),
                            });
                          } catch {
                            // Best-effort persistence when offline
                          }
                        }
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

          {/* U-F6: Status chips relocated out of <header> into clean sub-header banner strip */}
          {(() => {
            const hasSupervisorBadge = Boolean(
              supervisorState && deriveSupervisorBadgeState(supervisorState)
            );
            const hasScopeBadge = Boolean(threadScope || activeTask?.scope);
            const showDisconnectChip = Boolean(
              !activeSimulation &&
              hostDisconnectChipVisible({ hostAccess, runnerState, runnerAvailable })
            );
            const hasStripItems = Boolean(
              hasSupervisorBadge ||
              activeSimulation ||
              hasScopeBadge ||
              threadCompaction ||
              showDisconnectChip
            );
            if (!hasStripItems) return null;
            return (
              <div
                data-testid="chat-subheader-strip"
                className="flex flex-wrap items-center gap-1.5 px-2 sm:px-4 py-1.5 border-b border-stone-200/80 dark:border-white/[0.08] bg-stone-50/80 dark:bg-black/80 shrink-0"
              >
                {supervisorState && <SupervisorStatusBadge thread={supervisorState} />}
                {activeSimulation && (
                  <div
                    data-testid="simulation-badge"
                    className="inline-flex items-center gap-1 sm:gap-1.5 pl-2 pr-0.5 py-0.5 rounded-full bg-zinc-500/10 dark:bg-zinc-500/20 text-zinc-700 dark:text-zinc-400 border border-zinc-500/40 text-[10px] sm:text-xs font-bold uppercase tracking-wider shrink-0"
                    title={`Simulation active: ${activeSimulation.scenarioKey} (${activeSimulation.speedMultiplier || 1}x speed)`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 inline-block shrink-0" />
                    <span className="sr-only sm:not-sr-only">SIMULATION</span>
                    <span aria-hidden="true" className="sm:hidden">
                      SIM
                    </span>
                    <span className="hidden 2xl:inline font-mono text-[10px] lowercase text-zinc-600 dark:text-zinc-300">
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
                      className="min-h-[40px] min-w-[40px] -my-1 -mr-0.5 flex items-center justify-center rounded-full hover:bg-zinc-500/20 text-zinc-800 dark:text-zinc-200 transition-colors"
                      title="Exit simulation mode"
                      aria-label="Exit simulation mode"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                {hasScopeBadge && (
                  <span
                    className="inline-flex px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60 text-xs font-semibold uppercase tracking-wider"
                    title={`Task Scope: ${threadScope || activeTask?.scope}`}
                  >
                    {threadScope || activeTask?.scope}
                  </span>
                )}
                {threadCompaction ? (
                  <button
                    type="button"
                    onClick={() => setShowCompactionModal(true)}
                    className="min-h-[32px] px-2.5 py-1 inline-flex items-center justify-center rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
                    title="View compaction summary and restore options"
                  >
                    Compacted
                  </button>
                ) : null}
                {showDisconnectChip && (
                  <button
                    type="button"
                    data-testid="host-disconnect-chip"
                    onClick={() => (onOpenSettings ? onOpenSettings() : onOpenModelSheet?.())}
                    className="inline-flex items-center justify-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 rounded-full bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border border-dashed border-amber-400/70 dark:border-amber-700/70 text-[10px] sm:text-[11px] font-bold tracking-normal sm:tracking-wide shrink-0 min-h-[32px]"
                    title={runnerReason || "Host runner is unreachable — open Settings"}
                    aria-label="Host disconnected — open Settings"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block shrink-0" />
                    <span className="hidden min-[420px]:inline">
                      HOST DISCONNECTED · OPEN SETTINGS
                    </span>
                    <span className="min-[420px]:hidden">DISCONNECTED</span>
                    <span className="sr-only">HOST DISCONNECTED</span>
                  </button>
                )}
              </div>
            );
          })()}

          {(() => {
            const hasRunTurn = Boolean(isTurnLive || lastRunAssistant);
            const activeTraces =
              isLoading && liveTurnTraces.length > 0
                ? liveTurnTraces
                : lastRunAssistant?.traces || [];
            const hasOutcome = Boolean(
              (lastRunAssistant?.content && lastRunAssistant.content.trim()) ||
              (lastRunAssistant?.traces && lastRunAssistant.traces.length > 0) ||
              lastRunAssistant?.status === "completed"
            );
            return (
              <NowLineBar
                hasRunTurn={hasRunTurn}
                isStreaming={isTurnLive}
                streamStatus={streamStatus}
                status={lastRunAssistant?.status ?? null}
                isStopped={lastRunAssistant?.isStopped}
                hasOutcome={hasOutcome}
                traces={activeTraces}
                startedAtMs={effectiveStartedAtMs}
                lastActivityAtMs={effectiveLastActivityAtMs}
                totalDurationMs={lastRunAssistant?.durationMs}
                outputTokens={lastRunAssistant?.outputTokens}
                roundGenerationMs={lastRunAssistant?.roundGenerationMs}
                liveTokPerSec={liveTokPerSec}
              />
            );
          })()}

          {/* Confirm Dialog for Permanent Session Deletion (mirrors ThreadsSidebar) */}
          {activeCanvasDiff && (
            <CanvasDiffSheet
              currentDiff={activeCanvasDiff.current}
              allDiffs={activeCanvasDiff.all}
              onSelectDiff={(diff) =>
                setActiveCanvasDiff((prev) => (prev ? { ...prev, current: diff } : null))
              }
              onClose={() => setActiveCanvasDiff(null)}
            />
          )}
          {showDeleteConfirm && onDeleteThread && (
            <div
              data-testid="thread-delete-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="chat-confirm-delete-title"
              className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150"
              onClick={() => setShowDeleteConfirm(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setShowDeleteConfirm(false);
              }}
            >
              <div
                className="w-full max-w-md bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-3xl shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-150"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-start gap-3">
                  <div className="p-2.5 rounded-2xl bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 shrink-0">
                    <Trash2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3
                      id="chat-confirm-delete-title"
                      className="text-base font-bold text-slate-900 dark:text-zinc-100 line-clamp-2"
                    >
                      Delete &ldquo;{threadTitle || "Untitled session"}&rdquo;?
                    </h3>
                    <p className="mt-1.5 text-xs text-slate-600 dark:text-zinc-400 leading-relaxed">
                      This action is permanent and cannot be undone.{" "}
                      {activeTask?.taskId &&
                      ((activeThreadId || threadId) === `thread-${activeTask.taskId}` ||
                        (activeThreadId || threadId || "").startsWith("thread-task-"))
                        ? "All messages and the task checkpoint for this session will be removed."
                        : activeTask?.taskId
                          ? "All messages for this session will be removed. The task checkpoint is retained and the task will be marked cancelled."
                          : "All messages for this session will be removed."}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    data-testid="cancel-delete-btn"
                    onClick={() => setShowDeleteConfirm(false)}
                    className="min-h-[44px] px-4 py-2 rounded-xl text-xs font-semibold text-slate-700 dark:text-zinc-300 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid="confirm-delete-btn"
                    onClick={() => {
                      setShowDeleteConfirm(false);
                      onDeleteThread();
                    }}
                    className="min-h-[44px] px-4 py-2 rounded-xl text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 shadow-sm transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Conversation Thread Messages */}
          <div
            ref={chatContainerRef}
            onScroll={handleContainerScroll}
            onWheel={handleContainerWheel}
            onTouchMove={handleContainerTouchMove}
            data-scroll-container="true"
            className="flex-1 min-h-0 overflow-y-auto px-4 pt-[16px] pb-4 sm:px-6 sm:pt-4 sm:pb-6 bg-white dark:bg-black relative"
          >
            <div className="chat-track max-w-[840px] w-full mx-auto space-y-5 pb-16 sm:pb-20">
              {deduplicatedMessages.length === 0 && !activeTask && (
                <div className="h-full flex flex-col items-center justify-center text-center p-8 max-w-md mx-auto">
                  <div className="h-12 w-12 rounded-2xl bg-slate-100 dark:bg-zinc-900 flex items-center justify-center text-slate-600 dark:text-zinc-400 mb-4 border border-slate-200/80 dark:border-zinc-800">
                    <Sparkles className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <h3 className="text-base font-bold text-slate-800 dark:text-zinc-200 mb-1">
                    Start an autonomous session
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-zinc-400 leading-relaxed">
                    Ask questions, inspect the air-gapped sandbox, or build autonomous software
                    artifacts.
                  </p>
                </div>
              )}

              {deduplicatedMessages.map((m, idx) => {
                const isStreamingMsg = Boolean(
                  m.status === "streaming" ||
                  (isLoading && m.id === activeAssistantMsgIdRef.current)
                );
                const isTaskHost = idx === lastLinkedTaskMsgIndex;
                return (
                  <ChatMessageItem
                    key={m.id}
                    message={m}
                    idx={idx}
                    copiedMessageId={copiedMessageId === m.id ? m.id : null}
                    lastLinkedTaskMsgIndex={lastLinkedTaskMsgIndex}
                    lastAssistantIndex={lastAssistantIndex}
                    activeTask={isTaskHost ? activeTask : null}
                    liveTraces={isTaskHost ? liveTraces : EMPTY_LIVE_TRACES}
                    liveTurnTraces={isStreamingMsg ? liveTurnTraces : EMPTY_LIVE_TRACES}
                    isLoading={isLoading}
                    isStoppingTask={isTaskHost ? isStoppingTask : false}
                    activeAssistantMsgId={activeAssistantMsgIdRef.current}
                    completedTurnMsgId={completedTurnMsgId === m.id ? m.id : null}
                    expandedTraces={expandedTraces}
                    expandedProofs={expandedProofs}
                    hasResolvedDetachedTurn={hasResolvedDetachedTurn && idx === lastAssistantIndex}
                    activeModel={activeModel}
                    onPreviewImage={setPreviewModalImage}
                    onCopyToClipboard={copyToClipboard}
                    onRetry={handleRetry}
                    onToggleProof={toggleProof}
                    onToggleTraces={toggleTraces}
                    onStopTask={onStopTask}
                    onRunControlAction={handleRunControlAction}
                    onDeployRun={onDeployRun}
                    onOpenCanvasDiff={handleOpenCanvasDiff}
                  />
                );
              })}

              {/* Single timeline fallback when liveTurnTraces arrived before an assistant
                  message exists in messages (e.g. severed stream before assistant row lands).
                  Never duplicates traces already rendered on the tail assistant message. */}
              {liveTurnTraces.length > 0 &&
                !deduplicatedMessages.some(
                  (m) =>
                    m.role === "assistant" &&
                    (m.status === "streaming" || m.id === activeAssistantMsgIdRef.current)
                ) && (
                  <div className="w-full max-w-[840px]">
                    <ActivityTimeline
                      traces={liveTurnTraces}
                      isStreaming={isTurnLive}
                      onOpenCanvasDiff={handleOpenCanvasDiff}
                    />
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
              <HostApprovalsPanel approvals={hostApprovals} onDecision={handleApprovalDecision} />

              {/* Standalone turn status slot only when isLoading is true and no assistant ThinkingPanel is rendered at the tail */}
              {isLoading &&
                (() => {
                  const tailIdx = deduplicatedMessages.length - 1;
                  const tailMsg = tailIdx >= 0 ? deduplicatedMessages[tailIdx] : null;
                  const tailIsTaskHost = tailIdx === lastLinkedTaskMsgIndex && !!activeTask;
                  const tailRendersThinkingPanel = Boolean(
                    tailMsg && tailMsg.role === "assistant" && !tailIsTaskHost
                  );
                  if (tailRendersThinkingPanel) return null;
                  const phaseLabel = resolveTurnStatusPhase({
                    isStreaming: true,
                    streamStatus,
                    hasThought: false,
                    hasContent: false,
                  });
                  if (!phaseLabel) return null;
                  return (
                    <div
                      data-testid="turn-status-slot"
                      className="inline-flex items-center gap-2 h-7 px-3 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-200 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-400 w-fit"
                    >
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-600 dark:text-emerald-400 shrink-0" />
                      <span>{phaseLabel}</span>
                    </div>
                  );
                })()}

              {/* uir-1: in-thread stream banners — DISCONNECTED when the stream
            drops mid-turn, RECOVERED when the detached turn is reconciled.
            Both render at the interruption point so the drop and the
            recovery stay auditable in the stream. */}
              {(() => {
                const banner = streamBannerKind({
                  isDisconnected: isTransientDisconnected,
                  recoveredAtMs,
                  nowMs: Date.now(),
                });
                if (banner === "disconnected") {
                  return (
                    <div
                      data-testid="turn-transient-disconnected"
                      className="flex items-center gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-dashed border-amber-300 dark:border-amber-800/60 text-amber-800 dark:text-amber-200 text-xs font-medium w-full max-w-xl"
                    >
                      <Loader2 className="h-4 w-4 animate-spin text-amber-600 dark:text-amber-400 shrink-0" />
                      <span>{`⚠ DISCONNECTED · Connection interrupted — Auto-retrying (${reconnectAttempt}/${RECONCILE_POLL_MAX_ATTEMPTS})`}</span>
                    </div>
                  );
                }
                if (banner === "recovered") {
                  return (
                    <div
                      data-testid="stream-recovered-banner"
                      className="flex items-center gap-2 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 text-emerald-800 dark:text-emerald-200 text-xs font-medium w-full max-w-xl"
                    >
                      <span>{`↻ RECOVERED · Reconnected after ${recoveredAfterSec}s`}</span>
                    </div>
                  );
                }
                return null;
              })()}

              {errorMsg &&
                (() => {
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

          {/* Floating "Jump to bottom" button */}
          {isUserScrolledUp && (
            <div className="flex justify-center py-2 z-30 pointer-events-none bg-transparent">
              <button
                type="button"
                data-testid="live-follow-pill"
                onClick={() => scrollToBottom("smooth")}
                className="pointer-events-auto min-h-[44px] px-4 py-2 rounded-full bg-white dark:bg-black border border-emerald-600/70 dark:border-emerald-500/70 text-emerald-700 dark:text-emerald-400 text-xs font-semibold shadow-md hover:border-emerald-500 dark:hover:border-emerald-400 flex items-center gap-1.5 transition-all cursor-pointer"
                title="Jump to bottom"
                aria-label="Jump to bottom"
              >
                <ArrowDown className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" />
                <span>{isTurnLive ? "Live" : "Latest"}</span>
              </button>
            </div>
          )}

          {/* Docked Material 3 Single Input Bar matching Item 3, 4, 5, 6 & Mockup 1 & 4 */}
          <div className="sticky bottom-0 z-20 p-3 sm:p-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] bg-white/95 dark:bg-black/95 border-t border-slate-200/80 dark:border-zinc-800 backdrop-blur-md">
            {/* CHAT-STEER: Pending Steer indicator above composer */}
            {pendingSteers.length > 0 && (
              <div
                data-testid="chat-steer-pending-deck"
                className="flex items-center gap-2 pb-2 mb-2 border-b border-stone-200 dark:border-white/[0.10] max-w-[840px] mx-auto"
              >
                <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 shrink-0 uppercase tracking-wider flex items-center gap-1">
                  <span>Steer pending ({pendingSteers.length}):</span>
                </span>
                <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto scrollbar-none">
                  {pendingSteers.map((st, idx) => (
                    <div
                      key={idx}
                      data-testid="chat-steer-pending-chip"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-[11px] font-medium text-emerald-950 dark:text-emerald-200 shrink-0 max-w-[280px]"
                    >
                      <span className="truncate" title={st}>
                        {st}
                      </span>
                      <span className="text-[9px] text-emerald-700 dark:text-emerald-300 italic shrink-0">
                        (lands at next step)
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove steer item ${idx + 1}`}
                        onClick={() => {
                          setPendingSteers((prev) => prev.filter((_, i) => i !== idx));
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
                  data-testid="chat-steer-clear-all"
                  onClick={() => {
                    setPendingSteers([]);
                  }}
                  className="text-[11px] text-slate-500 hover:text-rose-600 dark:text-zinc-400 dark:hover:text-rose-400 underline shrink-0 px-1"
                >
                  Clear all
                </button>
              </div>
            )}

            {/* CHAT-QUEUE: Queue Chips above composer with per-item × and clear all */}
            {queueItems.length > 0 && (
              <div
                data-testid="chat-queue-deck"
                className="flex items-center gap-2 pb-2 mb-2 border-b border-slate-100 dark:border-zinc-850 max-w-[840px] mx-auto"
              >
                <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 shrink-0 uppercase tracking-wider flex items-center gap-1">
                  <span>Queue ({queueItems.length}):</span>
                </span>
                <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto scrollbar-none">
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
                      <NextImage
                        src={att.previewUrl}
                        alt={att.name}
                        width={24}
                        height={24}
                        unoptimized
                        className="h-6 w-6 rounded-lg object-cover border border-slate-200 dark:border-zinc-700"
                      />
                    ) : (
                      <FileText className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    )}
                    <div className="flex flex-col">
                      <span className="max-w-[130px] truncate font-medium text-[11px] text-slate-800 dark:text-zinc-200">
                        {att.name}
                      </span>
                      <span className="text-[9px] text-slate-600 dark:text-zinc-400 font-mono">
                        {formatFileSize(att.size)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveAttachment(att.id)}
                      className="p-1 rounded-md hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors ml-1"
                      title="Remove file"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Unified Two-Deck Composer Card */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
              className="max-w-[840px] mx-auto rounded-2xl bg-white dark:bg-[#111116] border border-stone-200 dark:border-white/[0.11] surface-card p-3 transition-all focus-within:ring-2 focus-within:ring-emerald-500/25 focus-within:border-emerald-500"
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
                className="w-full bg-transparent border-0 focus:outline-none focus:ring-0 text-[15px] sm:text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-400 resize-none px-1.5 py-1 leading-relaxed min-h-[46px] sm:min-h-[72px] max-h-[140px]"
              />

              {/* Bottom Deck: Controls Bar */}
              <div className="flex items-center justify-between pt-2 mt-1 border-t border-stone-200/70 dark:border-white/[0.08]">
                {/* Paperclip Button on left */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-9 w-9 rounded-full text-zinc-600 hover:text-emerald-700 dark:text-zinc-400 dark:hover:text-emerald-400 hover:bg-stone-200/60 dark:hover:bg-white/[0.08] transition-colors shrink-0 flex items-center justify-center"
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
                      className="inline-flex rounded-full p-0.5 bg-stone-200/70 dark:bg-[#1f1f28] text-[11px] font-medium select-none"
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={midTurnAction === "queue"}
                        onClick={() => handleSelectMidTurnAction("queue")}
                        className={`px-2.5 py-0.5 rounded-full transition-all ${
                          midTurnAction === "queue"
                            ? "bg-white dark:bg-[#0e0e12] text-emerald-700 dark:text-emerald-300 font-semibold shadow-xs"
                            : "text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200"
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
                            ? "bg-white dark:bg-[#0e0e12] text-emerald-800 dark:text-emerald-300 font-semibold shadow-xs"
                            : "text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200"
                        }`}
                      >
                        Steer
                      </button>
                    </div>
                  )}

                  {/* uir-0: the Chat|Build composer toggle is removed (owner ruling).
                  Build stays reachable via the /build prefix and the Builds view;
                  the dispatch check (composerMode === "build" || isBuildPrefix)
                  is unchanged. The auto-deploy opt-in now also appears when the
                  draft itself starts with the /build prefix. */}
                  {(composerMode === "build" ||
                    input.trim().toLowerCase().startsWith("/build ")) && (
                    <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-stone-600 dark:text-stone-400 cursor-pointer select-none px-1">
                      <input
                        type="checkbox"
                        checked={autoDeployOnGreen}
                        onChange={(e) => setAutoDeployOnGreen(e.target.checked)}
                        className="rounded border-stone-300 dark:border-white/[0.16] text-emerald-600 focus:ring-emerald-500 h-3.5 w-3.5"
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
                      className="h-10 w-10 rounded-xl bg-stone-900 dark:bg-stone-100 hover:bg-black dark:hover:bg-white text-white dark:text-stone-950 flex items-center justify-center shadow-xs active:scale-95 transition-all shrink-0"
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
                      className={`h-10 w-10 rounded-xl flex items-center justify-center shadow-xs active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition-all shrink-0 ${
                        isGeneratingOrRunning && midTurnAction === "steer"
                          ? "bg-emerald-600 hover:bg-emerald-500 text-white dark:bg-emerald-400 dark:hover:bg-emerald-300 dark:text-black"
                          : "bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-black"
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
                      <Send className="h-4 w-4 fill-current ml-0.5" />
                    </button>
                  )}
                </div>
              </div>
            </form>
          </div>
        </div>
        <ArtifactCanvasPane />
      </CanvasProvider>
    </div>
  );
}
