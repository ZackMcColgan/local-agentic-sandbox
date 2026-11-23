import { NextRequest } from "next/server";
import {
  BoardOrchestrator,
  extractJobOutcomeMetadata,
  extractThreadIdFromLink,
  MAX_DRAIN_DURATION_MS,
  MAX_DRAIN_ITEMS,
  ORPHANED_WORKING_ITEM_REASON,
  type BoardOrchestratorDeps,
  type JobExecutionOutcome,
  type OrphanedThreadEvidence,
  type WorkingItemLiveness,
} from "./boardOrchestrator";
import { readBoardControlState } from "./boardControl";
import type { DispatcherBoardItem, DispatcherHandoff } from "./dispatcher";
import {
  createProductionStageDeps,
  type HostBridgeCommandResult,
  type HostBridgeExecutor,
  type StageThreadStore,
} from "./productionStageDeps";
import { executeHostTool as defaultExecuteHostTool } from "../hostMode";
import { activeExecutionSet, type Thread, type ThreadStore } from "../threads/threadStore";
import { getSharedSlotScheduler } from "../slotScheduler";
import {
  resolveChunkHandoffTarget,
  TURN_CHUNK_COMPLETE_MARKER,
  type ChunkHandoffBrief,
} from "../jobChunking";
import { readMilestoneHandoff } from "../subagents/finishVerificationGate";
import { POST as chatPost } from "../../app/api/chat/route";
import { waitForTurnSettled } from "../chat/turnEngine";
import { readResponseStreamTail } from "./streamTail";

export interface ProductionChatDispatcherParams {
  threadId: string;
  brief: string;
}

export interface ProductionChatDispatchResult {
  ok: boolean;
  status: number;
  /** Bounded tail of the chat response stream (at most `STREAM_TAIL_CAP_BYTES`), not the full stream. */
  rawStream: string;
  /** Total bytes consumed from the response stream before tail truncation. */
  streamTotalBytes?: number;
}

export type ProductionChatDispatcher = (
  params: ProductionChatDispatcherParams
) => Promise<ProductionChatDispatchResult>;

export interface ProductionIssueAndWaitOptions {
  threadStore: StageThreadStore | null;
  dryRun?: boolean;
  hostCheckoutPath?: string;
  checkpointDir?: string;
  executeHostTool?: HostBridgeExecutor;
  dispatchChatTurn?: ProductionChatDispatcher;
  onThreadCreated?: (item: DispatcherBoardItem, threadId: string) => void;
}

export interface ProductionDrainOptions {
  threadStore: ThreadStore | null;
  dryRun?: boolean;
  maxItems?: number;
  maxDurationMs?: number;
  hostCheckoutPath?: string;
  checkpointDir?: string;
  executeHostTool?: HostBridgeExecutor;
  dispatchChatTurn?: ProductionChatDispatcher;
  triageAutoFix?: BoardOrchestratorDeps["triageAutoFix"];
}

export type HostCheckoutGroundingResult =
  { ok: true; branch: string } | { ok: false; message: string };

export type JobSummaryClassification = "blocked" | "turn-ended" | "completed";

const INTERRUPTED_THREAD_STATUSES = new Set(["stopped", "failed"]);

