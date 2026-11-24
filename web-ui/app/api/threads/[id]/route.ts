import fs from "fs";
import path from "path";
import crypto from "crypto";
import { NextResponse } from "next/server";
import {
  ThreadStore,
  activeExecutionSet,
  getActiveTurn,
  clearTurnActive,
  abortActiveTurn,
  resolveThreadsDir,
  type Thread,
  type ThreadMessage,
} from "@/lib/threads/threadStore";
import { extractTraceError } from "@/lib/activityTimeline";
import {
  OvernightSupervisor,
  createProductionStepExecutor,
  cancelTask,
} from "@/lib/subagents/supervisor";
import { WorkerPool } from "@/lib/subagents/workerPool";
import { TaskManifest } from "@/lib/subagents/types";
import { unloadAllModels } from "@/lib/subagents/residency";
import { getSharedRunLedger } from "@/lib/ledger/runLedger";
import { DEFAULT_PRIMARY_MODEL } from "@/config/models";
import { getSharedSlotScheduler } from "@/lib/slotScheduler";

// Store is created per request so a runtime THREADS_DIR change (tests, container env
// refresh) is always honored — mirrors the chat route's per-request store.
const getThreadStore = () => new ThreadStore(resolveThreadsDir());
const getSupervisor = () => new OvernightSupervisor();

function launchTaskExecution(activeThreadId: string, manifest: TaskManifest, threadModel?: string) {
  const supervisor = getSupervisor();
  const taskId = manifest.taskId;
  const scope = manifest.scope || "PROJECT";
  const effectiveModel = threadModel || process.env.MODEL_NAME || DEFAULT_PRIMARY_MODEL;
  (manifest as TaskManifest & { threadId?: string }).threadId = activeThreadId;
  let lastThinkingUpdate = 0;
  let lastRecordedLength = 0;

  const controller = new AbortController();
  supervisor.setAbortController(taskId, controller);

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
    signal: controller.signal,
    onThinkingChunk: (_chunk: string, totalThinking: string) => {
      if (
        !activeExecutionSet.has(taskId) ||
        supervisor.isPaused(taskId) ||
        manifest.status !== "active"
      ) {
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
          console.warn(`[threads/[id]] Failed to write in-flight thinking checkpoint:`, saveErr);
        }
      }
    },
  });

  (async () => {
    try {
      console.log(`[threads/[id]] executing task ${taskId} with recovery`);
      const result = await supervisor.executeTaskWithRecovery(manifest, {
        stepExecutor: executor,
        signal: controller.signal,
      });
      console.log(`[threads/[id]] task ${taskId} finished with status: ${result.status}`);

      if (result.status === "completed") {
        const currentThread = await getThreadStore().getThread(activeThreadId);
        if (currentThread) {
          const lastMilestone = result.milestones?.[result.milestones.length - 1];
          const targetFile = lastMilestone?.plannedFiles?.[0];
          let fileContent = "";

          if (targetFile) {
            const repoCandidates = [
              (result as TaskManifest & { worktreePath?: string }).worktreePath,
              process.env.WORKSPACE_DIR,
              "/workspace",
              process.cwd(),
              path.resolve(process.cwd(), ".."),
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
            timestamp: new Date().toISOString(),
            ...(result.completionStamp ? { completionStamp: result.completionStamp } : {}),
            ...(Array.isArray(result.verificationGaps)
              ? { verificationGaps: result.verificationGaps }
              : {}),
          });
          getThreadStore().saveThread(currentThread);
        }
      } else {
        const currentThread = await getThreadStore().getThread(activeThreadId);
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
                  .find((j) => typeof j?.message === "string" && j.message.trim().length > 0)
                  ?.message
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
          });
          getThreadStore().saveThread(currentThread);
        }
      }
    } catch (err: unknown) {
      const errReason = err instanceof Error ? err.message : String(err);
      console.error(`[threads/[id]] Task ${taskId} execution failed:`, errReason);
      try {
        supervisor.parkTask(manifest, `Execution failure: ${errReason}`);
      } catch {}
      try {
        const currentThread = await getThreadStore().getThread(activeThreadId);
        if (currentThread) {
          currentThread.status = "failed";
          currentThread.messages.push({
            id: `msg-${Date.now()}-err`,
            role: "assistant",
            content: `Task failed: ${errReason}`,
            taskId,
            timestamp: new Date().toISOString(),
          });
          getThreadStore().saveThread(currentThread);
        }
      } catch {}
    } finally {
      activeExecutionSet.delete(taskId);
    }
  })();
}

const HEAVY_TRACE_RESULT_THRESHOLD_CHARS = 512;

