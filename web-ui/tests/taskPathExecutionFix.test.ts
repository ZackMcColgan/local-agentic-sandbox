import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { OvernightSupervisor } from "../lib/subagents/supervisor";
import { WorkerGitOps } from "../lib/git/workerGitOps";
import { generatePlanSpec } from "../lib/subagents/planner";
import { LlamaCppProvider } from "../lib/llm/provider";
import { ThreadStore } from "../lib/threads/threadStore";
import { DEFAULT_PRIMARY_MODEL } from "../config/models";
import type { TaskManifest } from "../lib/subagents/types";
import { POST as threadsPost } from "../app/api/threads/route";
import { POST as threadByIdPost } from "../app/api/threads/[id]/route";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initTempGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "develop"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "retryAfter.mjs"), "export const retryAfter = 1000;\n", "utf8");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "temp-repo",
        version: "1.0.0",
        scripts: { "test:gate": 'node -e "process.exit(0)"' },
      },
      null,
      2
    ),
    "utf8"
  );
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "pipe" });
  // Add an unreachable origin remote to simulate zero port-443 egress in web-ui pod
  execFileSync("git", ["remote", "add", "origin", "https://127.0.0.1:1/unreachable.git"], {
    cwd: dir,
    stdio: "pipe",
  });
}

