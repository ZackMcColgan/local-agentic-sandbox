import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  initProjectStore,
  registerProject,
  toggleAllowlist,
  getProject,
  getProjectTask,
  listProjectTasks
} from "../lib/projects/projectStore";
import { runGit } from "../lib/projects/projectGit";
import {
  startProjectTask,
  cancelActiveProjectTasks,
  setEngineRunningCheckOverride
} from "../lib/projects/projectRunner";
import { POST as postTask } from "../app/api/projects/[id]/tasks/route";
import { POST as postEngine } from "../app/api/engine/route";
import { closeSharedRunLedger } from "../lib/ledger/runLedger";
import { DEFAULT_PRIMARY_MODEL } from "../config/models";

describe("PHASE 2: Project Task Object, Engine Gate & Overnight Runner", () => {
  let tempDir: string;
  let testRepoDir: string;
  let origDbPath: string | undefined;

  beforeEach(() => {
    origDbPath = process.env.RUN_LEDGER_DB_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-runner-test-"));
    process.env.RUN_LEDGER_DB_PATH = path.join(tempDir, "test-runner-runs.db");
    closeSharedRunLedger();

    testRepoDir = path.join(tempDir, "sample-repo");
    fs.mkdirSync(testRepoDir, { recursive: true });

    // Initialize clean git repo on 'develop'
    execFileSync("git", ["init", "-b", "develop"], { cwd: testRepoDir });
    execFileSync("git", ["config", "user.email", "tester@test.com"], { cwd: testRepoDir });
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: testRepoDir });

    fs.writeFileSync(path.join(testRepoDir, "README.md"), "# Initial Project\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: testRepoDir });
    execFileSync("git", ["commit", "-m", "Initial commit on develop"], { cwd: testRepoDir });

    // Default engine mock to running
    setEngineRunningCheckOverride(async () => true);
  });

  afterEach(() => {
    cancelActiveProjectTasks("Test teardown");
    setEngineRunningCheckOverride(null);
    closeSharedRunLedger();
    if (origDbPath !== undefined) {
      process.env.RUN_LEDGER_DB_PATH = origDbPath;
    } else {
      delete process.env.RUN_LEDGER_DB_PATH;
    }
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it("Item 1: Records baseSha, creates feat/task-<shortId> branch, and sets activeTaskId", async () => {
    const project = registerProject({
      name: "Runner Project",
      rootPath: testRepoDir,
      baseBranch: "develop"
    });

    const expectedBaseSha = runGit(project, ["rev-parse", "HEAD"]);
    assert.ok(expectedBaseSha.length >= 7, "Valid git commit sha on develop");

    const task = await startProjectTask({
      projectId: project.project_id,
      prompt: "Implement user authentication module",
      executeInline: false // Setup task and branch without executing full multi-hour loop
    });

    assert.ok(task.task_id);
    assert.equal(task.project_id, project.project_id);
    assert.equal(task.base_sha, expectedBaseSha);
    assert.match(task.branch, /^feat\/task-[a-f0-9]+$/);
    assert.equal(task.status, "running");

    // Check project has active_task_id set
    const updatedProj = getProject(project.project_id)!;
    assert.equal(updatedProj.active_task_id, task.task_id);

    // Verify current git branch in testRepoDir is the task branch
    const currentBranch = runGit(project, ["branch", "--show-current"]);
    assert.equal(currentBranch, task.branch);
  });

  it("Item 2: Rejects second concurrent task with 409 Conflict", async () => {
    const project = registerProject({
      name: "Conflict Test Project",
      rootPath: testRepoDir
    });

    // Start first task
    await startProjectTask({
      projectId: project.project_id,
      prompt: "First task",
      executeInline: false
    });

    // Attempt second task via API route
    const req = new Request(`http://localhost:3000/api/projects/${project.project_id}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Second task" })
    });

    const res = await postTask(req, { params: Promise.resolve({ id: project.project_id }) });
    assert.equal(res.status, 409, "Second concurrent task must return 409 Conflict");
    const data = await res.json();
    assert.match(data.error, /active task/i);
  });

  it("Item 3: Rejects revoked project with 403 Forbidden and zero workers spawned", async () => {
    const project = registerProject({
      name: "Revoked Runner Project",
      rootPath: testRepoDir
    });

    toggleAllowlist(project.project_id, false);

    const req = new Request(`http://localhost:3000/api/projects/${project.project_id}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Task on revoked project" })
    });

    const res = await postTask(req, { params: Promise.resolve({ id: project.project_id }) });
    assert.equal(res.status, 403, "Revoked project must return 403 Forbidden");
    const tasks = listProjectTasks(project.project_id);
    assert.equal(tasks.length, 0, "Zero tasks created for revoked project");
  });

  it("Item 4: Returns 503 when agent engine is stopped, zero workers spawned", async () => {
    const project = registerProject({
      name: "Stopped Engine Project",
      rootPath: testRepoDir
    });

    // Mock engine check reporting stopped
    setEngineRunningCheckOverride(async () => false);

    const req = new Request(`http://localhost:3000/api/projects/${project.project_id}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Task while engine offline" })
    });

    const res = await postTask(req, { params: Promise.resolve({ id: project.project_id }) });
    assert.equal(res.status, 503, "Engine offline must return 503 Service Unavailable");
    const tasks = listProjectTasks(project.project_id);
    assert.equal(tasks.length, 0, "Zero workers or tasks started");
  });

  it("Item 5: Mid-run engine stop aborts runner and parks task", async () => {
    const project = registerProject({
      name: "Engine Stop Abort Project",
      rootPath: testRepoDir
    });

    const task = await startProjectTask({
      projectId: project.project_id,
      prompt: "Long running overnight task",
      executeInline: false
    });

    assert.equal(task.status, "running");

    // Trigger engine stop / cancellation
    cancelActiveProjectTasks("Engine stopped mid-run");

    const updatedTask = getProjectTask(task.task_id)!;
    assert.equal(updatedTask.status, "parked", "Task must be marked parked on engine abort");

    const updatedProj = getProject(project.project_id)!;
    assert.equal(updatedProj.active_task_id, null, "Active task id cleared on abort");
  });

  it("Item 6: 2-milestone run writes inside rootPath, commits on task branch, leaves develop untouched", async () => {
    const project = registerProject({
      name: "Two Milestone Project",
      rootPath: testRepoDir,
      baseBranch: "develop"
    });

    const baseSha = runGit(project, ["rev-parse", "HEAD"]);

    // Run task with custom milestone executor that commits 2 milestones
    const completedTask = await startProjectTask({
      projectId: project.project_id,
      prompt: "Add auth and db helpers",
      executeInline: true,
      milestonesExecutor: async (proj, branch) => {
        // Milestone 1
        fs.writeFileSync(path.join(proj.root_path, "auth.ts"), "export const auth = true;", "utf8");
        runGit(proj, ["add", "auth.ts"]);
        runGit(proj, ["commit", "-m", "feat: milestone 1 auth"]);

        // Milestone 2
        fs.writeFileSync(path.join(proj.root_path, "db.ts"), "export const db = 'connected';", "utf8");
        runGit(proj, ["add", "db.ts"]);
        runGit(proj, ["commit", "-m", "feat: milestone 2 db"]);
      }
    });

    assert.equal(completedTask.status, "completed");
    assert.ok(completedTask.head_sha);
    assert.notEqual(completedTask.head_sha, baseSha);

    // Verify develop branch is completely untouched
    const developSha = runGit(project, ["rev-parse", "develop"]);
    assert.equal(developSha, baseSha, "develop branch must remain at baseSha untouched");

    // Verify task branch has the two files
    const taskBranchSha = runGit(project, ["rev-parse", completedTask.branch]);
    assert.equal(taskBranchSha, completedTask.head_sha);

    // Verify files exist inside rootPath
    assert.ok(fs.existsSync(path.join(testRepoDir, "auth.ts")));
    assert.ok(fs.existsSync(path.join(testRepoDir, "db.ts")));
  });
});