function getLastAssistantMessage(thread: Thread | null | undefined) {
  const assistantMessages = (thread?.messages ?? []).filter(
    (m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0
  );
  return assistantMessages[assistantMessages.length - 1];
}

export function isChunkCompleteOutcome(lastAssistantContent: string, rawStream?: string): boolean {
  if (lastAssistantContent.includes(TURN_CHUNK_COMPLETE_MARKER)) {
    return true;
  }
  if (rawStream && rawStream.includes(TURN_CHUNK_COMPLETE_MARKER)) {
    return true;
  }
  return false;
}

function parseHandoffField(text: string, label: string): string | undefined {
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?${label}\\s*:\\s*(.+)$`, "im");
  const match = re.exec(text);
  return match?.[1]?.trim() || undefined;
}

export function resolveChunkHandoffForThread(
  thread: Thread | null | undefined,
  threadId: string,
  lastAssistant: string,
  checkpointDir?: string
): DispatcherHandoff {
  try {
    const target = resolveChunkHandoffTarget({
      taskId: thread?.taskId,
      threadId,
      checkpointDir,
    });
    const banked = readMilestoneHandoff(target.handoffPath) as ChunkHandoffBrief | null;
    if (banked && typeof banked === "object") {
      return {
        state: banked.currentState || banked.summary || `Chunk completed on thread ${threadId}`,
        branch: banked.branch || "HEAD",
        headSha: banked.headSha || "unknown",
        nextStep: banked.nextStep || banked.nextMilestone || "Continue from banked chunk state.",
        ...(Array.isArray(banked.openQuestions) && banked.openQuestions.length > 0
          ? { openQuestions: banked.openQuestions }
          : {}),
      };
    }
  } catch {
    // Fall through to prose extraction
  }

  const cleanedProse = lastAssistant.split(TURN_CHUNK_COMPLETE_MARKER).join("").trim();
  return {
    state:
      parseHandoffField(cleanedProse, "State") ||
      (cleanedProse ? cleanedProse.slice(0, 500) : `Chunk completed on thread ${threadId}`),
    branch: parseHandoffField(cleanedProse, "Branch") || "HEAD",
    headSha: parseHandoffField(cleanedProse, "HEAD\\s*SHA") || "unknown",
    nextStep:
      parseHandoffField(cleanedProse, "Next\\s*step") ||
      "Continue from banked chunk state. Do not restart from scratch.",
  };
}

function extractMarkerFromContent(content: string): string | null {
  const markerMatches = content.match(/⚠️\s*\[[^\]]+\]/g);
  if (markerMatches && markerMatches.length > 0) {
    return markerMatches[markerMatches.length - 1].trim();
  }
  if (content.includes("*[Stopped by user]*")) {
    return "*[Stopped by user]*";
  }
  return null;
}

function extractStreamErrorText(rawStream?: string): string | null {
  if (!rawStream) return null;
  const trimmed = rawStream.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // Not a single JSON object; inspect SSE data lines
  }
  const lines = trimmed.split(/\r?\n/).reverse();
  for (const line of lines) {
    const dataMatch = /^data:\s*(.+)$/.exec(line.trim());
    if (!dataMatch) continue;
    try {
      const evt = JSON.parse(dataMatch[1]) as { type?: string; error?: unknown };
      if (evt.type === "error" && typeof evt.error === "string" && evt.error.trim()) {
        return evt.error.trim();
      }
    } catch {
      // ignore non-JSON SSE line
    }
  }
  return null;
}

export function extractTurnFailureReason(
  settled: Thread | null | undefined,
  threadId: string,
  response?: Pick<ProductionChatDispatchResult, "ok" | "status" | "rawStream">
): string {
  if (typeof settled?.error === "string" && settled.error.trim()) {
    return settled.error.trim();
  }
  if (typeof settled?.stalledReason === "string" && settled.stalledReason.trim()) {
    return settled.stalledReason.trim();
  }
  if (typeof settled?.parkedReason === "string" && settled.parkedReason.trim()) {
    return settled.parkedReason.trim();
  }

  const lastAssistantMsg = getLastAssistantMessage(settled);
  if (typeof lastAssistantMsg?.error === "string" && lastAssistantMsg.error.trim()) {
    return lastAssistantMsg.error.trim();
  }

  const lastContent = lastAssistantMsg?.content?.trim() ?? "";
  if (lastContent) {
    const marker = extractMarkerFromContent(lastContent);
    if (marker) return marker;
    return lastContent.slice(0, 300);
  }

  const streamError = extractStreamErrorText(response?.rawStream);
  if (streamError) {
    return streamError;
  }

  if (response && !response.ok) {
    return `Job turn failed for thread ${threadId} (HTTP ${response.status})`;
  }

  const statusLabel = settled?.status ?? "unknown";
  return `Job turn settled '${statusLabel}' for thread ${threadId} without an error detail`;
}

function isStaleGitLockFailure(reason: string): boolean {
  return /index\.lock/i.test(reason);
}

function isSuccessfulTraceResult(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result === "string") {
    return !/^\s*(?:error|fatal):/i.test(result);
  }
  if (typeof result === "object") {
    const obj = result as { ok?: unknown; exitCode?: unknown; error?: unknown };
    if (obj.ok === false) return false;
    if (typeof obj.exitCode === "number" && obj.exitCode !== 0) return false;
    if (typeof obj.error === "string" && obj.error.trim().length > 0) return false;
    return true;
  }
  return false;
}

export function inspectThreadPrOrCommitEvidence(thread: Thread): OrphanedThreadEvidence {
  const assistantMessages = (thread.messages ?? []).filter((m) => m.role === "assistant");
  const assistantTexts = assistantMessages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter((c) => c.length > 0);
  const combinedAssistantText = assistantTexts.join("\n");

  const meta = extractJobOutcomeMetadata(combinedAssistantText);
  const evidenceParts: string[] = [];
  let branch: string | undefined;
  let headSha: string | undefined = meta.headSha ?? meta.mergeSha;

  if (meta.prNumber !== undefined) {
    evidenceParts.push(`PR #${meta.prNumber}`);
  }
  if (meta.mergeSha) {
    evidenceParts.push(`merge ${meta.mergeSha}`);
  }

  const commitTextMatch =
    /\bcommitted\s+([0-9a-f]{7,40})\b/i.exec(combinedAssistantText) ??
    /\[([A-Za-z0-9._/-]+)\s+([0-9a-f]{7,40})\]/.exec(combinedAssistantText);
  if (commitTextMatch) {
    if (commitTextMatch.length >= 3 && commitTextMatch[2]) {
      branch = branch ?? commitTextMatch[1];
      headSha = headSha ?? commitTextMatch[2];
      evidenceParts.push(`commit ${commitTextMatch[2]} on ${commitTextMatch[1]}`);
    } else if (commitTextMatch[1]) {
      headSha = headSha ?? commitTextMatch[1];
      evidenceParts.push(`commit ${commitTextMatch[1]}`);
    }
  }

  let totalTraces = 0;
  let lastToolName: string | undefined;

  for (const msg of assistantMessages) {
    const traces = Array.isArray(msg.traces) ? msg.traces : [];
    for (const trace of traces) {
      totalTraces += 1;
      lastToolName = trace.tool;
      const resultText =
        typeof trace.result === "string"
          ? trace.result
          : trace.result && typeof trace.result === "object"
            ? JSON.stringify(trace.result)
            : "";

      if (
        (trace.tool === "host_git_commit" ||
          trace.tool === "host_git_push" ||
          trace.tool === "host_create_pr") &&
        isSuccessfulTraceResult(trace.result)
      ) {
        const traceMeta = extractJobOutcomeMetadata(resultText);
        if (traceMeta.prNumber !== undefined) {
          evidenceParts.push(`PR #${traceMeta.prNumber}`);
        } else {
          evidenceParts.push(trace.tool);
        }
        continue;
      }

      if (
        (trace.tool === "host_run_powershell" || trace.tool === "workspace_run_command") &&
        isSuccessfulTraceResult(trace.result)
      ) {
        const cmd = String(trace.args?.command ?? "");
        if (/\bgh\s+pr\s+create\b/i.test(cmd)) {
          const traceMeta = extractJobOutcomeMetadata(resultText);
          evidenceParts.push(
            traceMeta.prNumber !== undefined ? `PR #${traceMeta.prNumber}` : "gh pr create"
          );
        } else if (/\bgit\s+commit\b/i.test(cmd)) {
          const shaMatch = /\[([A-Za-z0-9._/-]+)\s+([0-9a-f]{7,40})\]/.exec(resultText);
          if (shaMatch) {
            branch = branch ?? shaMatch[1];
            headSha = headSha ?? shaMatch[2];
            evidenceParts.push(`commit ${shaMatch[2]}`);
          } else {
            evidenceParts.push("git commit");
          }
        } else if (/\bgit\s+push\b/i.test(cmd)) {
          evidenceParts.push("git push");
        }
      }
    }
  }

  const lastAssistantMsg = getLastAssistantMessage(thread);
  const rawLastContent = lastAssistantMsg?.content ?? "";
  const strippedProse = rawLastContent.replace(/⚠️\s*\[[^\]]+\]/g, "").trim();
  let previousAttemptSummary: string | undefined;
  if (strippedProse) {
    previousAttemptSummary = strippedProse.slice(0, 300);
  } else if (totalTraces > 0) {
    previousAttemptSummary = `Executed ${totalTraces} tool call(s) (last: ${lastToolName}).`;
  }

  const dedupedEvidence = Array.from(new Set(evidenceParts));
  return {
    threadId: thread.id,
    hasPrOrCommitEvidence: dedupedEvidence.length > 0,
    ...(dedupedEvidence.length > 0 ? { evidenceSummary: dedupedEvidence.join(", ") } : {}),
    ...(previousAttemptSummary ? { previousAttemptSummary } : {}),
    ...(branch ? { branch } : {}),
    ...(headSha ? { headSha } : {}),
  };
}

