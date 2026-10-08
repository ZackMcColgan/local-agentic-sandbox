import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { ThreadStore, activeExecutionSet, Thread } from "@/lib/threads/threadStore";
import { generatePlanSpec } from "@/lib/subagents/planner";
import { OvernightSupervisor, createProductionStepExecutor } from "@/lib/subagents/supervisor";
import { WorkerPool } from "@/lib/subagents/workerPool";
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
        complexity: planSpec.complexity,
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
            model: body.model || "swift-27b-mtp",
            reasoningEffort: body.reasoningEffort || "medium",
            initialPrompt: goal,
            attachments: body.attachments,
            taskId
          });
        }
      } else {
        thread = threadStore.createThread({
          title: goal.slice(0, 36),
          model: body.model || "swift-27b-mtp",
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

      const activeThreadId = thread.id;

      // Kick off actual execution — fire-and-forget so the API returns immediately.
      const executor = createProductionStepExecutor({
        workerPool: new WorkerPool(),
        model: "swift-27b-mtp"
      });
      (async () => {
        console.log(`[threads] launching task ${taskId}, calling executeTaskWithRecovery`);
        try {
          const result = await supervisor.executeTaskWithRecovery(manifest, { stepExecutor: executor });
          console.log(`[threads] task ${taskId} finished with status: ${result.status}`);

          if (result.status === "completed") {
            const currentThread = await threadStore.getThread(activeThreadId);
            if (currentThread) {
              const lastMilestone = result.milestones?.[result.milestones.length - 1];
              const targetFile = lastMilestone?.plannedFiles?.[0] || "weather.svg";
              let fileContent = "";

              const repoCandidates = [
                process.env.WORKSPACE_DIR,
                "/workspace",
                process.cwd(),
                path.resolve(process.cwd(), "..")
              ].filter(Boolean) as string[];

              for (const dir of repoCandidates) {
                const fullP = path.resolve(dir, targetFile);
                if (fs.existsSync(fullP)) {
                  try {
                    fileContent = fs.readFileSync(fullP, "utf8");
                    break;
                  } catch {}
                }
              }

              // Extract any thinking from the builder journal entries
              const builderReasoning = result.journal
                ?.filter((j) => j.role === "builder" && j.message?.startsWith("Builder reasoning:"))
                ?.map((j) => j.message.replace(/^Builder reasoning:\s*/, ""))
                ?.join("\n\n");

              let completionContent = `Task completed successfully! Here is the generated \`${targetFile}\`:\n\n`;
              if (fileContent.trim()) {
                const isSvg = targetFile.endsWith(".svg") || fileContent.includes("<svg");
                const fenceLang = isSvg ? "xml" : path.extname(targetFile).replace(".", "") || "text";
                completionContent += `\`\`\`${fenceLang}\n${fileContent.trim()}\n\`\`\``;
              } else {
                completionContent += `Deliverable committed as \`${targetFile}\`.`;
              }

              currentThread.status = "completed";
              currentThread.messages.push({
                id: `msg-${Date.now()}-d`,
                role: "assistant",
                content: completionContent,
                thought: builderReasoning || "Decomposed goal, verified syntax, and generated deliverable.",
                taskId,
                timestamp: new Date().toISOString()
              });
              threadStore.saveThread(currentThread);
            }
          }
        } catch (err: any) {
          console.error(`[threads] task ${taskId} executeTaskWithRecovery threw:`, err?.stack || err);
          throw err;
        }
      })().catch((err) => {
        console.error(`[threads] Task ${taskId} execution failed:`, err);
      });

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
