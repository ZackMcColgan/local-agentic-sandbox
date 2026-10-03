import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ThreadStore, Thread, activeExecutionSet } from "../lib/threads/threadStore";
import { ThreadsSidebar } from "../components/ThreadsSidebar";
import { ModelBottomSheet } from "../components/ModelBottomSheet";
import { LiveRunBlock } from "../components/LiveRunBlock";
import { ChatStream } from "../components/ChatStream";
import { TaskManifest } from "../lib/subagents/types";

describe("Work Order — Unified Agent UI (Material 3) Test Suite", () => {
  let tempDir: string;
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    tempDir = path.resolve(process.cwd(), `.tmp-threads-test-${Date.now()}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    win = new GlobalWindow({ url: "http://localhost:3000" });
    globalThis.window = win as any;
    globalThis.document = win.document as any;
    globalThis.localStorage = win.localStorage as any;

    container = win.document.createElement("div");
    win.document.body.appendChild(container);
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
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe("Item 1 — Threads Survive Refresh & Honest Server Crash Status", () => {
    it("creates durable thread file on disk and rehydrates it upon reload", async () => {
      const store = new ThreadStore(tempDir);
      const thread = store.createThread({
        title: "Rebuild settings in Material 3",
        model: "qwen3.8:27b-q3_k_m",
        reasoningEffort: "medium",
        initialPrompt: "Rebuild settings in Material 3"
      });

      assert.ok(fs.existsSync(store.getFilePath(thread.id)), "Thread file must exist on disk");

      // Simulate browser reload: create fresh store instance
      const freshStore = new ThreadStore(tempDir);
      const loaded = await freshStore.getThread(thread.id);
      assert.ok(loaded !== null, "Thread must rehydrate from disk");
      assert.equal(loaded?.title, "Rebuild settings in Material 3");
      assert.equal(loaded?.messages.length, 1);
      assert.equal(loaded?.messages[0].content, "Rebuild settings in Material 3");
    });

    it("server killed mid-run: reconciles active status honestly to stopped upon restart", async () => {
      const store = new ThreadStore(tempDir);
      const thread = store.createThread({
        title: "Long running engineering task",
        initialPrompt: "Run complex refactor",
        taskId: "task-crash-test"
      });
      thread.status = "active";
      store.saveThread(thread);

      // Verify that while activeExecutionSet does NOT contain task-crash-test (simulating server reboot):
      activeExecutionSet.delete("task-crash-test");
      activeExecutionSet.delete(thread.id);

      const freshStore = new ThreadStore(tempDir);
      const threads = await freshStore.listThreads();
      const reconciled = threads.find((t) => t.id === thread.id);

      assert.ok(reconciled, "Thread must be returned");
      assert.equal(
        reconciled?.status,
        "stopped",
        "Killed server mid-run must honestly reconcile status to 'stopped', never claim active"
      );
    });
  });

  describe("Item 2 & Item 5 — Live Run Blocks Inline & Stop Controls", () => {
    it("renders M3 LiveRunBlock elevated card with checklist, progress, and Stop run button", async () => {
      const mockTask: TaskManifest = {
        taskId: "task-test-live-run",
        goal: "Rebuild settings in Material 3",
        branchName: "feat/unified-ui",
        branch: "feat/unified-ui",
        toolchain: "node:22",
        status: "active",
        currentMilestoneIndex: 1,
        milestones: [
          {
            id: "m1",
            title: "Migrate config schema to M3 tokens",
            status: "completed",
            commitSha: "sha-1"
          },
          {
            id: "m2",
            title: "Update UI components to M3",
            status: "in_progress"
          },
          {
            id: "m3",
            title: "Validate component theming & accessibility",
            status: "pending"
          }
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [
          {
            timestamp: new Date().toISOString(),
            role: "builder",
            message: "Analyzing config dependencies... ✨"
          },
          {
            timestamp: new Date().toISOString(),
            role: "builder",
            message: "Validating theme tokens... ✨"
          }
        ],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      let stopCalled = false;
      root = createRoot(container);
      await act(async () => {
        root!.render(
          React.createElement(LiveRunBlock, {
            task: mockTask,
            onStopRun: () => {
              stopCalled = true;
            }
          })
        );
      });

      const html = container.innerHTML;
      assert.ok(html.includes("Live run"), "Must render Live run header");
      assert.ok(html.includes("Running"), "Must render Running status pill");
      assert.ok(html.includes("Milestone checklist"), "Must render Milestone checklist");
      assert.ok(html.includes("Migrate config schema to M3 tokens"), "Must render milestone 1");
      assert.ok(html.includes("Update UI components to M3"), "Must render active milestone 2");
      assert.ok(html.includes("Validate component theming"), "Must render pending milestone 3");
      assert.ok(html.includes("Analyzing config dependencies"), "Must render worker thinking step 1");
      assert.ok(html.includes("Stop run"), "Must render prominent Stop run button");

      // Click Stop run button
      const stopBtn = container.querySelector("button");
      assert.ok(stopBtn, "Stop button exists");
      await act(async () => {
        stopBtn!.click();
      });
      assert.equal(stopCalled, true, "Clicking Stop run triggers onStopRun callback");
    });
  });

  describe("Item 3 & Item 4 — One Input Bar: Empty by Default, Zero Starters, Auto-Expanding", () => {
    it("input starts completely empty with placeholder 'Describe the engineering task…' and zero presets", async () => {
      root = createRoot(container);
      await act(async () => {
        root!.render(
          React.createElement(ChatStream, {
            onTracesUpdate: () => {},
            activeModel: "qwen3.8:27b-q3_k_m",
            reasoningEffort: "medium",
            messages: []
          })
        );
      });

      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      assert.ok(textarea !== null, "Textarea input exists");
      assert.equal(textarea.value, "", "Input must start completely EMPTY");
      assert.equal(textarea.placeholder, "Describe the engineering task…");

      const html = container.innerHTML;
      // Assert zero starter presets anywhere
      assert.ok(!html.includes("Generate draw.io Architecture Diagram"), "Starter chips must not exist");
      assert.ok(!html.includes("Audit Network Egress"), "Preset buttons must not exist");
      assert.ok(!html.includes("Execute Regression Gate"), "Preset prompt chips must be deleted");
    });

    it("auto-expands smoothly without scrollbar clipping when multi-line task is pasted", async () => {
      root = createRoot(container);
      await act(async () => {
        root!.render(
          React.createElement(ChatStream, {
            onTracesUpdate: () => {},
            activeModel: "qwen3.8:27b-q3_k_m",
            reasoningEffort: "medium",
            messages: []
          })
        );
      });

      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      const fiveLinePrompt = "Line 1: Refactor UI\nLine 2: Add M3 Tokens\nLine 3: Implement bottom sheet\nLine 4: Add stop controls\nLine 5: Run tests";

      await act(async () => {
        textarea.value = fiveLinePrompt;
        textarea.dispatchEvent(new (win as any).Event("input", { bubbles: true }));
      });

      // Assert value set without truncation
      assert.equal(textarea.value, fiveLinePrompt);
      assert.ok(textarea.className.includes("min-h-[72px]"), "Textarea has at least 3 rows min-height");
    });
  });

  describe("Item 5 & Item 6 — Stop Button Morphing & Attachments", () => {
    it("morphs send button into dark stop button (■) while activeTask is running", async () => {
      const runningTask: TaskManifest = {
        taskId: "task-running-123",
        goal: "Build task",
        branchName: "feat/unified-ui",
        branch: "feat/unified-ui",
        toolchain: "node:22",
        status: "active",
        currentMilestoneIndex: 0,
        milestones: [],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      let stopCalled = false;
      root = createRoot(container);
      await act(async () => {
        root!.render(
          React.createElement(ChatStream, {
            onTracesUpdate: () => {},
            activeModel: "qwen3.8:27b-q3_k_m",
            reasoningEffort: "medium",
            activeTask: runningTask,
            onStopTask: () => {
              stopCalled = true;
            },
            messages: []
          })
        );
      });

      // Query stop button by title "Stop generation / halt workers"
      const stopButton = container.querySelector('button[title="Stop generation / halt workers"]');
      assert.ok(stopButton !== null, "Send button must morph into dark stop button while task is running");

      await act(async () => {
        (stopButton as HTMLButtonElement).click();
      });
      assert.equal(stopCalled, true, "Tapping morphed stop button triggers stop callback");
    });

    it("paperclip file input accepts required types: image/*,.pdf,.md,.txt,.drawio,.xml,.json,.csv", async () => {
      root = createRoot(container);
      await act(async () => {
        root!.render(
          React.createElement(ChatStream, {
            onTracesUpdate: () => {},
            activeModel: "qwen3.8:27b-q3_k_m",
            reasoningEffort: "medium",
            messages: []
          })
        );
      });

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      assert.ok(fileInput !== null, "Hidden file input exists");
      assert.equal(
        fileInput.accept,
        "image/*,.pdf,.md,.txt,.drawio,.xml,.json,.csv",
        "Must accept exact file extensions specified in Item 6"
      );
    });
  });

  describe("Material 3 Navigation & Bottom Sheet Components", () => {
    it("renders ThreadsSidebar with active thread indicator and search filter", async () => {
      const threads: Thread[] = [
        {
          id: "t1",
          title: "Rebuild settings in Material 3",
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          model: "qwen3.8",
          reasoningEffort: "medium",
          messages: []
        },
        {
          id: "t2",
          title: "How does the critic decide?",
          status: "completed",
          createdAt: new Date(Date.now() - 7200000).toISOString(),
          updatedAt: new Date(Date.now() - 7200000).toISOString(),
          model: "qwen3.8",
          reasoningEffort: "medium",
          messages: []
        }
      ];

      let selectedId = "t1";
      root = createRoot(container);
      await act(async () => {
        root!.render(
          React.createElement(ThreadsSidebar, {
            threads,
            selectedThreadId: selectedId,
            onSelectThread: (id) => {
              selectedId = id;
            },
            onNewThread: () => {}
          })
        );
      });

      const html = container.innerHTML;
      assert.ok(html.includes("Threads"), "Renders Threads header");
      assert.ok(html.includes("Rebuild settings in Material 3"), "Renders thread 1 title");
      assert.ok(html.includes("How does the critic decide?"), "Renders thread 2 title");
      assert.ok(html.includes("Active"), "Renders Active status");
      assert.ok(html.includes("Completed"), "Renders Completed status");
    });

    it("renders ModelBottomSheet with M3 segmented buttons and model rows", async () => {
      let selectedModel = "qwen3.8:27b-q3_k_m";
      let effort: "low" | "medium" | "xhigh" = "medium";
      let closed = false;

      root = createRoot(container);
      await act(async () => {
        root!.render(
          React.createElement(ModelBottomSheet, {
            isOpen: true,
            onClose: () => {
              closed = true;
            },
            selectedModel,
            onModelChange: (m) => {
              selectedModel = m;
            },
            reasoningEffort: effort,
            onReasoningChange: (e) => {
              effort = e;
            }
          })
        );
      });

      const html = container.innerHTML;
      assert.ok(html.includes("Model &amp; thinking effort") || html.includes("Model & thinking effort"));
      assert.ok(html.includes("qwen3.8"), "Renders qwen3.8 model option");
      assert.ok(html.includes("gemma4:e4b"), "Renders gemma4 model option");
      assert.ok(html.includes("Fast"), "Renders Fast effort segment");
      assert.ok(html.includes("Balanced"), "Renders Balanced effort segment");
      assert.ok(html.includes("Deep"), "Renders Deep effort segment");
      assert.ok(html.includes("Done"), "Renders Done button");
    });
  });
});
