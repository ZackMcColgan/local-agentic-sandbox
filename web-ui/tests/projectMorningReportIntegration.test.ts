import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import React from "react";
import { renderToString } from "react-dom/server";
import { Window } from "happy-dom";

import { TaskManifest } from "../lib/subagents/types";
import {
  generateOvernightMorningReport,
  generateMorningReport
} from "../lib/subagents/morningReport";
import { MorningReportView } from "../components/MorningReportView";
import { registerProject, createProjectTask, getProject, getFileReviews } from "../lib/projects/projectStore";
import { runGit, getProjectDiffSummary, acceptProjectFile, revertProjectFile } from "../lib/projects/projectGit";
import { runProjectOvernightTask, setEngineRunningCheckOverride } from "../lib/projects/projectRunner";
import { GET as getProjectDiff, POST as postProjectDiff } from "../app/api/projects/[id]/diff/route";
import { closeSharedRunLedger } from "../lib/ledger/runLedger";

describe("PHASE 4: Project Morning Report Integration & Full Lifecycle", () => {
  let tempDir: string;
  let testRepoDir: string;
  let origDbPath: string | undefined;

  beforeEach(() => {
    origDbPath = process.env.RUN_LEDGER_DB_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-morning-test-"));
    process.env.RUN_LEDGER_DB_PATH = path.join(tempDir, "test-morning-runs.db");
    closeSharedRunLedger();

    testRepoDir = path.join(tempDir, "sample-proj");
    fs.mkdirSync(testRepoDir, { recursive: true });

    execFileSync("git", ["init", "-b", "develop"], { cwd: testRepoDir });
    execFileSync("git", ["config", "user.email", "phase4-tester@test.com"], { cwd: testRepoDir });
    execFileSync("git", ["config", "user.name", "Phase4 Tester"], { cwd: testRepoDir });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: testRepoDir });

    fs.writeFileSync(path.join(testRepoDir, "index.ts"), "export const base = 1;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: testRepoDir });
    execFileSync("git", ["commit", "-m", "Initial base commit"], { cwd: testRepoDir });

    // Mock engine running check so tests starting project tasks pass cleanly without live engine
    setEngineRunningCheckOverride(async () => true);
  });

  afterEach(() => {
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

  it("Item 1: generateOvernightMorningReport attaches projectId, projectName, projectRoot, and reviewUrl when present", () => {
    const projectTask: TaskManifest = {
      taskId: "task-proj-101",
      goal: "Implement authentication service",
      toolchain: "node:22",
      scope: "PROJECT",
      branchName: "feat/task-auth",
      status: "completed",
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      completedAt: new Date().toISOString(),
      currentMilestoneIndex: 1,
      milestones: [
        {
          id: "M1",
          title: "Create auth routes",
          description: "Auth route implementation",
          status: "completed",
          commitSha: "sha-auth-1",
          testsPassed: 5,
          testsFailed: 0,
          diffSummary: "Created auth routes"
        }
      ],
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      projectId: "proj-core-auth",
      projectName: "Core Auth Service",
      projectRoot: "/workspace/projects/core-auth",
      reviewUrl: "/projects?projectId=proj-core-auth&tab=diffs"
    };

    const report = generateOvernightMorningReport([projectTask]);
    assert.equal(report.tasks.length, 1);
    const entry = report.tasks[0];

    assert.equal(entry.taskId, "task-proj-101");
    assert.equal(entry.projectId, "proj-core-auth");
    assert.equal(entry.projectName, "Core Auth Service");
    assert.equal(entry.projectRoot, "/workspace/projects/core-auth");
    assert.equal(entry.reviewUrl, "/projects?projectId=proj-core-auth&tab=diffs");
  });

  it("Item 2: generateOvernightMorningReport remains 100% backward-compatible with standalone tasks lacking project fields", () => {
    const standaloneTask: TaskManifest = {
      taskId: "task-standalone-202",
      goal: "Standalone weather SVG generation",
      toolchain: "node:22",
      branchName: "feat/standalone-weather",
      status: "completed",
      startedAt: new Date(Date.now() - 1800000).toISOString(),
      completedAt: new Date().toISOString(),
      currentMilestoneIndex: 1,
      milestones: [],
      checkpoints: [],
      ambiguityFlags: [],
      journal: []
    };

    const report = generateOvernightMorningReport([standaloneTask]);
    assert.equal(report.tasks.length, 1);
    const entry = report.tasks[0];

    assert.equal(entry.taskId, "task-standalone-202");
    assert.equal(entry.projectId, undefined);
    assert.equal(entry.projectName, undefined);
    assert.equal(entry.reviewUrl, undefined);
  });

  it("Item 3: MorningReportView renders project badge and review link for project tasks, omits them for standalone tasks", () => {
    const projectTaskEntry: any = {
      taskId: "task-view-proj",
      goal: "Build payment gateway",
      branch: "feat/payment",
      gitHeadSha: "head123",
      status: "completed",
      startedAt: new Date(Date.now() - 120000).toISOString(),
      completedAt: new Date().toISOString(),
      durationSeconds: 120,
      durationFormatted: "2m 0s",
      artifacts: [],
      milestones: [],
      ambiguityFlags: [],
      testsPassed: 3,
      testsFailed: 0,
      projectId: "proj-payment-gw",
      projectName: "Payment Gateway",
      reviewUrl: "/projects?projectId=proj-payment-gw&tab=diffs"
    };

    const standaloneTaskEntry: any = {
      taskId: "task-view-standalone",
      goal: "Generate standalone chart",
      branch: "feat/chart",
      gitHeadSha: "head456",
      status: "completed",
      startedAt: new Date(Date.now() - 60000).toISOString(),
      completedAt: new Date().toISOString(),
      durationSeconds: 60,
      durationFormatted: "1m 0s",
      artifacts: [],
      milestones: [],
      ambiguityFlags: [],
      testsPassed: 2,
      testsFailed: 0
    };

    const overnightReport: any = {
      reportId: "rep-view-test",
      generatedAt: new Date().toISOString(),
      windowLabel: "Autonomous Run",
      totalTasks: 2,
      completedCount: 2,
      parkedCount: 0,
      failedCount: 0,
      totalDurationSeconds: 180,
      totalDurationFormatted: "3m 0s",
      tasks: [projectTaskEntry, standaloneTaskEntry],
      artifactsProduced: [],
      attentionItems: [],
      summaryMarkdown: ""
    };

    const html = renderToString(
      React.createElement(MorningReportView, {
        overnightReport
      })
    );

    const window = new Window();
    window.document.body.innerHTML = html;

    const taskRows = window.document.querySelectorAll('[data-testid="task-row"]');
    assert.equal(taskRows.length, 2, "Exactly 2 task rows rendered");

    const projectBadges = window.document.querySelectorAll('[data-testid="project-badge"]');
    assert.equal(projectBadges.length, 1, "Exactly 1 project badge rendered for project task");
    assert.ok(projectBadges[0].textContent?.includes("Payment Gateway"), "Project badge has project name");

    const reviewLinks = window.document.querySelectorAll('[data-testid="project-review-link"]');
    assert.equal(reviewLinks.length, 1, "Exactly 1 project review link rendered");
    assert.equal(reviewLinks[0].getAttribute("href"), "/projects?projectId=proj-payment-gw&tab=diffs");
  });

  it("Item 4: Full lifecycle end-to-end integration", async () => {
    // 1. Register project
    const project = registerProject({
      name: "Lifecycle Project",
      rootPath: testRepoDir,
      baseBranch: "develop"
    });
    assert.equal(project.allowlisted, 1);

    // 2. Run overnight task inline with milestonesExecutor
    const taskResult = await runProjectOvernightTask({
      projectId: project.project_id,
      prompt: "Implement user management module",
      executeInline: true,
      milestonesExecutor: async (proj, branch) => {
        // Milestone 1: modify index.ts and create user.ts
        fs.writeFileSync(path.join(testRepoDir, "index.ts"), "export const base = 1;\nexport * from './user';\n", "utf8");
        fs.writeFileSync(path.join(testRepoDir, "user.ts"), "export interface User { id: string; name: string; }\n", "utf8");
        runGit(proj, ["add", "."]);
        runGit(proj, ["commit", "-m", "feat: implement user management"]);
      }
    });

    assert.ok(taskResult);
    assert.equal(taskResult.status, "completed");

    // 3. Verify task manifest integration with Morning Report
    const taskManifest: TaskManifest = {
      taskId: taskResult.task_id,
      goal: taskResult.prompt,
      toolchain: "node:22",
      scope: "PROJECT",
      branchName: taskResult.branch,
      status: "completed",
      startedAt: taskResult.created_at,
      completedAt: taskResult.updated_at,
      currentMilestoneIndex: 1,
      milestones: [
        {
          id: "M1",
          title: "User module implementation",
          description: "Implemented user interface and exports",
          status: "completed",
          commitSha: taskResult.head_sha || "head",
          testsPassed: 4,
          testsFailed: 0,
          diffSummary: "Modified index.ts, added user.ts"
        }
      ],
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      projectId: project.project_id,
      projectName: project.name,
      projectRoot: project.root_path,
      reviewUrl: `/projects?projectId=${project.project_id}&tab=diffs`
    };

    const morningReport = generateOvernightMorningReport([taskManifest]);
    assert.equal(morningReport.tasks.length, 1);
    const morningEntry = morningReport.tasks[0];
    assert.equal(morningEntry.projectId, project.project_id);
    assert.equal(morningEntry.projectName, "Lifecycle Project");
    assert.ok(morningEntry.reviewUrl?.includes(project.project_id));

    // 4. Follow reviewUrl to inspect diff via GET /api/projects/[id]/diff
    const getReq = new Request(`http://localhost:3000/api/projects/${project.project_id}/diff?taskId=${taskResult.task_id}`);
    const getRes = await getProjectDiff(getReq, { params: Promise.resolve({ id: project.project_id }) });
    assert.equal(getRes.status, 200);
    const diffData = await getRes.json();
    assert.equal(diffData.files.length, 2, "2 modified/added files in diff review");

    // 5. Accept one file, revert the other
    const acceptReq = new Request(`http://localhost:3000/api/projects/${project.project_id}/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "accept",
        taskId: taskResult.task_id,
        filePath: "user.ts"
      })
    });
    const acceptRes = await postProjectDiff(acceptReq, { params: Promise.resolve({ id: project.project_id }) });
    assert.equal(acceptRes.status, 200);

    const revertReq = new Request(`http://localhost:3000/api/projects/${project.project_id}/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "revert",
        taskId: taskResult.task_id,
        filePath: "index.ts",
        baseSha: taskResult.base_sha
      })
    });
    const revertRes = await postProjectDiff(revertReq, { params: Promise.resolve({ id: project.project_id }) });
    assert.equal(revertRes.status, 200);

    // 6. Verify filesystem and store statuses
    const reviews = getFileReviews(taskResult.task_id);
    assert.equal(reviews.find((r) => r.file_path === "user.ts")?.status, "accepted");
    assert.equal(reviews.find((r) => r.file_path === "index.ts")?.status, "reverted");

    // index.ts should be restored to base
    const restoredIndex = fs.readFileSync(path.join(testRepoDir, "index.ts"), "utf8");
    assert.equal(restoredIndex, "export const base = 1;\n");

    // user.ts should still exist (accepted)
    const userContent = fs.readFileSync(path.join(testRepoDir, "user.ts"), "utf8");
    assert.ok(userContent.includes("export interface User"));
  });
});
