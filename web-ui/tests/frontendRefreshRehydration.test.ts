import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import Home from "../app/page";
import { TaskManifest } from "../lib/subagents/types";

describe("Fix 5 — Frontend Render-on-Refresh Dashboard Rehydration Suite", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root | null = null;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    win = new GlobalWindow({ url: "http://localhost:3000" });
    globalThis.window = win as any;
    globalThis.document = win.document as any;
    globalThis.localStorage = win.localStorage as any;

    container = win.document.createElement("div");
    win.document.body.appendChild(container);
    originalFetch = globalThis.fetch;
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
    globalThis.fetch = originalFetch;
  });

  it("renders empty state threads list and unified input field when no run is active", async () => {
    globalThis.fetch = async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/threads")) {
        return {
          ok: true,
          json: async () => ({ threads: [] })
        } as any;
      }
      if (urlStr.includes("/api/tasks?active=true")) {
        return {
          ok: true,
          json: async () => ({ activeTask: null, tasks: [] })
        } as any;
      }
      if (urlStr.includes("/api/sandbox-status")) {
        return {
          ok: true,
          json: async () => ({
            services: { ollama: { status: "READY" }, mcp_server: { status: "READY" } }
          })
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    };

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(Home));
    });

    // Allow mount effects to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const html = container.innerHTML;
    assert.ok(html.includes("Message..."), "Must render M3 unified input field in empty state");
    assert.ok(html.includes("Sessions"), "Must render Sessions header in empty state");
    assert.ok(!html.includes("Milestone checklist"), "Empty state must not show active run checklist");
  });

  it("renders active run, unmounts (refresh), and verifies worker tiles, milestones, and journal tail restore", async () => {
    const mockActiveTask: TaskManifest = {
      taskId: "task-live-rehydration-101",
      goal: "Build a draw.io architecture diagram of this repo's current state, README-ready",
      branchName: "feat/v2.5-overnight",
      branch: "feat/v2.5-overnight",
      toolchain: "node:22",
      status: "active",
      currentMilestoneIndex: 1,
      milestones: [
        {
          id: "M1",
          title: "Topology Catalog",
          description: "Discover all microservices and persistent volumes",
          status: "completed",
          builderIterations: 1,
          criticRounds: 1,
          testsPassed: 4,
          testsFailed: 0,
          acceptanceCriteria: [{ id: "AC1", assertion: "Discovered 5 microservices" }]
        },
        {
          id: "M2",
          title: "Superset Architecture Diagram",
          description: "Synthesize 30-cell superset architecture diagram in draw.io",
          status: "in_progress",
          builderIterations: 1,
          criticRounds: 0,
          acceptanceCriteria: [{ id: "AC2", assertion: "Valid draw.io XML with 30 mxCells" }]
        }
      ],
      checkpoints: [],
      ambiguityFlags: [],
      journal: [
        {
          timestamp: new Date().toISOString(),
          role: "planner",
          message: "Decomposed goal into 2 milestones. SPEC.md generated."
        },
        {
          timestamp: new Date().toISOString(),
          role: "builder",
          message: "Builder synthesized milestone M2 diff. Beginning critic validation."
        }
      ],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    globalThis.fetch = async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/threads")) {
        return {
          ok: true,
          json: async () => ({
            threads: [
              {
                id: "thread-live-rehydration-101",
                title: "Build a draw.io architecture diagram",
                status: "active",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                model: "qwen3.8",
                reasoningEffort: "medium",
                taskId: mockActiveTask.taskId,
                messages: [
                  {
                    id: "msg-user-1",
                    role: "user",
                    content: "Build a draw.io architecture diagram"
                  },
                  {
                    id: "msg-assistant-1",
                    role: "assistant",
                    content: "Running task",
                    taskId: mockActiveTask.taskId
                  }
                ]
              }
            ],
            thread: {
              id: "thread-live-rehydration-101",
              title: "Build a draw.io architecture diagram",
              status: "active",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              model: "qwen3.8",
              reasoningEffort: "medium",
              taskId: mockActiveTask.taskId,
              messages: [
                {
                  id: "msg-user-1",
                  role: "user",
                  content: "Build a draw.io architecture diagram"
                },
                {
                  id: "msg-assistant-1",
                  role: "assistant",
                  content: "Running task",
                  taskId: mockActiveTask.taskId
                }
              ]
            },
            task: mockActiveTask
          })
        } as any;
      }
      if (urlStr.includes("/api/tasks?active=true") || urlStr.includes("/api/tasks?taskId=")) {
        return {
          ok: true,
          json: async () => ({
            activeTask: mockActiveTask,
            task: mockActiveTask,
            tasks: [mockActiveTask]
          })
        } as any;
      }
      if (urlStr.includes("/api/sandbox-status")) {
        return {
          ok: true,
          json: async () => ({
            services: { ollama: { status: "READY" }, mcp_server: { status: "READY" } }
          })
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    };

    // 1. Initial Render (First Page Load)
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(Home));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const initialHtml = container.innerHTML;
    assert.ok(initialHtml.includes("Live run"), "Live run block header rendered on initial load");
    assert.ok(initialHtml.includes("Superset Architecture Diagram"), "Current milestone rendered on initial load");
    assert.ok(initialHtml.includes("Topology Catalog"), "Completed milestone rendered on initial load");
    assert.ok(initialHtml.includes("Builder synthesized milestone M2 diff"), "Journal message present on initial load");
    assert.ok(initialHtml.includes("Stop run"), "Stop run button rendered on initial load");

    // 2. Simulate Browser Refresh (Unmount & Fresh Mount)
    await act(async () => {
      root!.unmount();
    });
    root = null;
    assert.equal(container.innerHTML, "", "Container is empty after unmount");

    // 3. Remount (Fresh Page Load after Refresh)
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(Home));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const refreshedHtml = container.innerHTML;

    // Assert Live run block and Stop run restored
    assert.ok(refreshedHtml.includes("Live run"), "Live run block restored on refresh");
    assert.ok(refreshedHtml.includes("Stop run"), "Stop run button restored on refresh");

    // Assert Milestones restored
    assert.ok(
      refreshedHtml.includes("Topology Catalog"),
      "Completed milestone M1 restored on refresh"
    );
    assert.ok(
      refreshedHtml.includes("Superset Architecture Diagram"),
      "In-progress milestone M2 restored on refresh"
    );

    // Assert Journal Message restored
    assert.ok(
      refreshedHtml.includes("Builder synthesized milestone M2 diff"),
      "Journal message restored on refresh"
    );
  });
});
