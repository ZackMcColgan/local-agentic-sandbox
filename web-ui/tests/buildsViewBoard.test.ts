import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildsView } from "../components/BuildsView";

describe("UI-051: BuildsView consumes /api/board", () => {
  it("production BuildsView component fetches /api/board", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../components/BuildsView.tsx"), "utf8");
    assert.ok(src.includes('fetch("/api/board")'), "BuildsView.tsx must fetch /api/board");
    assert.ok(!src.includes('fetch("/api/tasks")'), "BuildsView.tsx must not fetch /api/tasks");
  });

  it("renders board task rows when provided thread-backed tasks", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuildsView, {
        onOpenDrawer: () => {},
        activeTask: null,
        onSelectThread: () => {},
        tasks: [
          {
            taskId: "thread-board-1",
            goal: "Thread-backed Board Row Alpha",
            status: "active",
            toolchain: "node:22",
            branchName: "feat/board-row",
            milestones: [],
            currentMilestoneIndex: 0,
            checkpoints: [],
            ambiguityFlags: [],
            journal: [],
            startedAt: "2026-11-15T00:00:00.000Z",
            updatedAt: "2026-11-15T00:00:00.000Z"
          }
        ]
      })
    );
    assert.ok(html.includes("Thread-backed Board Row Alpha"), "Rendered BuildsView must display board task row");
  });
});
