import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildsView } from "../components/BuildsView";

describe("E6: BuildsView Self-Deploy Pipeline uses latest displayed task when activeTask is null (UI-034)", () => {
  it("displays completed task's branch and 'Gate Passed' when activeTask is null", () => {
    const completedTask = {
      taskId: "task-e6-1",
      title: "Build E6",
      status: "completed",
      branchName: "feat/e6-branch",
      testSummary: { passed: 10, failed: 0 },
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now(),
    } as any;

    const html = renderToStaticMarkup(
      React.createElement(BuildsView, {
        activeTask: null,
        tasks: [completedTask],
      } as any)
    );

    assert.ok(html.includes("feat/e6-branch"), "Expected completed task branch in Self-Deploy Pipeline");
    assert.ok(html.includes("Gate Passed"), "Expected 'Gate Passed' in Self-Deploy Pipeline");
  });
});
