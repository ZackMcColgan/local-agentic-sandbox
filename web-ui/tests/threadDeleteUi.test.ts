import { describe, it } from "node:test";
import assert from "node:assert";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { ThreadsSidebar } from "../components/ThreadsSidebar";
import { NavigationDrawer } from "../components/NavigationDrawer";
import { Thread } from "../lib/threads/threadStore";

describe("PART B — Thread Deletion UI Contract & Affordances", () => {
  const sampleThreads: Thread[] = [
    {
      id: "thread-abc-1",
      title: "Alpha Research Session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ id: "m1", role: "user", content: "hello", timestamp: new Date().toISOString() }]
    },
    {
      id: "thread-abc-2",
      title: "Beta Bug Fixing",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: []
    }
  ];

  it("1. Renders visible overflow (⋯) button with data-testid='thread-overflow-btn' on every thread row", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(ThreadsSidebar, {
        threads: sampleThreads,
        selectedThreadId: "thread-abc-1",
        onSelectThread: () => {},
        onNewThread: () => {},
        onDeleteThread: () => {}
      })
    );

    assert.ok(html.includes('data-testid="thread-overflow-btn"'), "Must render data-testid='thread-overflow-btn'");
    const overflowMatches = html.match(/data-testid="thread-overflow-btn"/g);
    assert.strictEqual(overflowMatches?.length, 2, "Each thread row must have a visible overflow button");
    // Ensure it is not hidden with opacity-0
    assert.ok(!html.includes('opacity-0 group-hover:opacity-100'), "Overflow button must not be hidden behind hover-only opacity-0");
  });

  it("2. Thread rows have tabIndex=0 and accessible role/labels for keyboard navigation", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(ThreadsSidebar, {
        threads: sampleThreads,
        selectedThreadId: "thread-abc-1",
        onSelectThread: () => {},
        onNewThread: () => {},
        onDeleteThread: () => {}
      })
    );

    assert.ok(html.includes('tabindex="0"'), "Thread row must be focusable via tabindex=0");
    assert.ok(html.includes('data-testid="thread-row-thread-abc-1"'), "Must include testid for individual rows");
  });

  it("3. Action Sheet and Confirm Dialog structure adheres to permanent deletion contract", () => {
    // Read ThreadsSidebar.tsx source code to verify modal/dialog and event handlers
    const fs = require("fs");
    const path = require("path");
    const sidebarSrc = fs.readFileSync(
      path.resolve(__dirname, "../components/ThreadsSidebar.tsx"),
      "utf-8"
    );

    // Three equivalent paths
    assert.ok(sidebarSrc.includes('handleTouchStart'), "Must implement touch long-press handler");
    assert.ok(sidebarSrc.includes('data-testid="thread-overflow-btn"'), "Must have visible overflow button");
    assert.ok(
      sidebarSrc.includes('e.key === "Delete"') || sidebarSrc.includes('e.key === \'Delete\''),
      "Must open confirm dialog on Delete key on row"
    );

    // ONE confirm dialog naming thread title and permanent text
    assert.ok(sidebarSrc.includes('data-testid="thread-delete-dialog"'), "Must have confirm dialog");
    assert.ok(sidebarSrc.includes('data-testid="confirm-delete-btn"'), "Must have confirm delete button");
    assert.ok(sidebarSrc.includes('data-testid="cancel-delete-btn"'), "Must have cancel delete button");
    assert.ok(
      sidebarSrc.includes("This action is permanent and cannot be undone"),
      "Must display permanent deletion warning text"
    );

    // Trapped focus and Escape handling
    assert.ok(sidebarSrc.includes('e.key === "Escape"'), "Escape key must close dialogs");
    assert.ok(sidebarSrc.includes('e.key === "Tab"'), "Focus must be trapped inside confirm dialog");
    assert.ok(sidebarSrc.includes('lastActiveElementRef.current?.focus()'), "Focus must return to list element");
  });

  it("4. App page handleDeleteThread returns UI to neutral state when deleting active thread", () => {
    const fs = require("fs");
    const path = require("path");
    const pageSrc = fs.readFileSync(
      path.resolve(__dirname, "../app/page.tsx"),
      "utf-8"
    );

    const deleteHandlerMatch = pageSrc.match(/const handleDeleteThread = async \([^)]*\) => {[\s\S]*?};/);
    assert.ok(deleteHandlerMatch, "handleDeleteThread must exist in page.tsx");
    const handlerBody = deleteHandlerMatch[0];
    assert.ok(handlerBody.includes('setSelectedThreadId(null)'), "Must reset selectedThreadId to null");
    assert.ok(handlerBody.includes('setMessages([])'), "Must clear messages on active thread deletion");
    assert.ok(handlerBody.includes('setActiveTask(null)'), "Must clear active task on active thread deletion");
  });

  it("5. NavigationDrawer renders visible overflow (⋯) button and accessible rows for mobile sessions", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(NavigationDrawer, {
        isOpen: true,
        onClose: () => {},
        activeView: "sessions",
        onNavigate: () => {},
        onNewSession: () => {},
        threads: sampleThreads,
        selectedThreadId: "thread-abc-1",
        onSelectThread: () => {},
        onDeleteThread: () => {}
      })
    );

    assert.ok(html.includes('data-testid="thread-overflow-btn"'), "NavigationDrawer must render data-testid='thread-overflow-btn'");
    const overflowMatches = html.match(/data-testid="thread-overflow-btn"/g);
    assert.strictEqual(overflowMatches?.length, 2, "Each session row in NavigationDrawer must have a visible overflow button");
    assert.ok(html.includes('data-testid="thread-row-thread-abc-1"'), "Must include testid for individual drawer session rows");
    assert.ok(html.includes('tabindex="0"'), "Session rows must be focusable via tabindex=0");
  });

  it("6. NavigationDrawer source implements touch long-press handler, action sheet, confirm dialog, and focus trap", () => {
    const fs = require("fs");
    const path = require("path");
    const drawerSrc = fs.readFileSync(
      path.resolve(__dirname, "../components/NavigationDrawer.tsx"),
      "utf-8"
    );

    // Three equivalent paths
    assert.ok(drawerSrc.includes('handleTouchStart'), "Must implement touch long-press handler");
    assert.ok(drawerSrc.includes('handleTouchMove'), "Must implement touch move threshold");
    assert.ok(drawerSrc.includes('handleTouchEnd'), "Must implement touch end handler");
    assert.ok(drawerSrc.includes('data-testid="thread-overflow-btn"'), "Must have visible overflow button");
    assert.ok(
      drawerSrc.includes('e.key === "Delete"') || drawerSrc.includes('e.key === \'Delete\''),
      "Must open confirm dialog on Delete key on row"
    );

    // Confirm dialog and Action sheet
    assert.ok(drawerSrc.includes('data-testid="thread-action-sheet"'), "Must have action sheet");
    assert.ok(drawerSrc.includes('data-testid="action-sheet-delete-btn"'), "Must have action sheet delete button");
    assert.ok(drawerSrc.includes('data-testid="thread-delete-dialog"'), "Must have confirm dialog");
    assert.ok(drawerSrc.includes('data-testid="confirm-delete-btn"'), "Must have confirm delete button");
    assert.ok(drawerSrc.includes('data-testid="cancel-delete-btn"'), "Must have cancel delete button");
    assert.ok(
      drawerSrc.includes("This action is permanent and cannot be undone"),
      "Must display permanent deletion warning text"
    );

    // Trapped focus and Escape handling
    assert.ok(drawerSrc.includes('e.key === "Escape"'), "Escape key must close dialogs");
    assert.ok(drawerSrc.includes('e.key === "Tab"'), "Focus must be trapped inside confirm dialog");
  });

  it("7. Confirm-dialog copy is truthful per thread kind (matches threadStore.deleteThread behavior)", () => {
    const fs = require("fs");
    const path = require("path");

    for (const rel of ["../components/ThreadsSidebar.tsx", "../components/NavigationDrawer.tsx"]) {
      const src = fs.readFileSync(path.resolve(__dirname, rel), "utf-8");

      // Must NOT claim checkpoints are removed for every thread (real task threads retain the checkpoint).
      assert.ok(
        !src.includes("All messages and task checkpoints for this session will be removed"),
        `${rel} must not promise checkpoint removal for all threads`
      );

      // Real thread with taskId: checkpoint retained, task marked cancelled (threadStore.ts L927-941).
      assert.ok(
        src.includes("The task checkpoint is retained and the task will be marked cancelled"),
        `${rel} must state the checkpoint is retained and the task cancelled for real task threads`
      );

      // Ghost/checkpoint-synthesized thread: checkpoint manifest removed (threadStore.ts L920-926).
      assert.ok(
        src.includes("All messages and the task checkpoint for this session will be removed"),
        `${rel} must state checkpoint removal for ghost task threads`
      );

      // Ghost detection mirrors deleteThread's isGhostTaskThread condition.
      assert.ok(
        src.includes("`thread-${") && src.includes('startsWith("thread-task-")'),
        `${rel} must branch on the ghost-thread id condition (thread-<taskId> / thread-task-*)`
      );
    }
  });
});
