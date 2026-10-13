import { NextResponse } from "next/server";
import { ThreadStore, activeExecutionSet } from "@/lib/threads/threadStore";
import { OvernightSupervisor } from "@/lib/subagents/supervisor";
import { unloadAllModels } from "@/lib/subagents/residency";
import { getSharedRunLedger } from "@/lib/ledger/runLedger";

const threadStore = new ThreadStore();
const supervisor = new OvernightSupervisor();

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const thread = await threadStore.getThread(id);
    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    let task = null;
    if (thread.taskId) {
      task = await supervisor.resumeTaskFromCheckpoint(thread.taskId);
      const ledgerEntry = getSharedRunLedger().getRun(thread.taskId);
      if (task && ledgerEntry?.status === "crashed" && task.status === "active") {
        task.status = "crashed";
      }
    }

    return NextResponse.json({ thread, task });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const thread = await threadStore.getThread(id);
    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    const body = await req.json();

    // 1. Action: Stop Run
    if (body.action === "stop") {
      thread.status = "stopped";
      if (thread.taskId) {
        activeExecutionSet.delete(thread.taskId);
        const task = await supervisor.resumeTaskFromCheckpoint(thread.taskId);
        if (task) {
          supervisor.parkTask(task, "User stopped run");
        }
      }
      activeExecutionSet.delete(thread.id);

      // Unload all models from Ollama VRAM immediately
      await unloadAllModels();

      // Mark the last assistant message as stopped
      for (let i = thread.messages.length - 1; i >= 0; i--) {
        if (thread.messages[i].role === "assistant") {
          thread.messages[i].isStopped = true;
          break;
        }
      }

      threadStore.saveThread(thread);
      return NextResponse.json({ status: "stopped", thread });
    }

    // 1b. Action: Pause Run
    if (body.action === "pause") {
      if (thread.taskId) {
        activeExecutionSet.delete(thread.taskId);
        const task = await supervisor.resumeTaskFromCheckpoint(thread.taskId);
        if (task) {
          supervisor.pauseTask(task, "User paused run");
          getSharedRunLedger().pauseRun(task.taskId);
          threadStore.saveThread(thread);
          return NextResponse.json({ status: "paused", thread, task });
        }
      }
      return NextResponse.json({ error: "No active task to pause" }, { status: 400 });
    }

    // 1c. Action: Resume Run
    if (body.action === "resume") {
      if (thread.taskId) {
        const task = await supervisor.resumeTaskFromCheckpoint(thread.taskId);
        if (task) {
          task.status = "active";
          task.updatedAt = new Date().toISOString();
          task.journal.push({
            timestamp: new Date().toISOString(),
            role: "supervisor",
            message: "Resumed run from last saved checkpoint. Completed milestones preserved."
          });
          supervisor.saveCheckpoint(task);
          activeExecutionSet.add(task.taskId);
          thread.status = "active";
          threadStore.saveThread(thread);
          return NextResponse.json({ status: "running", thread, task });
        }
      }
      return NextResponse.json({ error: "No task checkpoint found to resume" }, { status: 400 });
    }

    // 1d. Action: Restart Run
    if (body.action === "restart") {
      if (thread.taskId) {
        const original = await supervisor.resumeTaskFromCheckpoint(thread.taskId);
        if (original) {
          const restarted = supervisor.restartTask(original);
          try {
            getSharedRunLedger().restartRun(original.taskId, restarted.taskId);
          } catch {
            // synced by saveCheckpoint
          }
          thread.taskId = restarted.taskId;
          thread.status = "active";
          activeExecutionSet.add(restarted.taskId);
          threadStore.saveThread(thread);
          return NextResponse.json({ status: "running", thread, task: restarted });
        }
      }
      return NextResponse.json({ error: "No task found to restart" }, { status: 400 });
    }

    // 2. Action: Rename Thread
    if (body.action === "rename" && body.title) {
      thread.title = body.title;
      threadStore.saveThread(thread);
      return NextResponse.json({ thread });
    }

    // 3. Action: Add Message
    if (body.action === "addMessage" && body.message) {
      thread.messages.push(body.message);
      thread.updatedAt = new Date().toISOString();
      threadStore.saveThread(thread);
      return NextResponse.json({ thread });
    }

    return NextResponse.json({ thread });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const ok = await threadStore.deleteThread(id);
    return NextResponse.json({ success: ok });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