describe("ITEM-2: Task-Path Functional Fix & Unified Execution Contract", () => {
  it("1. launchTask creates isolated worktree/branch without outbound egress even when shared workspace is dirty", async () => {
    const dirtyRepo = makeTempDir("item2-dirty-ws-");
    const threadsDir = makeTempDir("item2-threads-");
    const checkpointsDir = makeTempDir("item2-ckpt-");
    const origWorkspaceDir = process.env.WORKSPACE_DIR;
    const origThreadsDir = process.env.THREADS_DIR;
    const origCheckpointsDir = process.env.CHECKPOINTS_DIR;
    const origFetch = globalThis.fetch;
    const origRunGateTest = WorkerGitOps.prototype.runGateTest;

    try {
      WorkerGitOps.prototype.runGateTest = async () => ({
        exitCode: 0,
        stdout: "stubbed test:gate ok",
        stderr: "",
        passed: true,
      });
      initTempGitRepo(dirtyRepo);
      // Make shared /workspace durably dirty like prod (M retryAfter.mjs + untracked file)
      fs.writeFileSync(
        path.join(dirtyRepo, "retryAfter.mjs"),
        "export const retryAfter = 9999;\n// dirty\n",
        "utf8"
      );
      fs.writeFileSync(path.join(dirtyRepo, "stray-untracked.txt"), "leftover\n", "utf8");

      process.env.WORKSPACE_DIR = dirtyRepo;
      process.env.THREADS_DIR = threadsDir;
      process.env.CHECKPOINTS_DIR = checkpointsDir;
      const store = new ThreadStore(threadsDir);

      // Mock LLM fetch so builder produces diag-hello.js and critic approves without real LLM
      globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const reqBody = String(init?.body || "");
        const isCritic = /critic|evaluate|verdict|approve/i.test(reqBody);
        const text = isCritic
          ? JSON.stringify({ approved: true, verdict: "PASS", score: 100, feedback: [] })
          : '```javascript\nconsole.log("diag-hello");\n```\n';
        const body = JSON.stringify({
          response: text,
          done: true,
        });
        return new Response(body + "\n", {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }) as typeof fetch;

      const req = new Request("http://localhost:3000/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "launchTask",
          goal: "Create diag-hello.js",
          scope: "SNIPPET",
          enableGitOps: true,
          toolchain: "node:22",
        }),
      });

      const res = await threadsPost(req);
      assert.equal(res.status, 201);
      const data = await res.json();
      const taskId = data.taskId || data.task?.taskId || data.thread?.taskId;
      const threadId = data.thread?.id || data.id;
      assert.ok(taskId, "launchTask must return taskId");
      assert.ok(threadId, "launchTask must return thread.id");

      // Wait for async task execution to reach terminal state
      let finalThread = await store.getThread(threadId);
      const deadline = Date.now() + 8000;
      while (finalThread && finalThread.status === "active" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        finalThread = await store.getThread(threadId);
      }

      assert.equal(
        finalThread?.status,
        "completed",
        `Expected completed status despite dirty workspace & unreachable origin, got ${finalThread?.status}: ${finalThread?.messages?.at(-1)?.content}`
      );

      // Verify shared dirtyRepo remained untouched on develop with its dirty retryAfter.mjs
      const mainBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: dirtyRepo,
        encoding: "utf8",
      }).trim();
      assert.equal(mainBranch, "develop");
      assert.ok(fs.readFileSync(path.join(dirtyRepo, "retryAfter.mjs"), "utf8").includes("9999"));

      // Verify isolated worktree was created and holds diag-hello.js
      const worktreeDir = path.join(dirtyRepo, ".worktrees", taskId);
      assert.ok(fs.existsSync(worktreeDir), `Expected isolated worktree at ${worktreeDir}`);
      assert.ok(
        fs.existsSync(path.join(worktreeDir, "diag-hello.js")),
        "Deliverable must exist in isolated worktree"
      );
    } finally {
      WorkerGitOps.prototype.runGateTest = origRunGateTest;
      globalThis.fetch = origFetch;
      if (origWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
      else process.env.WORKSPACE_DIR = origWorkspaceDir;
      if (origThreadsDir === undefined) delete process.env.THREADS_DIR;
      else process.env.THREADS_DIR = origThreadsDir;
      if (origCheckpointsDir === undefined) delete process.env.CHECKPOINTS_DIR;
      else process.env.CHECKPOINTS_DIR = origCheckpointsDir;
      fs.rmSync(dirtyRepo, { recursive: true, force: true });
      fs.rmSync(threadsDir, { recursive: true, force: true });
      fs.rmSync(checkpointsDir, { recursive: true, force: true });
    }
  });

  it("2. Resume in threads/[id]/route.ts uses thread.model || DEFAULT_PRIMARY_MODEL (never hardcoded swift-15-27b-mtp)", async () => {
    const threadsDir = makeTempDir("item2-resume-threads-");
    const checkpointsDir = makeTempDir("item2-resume-ckpt-");
    const repoDir = makeTempDir("item2-resume-repo-");
    const origThreadsDir = process.env.THREADS_DIR;
    const origCheckpointsDir = process.env.CHECKPOINTS_DIR;
    const origWorkspaceDir = process.env.WORKSPACE_DIR;
    const origFastGraph = process.env.FAST_GRAPH_TEST;
    const origForceMock = process.env.FORCE_MOCK;
    const origFetch = globalThis.fetch;

    try {
      initTempGitRepo(repoDir);
      process.env.THREADS_DIR = threadsDir;
      process.env.CHECKPOINTS_DIR = checkpointsDir;
      process.env.WORKSPACE_DIR = repoDir;
      delete process.env.FAST_GRAPH_TEST;
      delete process.env.FORCE_MOCK;

      const capturedModels: string[] = [];
      globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        try {
          const parsed = JSON.parse(String(init?.body || "{}"));
          if (parsed.model) capturedModels.push(parsed.model);
        } catch {}
        const body = JSON.stringify({
          response: '```javascript\nconsole.log("resumed");\n```\n',
          done: true,
        });
        return new Response(body + "\n", {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }) as typeof fetch;

      const store = new ThreadStore(threadsDir);
      const supervisor = new OvernightSupervisor();
      const taskId = `task-resume-model-${Date.now()}`;
      const manifest: TaskManifest = {
        taskId,
        goal: "Resume model verification",
        branchName: "feat/resume-model",
        toolchain: "node:22",
        status: "paused",
        enableGitOps: false,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentMilestoneIndex: 0,
        milestones: [
          {
            id: "M1",
            title: "Create resumed.js",
            description: "Write resumed.js",
            status: "pending",
            builderIterations: 0,
            criticRounds: 0,
            plannedFiles: ["resumed.js"],
            skipCriticOnValidSyntax: true,
            acceptanceCriteria: [{ id: "AC-1", assertion: "exists", fileMatch: "resumed.js" }],
          },
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
      };
      supervisor.saveCheckpoint(manifest);

      const expectedModel = "qwen3.8-flash-custom-resume";
      const thread = store.createThread({
        title: "Resume model test",
        model: expectedModel,
        taskId,
      });

      const req = new Request(`http://localhost:3000/api/threads/${thread.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume" }),
      });

      const res = await threadByIdPost(req, { params: Promise.resolve({ id: thread.id }) });
      assert.equal(res.status, 200);

      const deadline = Date.now() + 10000;
      while (capturedModels.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(capturedModels.length > 0, "Resumed turn must invoke WorkerPool.generate");
      assert.equal(
        capturedModels[0],
        expectedModel,
        `Expected resumed turn to use thread.model (${expectedModel}), got ${capturedModels[0]}`
      );
      assert.notEqual(capturedModels[0], "swift-15-27b-mtp");
    } finally {
      globalThis.fetch = origFetch;
      if (origFastGraph === undefined) delete process.env.FAST_GRAPH_TEST;
      else process.env.FAST_GRAPH_TEST = origFastGraph;
      if (origForceMock === undefined) delete process.env.FORCE_MOCK;
      else process.env.FORCE_MOCK = origForceMock;
      if (origThreadsDir === undefined) delete process.env.THREADS_DIR;
      else process.env.THREADS_DIR = origThreadsDir;
      if (origCheckpointsDir === undefined) delete process.env.CHECKPOINTS_DIR;
      else process.env.CHECKPOINTS_DIR = origCheckpointsDir;
      if (origWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
      else process.env.WORKSPACE_DIR = origWorkspaceDir;
      fs.rmSync(threadsDir, { recursive: true, force: true });
      fs.rmSync(checkpointsDir, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("3. generatePlanSpec rejects invalid/empty planner output cleanly at planning stage", async () => {
    // Case A: empty milestones
    await assert.rejects(async () => {
      await generatePlanSpec({
        taskId: "plan-empty",
        goal: "Build a utility",
        scope: "SCRIPT",
        generate: async () => ({
          text: JSON.stringify({ milestones: [] }),
          model: DEFAULT_PRIMARY_MODEL,
        }),
      });
    }, /milestone/i);

    // Case B: invalid relative plannedFiles (path traversal / absolute path)
    await assert.rejects(async () => {
      await generatePlanSpec({
        taskId: "plan-bad-files",
        goal: "Build a utility",
        scope: "SCRIPT",
        generate: async () => ({
          text: JSON.stringify({
            milestones: [
              {
                id: "M1",
                title: "Bad paths",
                description: "Bad",
                plannedFiles: ["../outside.ts"],
                acceptanceCriteria: [
                  { id: "AC-1", assertion: "ok", command: "node -e 'process.exit(0)'" },
                ],
              },
            ],
          }),
          model: DEFAULT_PRIMARY_MODEL,
        }),
      });
    }, /plannedFiles|relative|path/i);

    // Case C: missing executable acceptanceCriteria
    await assert.rejects(async () => {
      await generatePlanSpec({
        taskId: "plan-no-ac",
        goal: "Build a utility",
        scope: "SCRIPT",
        generate: async () => ({
          text: JSON.stringify({
            milestones: [
              {
                id: "M1",
                title: "No AC",
                description: "No AC",
                plannedFiles: ["src/app.ts"],
                acceptanceCriteria: [],
              },
            ],
          }),
          model: DEFAULT_PRIMARY_MODEL,
        }),
      });
    }, /acceptanceCriteria/i);
  });

  it("4. chunkBudget: { maxRounds: 2 } pauses with chunk-complete, banks commit + runlog + .handoff.json, and auto-resumes via /api/threads/[id]", async () => {
    const repoDir = makeTempDir("item2-chunk-repo-");
    const ckptDir = makeTempDir("item2-chunk-ckpt-");
    const origFetch = globalThis.fetch;
    const resumeCalls: Array<{ url: string; body?: { action?: string } }> = [];

    try {
      initTempGitRepo(repoDir);
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        resumeCalls.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify({ status: "running" }), { status: 200 });
      }) as typeof fetch;

      const supervisor = new OvernightSupervisor({ checkpointDirectory: ckptDir });
      const taskId = `task-chunk-${Date.now()}`;
      const threadId = `thread-chunk-${Date.now()}`;
      const task: TaskManifest = {
        taskId,
        goal: "Chunked 3-milestone job",
        branchName: "feat/chunk-test",
        toolchain: "node:22",
        status: "active",
        enableGitOps: false,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentMilestoneIndex: 0,
        milestones: [
          {
            id: "M1",
            title: "Step 1",
            description: "s1",
            status: "pending",
            builderIterations: 0,
            criticRounds: 0,
            plannedFiles: ["f1.txt"],
            acceptanceCriteria: [],
          },
          {
            id: "M2",
            title: "Step 2",
            description: "s2",
            status: "pending",
            builderIterations: 0,
            criticRounds: 0,
            plannedFiles: ["f2.txt"],
            acceptanceCriteria: [],
          },
          {
            id: "M3",
            title: "Step 3",
            description: "s3",
            status: "pending",
            builderIterations: 0,
            criticRounds: 0,
            plannedFiles: ["f3.txt"],
            acceptanceCriteria: [],
          },
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
      };
      const extTask = task as TaskManifest & {
        threadId?: string;
        chunkBudget?: { maxRounds: number };
      };
      extTask.threadId = threadId;
      extTask.chunkBudget = { maxRounds: 2 };

      const result = await supervisor.executeTaskWithRecovery(task, {
        repoRoot: repoDir,
        stepExecutor: async (milestone) => {
          const fname = milestone.plannedFiles![0];
          fs.writeFileSync(path.join(repoDir, fname), `content for ${milestone.id}\n`, "utf8");
          return {
            status: "completed",
            targetFile: fname,
            modifiedFiles: [fname],
          };
        },
      });

      assert.equal(
        result.status,
        "paused",
        `Expected task to pause at chunk boundary, got ${result.status}`
      );
      assert.equal(
        result.currentMilestoneIndex,
        2,
        "Should have completed 2 milestones before chunk pause"
      );

      // Check .handoff.json
      const handoffPath = path.join(ckptDir, `${taskId}.handoff.json`);
      assert.ok(fs.existsSync(handoffPath), "Expected .handoff.json to be written");
      const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
      assert.equal(handoff.chunkComplete, true);

      // Check runlog
      const runlogPath = path.join(ckptDir, `${taskId}-runlog.md`);
      assert.ok(fs.existsSync(runlogPath), "Expected runlog to be written");

      // Check git commit was banked in repoDir
      const logOut = execFileSync("git", ["log", "-n", "1", "--pretty=%s"], {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();
      assert.ok(
        logOut.length > 0 && !logOut.includes("initial commit"),
        `Expected banked chunk commit, got: ${logOut}`
      );

      // Check auto-resume targeted /api/threads/[id] with action: "resume"
      assert.ok(
        resumeCalls.some(
          (c) => c.url.includes(`/api/threads/${threadId}`) && c.body?.action === "resume"
        ),
        `Expected auto-resume POST to /api/threads/${threadId}, got: ${JSON.stringify(resumeCalls)}`
      );
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(ckptDir, { recursive: true, force: true });
    }
  });

  it("5. LlamaCppProvider.generate() forwards reasoning_effort to the engine call", async () => {
    const provider = new LlamaCppProvider("strata");
    const capturedBodies: Array<{ reasoning_effort?: string }> = [];

    const mockFetch: typeof fetch = async (_url, init) => {
      capturedBodies.push(JSON.parse(String(init?.body || "{}")));
      const sse =
        'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const res = await provider.generate(
      {
        model: DEFAULT_PRIMARY_MODEL,
        prompt: "Reply hello",
        reasoningEffort: "low",
      },
      "http://127.0.0.1:8080",
      { fetchImpl: mockFetch }
    );

    const capturedBody = capturedBodies[0];
    assert.equal(res.text, "hello");
    assert.ok(capturedBody, "Expected fetchImpl to receive request body");
    assert.equal(
      capturedBody.reasoning_effort,
      "low",
      `Expected requestBody.reasoning_effort to be 'low', got ${capturedBody.reasoning_effort}`
    );
  });
});