export function evaluateSettledThreadOutcome(params: {
  thread: Thread | null | undefined;
  threadId: string;
  response?: ProductionChatDispatchResult;
  itemId?: string;
  checkpointDir?: string;
}): JobExecutionOutcome {
  const { thread, threadId, response, itemId, checkpointDir } = params;
  const lastAssistantMsg = getLastAssistantMessage(thread);
  const lastAssistant = lastAssistantMsg?.content ?? "";

  // Fix A4: detect chunk-complete before any stopped short-circuit (roundLoop sets
  // turnStatus="incomplete" -> thread.status="stopped" with [[CHUNK_COMPLETE]]).
  if ((!response || response.ok) && isChunkCompleteOutcome(lastAssistant, response?.rawStream)) {
    const handoff = resolveChunkHandoffForThread(thread, threadId, lastAssistant, checkpointDir);
    return {
      status: "chunk-complete",
      threadId,
      handoff,
    };
  }

  // Fix A3: run classifyJobSummary BEFORE any stopped/failed short-circuit when
  // assistant summary content exists, so BLOCKED and Turn-ended classifications
  // are never masked behind generic failures.
  if (lastAssistant) {
    const classification = classifyJobSummary(lastAssistant);
    if (classification === "blocked" || classification === "turn-ended") {
      const turnEndedMarker =
        classification === "turn-ended" ? extractMarkerFromContent(lastAssistant) : null;
      const firstLine =
        lastAssistant.trim().split(/\r?\n/)[0]?.trim() ||
        `Job ended with classification '${classification}'`;
      const reason = turnEndedMarker || firstLine;
      const code = classification === "blocked" ? "job-blocked" : "job-turn-ended";
      return {
        status: "failed",
        threadId,
        error: reason,
        issue: {
          code,
          autoFixable: false,
          message: reason,
        },
      };
    }
  }

  if ((response && !response.ok) || thread?.status === "failed" || thread?.status === "stopped") {
    const reason = extractTurnFailureReason(thread, threadId, response);
    const autoFixable = isStaleGitLockFailure(reason);
    return {
      status: "failed",
      threadId,
      error: reason,
      issue: {
        code: autoFixable ? "stale-git-lock" : "execution-failed",
        autoFixable,
        message: reason,
      },
    };
  }

  const metadata = extractJobOutcomeMetadata(lastAssistant, response?.rawStream);
  if (response && itemId) {
    const mem = process.memoryUsage();
    const rssMb = (mem.rss / (1024 * 1024)).toFixed(1);
    const heapUsedMb = (mem.heapUsed / (1024 * 1024)).toFixed(1);
    const streamTotalBytes =
      response.streamTotalBytes ?? Buffer.byteLength(response.rawStream, "utf8");
    console.info(
      `[board-drain] job completed itemId=${itemId} streamTotalBytes=${streamTotalBytes} rssMB=${rssMb} heapUsedMB=${heapUsedMb}`
    );
  }

  return {
    status: "completed",
    threadId,
    summary: lastAssistant ? lastAssistant.slice(0, 500) : `Completed thread ${threadId}`,
    ...metadata,
  };
}

