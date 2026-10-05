import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ThreadStore, Thread, activeExecutionSet } from "../lib/threads/threadStore";
import { ThreadsSidebar } from "../components/ThreadsSidebar";
import { ChatStream } from "../components/ChatStream";
import { OvernightSupervisor } from "../lib/subagents/supervisor";
import { TaskManifest } from "../lib/subagents/types";

describe("Sprint 1 — Session List Integrity Suite", () => {
  let tempDir: string;
  let supervisorTempDir: string;
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    tempDir = path.resolve(process.cwd(), `.tmp-sprint1-store-${Date.now()}`);
    supervisorTempDir = path.resolve(process.cwd(), `.tmp-sprint1-sup-${Date.now()}`);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    if (!fs.existsSync(supervisorTempDir)) fs.mkdirSync(supervisorTempDir, { recursive: true });

    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    win = new GlobalWindow({ url: "http://localhost:3000" });
    globalThis.window = win as any;
    globalThis.document = win.document as any;
    globalThis.localStorage = win.localStorage as any;

    const div = win.document.createElement("div");
    win.document.body.appendChild(div);
    container = div as unknown as HTMLDivElement;
  });

  afterEach(() => {
    if (root) {
      try {
        root.unmount();
      } catch {}
      root = null;
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    try {
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      if (fs.existsSync(supervisorTempDir)) fs.rmSync(supervisorTempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("S1 — Swipe-to-delete a session", () => {
    it("deletes a thread and removes it from disk and list", async () => {
      const store = new ThreadStore(tempDir);
      const thread = store.createThread({
        initialPrompt: "Test thread to delete"
      });
      assert.ok(fs.existsSync(store.getFilePath(thread.id)), "Thread file must exist before delete");

      const deleted = await store.deleteThread(thread.id);
      assert.equal(deleted, true, "deleteThread should return true");
      assert.equal(fs.existsSync(store.getFilePath(thread.id)), false, "Thread file must be unlinked from disk");

      const remaining = await store.listThreads();
      assert.equal(remaining.some((t) => t.id === thread.id), false, "Deleted thread must not appear in list");
    });

    it("deleting an active run halts execution first, then removes the thread", async () => {
      const supervisor = new OvernightSupervisor({ checkpointDirectory: supervisorTempDir });
      const store = new ThreadStore(tempDir, supervisor);

      const taskId = "task-active-deletion-test";
      const task: TaskManifest = {
        taskId,
        goal: "Active task about to be deleted",
        toolchain: "node:22",
        branch: "feat/test",
        branchName: "feat/test",
        status: "active",
        currentMilestoneIndex: 0,
        milestones: [],
        journal: [],
        checkpoints: [],
        ambiguityFlags: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      supervisor.saveCheckpoint(task);

      const thread = store.createThread({
        initialPrompt: "Active task to delete",
        taskId
      });
      thread.status = "active";
      store.saveThread(thread);

      activeExecutionSet.add(taskId);
      activeExecutionSet.add(thread.id);

      assert.ok(activeExecutionSet.has(taskId), "Task should be in active execution set");

      // Now delete thread
      const deleted = await store.deleteThread(thread.id);
      assert.equal(deleted, true);

      // Verify active execution set was cleaned
      assert.equal(activeExecutionSet.has(taskId), false, "Task execution must be halted from activeExecutionSet");
      assert.equal(activeExecutionSet.has(thread.id), false, "Thread execution must be halted from activeExecutionSet");

      // Verify task status was updated to cancelled/stopped in checkpoint
      const resumed = await supervisor.resumeTaskFromCheckpoint(taskId);
      assert.ok(resumed);
      assert.equal(resumed?.status, "cancelled", "Checkpoint must record cancelled status upon deletion");
      assert.equal(fs.existsSync(store.getFilePath(thread.id)), false, "Thread file must be deleted");
    });

    it("threads list renders zero ⋮ buttons on session rows", () => {
      const threads: Thread[] = [
        {
          id: "t1",
          title: "Session Alpha",
          status: "completed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          model: "qwen3.8",
          reasoningEffort: "medium",
          messages: []
        },
        {
          id: "t2",
          title: "Session Beta",
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          model: "qwen3.8",
          reasoningEffort: "medium",
          messages: []
        }
      ];

      root = createRoot(container);
      act(() => {
        root!.render(
          React.createElement(ThreadsSidebar, {
            threads,
            selectedThreadId: "t1",
            onSelectThread: () => {},
            onNewThread: () => {},
            onDeleteThread: () => {}
          })
        );
      });

      const buttons = container.querySelectorAll("button");
      // Check that no button in the row represents a per-row vertical dots menu (⋮ / MoreVertical)
      const moreVerticalButtons = Array.from(buttons).filter((b) =>
        b.getAttribute("title")?.toLowerCase().includes("options") ||
        b.innerHTML.includes("lucide-more-vertical")
      );
      assert.equal(moreVerticalButtons.length, 0, "There must be zero per-row ⋮ buttons in the threads list");
    });

    it("thread-view overflow menu provides a delete session action", () => {
      let deleteCalled = false;
      root = createRoot(container);
      act(() => {
        root!.render(
          React.createElement(ChatStream, {
            messages: [],
            onSendMessage: async () => {},
            threadTitle: "Critic approval logic",
            onDeleteThread: () => {
              deleteCalled = true;
            },
            onTracesUpdate: () => {},
            activeModel: "swift-27b-mtp",
            reasoningEffort: "medium"
          })
        );
      });

      // Find overflow menu button (MoreHorizontal)
      const moreBtn = container.querySelector("header button[title='More options']") as HTMLButtonElement;
      assert.ok(moreBtn, "Header must have overflow options button");

      act(() => {
        moreBtn.click();
      });

      // Find 'Delete session' button in overflow menu
      const deleteBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.toLowerCase().includes("delete session") ||
        b.textContent?.toLowerCase().includes("delete thread")
      );
      assert.ok(deleteBtn, "Overflow menu must provide a Delete session action");

      act(() => {
        (deleteBtn as HTMLButtonElement).click();
      });

      assert.equal(deleteCalled, true, "Clicking delete action must trigger onDeleteThread");
    });
  });

  describe("S2 — Honest status on every read", () => {
    it("reconciles phantom active status to stopped on read and corrects persisted file", async () => {
      const store = new ThreadStore(tempDir);
      const thread = store.createThread({
        initialPrompt: "Task interrupted by system crash",
        taskId: "task-phantom-read-test"
      });
      thread.status = "active";
      store.saveThread(thread);

      // Neither thread.id nor task-phantom-read-test is in activeExecutionSet
      activeExecutionSet.delete(thread.id);
      activeExecutionSet.delete("task-phantom-read-test");

      // Read thread via getThread
      const retrieved = await store.getThread(thread.id);
      assert.ok(retrieved);
      assert.equal(retrieved?.status, "stopped", "Phantom active must read as 'stopped'");

      // Verify the persisted file on disk was also updated to stopped
      const rawOnDisk = JSON.parse(fs.readFileSync(store.getFilePath(thread.id), "utf8"));
      assert.equal(rawOnDisk.status, "stopped", "Persisted file on disk must be corrected to 'stopped'");

      // Read via listThreads
      const all = await store.listThreads();
      const inList = all.find((t) => t.id === thread.id);
      assert.equal(inList?.status, "stopped", "listThreads must also report 'stopped'");
    });

    it("preserves active status when task is genuinely active in activeExecutionSet", async () => {
      const store = new ThreadStore(tempDir);
      const thread = store.createThread({
        initialPrompt: "Genuinely running task",
        taskId: "task-genuine-active"
      });
      thread.status = "active";
      store.saveThread(thread);

      activeExecutionSet.add("task-genuine-active");

      const retrieved = await store.getThread(thread.id);
      assert.equal(retrieved?.status, "active", "Genuinely active task must remain 'active'");

      activeExecutionSet.delete("task-genuine-active");
    });
  });

  describe("S3 — Verification cleanup", () => {
    it("marks test sessions and provides cleanup leaving zero phantom sessions in production list", async () => {
      const store = new ThreadStore(tempDir);

      // Create a test session
      const testThread = store.createThread({
        initialPrompt: "Automated test probe",
        isTest: true
      });
      assert.equal(testThread.isTest, true, "Thread must be marked as test session");

      // Run cleanup
      await store.cleanupTestSessions();

      const remaining = await store.listThreads();
      assert.equal(
        remaining.some((t) => t.id === testThread.id),
        false,
        "Test sessions must be cleaned up and not remain in the list"
      );
    });
  });

  describe("S4 — Titles from content", () => {
    it("sets title to 'New thread' when truly empty", () => {
      const store = new ThreadStore(tempDir);
      const thread = store.createThread({});
      assert.equal(thread.title, "New thread", "Empty thread must have title 'New thread'");
    });

    it("derives title from first ~40 characters of first user message", () => {
      const store = new ThreadStore(tempDir);
      const longPrompt = "How does the critic handle crashes in workerPool when model is unreachable?";
      const thread = store.createThread({
        initialPrompt: longPrompt
      });
      assert.equal(
        thread.title,
        longPrompt.slice(0, 40),
        "Title must be derived from first ~40 chars of first user message"
      );
    });

    it("retroactively titles an existing 'New thread' upon receiving first user message or upon read", async () => {
      const store = new ThreadStore(tempDir);
      const thread = store.createThread({});
      assert.equal(thread.title, "New thread");

      // User later sends a message
      thread.messages.push({
        id: "msg-1",
        role: "user",
        content: "What is the status of the OTEL waterfall spans?",
        timestamp: new Date().toISOString()
      });
      store.saveThread(thread);

      // On read, store retroactively assigns title
      const reloaded = await store.getThread(thread.id);
      assert.ok(reloaded);
      assert.equal(
        reloaded?.title,
        "What is the status of the OTEL waterfall",
        "Thread with 'New thread' title must be retroactively updated from first user message"
      );

      // Verify persisted on disk
      const rawOnDisk = JSON.parse(fs.readFileSync(store.getFilePath(thread.id), "utf8"));
      assert.equal(rawOnDisk.title, "What is the status of the OTEL waterfall");
    });
  });
});
