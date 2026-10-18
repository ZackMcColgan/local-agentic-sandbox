import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { ThreadStore, activeExecutionSet } from "@/lib/threads/threadStore";
import { OvernightSupervisor, createProductionStepExecutor, cancelTask } from "@/lib/subagents/supervisor";
import { WorkerPool } from "@/lib/subagents/workerPool";
import { TaskManifest } from "@/lib/subagents/types";
import { unloadAllModels } from "@/lib/subagents/residency";
import { getSharedRunLedger } from "@/lib/ledger/runLedger";

const threadStore = new ThreadStore();
const supervisor = new OvernightSupervisor();

function launchTaskExecution(activeThreadId: string, manifest: TaskManifest) {
  const taskId = manifest.taskId;
  const scope = manifest.scope || "PROJECT";
  let lastThinkingUpdate = 0;
  let lastRecordedLength = 0;

  const controller = new AbortController();
  supervisor.setAbortController(taskId, controller);

  const executor = createProductionStepExecutor({
    workerPool: new WorkerPool({ scope }),
    model: "swift-15-27b-mtp",
    scope,
    signal: controller.signal,
    onThinkingChunk: (_chunk: string, totalThinking: string) => {
      if (!activeExecutionSet.has(taskId) || supervisor.isPaused(taskId) || manifest.status !== "active") {
        return;
      }
      const now = Date.now();
      if (now - lastThinkingUpdate > 3000 || totalThinking.length - lastRecordedLength > 120) {
        lastThinkingUpdate = now;
        lastRecordedLength = totalThinking.length;
        const cleaned = totalThinking.trim().replace(/\r?\n/g, " ");
        const snippet = cleaned.length > 200 ? cleaned.slice(-200) : cleaned;
        const message = `Analyzing: ${snippet.trim()}`;

        const journal = manifest.journal || [];
        const lastEntry = journal[journal.length - 1];
        if (lastEntry && lastEntry.role === "builder" && lastEntry.message.startsWith("Analyzing:")) {
          lastEntry.message = message;
          lastEntry.timestamp = new Date().toISOString();
        } else {
          journal.push({
            timestamp: new Date().toISOString(),
            role: "builder",
            message
          });
        }
        manifest.journal = journal;
        manifest.updatedAt = new Date().toISOString();

        try {
          const file = supervisor.getCheckpointFilePath(taskId);
          fs.writeFileSync(file, JSON.stringify(manifest, null, 2), "utf8");
        } catch (saveErr) {
          console.warn(`[threads/[id]] Failed to write in-flight thinking checkpoint:`, saveErr);
        }
      }
    }
  });

  (async () => {
    try {
      console.log(`[threads/[id]] executing task ${taskId} with recovery`);
      const result = await supervisor.executeTaskWithRecovery(manifest, { stepExecutor: executor, signal: controller.signal });
      console.log(`[threads/[id]] task ${taskId} finished with status: ${result.status}`);

      if (result.status === "completed") {
        const currentThread = await threadStore.getThread(activeThreadId);
        if (currentThread) {
          const lastMilestone = result.milestones?.[result.milestones.length - 1];
          const targetFile = lastMilestone?.plannedFiles?.[0];
          let fileContent = "";

          if (targetFile) {
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
          }

          let completedMsg = targetFile
            ? `Task completed successfully! Here is the generated \`${targetFile}\`:\n\n`
            : "Task completed successfully!";

          if (targetFile && fileContent.trim()) {
            const isSvg = targetFile.endsWith(".svg") || fileContent.includes("<svg");
            const fenceLang = isSvg ? "xml" : path.extname(targetFile).replace(".", "") || "text";
            completedMsg += `\`\`\`${fenceLang}\n${fileContent.trim()}\n\`\`\``;
          } else if (targetFile) {
            completedMsg += `Deliverable committed as \`${targetFile}\`.`;
          }

          currentThread.status = "completed";
          currentThread.messages.push({
            id: `msg-${Date.now()}-done`,
            role: "assistant",
            content: completedMsg,
            taskId,
            timestamp: new Date().toISOString()
          });
          threadStore.saveThread(currentThread);
        }
      }
    } catch (err: any) {
      console.error(`[threads/[id]] Task ${taskId} execution failed:`, err?.message || err);
      try {
        supervisor.parkTask(manifest, `Execution failure: ${err?.message || err}`);
      } catch {}
    } finally {
      activeExecutionSet.delete(taskId);
    }
  })();
}

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

    // 1. Action: Stop / Cancel Run
    if (body.action === "stop" || body.action === "cancel") {
      thread.status = "stopped";
      if (thread.taskId) {
        cancelTask(thread.taskId);
        activeExecutionSet.delete(thread.taskId);
        const task = await supervisor.resumeTaskFromCheckpoint(thread.taskId);
        if (task) {
          supervisor.parkTask(task, "User stopped run");
        }
      }
      activeExecutionSet.delete(thread.id);

      // Unload all models from LLM VRAM immediately
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
          thread.status = "paused";
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
          supervisor.resumeTask(task.taskId);
          activeExecutionSet.add(task.taskId);
          thread.status = "active";
          threadStore.saveThread(thread);

          launchTaskExecution(thread.id, task);

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

          launchTaskExecution(thread.id, restarted);

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
      if (body.message.role === "user") {
        if (
          !thread.title ||
          thread.title.toLowerCase() === "new thread" ||
          thread.title.toLowerCase() === "untitled thread" ||
          thread.title.toLowerCase() === "new task" ||
          thread.title.toLowerCase() === "new session"
        ) {
          const content = body.message.content || "";
          if (content.trim()) {
            const maxLen = thread.title?.toLowerCase() === "new session" ? 48 : 40;
            thread.title = content.trim().slice(0, maxLen);
          }
        }
      } else if (body.message.role === "assistant") {
        if (thread.status !== "active") {
          thread.status = "completed";
        }
      }
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
    const thread = await threadStore.getThread(id);
    if (thread?.taskId) {
      cancelTask(thread.taskId);
    }
    const ok = await threadStore.deleteThread(id);
    return NextResponse.json({ success: ok });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
