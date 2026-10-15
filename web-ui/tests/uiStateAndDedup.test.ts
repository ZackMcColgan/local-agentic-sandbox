import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import { ChatStream } from "../components/ChatStream";
import { ThinkingPanel } from "../components/ThinkingPanel";
import { TaskManifest } from "../lib/subagents/types";

describe("Sprint 14 — UI State, Message Dedup, & LiveRunBlock Single-Host Suite", () => {
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

    const div = win.document.createElement("div");
    win.document.body.appendChild(div);
    container = div as unknown as HTMLDivElement;

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

  it("1. ChatStream does NOT dispatch action: 'addMessage' inside handleSend when isBuilder && onLaunchTask is taken", async () => {
    let addMessageDispatched = false;
    let launchTaskCalled = false;
    let launchedGoal = "";

    globalThis.fetch = (async (url: any, init?: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/threads/test-thread-1")) {
        try {
          const body = JSON.parse(init?.body || "{}");
          if (body.action === "addMessage") {
            addMessageDispatched = true;
          }
        } catch {}
      }
      return new (win as any).Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "swift-15-27b-mtp",
          reasoningEffort: "medium",
          threadId: "test-thread-1",
          messages: [],
          onLaunchTask: async (goal: string) => {
            launchTaskCalled = true;
            launchedGoal = goal;
          }
        })
      );
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    assert.ok(textarea, "Textarea input must exist");

    const builderPrompt = "Build an autonomous microservice architecture diagram";

    await act(async () => {
      const textareaPropsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"));
      if (textareaPropsKey && (textarea as any)[textareaPropsKey]?.onChange) {
        (textarea as any)[textareaPropsKey].onChange({ target: { value: builderPrompt } });
      } else {
        const tracker = (textarea as any)._valueTracker;
        if (tracker) tracker.setValue("");
        textarea.value = builderPrompt;
        textarea.dispatchEvent(new (win as any).Event("input", { bubbles: true }));
        textarea.dispatchEvent(new (win as any).Event("change", { bubbles: true }));
      }
    });

    const sendForm = container.querySelector("form");
    assert.ok(sendForm, "Send form must exist");

    await act(async () => {
      const formPropsKey = Object.keys(sendForm).find((k) => k.startsWith("__reactProps"));
      if (formPropsKey && (sendForm as any)[formPropsKey]?.onSubmit) {
        (sendForm as any)[formPropsKey].onSubmit({ preventDefault: () => {} });
      } else {
        sendForm.dispatchEvent(new (win as any).Event("submit", { bubbles: true, cancelable: true }));
      }
    });

    assert.equal(launchTaskCalled, true, "onLaunchTask must be called for builder prompt");
    assert.equal(launchedGoal, builderPrompt, "Goal passed to onLaunchTask must match input prompt");
    assert.equal(
      addMessageDispatched,
      false,
      "ChatStream must NOT dispatch action: 'addMessage' to /api/threads when onLaunchTask handles it"
    );
  });

  it("2. When multiple assistant messages share the same taskId, LiveRunBlock is rendered at most once", async () => {
    const mockTask: TaskManifest = {
      taskId: "task-multi-msg-123",
      goal: "Build vector search",
      branchName: "sched/task-multi-msg-123",
      branch: "sched/task-multi-msg-123",
      toolchain: "node:22",
      status: "active",
      milestones: [
        {
          id: "M1",
          title: "Milestone 1",
          description: "M1 desc",
          acceptanceCriteria: [],
          status: "in_progress",
          builderIterations: 1,
          criticRounds: 0
        }
      ],
      currentMilestoneIndex: 0,
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const messages = [
      {
        id: "msg-user-1",
        role: "user" as const,
        content: "Build vector search"
      },
      {
        id: "msg-assistant-1",
        role: "assistant" as const,
        content: "Started autonomous engineering run.",
        taskId: "task-multi-msg-123"
      },
      {
        id: "msg-assistant-2",
        role: "assistant" as const,
        content: "Completed milestone 1.",
        taskId: "task-multi-msg-123"
      }
    ];

    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "swift-15-27b-mtp",
          reasoningEffort: "medium",
          threadId: "test-thread-1",
          activeTask: mockTask,
          messages
        })
      );
    });

    // Count instances of LiveRunBlock (rendered via milestone checklist or live-run indicators)
    const liveRunBlocks = container.querySelectorAll('[data-testid="live-run-block"], .border-slate-200.rounded-3xl');
    // More specifically, check how many times "Milestone checklist" is present in the DOM
    const checklistHeaders = Array.from(container.querySelectorAll("*")).filter(
      (el) => el.textContent?.trim() === "Milestone checklist"
    );

    assert.equal(
      checklistHeaders.length,
      1,
      `LiveRunBlock must only be rendered once across multiple messages sharing the same taskId, found ${checklistHeaders.length}`
    );
  });

  it("3. For a linked task message, ChatStream suppresses redundant outer deliverable/content rendering when LiveRunBlock is active", async () => {
    const mockTask: TaskManifest = {
      taskId: "task-host-suppress-456",
      goal: "Generate SVG diagram",
      branchName: "sched/task-host-suppress-456",
      toolchain: "node:22",
      status: "active",
      milestones: [
        {
          id: "M1",
          title: "Create architecture.svg",
          description: "SVG diagram",
          acceptanceCriteria: [],
          status: "in_progress",
          builderIterations: 1,
          criticRounds: 0,
          plannedFiles: ["docs/architecture.svg"]
        }
      ],
      currentMilestoneIndex: 0,
      checkpoints: [],
      ambiguityFlags: [],
      journal: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const messages = [
      {
        id: "msg-assistant-task",
        role: "assistant" as const,
        content: "Started autonomous engineering run.\n```xml\n<svg viewBox='0 0 100 100'></svg>\n```",
        taskId: "task-host-suppress-456",
        thought: "Planning out the SVG architecture diagram..."
      }
    ];

    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "swift-15-27b-mtp",
          reasoningEffort: "medium",
          threadId: "test-thread-1",
          activeTask: mockTask,
          messages
        })
      );
    });

    // The task host message should render LiveRunBlock, but suppress the redundant outer ThinkingPanel
    // and suppress the redundant outer raw code block / outer SVG viewer
    const outerThinkingPanels = container.querySelectorAll('[data-testid="thinking-panel"]');
    // Inside LiveRunBlock there may be an internal thinking panel if cleanedThinking exists, but outer thinking panel must be suppressed
    assert.equal(
      outerThinkingPanels.length,
      0,
      "Outer ThinkingPanel must be suppressed on the task host message when LiveRunBlock is active"
    );
  });

  it("4. ThinkingPanel auto-collapses when isStreaming transitions from true to false", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(ThinkingPanel, {
          rawThought: "Thinking through the architecture design...",
          isStreaming: true,
          defaultExpanded: true
        })
      );
    });

    // While streaming, streaming badge shows Streaming
    const badge = container.querySelector('[data-testid="streaming-badge"]');
    assert.ok(badge?.textContent?.includes("Streaming"), "Badge shows Streaming while isStreaming is true");

    // Transition isStreaming to false
    await act(async () => {
      root!.render(
        React.createElement(ThinkingPanel, {
          rawThought: "Thinking through the architecture design...",
          isStreaming: false,
          defaultExpanded: true
        })
      );
    });

    // After transition, badge shows Thought process or Complete, and the phase cards / expanded body is collapsed
    const phaseCard = container.querySelector('[data-testid="phase-card-planning"]');
    assert.equal(phaseCard, null, "ThinkingPanel should auto-collapse when generation completes (isStreaming becomes false)");
  });
});
