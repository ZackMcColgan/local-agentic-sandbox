import type { TaskScope } from "../subagents/types";
import type { ExecutionTraceItem } from "@/components/ExecutionTrace";
import type {
  CompactionStrategy,
  HybridFallbackReason,
  SummarizeRequest,
  SummarizeResult,
} from "../conversationCompaction";
import type { TurnFileDiff } from "../chatDiffs";
import type { JobTokenRollup } from "../tokenEconomics";
import type { ElisionMeta } from "../microElision";
import type { ReadDedupMeta } from "../readDedup";
import type { ChunkBudgetConfig } from "../jobChunking";
import type { ThinkingSegment } from "../activityTimeline";

/** Result of turn-start conversation preparation (thread view + compaction report). */
export interface TurnConversationPreparation {
  messages: Array<{
    role: string;
    content: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string | Record<string, unknown> };
    }>;
    [key: string]: unknown;
  }>;
  compactedThisTurn: boolean;
  tokensBeforeCompaction?: number;
  tokensAfterCompaction?: number;
  /** True when the boundary summary placed in the model view is the MODEL DIGEST. */
  modelSummaryUsed?: boolean;
  /** Set when the hybrid pass failed and the extraction digest was used instead. */
  fallbackReason?: HybridFallbackReason;
}

/** Options for the turn-start compaction path (strategy-aware dispatch). */
export interface TurnStartCompactionOptions {
  /** Overrides COMPACTION_STRATEGY for this call; defaults to resolveCompactionStrategy(). */
  strategy?: CompactionStrategy;
  /** Summarization callback for the hybrid rung. Absent => extraction rung. */
  summarize?: (req: SummarizeRequest) => Promise<SummarizeResult | string>;
  /** Injectable deadlines (test seam); default to the pinned guardrails. */
  inactivityMs?: number;
  totalDeadlineMs?: number;
}

export interface ThreadAttachment {
  name: string;
  type: string;
  size: number;
  previewUrl?: string;
  base64?: string;
  isImage?: boolean;
}

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thought?: string;
  thinkingSegments?: ThinkingSegment[];
  traces?: ExecutionTraceItem[];
  attachments?: ThreadAttachment[];
  diffs?: TurnFileDiff[];
  modelUsed?: string;
  turnStartMs?: number;
  durationMs?: number;
  thinkingDurationMs?: number;
  phaseTimings?: {
    contextPrepMs?: number;
    thinkingMs?: number;
    toolsMs?: number;
    writingMs?: number;
  };
  timestamp: string;
  taskId?: string;
  error?: string;
  parkedReason?: string;
  isStopped?: boolean;
  compactedThisTurn?: boolean;
  tokensBeforeCompaction?: number;
  tokensAfterCompaction?: number;
  compactionActions?: string[];
  selectedModel?: string;
  status?: "completed" | "incomplete" | "error" | "streaming";
  finish_reason?: string;
  outputTokens?: number;
  /** TOKEN ECONOMICS (a): prompt tokens recorded per model round in this turn. */
  roundPromptTokens?: number[];
  /** Per-round generation duration (ms) for completed rounds in this turn. */
  roundGenerationMs?: number[];
  /** TOKEN ECONOMICS (c): micro-elision audit — every stub applied during the
   * turn (tool, target, original size, round). The full results remain in
   * `traces`, so a stubbed result stays recoverable from the thread record. */
  microElisions?: ElisionMeta[];
  /** TOKEN ECONOMICS (d): read-dedup audit — every unchanged re-read stubbed
   * during the turn (path, content hash, the earlier read's round/trace, and
   * the re-read's round). The full content of the first read remains in
   * `traces`, so a stubbed read stays recoverable from the thread record. */
  readDedups?: ReadDedupMeta[];
  /** TOKEN ECONOMICS (a): per-job rollup for this turn (rounds, prompt integral, output, compactions). */
  tokenEconomics?: JobTokenRollup;
  /** Per-job chunk budget override (maxRounds, maxDurationMs, marathonOptOut). */
  chunkBudget?: ChunkBudgetConfig | null;
}

/**
 * TURN-LIVENESS: derived heartbeat state for a thread record.
 * - "alive": turn is live and its record was touched within TURN_STALL_WINDOW_MS.
 * - "stalled": turn is live but no activity landed past the stale window.
 * - "settled": turn is not live (completed / stopped / failed / paused).
 */
export type ThreadLiveness = "alive" | "stalled" | "settled";

export interface ThreadCompactionBoundary {
  strategy?: CompactionStrategy;
  extractionDigest?: string;
  fallbackLogged?: boolean;
  fallbackReason?: HybridFallbackReason;
  throughMessageId: string;
  summary: string;
  compactedAt: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface ThreadSummary {
  id: string;
  title: string;
  status: Thread["status"];
  createdAt: string;
  updatedAt: string;
  model?: string;
  reasoningEffort?: Thread["reasoningEffort"];
  taskId?: string;
  /** Board item ID when this thread is owned by the board drain. */
  boardItemId?: string;
  error?: string;
  parkedReason?: string;
  messageCount: number;
  lastMessagePreview: string;
  hasDiffs: boolean;
  hasStreamingMessage: boolean;
  /** True while the turn is queued waiting for a queue/slot before round-0 execution starts. */
  queuedForExecution?: boolean;
  matchSnippet?: string;
}

export interface Thread {
  id: string;
  title: string;
  status: "active" | "running" | "paused" | "stopped" | "completed" | "failed" | "needs_input";
  createdAt: string;
  updatedAt: string;
  liveness?: ThreadLiveness;
  model: string;
  reasoningEffort: "low" | "medium" | "xhigh";
  messages: ThreadMessage[];
  compaction?: ThreadCompactionBoundary;
  hostAccess?: boolean;
  taskId?: string;
  /** Board item ID when this thread is owned by the board drain (never supervised by inAppSupervisor). */
  boardItemId?: string;
  error?: string;
  parkedReason?: string;
  scope?: TaskScope;
  workerInfo?: string;
  timeLabel?: string;
  isTest?: boolean;
  isSubagent?: boolean;
  isScheduled?: boolean;
  /** In-app supervisor: reason the turn was honestly ended after stalling. */
  stalledReason?: string;
  /** In-app supervisor: true when auto-resume cap is reached or no banked state exists. */
  needsAttention?: boolean;
  /** In-app supervisor: number of auto-resumes issued for this thread/job. */
  autoResumeCount?: number;
  /** In-app supervisor: source thread ID when this thread was created by auto-resume. */
  resumedFromThreadId?: string;
  /** In-app supervisor: fresh thread ID created when this stalled thread was auto-resumed. */
  resumedToThreadId?: string;
  /**
   * TOKEN ECONOMICS (a): per-job rollup aggregated across the thread's turns
   * (rounds, prompt-token integral, output tokens, compaction count). Surfaced
   * with the board item; no separate UI surface in this pass.
   */
  tokenEconomics?: JobTokenRollup;
  /** Per-job chunk budget override (maxRounds, maxDurationMs, marathonOptOut). */
  chunkBudget?: ChunkBudgetConfig | null;
  /** True while waiting in the turn queue/slot scheduler before execution begins; excluded from stall clock. */
  queuedForExecution?: boolean;
}

/**
 * CHAT-PRESENCE: turn-presence marker. Visible in GET responses from the moment a
 * turn starts — before any token or streaming snapshot exists — so cross-device
 * watchers see "a turn is running" immediately. Cleared on done/error/abort/stop.
 */
export interface ActiveTurnInfo {
  threadId: string;
  startedAt: string;
  status: "streaming";
  queued?: boolean;
}