function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  for (const rawToken of header.split(",")) {
    const token = rawToken.trim();
    if (!token) continue;
    if (token === "*") return true;
    const normalized = token.replace(/^W\//i, "");
    if (normalized === etag || `"${normalized.replace(/^"|"$/g, "")}"` === etag) {
      return true;
    }
  }
  return false;
}

function stripHeavyTraceResults(thread: Thread): Thread {
  let anyChanged = false;
  const messages: ThreadMessage[] = (thread.messages || []).map((msg) => {
    if (!Array.isArray(msg.traces) || msg.traces.length === 0) return msg;
    let msgChanged = false;
    const nextTraces = msg.traces.map((trace) => {
      if (trace.result === undefined) return trace;
      let serializedLen = 0;
      if (typeof trace.result === "string") {
        serializedLen = trace.result.length;
      } else {
        try {
          serializedLen = JSON.stringify(trace.result)?.length ?? 0;
        } catch {
          serializedLen = HEAVY_TRACE_RESULT_THRESHOLD_CHARS + 1;
        }
      }
      if (serializedLen <= HEAVY_TRACE_RESULT_THRESHOLD_CHARS) {
        return trace;
      }
      msgChanged = true;
      const traceWithErr = trace as typeof trace & { isError?: boolean };
      const errSummary = extractTraceError(trace.result, traceWithErr.isError);
      const { result: _omitted, ...rest } = trace;
      return {
        ...rest,
        ...(errSummary && traceWithErr.isError === undefined ? { isError: true } : {}),
      } as typeof trace;
    });
    if (!msgChanged) return msg;
    anyChanged = true;
    return { ...msg, traces: nextTraces };
  });
  return anyChanged ? { ...thread, messages } : thread;
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const supervisor = getSupervisor();
    const { id } = await context.params;
    const url = new URL(req.url);
    const omitHeavyTraceResults = url.searchParams.get("omitHeavyTraceResults") === "1";

    const thread = await getThreadStore().getThread(id);
    if (!thread) {
      // CHAT-PRESENCE: a turn may have just started before the thread file lands.
      // Still answer 200 with the presence marker so a fresh watcher sees activity.
      const presence = getActiveTurn(id);
      if (presence) {
        return NextResponse.json({ thread: null, task: null, activeTurn: presence });
      }
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

    const activeTurn = getActiveTurn(id);
    const lastMsg = thread.messages[thread.messages.length - 1];
    const etagSource = [
      thread.updatedAt || "",
      String(thread.messages.length),
      thread.status || "",
      lastMsg?.id || "",
      String(lastMsg?.content?.length ?? 0),
      String(lastMsg?.traces?.length ?? 0),
      lastMsg?.status || "",
      activeTurn
        ? `${activeTurn.status}:${activeTurn.lastActivityAtMs ?? activeTurn.startedAt}`
        : "none",
      task ? `${task.status}:${task.updatedAt || ""}` : "none",
      omitHeavyTraceResults ? "compact" : "full",
    ].join("|");
    const etag = `"${crypto.createHash("sha1").update(etagSource).digest("hex").slice(0, 16)}"`;

    const responseHeaders = {
      ETag: etag,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    };

    if (matchesIfNoneMatch(req.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, { status: 304, headers: responseHeaders });
    }

    const responseThread = omitHeavyTraceResults ? stripHeavyTraceResults(thread) : thread;

    return NextResponse.json(
      { thread: responseThread, task, activeTurn },
      { headers: responseHeaders }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const supervisor = getSupervisor();
    const { id } = await context.params;
    const thread = await getThreadStore().getThread(id);
    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    const body = await req.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }

    // 1. Action: Stop / Cancel Run
    if (body.action === "stop" || body.action === "cancel") {
      clearTurnActive(thread.id);
      abortActiveTurn(thread.id);
      const updatedThread = (await getThreadStore().getThread(id)) || thread;
      if (updatedThread.taskId) {
        cancelTask(updatedThread.taskId);
        activeExecutionSet.delete(updatedThread.taskId);
        const task = await supervisor.resumeTaskFromCheckpoint(updatedThread.taskId);
        if (task) {
          supervisor.parkTask(task, "User stopped run");
        }
      }
      activeExecutionSet.delete(updatedThread.id);

      // Unload all models from LLM VRAM immediately
      await unloadAllModels();

      // Re-read immediately before mutating so concurrent writes during unloadAllModels are preserved.
      const freshThread = (await getThreadStore().getThread(id)) || updatedThread;
      freshThread.status = "stopped";

      // Mark the last assistant message as stopped
      for (let i = freshThread.messages.length - 1; i >= 0; i--) {
        if (freshThread.messages[i].role === "assistant") {
          freshThread.messages[i].isStopped = true;
          const existingContent = freshThread.messages[i].content || "";
          if (!existingContent.includes("*[Stopped by user]*")) {
            freshThread.messages[i].content = existingContent.trim()
              ? `${existingContent.trimEnd()}\n\n*[Stopped by user]*`
              : "*[Stopped by user]*";
          }
          if (!freshThread.messages[i].status || freshThread.messages[i].status === "streaming") {
            freshThread.messages[i].status = "incomplete";
          }
          break;
        }
      }

      getThreadStore().saveThread(freshThread);
      return NextResponse.json({ status: "stopped", thread: freshThread });
    }

    // 1b. Action: Pause Run
    if (body.action === "pause") {
      if (thread.taskId) {
        activeExecutionSet.delete(thread.taskId);
        const task = await supervisor.resumeTaskFromCheckpoint(thread.taskId);
        if (task) {
          supervisor.pauseTask(task, "User paused run");
          getSharedRunLedger().pauseRun(task.taskId);
          const freshThread = (await getThreadStore().getThread(id)) || thread;
          freshThread.status = "paused";
          getThreadStore().saveThread(freshThread);
          return NextResponse.json({ status: "paused", thread: freshThread, task });
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
            message: "Resumed run from last saved checkpoint. Completed milestones preserved.",
          });
          supervisor.saveCheckpoint(task);
          supervisor.resumeTask(task.taskId);
          activeExecutionSet.add(task.taskId);
          const freshThread = (await getThreadStore().getThread(id)) || thread;
          freshThread.status = "active";
          getThreadStore().saveThread(freshThread);

          const taskWithBudget = task as TaskManifest & { chunkBudget?: unknown };
          if (freshThread.chunkBudget !== undefined && taskWithBudget.chunkBudget === undefined) {
            taskWithBudget.chunkBudget = freshThread.chunkBudget;
          }
          launchTaskExecution(freshThread.id, task, freshThread.model);

          return NextResponse.json({ status: "running", thread: freshThread, task });
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
          const freshThread = (await getThreadStore().getThread(id)) || thread;
          freshThread.taskId = restarted.taskId;
          freshThread.status = "active";
          activeExecutionSet.add(restarted.taskId);
          getThreadStore().saveThread(freshThread);

          const restartedWithBudget = restarted as TaskManifest & { chunkBudget?: unknown };
          if (
            freshThread.chunkBudget !== undefined &&
            restartedWithBudget.chunkBudget === undefined
          ) {
            restartedWithBudget.chunkBudget = freshThread.chunkBudget;
          }
          launchTaskExecution(freshThread.id, restarted, freshThread.model);

          return NextResponse.json({ status: "running", thread: freshThread, task: restarted });
        }
      }
      return NextResponse.json({ error: "No task found to restart" }, { status: 400 });
    }

    // 2. Action: Rename Thread
    if (body.action === "rename" && body.title) {
      const freshThread = (await getThreadStore().getThread(id)) || thread;
      freshThread.title = body.title;
      getThreadStore().saveThread(freshThread);
      return NextResponse.json({ thread: freshThread });
    }

    // 3. Action: Add Message
    if (body.action === "addMessage" && body.message) {
      const updated = getThreadStore().addMessage(thread.id, body.message);
      return NextResponse.json({ thread: updated || thread });
    }

    // 4. Action: Restore Compaction
    if (body.action === "restoreCompaction") {
      const freshThread = (await getThreadStore().getThread(id)) || thread;
      getThreadStore().clearCompactionBoundary(freshThread);
      return NextResponse.json({ thread: freshThread });
    }

    // 5. Action: Toggle Host Access
    if (body.action === "setHostAccess") {
      const freshThread = (await getThreadStore().getThread(id)) || thread;
      freshThread.hostAccess = Boolean(body.hostAccess);
      getThreadStore().saveThread(freshThread);
      return NextResponse.json({ thread: freshThread });
    }

    // 6. Action: Set Model & Reasoning Effort
    if (body.action === "setModel") {
      if (typeof body.model === "string" && body.model.trim()) {
        thread.model = body.model.trim();
      }
      if (body.reasoningEffort !== undefined) {
        if (
          body.reasoningEffort === "low" ||
          body.reasoningEffort === "medium" ||
          body.reasoningEffort === "xhigh"
        ) {
          thread.reasoningEffort = body.reasoningEffort;
        } else {
          return NextResponse.json({ error: "Invalid reasoningEffort" }, { status: 400 });
        }
      }
      getThreadStore().saveThread(thread);
      return NextResponse.json({ thread });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const thread = await getThreadStore().getThread(id);
    if (thread?.taskId) {
      cancelTask(thread.taskId);
    }
    const ok = await getThreadStore().deleteThread(id);
    return NextResponse.json({ success: ok });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