export function createProductionWorkingItemLivenessCheck(options: {
  threadStore: StageThreadStore | null;
  checkpointDir?: string;
  isThreadLive?: (threadId: string) => boolean;
}): NonNullable<BoardOrchestratorDeps["checkWorkingItemLiveness"]> {
  const isThreadLive = options.isThreadLive ?? ((id: string) => activeExecutionSet.has(id));

  return async (item): Promise<WorkingItemLiveness> => {
    if (!options.threadStore) {
      return { status: "unknown", reason: "Thread store unavailable" };
    }

    const threadId = extractThreadIdFromLink(item.threadLink);
    if (!threadId) {
      return {
        status: "orphaned",
        reason: ORPHANED_WORKING_ITEM_REASON,
        evidence: { hasPrOrCommitEvidence: false },
      };
    }

    if (isThreadLive(threadId)) {
      return { status: "live", reason: `Active execution in progress for thread ${threadId}` };
    }

    const thread = await options.threadStore.getThread(threadId);
    if (!thread) {
      return {
        status: "orphaned",
        reason: ORPHANED_WORKING_ITEM_REASON,
        evidence: { threadId, hasPrOrCommitEvidence: false },
      };
    }

    // Fix A2: a completed thread must NEVER be classified as orphaned — inspect
    // its outcome through the normal completion path.
    if (thread.status === "completed") {
      const outcome = evaluateSettledThreadOutcome({
        thread,
        threadId,
        itemId: item.id,
        checkpointDir: options.checkpointDir,
      });
      return {
        status: "completed",
        outcome,
        reason: `Thread ${threadId} settled completed`,
      };
    }

    if (INTERRUPTED_THREAD_STATUSES.has(thread.status)) {
      const lastAssistant = getLastAssistantMessage(thread)?.content ?? "";
      if (isChunkCompleteOutcome(lastAssistant)) {
        const outcome = evaluateSettledThreadOutcome({
          thread,
          threadId,
          itemId: item.id,
          checkpointDir: options.checkpointDir,
        });
        return {
          status: "completed",
          outcome,
          reason: `Thread ${threadId} settled chunk-complete`,
        };
      }

      const evidence = inspectThreadPrOrCommitEvidence(thread);
      const failureReason = extractTurnFailureReason(thread, threadId);
      return {
        status: "orphaned",
        reason: failureReason || ORPHANED_WORKING_ITEM_REASON,
        evidence,
      };
    }

    return { status: "live", reason: `Thread ${threadId} is ${thread.status}` };
  };
}

