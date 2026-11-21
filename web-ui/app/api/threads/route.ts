import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import {
  ThreadStore,
  activeExecutionSet,
  Thread,
  resolveThreadsDir,
} from "@/lib/threads/threadStore";
import { generatePlanSpec } from "@/lib/subagents/planner";
import { OvernightSupervisor, createProductionStepExecutor } from "@/lib/subagents/supervisor";
import { WorkerPool } from "@/lib/subagents/workerPool";
import { TaskManifest, ToolchainType, TaskScope } from "@/lib/subagents/types";
import { DEFAULT_PRIMARY_MODEL } from "@/config/models";
import type { ChunkBudgetConfig } from "@/lib/jobChunking";
import { getSharedSlotScheduler, SlotPriority } from "@/lib/slotScheduler";

const getThreadStore = () => new ThreadStore(resolveThreadsDir());
const getSupervisor = () => new OvernightSupervisor();

export async function GET(req: Request) {
  try {
    const threadStore = getThreadStore();
    const url = new URL(req.url);
    const full = url.searchParams.get("full") === "1";
    const q = url.searchParams.get("q")?.trim() || undefined;
    const threads = full
      ? await threadStore.listThreads()
      : await threadStore.listThreadSummaries(q);
    return NextResponse.json({ threads });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const threadStore = getThreadStore();
    const supervisor = getSupervisor();
    const body = await req.json();

    // 1. Action: Launch engineering builder task inside a thread
    if (body.action === "launchTask" || body.action === "build") {
      const goal: string = body.goal || body.prompt;
      if (!goal || !goal.trim()) {
        return NextResponse.json({ error: "Goal is required" }, { status: 400 });
      }

      const toolchain: ToolchainType = body.toolchain || "node:22";
      const scope: TaskScope = body.scope || "PROJECT";
      const taskId = `task-${Date.now()}`;
      const branchName = `feat/task-${taskId.replace(/^task-/, "").slice(0, 12)}`;
      const enableGitOps = body.enableGitOps !== false;
      const autoDeployOnGreen = Boolean(body.autoDeployOnGreen);
      const effectiveModel = body.model || process.env.MODEL_NAME || DEFAULT_PRIMARY_MODEL;
      const chunkBudget: ChunkBudgetConfig | undefined =
        body.chunkBudget && typeof body.chunkBudget === "object"
          ? (body.chunkBudget as ChunkBudgetConfig)
          : typeof body.maxRounds === "number"
            ? { maxRounds: body.maxRounds }
            : undefined;

      // Persist-first launch: create manifest with status "planning" and write checkpoint before planner runs
      const manifest: TaskManifest = {
        taskId,
        goal,
        branchName,
        branch: branchName,
        enableGitOps,
        autoDeployOnGreen,
        toolchain,
        scope,
        status: "planning",
        milestones: [],
        currentMilestoneIndex: 0,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [
          {
            timestamp: new Date().toISOString(),
            role: "planner",
            message: `Planning engineering task for goal: ${goal}`,
          },
        ],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
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
          thread.scope = scope;
          thread.status = "active";
          if (chunkBudget !== undefined) {
            thread.chunkBudget = chunkBudget;
          }
          const lastMsg = thread.messages[thread.messages.length - 1];
          const isDuplicate = lastMsg && lastMsg.role === "user" && lastMsg.content === goal;
          if (!isDuplicate) {
            thread.messages.push({
              id: `msg-${Date.now()}-u`,
              role: "user",
              content: goal,
              attachments: body.attachments,
              timestamp: new Date().toISOString(),
            });
            thread.messages.push({
              id: `msg-${Date.now()}-a`,
              role: "assistant",
              content: "Started autonomous engineering run.",
              taskId,
              timestamp: new Date().toISOString(),
            });
          } else {
            // Attach taskId to the last assistant message if present
            const lastAssistant = thread.messages
              .slice()
              .reverse()
              .find((m) => m.role === "assistant");
            if (lastAssistant) {
              lastAssistant.taskId = taskId;
            }
          }
          threadStore.saveThread(thread);
        } else {
          thread = threadStore.createThread({
            model: effectiveModel,
            reasoningEffort: body.reasoningEffort || "low",
            initialPrompt: goal,
            attachments: body.attachments,
            taskId,
            scope,
            hostAccess: false,
            ...(chunkBudget !== undefined ? { chunkBudget } : {}),
          });
        }
      } else {
        thread = threadStore.createThread({
          model: effectiveModel,
          reasoningEffort: body.reasoningEffort || "low",
          initialPrompt: goal,
          attachments: body.attachments,
          taskId,
          scope,
          hostAccess: false,
          ...(chunkBudget !== undefined ? { chunkBudget } : {}),
        });
        thread.messages.push({
          id: `msg-${Date.now()}-a`,
          role: "assistant",
          content: "Started autonomous engineering run.",
          taskId,
          timestamp: new Date().toISOString(),
        });
        threadStore.saveThread(thread);
      }

      const activeThreadId = thread.id;
      (manifest as any).threadId = activeThreadId;
      if (chunkBudget !== undefined) {
        (manifest as any).chunkBudget = chunkBudget;
      }

      // Kick off actual execution — fire-and-forget so the API returns immediately.
      let lastThinkingUpdate = 0;
      let lastRecordedLength = 0;

      const planController = new AbortController();
      supervisor.setAbortController(taskId, planController);

      const executor = createProductionStepExecutor({
        workerPool: new WorkerPool({
          maxConcurrency: 1,
          scheduler: getSharedSlotScheduler(),
          scope,
          modelRoster: {
            planner: effectiveModel,
            builder: effectiveModel,
            critic: effectiveModel,
            explorer: effectiveModel,
            recorder: effectiveModel,
          },
        }),
        model: effectiveModel,
        scope,
        signal: planController.signal,
        onThinkingChunk: (_chunk: string, totalThinking: string) => {
          if (
            !activeExecutionSet.has(taskId) ||
            supervisor.isPaused(taskId) ||
            (manifest.status !== "active" && manifest.status !== "planning")
          ) {
            return;
          }
          manifest.builderThinking = totalThinking;
          if (manifest.milestones && manifest.milestones[manifest.currentMilestoneIndex]) {
            manifest.milestones[manifest.currentMilestoneIndex].builderThinking = totalThinking;
          }
          const now = Date.now();
          // Update at most once every 3 seconds or when totalThinking has grown substantially (>120 chars)
          if (now - lastThinkingUpdate > 3000 || totalThinking.length - lastRecordedLength > 120) {
            lastThinkingUpdate = now;
            lastRecordedLength = totalThinking.length;

            // Extract the latest meaningful sentence or clause from thinking
            const cleaned = totalThinking.trim().replace(/\r?\n/g, " ");
            const snippet = cleaned.length > 200 ? cleaned.slice(-200) : cleaned;
            const message = `Analyzing: ${snippet.trim()}`;

            // Check if last entry is an in-flight thinking entry we can update, or append a new entry
            const journal = manifest.journal || [];
            const lastEntry = journal[journal.length - 1];
            if (
              lastEntry &&
              lastEntry.role === "builder" &&
              lastEntry.message.startsWith("Analyzing:")
            ) {
              lastEntry.message = message;
              lastEntry.timestamp = new Date().toISOString();
            } else {
              journal.push({
                timestamp: new Date().toISOString(),
                role: "builder",
                message,
              });
            }
            manifest.journal = journal;
            manifest.updatedAt = new Date().toISOString();

            try {
              const file = supervisor.getCheckpointFilePath(taskId);
              fs.writeFileSync(file, JSON.stringify(manifest, null, 2), "utf8");
            } catch (saveErr) {
              console.warn(`[threads] Failed to write in-flight thinking checkpoint:`, saveErr);
            }
          }
        },
      });
      (async () => {
        console.log(`[threads] decomposing goal for task ${taskId}`);
        try {
          const abortPromise = new Promise<never>((_, reject) => {
            if (planController.signal.aborted) {
              const abortErr = new Error("Planning aborted by user");
              abortErr.name = "AbortError";
              reject(abortErr);
              return;
            }
            planController.signal.addEventListener(
              "abort",
              () => {
                const abortErr = new Error("Planning aborted by user");
                abortErr.name = "AbortError";
                reject(abortErr);
              },
              { once: true }
            );
          });
          const planSpec = await Promise.race([
            getSharedSlotScheduler().runWithSlot(
              { priority: SlotPriority.P2_ORCHESTRATOR, label: `planner:${taskId}` },
              () => generatePlanSpec({ taskId, goal, toolchain, scope, model: effectiveModel })
            ),
            abortPromise,
          ]);
          if (planController.signal.aborted) {
            const abortErr = new Error("Planning aborted by user");
            abortErr.name = "AbortError";
            throw abortErr;
          }
          manifest.complexity = planSpec.complexity;
          manifest.milestones = planSpec.milestones;
          manifest.status = "active";
          manifest.journal.push({
            timestamp: new Date().toISOString(),
            role: "planner",
            message: `Decomposed goal into ${planSpec.milestones.length} milestones (Scope: ${scope}). SPEC.md generated.`,
          });
          supervisor.saveCheckpoint(manifest);

          const currentThread = await threadStore.getThread(activeThreadId);
          if (currentThread) {
            const lastAsst = currentThread.messages
              .slice()
              .reverse()
              .find((m) => m.role === "assistant" && m.taskId === taskId);
            if (lastAsst) {
              lastAsst.content = `Started autonomous engineering run (${planSpec.milestones.length} milestones).`;
            }
            threadStore.saveThread(currentThread);
          }
        } catch (planErr: any) {
          const wasAborted = planController.signal.aborted || planErr?.name === "AbortError";
          if (wasAborted) {
            console.log(`[threads] Planning aborted for task ${taskId}`);
            manifest.status = "cancelled";
            manifest.parkedReason = "Planning aborted by user";
            manifest.journal.push({
              timestamp: new Date().toISOString(),
              role: "planner",
              message: "Planning aborted by user",
            });
            supervisor.saveCheckpoint(manifest);
            const currentThread = await threadStore.getThread(activeThreadId);
            if (currentThread) {
              currentThread.status = "stopped";
              currentThread.messages.push({
                id: `msg-${Date.now()}-abort`,
                role: "assistant",
                content: "Task cancelled: Planning aborted by user",
                taskId,
                timestamp: new Date().toISOString(),
              });
              threadStore.saveThread(currentThread);
            }
            supervisor.deleteAbortController(taskId);
            activeExecutionSet.delete(taskId);
            return;
          }
          console.error(`[threads] Planning failed for task ${taskId}:`, planErr);
          manifest.status = "failed";
          manifest.parkedReason = planErr?.message || String(planErr);
          manifest.journal.push({
            timestamp: new Date().toISOString(),
            role: "planner",
            message: `Planning failed: ${manifest.parkedReason}`,
          });
          supervisor.saveCheckpoint(manifest);
          const currentThread = await threadStore.getThread(activeThreadId);
          if (currentThread) {
            currentThread.status = "failed";
            currentThread.messages.push({
              id: `msg-${Date.now()}-err`,
              role: "assistant",
              content: `Task failed: ${manifest.parkedReason}`,
              taskId,
              timestamp: new Date().toISOString(),
            });
            threadStore.saveThread(currentThread);
          }
          supervisor.deleteAbortController(taskId);
          activeExecutionSet.delete(taskId);
          return;
        }

        console.log(`[threads] launching task ${taskId}, calling executeTaskWithRecovery`);
        try {
          const result = await supervisor.executeTaskWithRecovery(manifest, {
            stepExecutor: executor,
            signal: planController.signal,
          });
          console.log(`[threads] task ${taskId} finished with status: ${result.status}`);

          if (result.status === "completed") {
            const currentThread = await threadStore.getThread(activeThreadId);
            if (currentThread) {
              // Task 3 (Sprint A2): Collect all modified deliverables across all completed milestones without hardcoded weather.svg fallback
              const allFiles = new Set<string>();
              for (const m of result.milestones || []) {
                if (m.plannedFiles && Array.isArray(m.plannedFiles)) {
                  for (const f of m.plannedFiles) {
                    if (f && typeof f === "string" && f.trim()) allFiles.add(f.trim());
                  }
                }
              }

              const repoCandidates = [
                (result as any).worktreePath,
                process.env.WORKSPACE_DIR,
                "/workspace",
                process.cwd(),
                path.resolve(process.cwd(), ".."),
              ].filter(Boolean) as string[];

              const deliverables: Array<{ file: string; content: string }> = [];

              for (const targetFile of allFiles) {
                let fileContent = "";
                for (const dir of repoCandidates) {
                  const fullP = path.resolve(dir, targetFile);
                  if (fs.existsSync(fullP)) {
                    try {
                      fileContent = fs.readFileSync(fullP, "utf8");
                      break;
                    } catch {}
                  }
                }
                deliverables.push({ file: targetFile, content: fileContent });
              }

              // Extract any thinking from the builder journal entries
              const builderReasoning = result.journal
                ?.filter((j) => j.role === "builder" && j.message?.startsWith("Builder reasoning:"))
                ?.map((j) => j.message.replace(/^Builder reasoning:\s*/, ""))
                ?.join("\n\n");

              let completionContent = "";
              if (deliverables.length === 0) {
                completionContent = "Task completed successfully!";
              } else if (deliverables.length === 1) {
                const d = deliverables[0];
                completionContent = `Task completed successfully! Here is the generated \`${d.file}\`:\n\n`;
                if (d.content.trim()) {
                  const isSvg = d.file.endsWith(".svg") || d.content.includes("<svg");
                  const fenceLang = isSvg ? "xml" : path.extname(d.file).replace(".", "") || "text";
                  completionContent += `\`\`\`${fenceLang}\n${d.content.trim()}\n\`\`\``;
                } else {
                  completionContent += `Deliverable committed as \`${d.file}\`.`;
                }
              } else {
                completionContent = `Task completed successfully! Generated ${deliverables.length} deliverables:\n\n`;
                for (const d of deliverables) {
                  completionContent += `### \`${d.file}\`\n`;
                  if (d.content.trim()) {
                    const isSvg = d.file.endsWith(".svg") || d.content.includes("<svg");
                    const fenceLang = isSvg
                      ? "xml"
                      : path.extname(d.file).replace(".", "") || "text";
                    completionContent += `\`\`\`${fenceLang}\n${d.content.trim()}\n\`\`\`\n\n`;
                  } else {
                    completionContent += `Deliverable committed as \`${d.file}\`.\n\n`;
                  }
                }
              }

              currentThread.status = "completed";
              currentThread.messages.push({
                id: `msg-${Date.now()}-d`,
                role: "assistant",
                content: completionContent,
                thought:
                  builderReasoning ||
                  "Decomposed goal, verified syntax, and generated deliverable.",
                taskId,
                timestamp: new Date().toISOString(),
                ...(result.completionStamp ? { completionStamp: result.completionStamp } : {}),
                ...(Array.isArray(result.verificationGaps)
                  ? { verificationGaps: result.verificationGaps }
                  : {}),
              } as any);
              threadStore.saveThread(currentThread);
            }
          } else {
            // Task ended in non-completed terminal state (failed, parked, cancelled)
            const currentThread = await threadStore.getThread(activeThreadId);
            if (currentThread) {
              currentThread.status =
                result.status === "failed" || (result.status as string) === "crashed"
                  ? "failed"
                  : result.status === "paused"
                    ? "paused"
                    : "stopped";
              const lastJournalReason =
                Array.isArray(result.journal) && result.journal.length > 0
                  ? [...result.journal]
                      .reverse()
                      .find(
                        (j: any) => typeof j?.message === "string" && j.message.trim().length > 0
                      )?.message
                  : undefined;
              const reason =
                result.errorSummary ||
                result.parkedReason ||
                lastJournalReason ||
                result.ambiguityFlags?.[0]?.question ||
                "Task did not reach completion.";
              currentThread.messages.push({
                id: `msg-${Date.now()}-term`,
                role: "assistant",
                content: `Task ${result.status}: ${reason}`,
                taskId,
                timestamp: new Date().toISOString(),
                ...(result.completionStamp ? { completionStamp: result.completionStamp } : {}),
                ...(Array.isArray(result.verificationGaps)
                  ? { verificationGaps: result.verificationGaps }
                  : {}),
              } as any);
              threadStore.saveThread(currentThread);
            }
          }
        } catch (err: any) {
          console.error(
            `[threads] task ${taskId} executeTaskWithRecovery threw:`,
            err?.stack || err
          );
          manifest.status = "failed";
          manifest.parkedReason = err?.message || String(err);
          manifest.journal.push({
            timestamp: new Date().toISOString(),
            role: "supervisor",
            message: `Fatal execution error: ${manifest.parkedReason}`,
          });
          supervisor.saveCheckpoint(manifest);
          const currentThread = await threadStore.getThread(activeThreadId);
          if (currentThread) {
            currentThread.status = "failed";
            currentThread.messages.push({
              id: `msg-${Date.now()}-err`,
              role: "assistant",
              content: `Task failed: ${manifest.parkedReason}`,
              taskId,
              timestamp: new Date().toISOString(),
            });
            threadStore.saveThread(currentThread);
          }
        } finally {
          activeExecutionSet.delete(taskId);
        }
      })().catch((err) => {
        console.error(`[threads] Task ${taskId} execution failed:`, err);
      });

      return NextResponse.json({ thread, task: manifest }, { status: 201 });
    }

    // 2. Action: Durably clear persisted messages on an existing thread
    if (body.action === "clearMessages") {
      const targetThreadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
      if (!targetThreadId) {
        return NextResponse.json({ error: "threadId is required" }, { status: 400 });
      }
      const cleared = await threadStore.clearThreadMessages(targetThreadId);
      if (!cleared) {
        return NextResponse.json({ error: "Thread not found" }, { status: 404 });
      }
      return NextResponse.json({ thread: cleared }, { status: 200 });
    }

    // 3. Default: Create New Thread
    const thread = threadStore.createThread({
      title: body.title,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      initialPrompt: body.initialPrompt,
      attachments: body.attachments,
    });

    return NextResponse.json({ thread }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
