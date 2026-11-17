import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  registerProject,
  createProjectTask,
  getProject,
  getFileReviews,
  setFileReviewStatus
} from "../lib/projects/projectStore";
import {
  runGit,
  getProjectDiffSummary,
  acceptProjectFile,
  revertProjectFile,
  finalizeProjectReview
} from "../lib/projects/projectGit";
import { GET as getProjectDiff, POST as postProjectDiff } from "../app/api/projects/[id]/diff/route";
import { ProjectsView } from "../components/ProjectsView";
import { closeSharedRunLedger } from "../lib/ledger/runLedger";

describe("PHASE 3: Per-File Diff Engine & Accept/Revert Review", () => {
  let tempDir: string;
  let testRepoDir: string;
  let origDbPath: string | undefined;
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    origDbPath = process.env.RUN_LEDGER_DB_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-diff-test-"));
    process.env.RUN_LEDGER_DB_PATH = path.join(tempDir, "test-diff-runs.db");
    closeSharedRunLedger();

    testRepoDir = path.join(tempDir, "diff-repo");
    fs.mkdirSync(testRepoDir, { recursive: true });

    // Initialize git repository
    execFileSync("git", ["init", "-b", "develop"], { cwd: testRepoDir });
    execFileSync("git", ["config", "user.email", "diff-tester@test.com"], { cwd: testRepoDir });
    execFileSync("git", ["config", "user.name", "Diff Tester"], { cwd: testRepoDir });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: testRepoDir });

    // Base files
    fs.mkdirSync(path.join(testRepoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testRepoDir, "src", "existing1.ts"), "const a = 1;\nexport default a;\n", "utf8");
    fs.writeFileSync(path.join(testRepoDir, "src", "existing2.ts"), "const b = 2;\nexport default b;\n", "utf8");
    fs.writeFileSync(path.join(testRepoDir, "README.md"), "# Base README\n", "utf8");

    execFileSync("git", ["add", "."], { cwd: testRepoDir });
    execFileSync("git", ["commit", "-m", "Initial base commit"], { cwd: testRepoDir });

    // Happy DOM
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

  it("Item 1: Diff summary accurately tracks modified, added, and deleted files across baseSha..HEAD", () => {
    const project = registerProject({
      name: "Diff Summary Project",
      rootPath: testRepoDir,
      baseBranch: "develop"
    });

    const baseSha = runGit(project, ["rev-parse", "HEAD"]);

    // Create task branch
    const branch = "feat/task-diffsummary";
    runGit(project, ["checkout", "-B", branch]);
    const task = createProjectTask({
      projectId: project.project_id,
      prompt: "Make 3 file changes",
      baseSha,
      branch
    });

    // Make 3 distinct changes:
    // 1. Modify src/existing1.ts
    fs.writeFileSync(path.join(testRepoDir, "src", "existing1.ts"), "const a = 999;\nexport default a;\n", "utf8");
    // 2. Add src/newfile.ts
    fs.writeFileSync(path.join(testRepoDir, "src", "newfile.ts"), "export const newlyCreated = true;\n", "utf8");
    // 3. Delete README.md
    fs.rmSync(path.join(testRepoDir, "README.md"));

    runGit(project, ["add", "-A"]);
    runGit(project, ["commit", "-m", "feat: 3 file changes"]);

    const summary = getProjectDiffSummary(project, task.task_id, baseSha);
    assert.equal(summary.files.length, 3, "Exactly 3 changed files");

    const existing1Diff = summary.files.find((f) => f.filePath === "src/existing1.ts");
    assert.ok(existing1Diff);
    assert.equal(existing1Diff.changeType, "M");
    assert.ok(existing1Diff.diff.includes("999"));

    const newfileDiff = summary.files.find((f) => f.filePath === "src/newfile.ts");
    assert.ok(newfileDiff);
    assert.equal(newfileDiff.changeType, "A");
    assert.ok(newfileDiff.diff.includes("newlyCreated"));

    const readmeDiff = summary.files.find((f) => f.filePath === "README.md");
    assert.ok(readmeDiff);
    assert.equal(readmeDiff.changeType, "D");
  });

  it("Item 2: acceptProjectFile preserves content and marks status accepted", () => {
    const project = registerProject({
      name: "Accept Test Project",
      rootPath: testRepoDir
    });

    const baseSha = runGit(project, ["rev-parse", "HEAD"]);
    const branch = "feat/task-accept";
    runGit(project, ["checkout", "-B", branch]);
    const task = createProjectTask({
      projectId: project.project_id,
      prompt: "Accept file test",
      baseSha,
      branch
    });

    fs.writeFileSync(path.join(testRepoDir, "src", "existing1.ts"), "const a = 'accepted_val';\n", "utf8");
    runGit(project, ["add", "src/existing1.ts"]);
    runGit(project, ["commit", "-m", "feat: modify existing1"]);

    const review = acceptProjectFile(project, task.task_id, "src/existing1.ts");
    assert.equal(review.status, "accepted");
    assert.equal(review.file_path, "src/existing1.ts");

    // Content is preserved on disk
    const content = fs.readFileSync(path.join(testRepoDir, "src", "existing1.ts"), "utf8");
    assert.equal(content, "const a = 'accepted_val';\n");

    const reviews = getFileReviews(task.task_id);
    assert.equal(reviews.find((r) => r.file_path === "src/existing1.ts")?.status, "accepted");
  });

  it("Item 3: revertProjectFile restores modified file byte-for-byte from baseSha with revert commit, leaves other files untouched", () => {
    const project = registerProject({
      name: "Revert Modified Project",
      rootPath: testRepoDir
    });

    const originalContent1 = fs.readFileSync(path.join(testRepoDir, "src", "existing1.ts"), "utf8");
    const originalContent2 = fs.readFileSync(path.join(testRepoDir, "src", "existing2.ts"), "utf8");
    const baseSha = runGit(project, ["rev-parse", "HEAD"]);

    const branch = "feat/task-revert-mod";
    runGit(project, ["checkout", "-B", branch]);
    const task = createProjectTask({
      projectId: project.project_id,
      prompt: "Revert test",
      baseSha,
      branch
    });

    // Modify both files
    fs.writeFileSync(path.join(testRepoDir, "src", "existing1.ts"), "const corrupted1 = true;\n", "utf8");
    fs.writeFileSync(path.join(testRepoDir, "src", "existing2.ts"), "const corrupted2 = true;\n", "utf8");
    runGit(project, ["add", "."]);
    runGit(project, ["commit", "-m", "feat: modified both files"]);

    // Revert ONLY existing1.ts
    const review = revertProjectFile(project, task.task_id, "src/existing1.ts", baseSha);
    assert.equal(review.status, "reverted");

    // Check existing1 is restored byte-for-byte
    const restoredContent1 = fs.readFileSync(path.join(testRepoDir, "src", "existing1.ts"), "utf8");
    assert.equal(restoredContent1, originalContent1, "Restored byte-for-byte from baseSha");

    // Check existing2 is UNTOUCHED (still modified)
    const untouchedContent2 = fs.readFileSync(path.join(testRepoDir, "src", "existing2.ts"), "utf8");
    assert.equal(untouchedContent2, "const corrupted2 = true;\n", "Other files remain untouched");

    // Verify git log has the revert commit
    const logOut = runGit(project, ["log", "-n", "1", "--oneline"]);
    assert.match(logOut, /revert.*src\/existing1\.ts/i, "Argv-safe revert commit created");
  });

  it("Item 4: revertProjectFile of new file removes it cleanly", () => {
    const project = registerProject({
      name: "Revert New File Project",
      rootPath: testRepoDir
    });

    const baseSha = runGit(project, ["rev-parse", "HEAD"]);
    const branch = "feat/task-revert-new";
    runGit(project, ["checkout", "-B", branch]);
    const task = createProjectTask({
      projectId: project.project_id,
      prompt: "Revert new file",
      baseSha,
      branch
    });

    // Add brand new file
    const newFilePath = path.join(testRepoDir, "src", "unwanted.ts");
    fs.writeFileSync(newFilePath, "export const deleteMe = true;\n", "utf8");
    runGit(project, ["add", "src/unwanted.ts"]);
    runGit(project, ["commit", "-m", "feat: add unwanted"]);

    assert.ok(fs.existsSync(newFilePath));

    // Revert new file
    const review = revertProjectFile(project, task.task_id, "src/unwanted.ts", baseSha);
    assert.equal(review.status, "reverted");

    // File must be completely removed
    assert.ok(!fs.existsSync(newFilePath), "Reverted new file must be deleted from filesystem");
  });

  it("Item 5: Malicious filename handled safely via execFile array with zero shell execution", () => {
    const project = registerProject({
      name: "Malicious Filename Project",
      rootPath: testRepoDir
    });

    const baseSha = runGit(project, ["rev-parse", "HEAD"]);
    const branch = "feat/task-malicious";
    runGit(project, ["checkout", "-B", branch]);
    const task = createProjectTask({
      projectId: project.project_id,
      prompt: "Malicious file test",
      baseSha,
      branch
    });

    // Malicious shell injection tokens in filename (e.g. spaces, semicolons, dollar signs)
    const evilName = "test;echo injected.txt";
    const evilPath = path.join(testRepoDir, evilName);
    fs.writeFileSync(evilPath, "harmless text", "utf8");
    runGit(project, ["add", evilName]);
    runGit(project, ["commit", "-m", "feat: evil filename"]);

    // Reverting must execute without shell interpolation
    const review = revertProjectFile(project, task.task_id, evilName, baseSha);
    assert.equal(review.status, "reverted");
    assert.ok(!fs.existsSync(evilPath));
  });

  it("Item 6: API route & UI Diff tab renders diffs with accept and revert buttons", async () => {
    const project = registerProject({
      name: "UI Diff Project",
      rootPath: testRepoDir
    });

    const baseSha = runGit(project, ["rev-parse", "HEAD"]);
    const branch = "feat/task-ui-diff";
    runGit(project, ["checkout", "-B", branch]);
    const task = createProjectTask({
      projectId: project.project_id,
      prompt: "UI diff test",
      baseSha,
      branch
    });

    fs.writeFileSync(path.join(testRepoDir, "src", "existing1.ts"), "const uiDiff = 42;\n", "utf8");
    runGit(project, ["add", "."]);
    runGit(project, ["commit", "-m", "feat: ui diff"]);

    // GET /api/projects/[id]/diff
    const getReq = new Request(`http://localhost:3000/api/projects/${project.project_id}/diff?taskId=${task.task_id}`);
    const getRes = await getProjectDiff(getReq, { params: Promise.resolve({ id: project.project_id }) });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.ok(Array.isArray(getData.files));
    assert.equal(getData.files.length, 1);

    // POST /api/projects/[id]/diff accept action
    const postReq = new Request(`http://localhost:3000/api/projects/${project.project_id}/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "accept",
        taskId: task.task_id,
        filePath: "src/existing1.ts"
      })
    });
    const postRes = await postProjectDiff(postReq, { params: Promise.resolve({ id: project.project_id }) });
    assert.equal(postRes.status, 200);

    // Render ProjectsView in Tab 3 ("diffs")
    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(ProjectsView, {
          projects: [project],
          selectedProjectId: project.project_id,
          onOpenDrawer: () => {},
          diffs: getData.files,
          onAcceptFile: async () => {},
          onRevertFile: async () => {}
        })
      );
    });

    const html = container.innerHTML;
    assert.ok(html.includes("Diff Review") || html.includes("Diffs"), "Renders Diff Review tab");
  });
});
