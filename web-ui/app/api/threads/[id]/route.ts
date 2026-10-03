import { NextResponse } from "next/server";
import { ThreadStore, activeExecutionSet } from "@/lib/threads/threadStore";
import { OvernightSupervisor } from "@/lib/subagents/supervisor";
import { unloadAllModels } from "@/lib/subagents/residency";

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
