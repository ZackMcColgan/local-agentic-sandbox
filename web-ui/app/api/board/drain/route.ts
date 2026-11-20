import { NextRequest, NextResponse } from "next/server";
import {
  BoardOrchestrator,
  extractJobOutcomeMetadata,
  getLastDrainReport,
  MAX_DRAIN_DURATION_MS,
  MAX_DRAIN_ITEMS,
} from "@/lib/board/boardOrchestrator";
import { isDrainAllowed, readBoardControlState } from "@/lib/board/boardControl";
import { createProductionStageDeps } from "@/lib/board/productionStageDeps";
import { formatDrainReportMarkdown } from "@/lib/subagents/morningReport";
import { activeExecutionSet, ThreadStore } from "@/lib/threads/threadStore";
import { getSharedSlotScheduler } from "@/lib/slotScheduler";
import { POST as chatPost } from "@/app/api/chat/route";

export async function GET() {
  try {
    const control = readBoardControlState();
    const report = getLastDrainReport();
    return NextResponse.json({
      control,
      report,
      markdown: report ? formatDrainReportMarkdown(report) : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load drain status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: {
      maxItems?: unknown;
      maxDurationMs?: unknown;
      dryRun?: unknown;
    } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      // Empty body is valid; defaults apply
    }

    const control = readBoardControlState();
    if (!isDrainAllowed(control)) {
      return NextResponse.json(
        {
          error: `Board control is '${control.state}'; drain requires 'running' state.`,
          control,
        },
        { status: 409 }
      );
    }

    const maxItems =
      typeof body.maxItems === "number" && Number.isFinite(body.maxItems)
        ? Math.min(Math.max(1, Math.floor(body.maxItems)), MAX_DRAIN_ITEMS)
        : MAX_DRAIN_ITEMS;

    const maxDurationMs =
      typeof body.maxDurationMs === "number" && Number.isFinite(body.maxDurationMs)
        ? Math.min(Math.max(1, body.maxDurationMs), MAX_DRAIN_DURATION_MS)
        : MAX_DRAIN_DURATION_MS;

    const dryRun = body.dryRun === true;
    const threadStore = dryRun ? null : new ThreadStore();
    const stageDeps =
      dryRun || !threadStore ? {} : createProductionStageDeps({ threadStore });

    const orchestrator = new BoardOrchestrator({
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
          snapshot.active?.priority === 0 ||
          snapshot.queued.some((q) => q.priority === 0);
        return {
          isMidTurn: ownerActive,
          reason: ownerActive ? "Owner P0 turn active or queued" : undefined,
        };
      },
      issueAndWait: async ({ item, brief }) => {
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
              mode: "agent",
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
                settled?.error ||
                `Job turn failed for thread ${thread.id} (HTTP ${response.status})`,
            };
          }

          const assistantMessages = (settled?.messages ?? []).filter(
            (m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0
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
    });

    const report = await orchestrator.drain();
    return NextResponse.json({
      control: readBoardControlState(),
      report,
      markdown: formatDrainReportMarkdown(report),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to run board drain";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
