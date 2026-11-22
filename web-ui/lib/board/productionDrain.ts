import { NextRequest } from "next/server";
import {
  BoardOrchestrator,
  extractJobOutcomeMetadata,
  MAX_DRAIN_DURATION_MS,
  MAX_DRAIN_ITEMS,
  type BoardOrchestratorDeps,
  type JobExecutionOutcome,
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

export interface ProductionChatDispatcherParams {
  threadId: string;
  brief: string;
}

export type ProductionChatDispatcher = (
  params: ProductionChatDispatcherParams
) => Promise<{ ok: boolean; status: number; rawStream: string }>;

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
  | { ok: true; branch: string }
  | { ok: false; message: string };

function isHostCommandSuccess(res: HostBridgeCommandResult | null | undefined): boolean {
  if (!res) return false;
  if (res.ok === false) return false;
  if (typeof res.exitCode === "number" && res.exitCode !== 0) return false;
  return true;
}

async function defaultDispatchChatTurn(
  params: ProductionChatDispatcherParams
): Promise<{ ok: boolean; status: number; rawStream: string }> {
  const chatReq = new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: params.threadId,
      messages: [{ role: "user", content: params.brief }],
    }),
  });
  const response = await chatPost(chatReq);
  const rawStream = await response.text();
  return { ok: response.ok, status: response.status, rawStream };
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
      const metadata = extractJobOutcomeMetadata(lastAssistant, response.rawStream);

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
