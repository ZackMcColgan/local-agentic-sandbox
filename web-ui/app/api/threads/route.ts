import { NextResponse } from "next/server";
import { ThreadStore, activeExecutionSet, Thread } from "@/lib/threads/threadStore";
import { generatePlanSpec } from "@/lib/subagents/planner";
import { OvernightSupervisor } from "@/lib/subagents/supervisor";
import { TaskManifest, ToolchainType } from "@/lib/subagents/types";

const threadStore = new ThreadStore();
const supervisor = new OvernightSupervisor();

export async function GET(req: Request) {
  try {
    const threads = await threadStore.listThreads();
    return NextResponse.json({ threads });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // 1. Action: Launch engineering builder task inside a thread
    if (body.action === "launchTask" || body.action === "build") {
      const goal: string = body.goal || body.prompt;
      if (!goal || !goal.trim()) {
        return NextResponse.json({ error: "Goal is required" }, { status: 400 });
      }

      const toolchain: ToolchainType = body.toolchain || "node:22";
      const taskId = `task-${Date.now()}`;
      const planSpec = await generatePlanSpec({ taskId, goal, toolchain, model: body.model });

      const manifest: TaskManifest = {
        taskId,
        goal,
        branchName: "feat/v2.5-overnight",
        branch: "feat/v2.5-overnight",
        toolchain,
        status: "active",
        milestones: planSpec.milestones,
        currentMilestoneIndex: 0,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [
          {
            timestamp: new Date().toISOString(),
            role: "planner",
            message: `Decomposed goal into ${planSpec.milestones.length} milestones. SPEC.md generated.`
          }
        ],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      supervisor.saveCheckpoint(manifest);
      activeExecutionSet.add(taskId);

      // Create new durable thread or attach to existing
      let thread: Thread;
      if (body.threadId) {
        const existing = await threadStore.getThread(body.threadId);
        if (existing) {
          thread = existing;
          thread.taskId = taskId;
          thread.status = "active";
          thread.messages.push({
            id: `msg-${Date.now()}-u`,
            role: "user",
            content: goal,
            attachments: body.attachments,
            timestamp: new Date().toISOString()
          });
          thread.messages.push({
            id: `msg-${Date.now()}-a`,
            role: "assistant",
            content: "Started autonomous engineering run.",
            taskId,
            timestamp: new Date().toISOString()
          });
          threadStore.saveThread(thread);
        } else {
          thread = threadStore.createThread({
            title: goal.slice(0, 36),
            model: body.model || "qwen3.8:27b-q3_k_m",
            reasoningEffort: body.reasoningEffort || "medium",
            initialPrompt: goal,
            attachments: body.attachments,
            taskId
          });
        }
      } else {
        thread = threadStore.createThread({
          title: goal.slice(0, 36),
          model: body.model || "qwen3.8:27b-q3_k_m",
          reasoningEffort: body.reasoningEffort || "medium",
          initialPrompt: goal,
          attachments: body.attachments,
          taskId
        });
        thread.messages.push({
          id: `msg-${Date.now()}-a`,
          role: "assistant",
          content: "Started autonomous engineering run.",
          taskId,
          timestamp: new Date().toISOString()
        });
        threadStore.saveThread(thread);
      }

      return NextResponse.json({ thread, task: manifest }, { status: 201 });
    }

    // 2. Default: Create New Thread
    const thread = threadStore.createThread({
      title: body.title,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      initialPrompt: body.initialPrompt,
      attachments: body.attachments
    });

    return NextResponse.json({ thread }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