export function classifyJobSummary(summary: string): JobSummaryClassification {
  const trimmed = summary.trim();
  if (!trimmed) return "completed";

  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  if (/^(?:[*_`#>\-\s]*?)BLOCKED\b/.test(firstLine)) {
    return "blocked";
  }

  if (/⚠️\s*\[Turn ended:/i.test(trimmed)) {
    return "turn-ended";
  }

  return "completed";
}

function isHostCommandSuccess(res: HostBridgeCommandResult | null | undefined): boolean {
  if (!res) return false;
  if (res.ok === false) return false;
  if (typeof res.exitCode === "number" && res.exitCode !== 0) return false;
  return true;
}

async function defaultDispatchChatTurn(
  params: ProductionChatDispatcherParams
): Promise<ProductionChatDispatchResult> {
  const chatReq = new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-consumer": "in-process",
      "x-dispatch-source": "board-drain",
    },
    body: JSON.stringify({
      threadId: params.threadId,
      messages: [{ role: "user", content: params.brief }],
    }),
  });
  const response = await chatPost(chatReq);
  let rawStream = "";
  let streamTotalBytes = 0;
  try {
    const tailResult = await readResponseStreamTail(response);
    rawStream = tailResult.tail;
    streamTotalBytes = tailResult.totalBytes;
  } catch {
    // Never fail a live in-process turn on stream backpressure/reader error;
    // await the turn's own settlement below and evaluate its persisted outcome.
  }
  await waitForTurnSettled(params.threadId);
  return { ok: response.ok, status: response.status, rawStream, streamTotalBytes };
}

export async function verifyHostCheckoutGrounding(
  hostCheckoutPath: string | undefined,
  executeHostTool: HostBridgeExecutor
): Promise<HostCheckoutGroundingResult> {
  const trimmedPath = typeof hostCheckoutPath === "string" ? hostCheckoutPath.trim() : "";
  if (!trimmedPath) {
    return {
      ok: false,
      message: "HOST_CHECKOUT_PATH is not configured.",
    };
  }

  try {
    const res = await executeHostTool("host_run_powershell", {
      command: "git rev-parse --abbrev-ref HEAD",
      cwd: trimmedPath,
      timeoutSeconds: 30,
    });
    if (!isHostCommandSuccess(res)) {
      const detail = (res?.stderr || res?.error || res?.stdout || "command failed").trim();
      return {
        ok: false,
        message: `Host checkout unavailable at ${trimmedPath}: ${detail}`,
      };
    }
    return {
      ok: true,
      branch: typeof res.stdout === "string" ? res.stdout.trim() : "",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Host checkout check failed at ${trimmedPath}: ${detail}`,
    };
  }
}

export function createProductionTriageAutoFix(options: {
  hostCheckoutPath?: string;
  executeHostTool?: HostBridgeExecutor;
}): NonNullable<BoardOrchestratorDeps["triageAutoFix"]> {
  const execBridge: HostBridgeExecutor =
    options.executeHostTool ?? ((tool, args) => defaultExecuteHostTool(tool, args));

  return async (issue): Promise<boolean> => {
    if (issue.code !== "stale-git-lock") {
      return false;
    }
    const trimmedPath =
      typeof options.hostCheckoutPath === "string" ? options.hostCheckoutPath.trim() : "";
    if (!trimmedPath) {
      return false;
    }
    try {
      const res = await execBridge("host_run_powershell", {
        command:
          "if (Test-Path '.git/index.lock') { Remove-Item -Force '.git/index.lock' }; git status --short",
        cwd: trimmedPath,
        timeoutSeconds: 30,
      });
      return isHostCommandSuccess(res);
    } catch {
      return false;
    }
  };
}

export function createProductionIssueAndWait(
  options: ProductionIssueAndWaitOptions
): BoardOrchestratorDeps["issueAndWait"] {
  const dryRun = options.dryRun === true;
  const threadStore = dryRun ? null : options.threadStore;
  const hostCheckoutPath = options.hostCheckoutPath;
  const checkpointDir = options.checkpointDir;
  const execBridge: HostBridgeExecutor =
    options.executeHostTool ?? ((tool, args) => defaultExecuteHostTool(tool, args));
  const dispatchChatTurn: ProductionChatDispatcher =
    options.dispatchChatTurn ?? defaultDispatchChatTurn;

  return async ({ item, brief, onThreadCreated }): Promise<JobExecutionOutcome> => {
    if (dryRun || !threadStore) {
      return {
        status: "completed",
        threadId: `dry-run-${item.id}`,
        summary: `Dry-run composed brief (${brief.length} chars)`,
      };
    }

    const grounding = await verifyHostCheckoutGrounding(hostCheckoutPath, execBridge);
    if (!grounding.ok) {
      return {
        status: "failed",
        error: grounding.message,
        issue: {
          code: "host-checkout-unavailable",
          autoFixable: false,
          message: grounding.message,
        },
      };
    }

    const thread = threadStore.createThread({
      title: `${item.key} ${item.title}`,
      initialPrompt: brief,
      boardItemId: item.id,
    });

    // Fix A1: persist threadLink immediately upon thread creation, before the
    // chat turn is dispatched or awaited.
    onThreadCreated?.(thread.id);
    options.onThreadCreated?.(item, thread.id);

    try {
      const response = await dispatchChatTurn({
        threadId: thread.id,
        brief,
      });
      const settled = await threadStore.getThread(thread.id);
      return evaluateSettledThreadOutcome({
        thread: settled,
        threadId: thread.id,
        response,
        itemId: item.id,
        checkpointDir,
      });
    } catch (err) {
      return {
        status: "failed",
        threadId: thread.id,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

export function createProductionBoardOrchestrator(
  options: ProductionDrainOptions
): BoardOrchestrator {
  const dryRun = options.dryRun === true;
  const threadStore = dryRun ? null : options.threadStore;
  const maxItems = options.maxItems ?? MAX_DRAIN_ITEMS;
  const maxDurationMs = options.maxDurationMs ?? MAX_DRAIN_DURATION_MS;
  const hostCheckoutPath = options.hostCheckoutPath ?? process.env.HOST_CHECKOUT_PATH;
  const stageDeps =
    dryRun || !threadStore
      ? {}
      : createProductionStageDeps({
          threadStore,
          hostCheckoutPath,
          executeHostTool: options.executeHostTool,
        });

  const deps: BoardOrchestratorDeps = {
    maxItems,
    maxDurationMs,
    dryRun,
    hostCheckoutPath,
    ...stageDeps,
    getControlState: () => readBoardControlState(),
    getLiveJobState: () => ({
      isRunning: activeExecutionSet.size > 0,
      runningJobId: activeExecutionSet.values().next().value,
    }),
    checkWorkingItemLiveness: createProductionWorkingItemLivenessCheck({
      threadStore,
      checkpointDir: options.checkpointDir,
    }),
    getOwnerState: () => {
      const snapshot = getSharedSlotScheduler().getSnapshot();
      const ownerActive =
        snapshot.active?.priority === 0 || snapshot.queued.some((q) => q.priority === 0);
      return {
        isMidTurn: ownerActive,
        reason: ownerActive ? "Owner P0 turn active or queued" : undefined,
      };
    },
    triageAutoFix:
      options.triageAutoFix ??
      (dryRun
        ? undefined
        : createProductionTriageAutoFix({
            hostCheckoutPath,
            executeHostTool: options.executeHostTool,
          })),
    issueAndWait: createProductionIssueAndWait({
      threadStore,
      dryRun,
      hostCheckoutPath,
      checkpointDir: options.checkpointDir,
      executeHostTool: options.executeHostTool,
      dispatchChatTurn: options.dispatchChatTurn,
    }),
  };

  return new BoardOrchestrator(deps);
}
