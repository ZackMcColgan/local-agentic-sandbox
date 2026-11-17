import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import React from "react";
import { renderToString } from "react-dom/server";
import { Window } from "happy-dom";
import { TaskManifest } from "../lib/subagents/types.js";

function findRepoRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../..")
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "web-ui"))) {
      return dir;
    }
  }
  return process.cwd();
}

describe("UI-P1-1 Self-Deploy Wiring & BuildsView Polish", () => {
  it("Test 1: page.tsx dispatches action: 'executeSelfDeploy' in handleDeployRun (and does NOT dispatch action: 'deployBuild')", () => {
    const pageFile = path.resolve(findRepoRoot(), "web-ui/app/page.tsx");
    const content = fs.readFileSync(pageFile, "utf8");

    // Extract handleDeployRun function block
    const handleDeployRunMatch = content.match(/const\s+handleDeployRun\s*=\s*async\s*\([\s\S]*?\n\s*\};/);
    assert.ok(handleDeployRunMatch, "handleDeployRun function must be present in page.tsx");
    const funcBody = handleDeployRunMatch[0];

    // Must dispatch action: "executeSelfDeploy"
    assert.match(
      funcBody,
      /action:\s*["']executeSelfDeploy["']/,
      "handleDeployRun must dispatch action: 'executeSelfDeploy'"
    );

    // Must NOT dispatch action: "deployBuild"
    assert.doesNotMatch(
      funcBody,
      /action:\s*["']deployBuild["']/,
      "handleDeployRun must NOT dispatch action: 'deployBuild'"
    );

    // Must pass branchName
    assert.match(
      funcBody,
      /branchName:\s*activeTask\?\.branchName/,
      "handleDeployRun must include branchName: activeTask?.branchName in request payload"
    );
  });

  it("Test 2: BuildsView.tsx passes onDeployRun={onDeployRun} to <LiveRunBlock />", async () => {
    const buildsFile = path.resolve(findRepoRoot(), "web-ui/components/BuildsView.tsx");
    const content = fs.readFileSync(buildsFile, "utf8");

    // Static source check: LiveRunBlock tag must receive onDeployRun={onDeployRun}
    const liveRunMatch = content.match(/<LiveRunBlock[\s\S]*?\/>/);
    assert.ok(liveRunMatch, "<LiveRunBlock /> must be rendered in BuildsView.tsx");
    assert.match(
      liveRunMatch[0],
      /onDeployRun=\{onDeployRun\}/,
      "<LiveRunBlock /> must receive onDeployRun={onDeployRun} prop"
    );

    // Component render check: when completed task and onDeployRun are provided, LiveRunBlock renders the rollout button
    const { BuildsView } = await import("../components/BuildsView.js");
    const sampleTask: TaskManifest = {
      taskId: "task-deploy-test-1",
      goal: "Test deploy button in BuildsView",
      toolchain: "node:22",
      branchName: "feat/task-deploy-test",
      status: "completed",
      currentMilestoneIndex: 1,
      milestones: [
        {
          id: "M1",
          title: "Complete work",
          description: "All done",
          status: "completed",
          builderIterations: 1,
          criticRounds: 1,
          acceptanceCriteria: []
        }
      ],
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };

    let deployRunCalledWith = "";
    const html = renderToString(
      React.createElement(BuildsView, {
        onOpenDrawer: () => {},
        activeTask: sampleTask,
        onSelectThread: () => {},
        onDeployRun: (taskId: string) => {
          deployRunCalledWith = taskId;
        }
      })
    );

    const window = new Window();
    window.document.body.innerHTML = html;
    const rolloutBtn = window.document.querySelector('[data-testid="merge-rollout-btn"]');
    assert.ok(rolloutBtn, "LiveRunBlock inside BuildsView must render data-testid='merge-rollout-btn' when onDeployRun is passed");
    assert.match(rolloutBtn.textContent || "", /Merge to develop & Rollout/);
  });

  it("Test 3: BuildsView.tsx line 153 button label does not contain literal backticks `develop`", async () => {
    const buildsFile = path.resolve(findRepoRoot(), "web-ui/components/BuildsView.tsx");
    const content = fs.readFileSync(buildsFile, "utf8");

    // Button label must not have literal backticks `develop`
    assert.doesNotMatch(
      content,
      /Merge to `develop` & Deploy/,
      "BuildsView.tsx button label must not contain literal backticks `develop`"
    );

    // Must contain cleaned up text "Merge to develop & Deploy"
    assert.match(
      content,
      /Merge to develop & Deploy/,
      "BuildsView.tsx button label must be 'Merge to develop & Deploy'"
    );

    // Render check
    const { BuildsView } = await import("../components/BuildsView.js");
    const sampleTask: TaskManifest = {
      taskId: "task-deploy-test-2",
      goal: "Test deploy button label",
      toolchain: "node:22",
      branchName: "feat/task-deploy-test",
      status: "completed",
      currentMilestoneIndex: 1,
      milestones: [],
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const html = renderToString(
      React.createElement(BuildsView, {
        onOpenDrawer: () => {},
        activeTask: sampleTask,
        onSelectThread: () => {},
        onDeployRun: () => {}
      })
    );

    const window = new Window();
    window.document.body.innerHTML = html;
    const deployBtn = window.document.querySelector('[data-testid="merge-deploy-btn"]');
    assert.ok(deployBtn, "BuildsView must render data-testid='merge-deploy-btn'");
    assert.equal(deployBtn.textContent?.trim(), "Merge to develop & Deploy");
  });
});
