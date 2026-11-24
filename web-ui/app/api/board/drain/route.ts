import { NextRequest, NextResponse } from "next/server";
import {
  getLastDrainReport,
  MAX_DRAIN_DURATION_MS,
  MAX_DRAIN_ITEMS,
  runBoardDrainWithMutex,
  type DrainReport,
} from "@/lib/board/boardOrchestrator";
import { isDrainAllowed, readBoardControlState } from "@/lib/board/boardControl";
import { createProductionBoardOrchestrator } from "@/lib/board/productionDrain";
import { formatDrainReportMarkdown } from "@/lib/subagents/morningReport";
import { ThreadStore } from "@/lib/threads/threadStore";

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
    const { result: report, deduplicated } = await runBoardDrainWithMutex(async () => {
      const threadStore = dryRun ? null : new ThreadStore();
      const orchestrator = createProductionBoardOrchestrator({
        threadStore,
        dryRun,
        maxItems,
        maxDurationMs,
      });
      return orchestrator.drain();
    });
    const isDrainReport =
      Boolean(report) && typeof report === "object" && "drainId" in (report as object);

    return NextResponse.json({
      control: readBoardControlState(),
      report,
      markdown: isDrainReport ? formatDrainReportMarkdown(report as DrainReport) : null,
      deduplicated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to run board drain";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
