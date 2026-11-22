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
  type WorkingItemLiveness,
} from "./boardOrchestrator";
import { readBoardControlState } from "./boardControl";
import {
  createProductionStageDeps,
  type HostBridgeCommandResult,
  type HostBridgeExecutor,
  type StageThreadStore,
} from "./productionStageDeps";
import { executeHostTool as defaultExecuteHostTool } from "../hostMode";
import { activeExecutionSet, type ThreadStore } from "../threads/threadStore";
import { getSharedSlotScheduler } from "../slotScheduler";
import { POST as chatPost } from "../../app/api/chat/route";
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
  executeHostTool?: HostBridgeExecutor;
  dispatchChatTurn?: ProductionChatDispatcher;
}

export interface ProductionDrainOptions {
  threadStore: ThreadStore | null;
  dryRun?: boolean;
  maxItems?: number;
  maxDurationMs?: number;
  hostCheckoutPath?: string;
  executeHostTool?: HostBridgeExecutor;
  dispatchChatTurn?: ProductionChatDispatcher;
}

export type HostCheckoutGroundingResult =
  { ok: true; branch: string } | { ok: false; message: string };

export type JobSummaryClassification = "blocked" | "turn-ended" | "completed";

const TERMINAL_THREAD_STATUSES = new Set(["stopped", "failed", "completed"]);

export function createProductionWorkingItemLivenessCheck(options: {
  threadStore: StageThreadStore | null;
  isThreadLive?: (threadId: string) => boolean;
}): NonNullable<BoardOrchestratorDeps["checkWorkingItemLiveness"]> {
  const isThreadLive = options.isThreadLive ?? ((id: string) => activeExecutionSet.has(id));

  return async (item): Promise<WorkingItemLiveness> => {
    if (!options.threadStore) {
      return { status: "unknown", reason: "Thread store unavailable" };
    }

    const threadId = extractThreadIdFromLink(item.threadLink);
    if (!threadId) {
      return { status: "orphaned", reason: ORPHANED_WORKING_ITEM_REASON };
    }

    if (isThreadLive(threadId)) {
      return { status: "live", reason: `Active execution in progress for thread ${threadId}` };
    }

    const thread = await options.threadStore.getThread(threadId);
    if (!thread || TERMINAL_THREAD_STATUSES.has(thread.status)) {
      return { status: "orphaned", reason: ORPHANED_WORKING_ITEM_REASON };
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: params.threadId,
      messages: [{ role: "user", content: params.brief }],
    }),
  });
  const response = await chatPost(chatReq);
  const { tail: rawStream, totalBytes: streamTotalBytes } = await readResponseStreamTail(response);
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

export function createProductionIssueAndWait(
  options: ProductionIssueAndWaitOptions
): BoardOrchestratorDeps["issueAndWait"] {
  const dryRun = options.dryRun === true;
  const threadStore = dryRun ? null : options.threadStore;
  const hostCheckoutPath = options.hostCheckoutPath;
  const execBridge: HostBridgeExecutor =
    options.executeHostTool ?? ((tool, args) => defaultExecuteHostTool(tool, args));
  const dispatchChatTurn: ProductionChatDispatcher =
    options.dispatchChatTurn ?? defaultDispatchChatTurn;

  return async ({ item, brief }): Promise<JobExecutionOutcome> => {
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
    });
    try {
      const response = await dispatchChatTurn({
        threadId: thread.id,
        brief,
      });
      const settled = await threadStore.getThread(thread.id);

      if (!response.ok || settled?.status === "failed" || settled?.status === "stopped") {
        return {
          status: "failed",
          threadId: thread.id,
          error:
            settled?.error || `Job turn failed for thread ${thread.id} (HTTP ${response.status})`,
        };
      }

      const assistantMessages = (settled?.messages ?? []).filter(
        (m) =>
          m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0
      );
      const lastAssistant = assistantMessages[assistantMessages.length - 1]?.content ?? "";
      const classification = classifyJobSummary(lastAssistant);
      if (classification === "blocked" || classification === "turn-ended") {
        const firstLine =
          lastAssistant.trim().split(/\r?\n/)[0]?.trim() ||
          `Job ended with classification '${classification}'`;
        const code = classification === "blocked" ? "job-blocked" : "job-turn-ended";
        return {
          status: "failed",
          threadId: thread.id,
          error: firstLine,
          issue: {
            code,
            autoFixable: false,
            message: firstLine,
          },
        };
      }

      const metadata = extractJobOutcomeMetadata(lastAssistant, response.rawStream);
      const mem = process.memoryUsage();
      const rssMb = (mem.rss / (1024 * 1024)).toFixed(1);
      const heapUsedMb = (mem.heapUsed / (1024 * 1024)).toFixed(1);
      const streamTotalBytes =
        response.streamTotalBytes ?? Buffer.byteLength(response.rawStream, "utf8");
      console.info(
        `[board-drain] job completed itemId=${item.id} streamTotalBytes=${streamTotalBytes} rssMB=${rssMb} heapUsedMB=${heapUsedMb}`
      );

      return {
        status: "completed",
        threadId: thread.id,
        summary: lastAssistant ? lastAssistant.slice(0, 500) : `Completed thread ${thread.id}`,
        ...metadata,
      };
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
    checkWorkingItemLiveness: createProductionWorkingItemLivenessCheck({ threadStore }),
    getOwnerState: () => {
      const snapshot = getSharedSlotScheduler().getSnapshot();
      const ownerActive =
        snapshot.active?.priority === 0 || snapshot.queued.some((q) => q.priority === 0);
      return {
        isMidTurn: ownerActive,
        reason: ownerActive ? "Owner P0 turn active or queued" : undefined,
      };
    },
    issueAndWait: createProductionIssueAndWait({
      threadStore,
      dryRun,
      hostCheckoutPath,
      executeHostTool: options.executeHostTool,
      dispatchChatTurn: options.dispatchChatTurn,
    }),
  };

  return new BoardOrchestrator(deps);
}
