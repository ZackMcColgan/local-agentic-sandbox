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
import { createProductionStageDeps } from "./productionStageDeps";
import { activeExecutionSet, type ThreadStore } from "../threads/threadStore";
import { getSharedSlotScheduler } from "../slotScheduler";
import { POST as chatPost } from "../../app/api/chat/route";

export interface ProductionDrainOptions {
  threadStore: ThreadStore | null;
  dryRun?: boolean;
  maxItems?: number;
  maxDurationMs?: number;
}

export function createProductionBoardOrchestrator(
  options: ProductionDrainOptions
): BoardOrchestrator {
  const dryRun = options.dryRun === true;
  const threadStore = dryRun ? null : options.threadStore;
  const maxItems = options.maxItems ?? MAX_DRAIN_ITEMS;
  const maxDurationMs = options.maxDurationMs ?? MAX_DRAIN_DURATION_MS;
  const stageDeps = dryRun || !threadStore ? {} : createProductionStageDeps({ threadStore });

  const deps: BoardOrchestratorDeps = {
    maxItems,
    maxDurationMs,
    dryRun,
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
    issueAndWait: async ({ item, brief }): Promise<JobExecutionOutcome> => {
      if (dryRun || !threadStore) {
        return {
          status: "completed",
          threadId: `dry-run-${item.id}`,
          summary: `Dry-run composed brief (${brief.length} chars)`,
        };
      }
      const thread = threadStore.createThread({
        title: `${item.key} ${item.title}`,
        initialPrompt: brief,
      });
      try {
        const chatReq = new NextRequest("http://localhost/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            threadId: thread.id,
            messages: [{ role: "user", content: brief }],
          }),
        });
        const response = await chatPost(chatReq);
        const rawStream = await response.text();
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
        const metadata = extractJobOutcomeMetadata(lastAssistant, rawStream);

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
    },
  };

  return new BoardOrchestrator(deps);
}
