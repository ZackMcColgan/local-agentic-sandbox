import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ThreadStore,
  registerTurnAbortController,
  markTurnActive,
  getActiveTurn,
  resolveThreadsDir
} from "../lib/threads/threadStore";
import { OvernightSupervisor } from "../lib/subagents/supervisor";
import { TaskManifest } from "../lib/subagents/types";

describe("PART B — Thread Deletion Backend Invariants", () => {
  let tmpDir: string;
  let store: ThreadStore;
  let supervisor: OvernightSupervisor;
  const originalThreadsDir = process.env.THREADS_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-delete-test-"));
    process.env.THREADS_DIR = tmpDir;
    store = new ThreadStore(tmpDir);
    supervisor = new OvernightSupervisor();
  });

  afterEach(() => {
    process.env.THREADS_DIR = originalThreadsDir;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("1. deleteThread removes record JSON, <threadId>/ subdirectory recursively, and .steer.json sidecar (nothing else changes)", async () => {
    const threadId = "thread-del-cleanup-1";
    const thread = store.createThread({ id: threadId, title: "Cleanup Target" });

    // Create thread files subdirectory with subfiles
    const subDir = path.join(tmpDir, threadId, "files");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, "artifact.md"), "# Artifact Content", "utf8");
    fs.writeFileSync(path.join(subDir, "output.txt"), "Output text", "utf8");

    // Create steer sidecar
    const steerFile = path.join(tmpDir, `${threadId}.steer.json`);
    fs.writeFileSync(steerFile, JSON.stringify(["steer 1"]), "utf8");

    // Create sibling thread that must NOT be touched
    const siblingId = "thread-sibling-stay";
    store.createThread({ id: siblingId, title: "Sibling Thread" });
    const siblingSubDir = path.join(tmpDir, siblingId, "files");
    fs.mkdirSync(siblingSubDir, { recursive: true });
    fs.writeFileSync(path.join(siblingSubDir, "stay.txt"), "Preserved", "utf8");

    // Execute delete
    const result = await store.deleteThread(threadId);
    assert.strictEqual(result, true, "deleteThread should return true for existing thread");

    // Assert target artifacts deleted
    assert.strictEqual(fs.existsSync(path.join(tmpDir, `${threadId}.json`)), false, "Thread JSON must be removed");
    assert.strictEqual(fs.existsSync(path.join(tmpDir, threadId)), false, "Thread subdirectory must be removed recursively");
    assert.strictEqual(fs.existsSync(steerFile), false, "Steer sidecar file must be removed");

    // Assert sibling artifacts preserved
    assert.strictEqual(fs.existsSync(path.join(tmpDir, `${siblingId}.json`)), true, "Sibling thread JSON must remain");
    assert.strictEqual(fs.existsSync(path.join(siblingSubDir, "stay.txt")), true, "Sibling subfile must remain");
  });

  it("2. Deleting a thread with an actively streaming turn aborts the turn first and prevents resurrection on would-be late persist", async () => {
    const threadId = "thread-streaming-abort-2";
    const thread = store.createThread({ id: threadId, title: "Streaming Target" });

    // Register active turn abort controller and presence
    const controller = new AbortController();
    registerTurnAbortController(threadId, controller);
    markTurnActive(threadId);

    assert.strictEqual(controller.signal.aborted, false, "Controller should not be aborted before delete");
    assert.ok(getActiveTurn(threadId), "Active turn should be present before delete");

    // Delete thread while turn is live
    const result = await store.deleteThread(threadId);
    assert.strictEqual(result, true);

    // Turn must be aborted and active presence cleared
    assert.strictEqual(controller.signal.aborted, true, "Streaming turn abort controller must be triggered");
    assert.strictEqual(getActiveTurn(threadId), null, "Active turn presence must be cleared");
    assert.strictEqual(fs.existsSync(path.join(tmpDir, `${threadId}.json`)), false, "Thread file must be gone");

    // Late persist attempt from severed streaming turn
    store.addMessage(threadId, {
      id: "msg-late-assistant",
      role: "assistant",
      content: "Late completion text that should not resurrect thread",
      timestamp: new Date().toISOString()
    });

    store.saveThread({
      ...thread,
      messages: [
        {
          id: "msg-resurrect",
          role: "assistant",
          content: "Resurrect attempt",
          timestamp: new Date().toISOString()
        }
      ]
    });

    // Record MUST STILL BE ABSENT after would-be final persist
    assert.strictEqual(fs.existsSync(path.join(tmpDir, `${threadId}.json`)), false, "Thread must NOT resurrect from late message/save");
    const retrieved = await store.getThread(threadId);
    assert.strictEqual(retrieved, null, "getThread must return null for deleted thread even after late persist attempt");
  });

  it("3. Deleting a checkpoint-synthesized ghost thread removes its checkpoint manifest so it never resurrects", async () => {
    const taskId = "task-ghost-sample-123";
    const ghostThreadId = `thread-${taskId}`;

    const manifest: TaskManifest = {
      taskId,
      goal: "Analyze legacy code",
      scope: "PROJECT",
      status: "active",
      milestones: [],
      journal: [],
      toolchain: "readonly",
      allowedWorkspaces: [],
      startedAt: new Date().toISOString()
    };

    supervisor.saveCheckpoint(manifest);
    const checkpointFile = supervisor.getCheckpointFilePath(taskId);
    assert.strictEqual(fs.existsSync(checkpointFile), true, "Checkpoint file must exist initially");

    // listThreads synthesizes ghost thread
    const initialList = await store.listThreads();
    const ghost = initialList.find((t) => t.id === ghostThreadId || t.taskId === taskId);
    assert.ok(ghost, "Ghost thread must be synthesized in listThreads");

    // Delete ghost thread
    const result = await store.deleteThread(ghostThreadId);
    assert.strictEqual(result, true, "deleteThread should succeed on ghost thread");

    // Checkpoint manifest MUST be removed from disk
    assert.strictEqual(fs.existsSync(checkpointFile), false, "Checkpoint manifest file must be removed for ghost thread");

    // Subsequent listThreads must NOT resurrect the ghost thread
    const refreshedList = await store.listThreads();
    const resurrected = refreshedList.find((t) => t.id === ghostThreadId || t.taskId === taskId);
    assert.strictEqual(resurrected, undefined, "Ghost thread must never resurrect after deletion");
  });

  it("4. Guard: deleting a REAL thread with a taskId retains checkpoint manifest and cancels the task", async () => {
    const realThreadId = "thread-1794249000-real";
    const taskId = "task-real-worker-999";

    const manifest: TaskManifest = {
      taskId,
      goal: "Compile distribution",
      scope: "PROJECT",
      status: "active",
      milestones: [],
      journal: [],
      toolchain: "readonly",
      allowedWorkspaces: [],
      startedAt: new Date().toISOString()
    };

    supervisor.saveCheckpoint(manifest);
    const checkpointFile = supervisor.getCheckpointFilePath(taskId);
    assert.strictEqual(fs.existsSync(checkpointFile), true);

    // Create real thread with taskId
    store.createThread({
      id: realThreadId,
      title: "Real Run Thread",
      taskId
    });
    assert.strictEqual(fs.existsSync(path.join(tmpDir, `${realThreadId}.json`)), true);

    // Delete real thread
    const result = await store.deleteThread(realThreadId);
    assert.strictEqual(result, true);

    // Thread file deleted
    assert.strictEqual(fs.existsSync(path.join(tmpDir, `${realThreadId}.json`)), false);

    // Checkpoint manifest file MUST BE RETAINED for real thread, with status cancelled
    assert.strictEqual(fs.existsSync(checkpointFile), true, "Checkpoint manifest must be retained for real thread with taskId");
    const updatedManifest: TaskManifest = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
    assert.strictEqual(updatedManifest.status, "cancelled", "Retained checkpoint status must be set to cancelled");
  });
});
