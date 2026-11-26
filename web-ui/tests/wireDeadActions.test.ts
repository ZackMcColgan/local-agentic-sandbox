import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { ThreadStore, Thread } from "../lib/threads/threadStore";
import { POST as postThreadAction } from "../app/api/threads/[id]/route";
import { POST as postThreadCompact } from "../app/api/threads/[id]/compact/route";
import { POST as postProjectTask } from "../app/api/projects/[id]/tasks/route";
import { registerProject, getProject, listProjectTasks } from "../lib/projects/projectStore";
import { runGit } from "../lib/projects/projectGit";
import {
  cancelActiveProjectTasks,
  setEngineRunningCheckOverride,
  setProjectTaskExecutorOverride,
  waitForProjectTask,
} from "../lib/projects/projectRunner";
import { listSchedules, resetGlobalScheduler } from "../lib/subagents/scheduler";
import { closeSharedRunLedger } from "../lib/ledger/runLedger";

describe("Rank 14 (U-F7): Wire dead actions & fix phantom running project tasks", () => {
  describe("1. Thread setModel persistence & 400 Unknown action", () => {
    let threadsDir: string;
    let origThreadsDir: string | undefined;

    beforeEach(() => {
      origThreadsDir = process.env.THREADS_DIR;
      threadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-dead-threads-"));
      process.env.THREADS_DIR = threadsDir;
    });

    afterEach(() => {
      if (origThreadsDir !== undefined) {
        process.env.THREADS_DIR = origThreadsDir;
      } else {
        delete process.env.THREADS_DIR;
      }
      try {
        fs.rmSync(threadsDir, { recursive: true, force: true });
      } catch {}
    });

    it("POST /api/threads/[id] with action='setModel' persists model & reasoningEffort", async () => {
      const store = new ThreadStore(threadsDir);
      const thread: Thread = {
        id: "thread-set-model-1",
        title: "Model Test Thread",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: "initial-model",
        reasoningEffort: "low",
        messages: [],
      };
      store.saveThread(thread);

      const req = new Request(`http://localhost/api/threads/${thread.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setModel",
          model: "updated-model-27b",
          reasoningEffort: "xhigh",
        }),
      });

      const res = await postThreadAction(req, { params: Promise.resolve({ id: thread.id }) });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.thread.model, "updated-model-27b");
      assert.equal(data.thread.reasoningEffort, "xhigh");

      // Reload from disk via fresh ThreadStore to confirm persistence
      const reloaded = await new ThreadStore(threadsDir).getThread(thread.id);
      assert.equal(reloaded?.model, "updated-model-27b");
      assert.equal(reloaded?.reasoningEffort, "xhigh");
    });

    it("POST /api/threads/[id] returns HTTP 400 Unknown action for unrecognized actions", async () => {
      const store = new ThreadStore(threadsDir);
      const thread: Thread = {
        id: "thread-unknown-action-1",
        title: "Unknown Action Thread",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: "initial-model",
        reasoningEffort: "medium",
        messages: [],
      };
      store.saveThread(thread);

      for (const payload of [{ action: "compact" }, { action: "bogusAction" }, {}]) {
        const req = new Request(`http://localhost/api/threads/${thread.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const res = await postThreadAction(req, { params: Promise.resolve({ id: thread.id }) });
        assert.equal(
          res.status,
          400,
          `Expected 400 for payload ${JSON.stringify(payload)}, got ${res.status}`
        );
        const body = await res.json();
        assert.equal(body.error, "Unknown action");
      }
    });
  });

  describe("2. ChatStream manual compaction targets /api/threads/[id]/compact", () => {
    let threadsDir: string;
    let origThreadsDir: string | undefined;

    beforeEach(() => {
      origThreadsDir = process.env.THREADS_DIR;
      threadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-dead-compact-"));
      process.env.THREADS_DIR = threadsDir;
    });

    afterEach(() => {
      if (origThreadsDir !== undefined) {
        process.env.THREADS_DIR = origThreadsDir;
      } else {
        delete process.env.THREADS_DIR;
      }
      try {
        fs.rmSync(threadsDir, { recursive: true, force: true });
      } catch {}
    });

    it("ChatStream.tsx handleManualCompact calls POST /api/threads/${encodeURIComponent(...)}/compact", () => {
      const chatStreamSrc = fs.readFileSync(
        path.resolve(__dirname, "../components/ChatStream.tsx"),
        "utf8"
      );
      const fnStart = chatStreamSrc.indexOf("const handleManualCompact = async () =>");
      assert.ok(fnStart >= 0, "ChatStream.tsx must define handleManualCompact");
      // #139: the fetch now lives in the shared runManualCompaction() verdict
      // path (used by both the ContextSheet button and the /compact composer
      // command). Inspect the shared path plus handleManualCompact itself.
      const sharedStart = chatStreamSrc.indexOf("const runManualCompaction = async");
      assert.ok(sharedStart >= 0, "ChatStream.tsx must define runManualCompaction");
      const fnEnd = chatStreamSrc.indexOf("const handleRestoreCompaction", sharedStart);
      assert.ok(fnEnd > fnStart);
      const fnBody = chatStreamSrc.slice(sharedStart, fnEnd);

      assert.ok(
        fnBody.includes("/api/threads/${encodeURIComponent(currentThreadId)}/compact"),
        "handleManualCompact must fetch /api/threads/${encodeURIComponent(currentThreadId)}/compact"
      );
      assert.ok(
        !fnBody.includes('action: "compact"'),
        "handleManualCompact must not send legacy { action: 'compact' } payload"
      );
    });

    it("POST /api/threads/[id]/compact returns thread.compaction and tokensAfter for UI update", async () => {
      const store = new ThreadStore(threadsDir);
      const filler = "Context payload for compaction verification. ".repeat(50);
      const thread: Thread = {
        id: "thread-compact-shape",
        title: "Compact Shape Thread",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: "default-model",
        reasoningEffort: "medium",
        messages: [
          { id: "m1", role: "user", content: "U1 " + filler, timestamp: "now" },
          { id: "m2", role: "assistant", content: "A1 " + filler, timestamp: "now" },
          { id: "m3", role: "user", content: "U2 " + filler, timestamp: "now" },
          { id: "m4", role: "assistant", content: "A2 " + filler, timestamp: "now" },
          { id: "m5", role: "user", content: "U3 recent", timestamp: "now" },
          { id: "m6", role: "assistant", content: "A3 recent", timestamp: "now" },
        ],
      };
      store.saveThread(thread);

      const req = new Request(`http://localhost/api/threads/${thread.id}/compact`, {
        method: "POST",
      });
      const res = await postThreadCompact(req, { params: Promise.resolve({ id: thread.id }) });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.noop, false);
      assert.ok(data.thread?.compaction, "Response must include thread.compaction");
      assert.equal(typeof data.tokensAfter, "number");
      assert.ok(data.tokensAfter < data.tokensBefore);
    });
  });

  describe("3. Project tasks route mode='now' background execution & mode='schedule'", () => {
    let tempDir: string;
    let testRepoDir: string;
    let workspaceDir: string;
    let origDbPath: string | undefined;
    let origWorkspaceDir: string | undefined;

    beforeEach(() => {
      origDbPath = process.env.RUN_LEDGER_DB_PATH;
      origWorkspaceDir = process.env.WORKSPACE_DIR;
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-dead-projects-"));
      process.env.RUN_LEDGER_DB_PATH = path.join(tempDir, "test-runs.db");
      workspaceDir = path.join(tempDir, "workspace");
      fs.mkdirSync(workspaceDir, { recursive: true });
      process.env.WORKSPACE_DIR = workspaceDir;
      resetGlobalScheduler();
      closeSharedRunLedger();

      testRepoDir = path.join(tempDir, "sample-repo");
      fs.mkdirSync(testRepoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "develop"], { cwd: testRepoDir });
      execFileSync("git", ["config", "user.email", "tester@test.com"], { cwd: testRepoDir });
      execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: testRepoDir });
      fs.writeFileSync(path.join(testRepoDir, "README.md"), "# Sample\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: testRepoDir });
      execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: testRepoDir });

      setEngineRunningCheckOverride(async () => true);
    });

    afterEach(async () => {
      cancelActiveProjectTasks("Test teardown");
      setProjectTaskExecutorOverride(null);
      setEngineRunningCheckOverride(null);
      resetGlobalScheduler();
      closeSharedRunLedger();
      if (origDbPath !== undefined) {
        process.env.RUN_LEDGER_DB_PATH = origDbPath;
      } else {
        delete process.env.RUN_LEDGER_DB_PATH;
      }
      if (origWorkspaceDir !== undefined) {
        process.env.WORKSPACE_DIR = origWorkspaceDir;
      } else {
        delete process.env.WORKSPACE_DIR;
      }
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    });

    it("POST /api/projects/[id]/tasks with mode='now' launches non-blocking background execution and settles task", async () => {
      const project = registerProject({
        name: "Async Runner Project",
        rootPath: testRepoDir,
        baseBranch: "develop",
      });

      let releaseExecutor!: () => void;
      const executorStarted = new Promise<void>((resolveStarted) => {
        setProjectTaskExecutorOverride(async (proj) => {
          resolveStarted();
          await new Promise<void>((resolveGate) => {
            releaseExecutor = resolveGate;
          });
          fs.writeFileSync(path.join(proj.root_path, "feature.ts"), "export const ok = true;\n");
          runGit(proj, ["add", "feature.ts"]);
          runGit(proj, ["commit", "-m", "feat: background task output"]);
        });
      });

      const req = new Request(`http://localhost/api/projects/${project.project_id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Build feature asynchronously", mode: "now" }),
      });

      const res = await postProjectTask(req, {
        params: Promise.resolve({ id: project.project_id }),
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.task.status, "running");

      // Background executor actually started asynchronously
      await executorStarted;
      releaseExecutor();

      const settled = await waitForProjectTask(data.task.task_id);
      assert.equal(settled?.status, "completed", "Background execution must settle task");
      const updatedProject = getProject(project.project_id);
      assert.equal(updatedProject?.active_task_id, null, "active_task_id must clear on settlement");
    });

    it("POST /api/projects/[id]/tasks with mode='now' settles failed background run instead of leaving phantom 'running' row", async () => {
      const project = registerProject({
        name: "Failing Async Project",
        rootPath: testRepoDir,
        baseBranch: "develop",
      });

      setProjectTaskExecutorOverride(async () => {
        throw new Error("Simulated worker failure");
      });

      const req = new Request(`http://localhost/api/projects/${project.project_id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Task that fails", mode: "now" }),
      });

      const res = await postProjectTask(req, {
        params: Promise.resolve({ id: project.project_id }),
      });
      assert.equal(res.status, 201);
      const data = await res.json();

      const settled = await waitForProjectTask(data.task.task_id);
      assert.equal(settled?.status, "failed", "Failed background task must settle as failed");
      assert.equal(
        getProject(project.project_id)?.active_task_id,
        null,
        "Failed background task must release active_task_id"
      );
    });

    it("POST /api/projects/[id]/tasks with mode='schedule' creates a schedule without checking out branch or locking active_task_id", async () => {
      const project = registerProject({
        name: "Scheduled Project",
        rootPath: testRepoDir,
        baseBranch: "develop",
      });

      const req = new Request(`http://localhost/api/projects/${project.project_id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Run nightly refactor",
          mode: "schedule",
          scheduleTime: "02:00",
        }),
      });

      const res = await postProjectTask(req, {
        params: Promise.resolve({ id: project.project_id }),
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.scheduled, true);
      assert.ok(data.scheduleId);
      assert.equal(data.cronExpression, "0 2 * * *");

      const schedules = await listSchedules({ workspaceDir });
      assert.equal(schedules.length, 1);
      assert.equal(schedules[0].cronExpression, "0 2 * * *");
      assert.ok(schedules[0].taskDescription.includes("Run nightly refactor"));

      // Must NOT check out feat/task-* branch, insert project_tasks row, or lock active_task_id
      const currentBranch = runGit(project, ["branch", "--show-current"]);
      assert.equal(currentBranch, "develop");
      assert.equal(listProjectTasks(project.project_id).length, 0);
      assert.equal(getProject(project.project_id)?.active_task_id, null);
    });
  });

  describe("4. ProjectsView.tsx res.ok error handling", () => {
    it("checks res.ok across all mutation fetches and surfaces errors in UI state", () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, "../components/ProjectsView.tsx"),
        "utf8"
      );

      for (const fnName of [
        "const handleAcceptFile",
        "const handleRevertFile",
        "const handleFinalizeReview",
        "const handleToggle",
      ]) {
        const start = src.indexOf(fnName);
        assert.ok(start >= 0, `${fnName} must exist in ProjectsView.tsx`);
        const snippet = src.slice(start, start + 900);
        assert.ok(
          snippet.includes("res.ok") || snippet.includes("if (!res.ok)"),
          `${fnName} must check res.ok on its fetch response`
        );
      }

      const submitStart = src.indexOf("onSubmitTask={async");
      assert.ok(submitStart >= 0, "onSubmitTask handler must exist in ProjectsView.tsx");
      const submitSnippet = src.slice(submitStart, submitStart + 1200);
      assert.ok(
        submitSnippet.includes("res.ok"),
        "onSubmitTask must check res.ok on POST /api/projects/:id/tasks"
      );
      assert.ok(
        submitSnippet.includes("setTaskError"),
        "onSubmitTask must surface failed responses via setTaskError"
      );
      assert.ok(
        src.includes("projectActionError") && src.includes("taskError"),
        "ProjectsView.tsx must track UI error state for project actions and task submission"
      );
    });
  });
});
