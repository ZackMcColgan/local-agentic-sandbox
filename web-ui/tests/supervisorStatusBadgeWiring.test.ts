import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadsSidebar } from "../components/ThreadsSidebar";
import type { Thread } from "../lib/threads/threadStore";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  const now = new Date().toISOString();
  return {
    id: "t-1",
    title: "Test Session",
    createdAt: now,
    updatedAt: now,
    status: "stopped",
    messages: [],
    ...overrides,
  };
}

function renderSidebar(threads: Thread[]): string {
  return renderToStaticMarkup(
    React.createElement(ThreadsSidebar, {
      threads,
      selectedThreadId: null,
      onSelectThread: () => {},
      onNewThread: () => {},
      onDeleteThread: () => {},
    })
  );
}

describe("SupervisorStatusBadge UI wiring", () => {
  it("renders 'Needs attention' badge in ThreadsSidebar for a needsAttention thread", () => {
    const html = renderSidebar([
      makeThread({
        id: "t-attn",
        needsAttention: true,
        stalledReason: "Auto-resume cap (2) reached",
      }),
    ]);
    assert.match(html, /supervisor-needs-attention/);
    assert.match(html, /Needs attention/);
  });

  it("renders 'Stalled' badge in ThreadsSidebar for a stalled thread", () => {
    const html = renderSidebar([
      makeThread({
        id: "t-stalled",
        stalledReason: "Turn stalled: no activity for 10m",
      }),
    ]);
    assert.match(html, /supervisor-stalled/);
    assert.match(html, /Stalled/);
  });

  it("renders 'Auto-resumed' badge in ThreadsSidebar for an auto-resumed thread", () => {
    const html = renderSidebar([
      makeThread({
        id: "t-resumed",
        autoResumeCount: 1,
      }),
    ]);
    assert.match(html, /supervisor-auto-resumed/);
    assert.match(html, /Auto-resumed \(1\/2\)/);
  });
});
