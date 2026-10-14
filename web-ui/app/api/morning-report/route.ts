import { NextResponse } from "next/server";
import { OvernightSupervisor } from "@/lib/subagents/supervisor";
import {
  generateOvernightMorningReport,
  persistOvernightMorningReport,
  loadPersistedOvernightMorningReport,
  generateMorningReport
} from "@/lib/subagents/morningReport";
import { ThreadStore, Thread } from "@/lib/threads/threadStore";

const supervisor = new OvernightSupervisor();
const threadStore = new ThreadStore();

export async function GET() {
  try {
    const tasks = await supervisor.listAllTasks();
    const threads = await threadStore.listThreads();

    // Link threadId onto tasks if thread.taskId matches taskId
    for (const task of tasks) {
      if (!task.threadId) {
        const matchedThread = threads.find((t: Thread) => t.taskId === task.taskId);
        if (matchedThread) {
          task.threadId = matchedThread.id;
        }
      }
    }

    let overnightReport =
      tasks.length > 0
        ? generateOvernightMorningReport(tasks)
        : loadPersistedOvernightMorningReport(supervisor.checkpointDirectory);

    if (tasks.length > 0 && overnightReport) {
      persistOvernightMorningReport(overnightReport, supervisor.checkpointDirectory);
    }

    if (!overnightReport) {
      overnightReport = generateOvernightMorningReport([]);
    }

    const latestTask = tasks[0];
    const singleReport = latestTask
      ? generateMorningReport({
          taskId: latestTask.taskId,
          goal: latestTask.goal,
          branch: latestTask.branch || latestTask.branchName || "feat/overnight",
          gitHeadSha:
            latestTask.checkpoints?.[latestTask.checkpoints.length - 1]?.gitHeadSha || "HEAD",
          status:
            latestTask.status === "completed" ||
            latestTask.status === "parked" ||
            latestTask.status === "failed" ||
            latestTask.status === "cancelled"
              ? latestTask.status
              : "active",
          startedAt: latestTask.startedAt || new Date().toISOString(),
          completedAt: latestTask.completedAt,
          milestones: (latestTask.milestones || []).map((m) => ({
            id: m.id,
            title: m.title,
            status: m.status,
            commitSha: m.commitSha,
            testsPassed: m.testsPassed ?? 0,
            testsFailed: m.testsFailed ?? 0,
            diffSummary: m.diffSummary
          })),
          ambiguityFlags: latestTask.ambiguityFlags || [],
          parkedItems: latestTask.parkedReason ? [latestTask.parkedReason] : [],
        })
      : null;

    if (singleReport) {
      singleReport.overnightSummary = overnightReport;
    }

    return NextResponse.json({
      overnightReport,
      morningReport: singleReport
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const tasks = Array.isArray(body.tasks) ? body.tasks : await supervisor.listAllTasks();
    const overnightReport = generateOvernightMorningReport(tasks);
    persistOvernightMorningReport(overnightReport, supervisor.checkpointDirectory);
    return NextResponse.json({ overnightReport });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
