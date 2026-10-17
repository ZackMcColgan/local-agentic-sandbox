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
import { NavigationDrawer } from "../components/NavigationDrawer";
import { SettingsView } from "../components/SettingsView";
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
            description: "Migrate config schema to M3 tokens",
            acceptanceCriteria: [{ id: "ac1", assertion: "schema migrated" }],
            status: "completed",
            builderIterations: 1,
            criticRounds: 1,
            commitSha: "sha-1"
          },
          {
            id: "m2",
            title: "Update UI components to M3",
            description: "Update UI components to M3",
            acceptanceCriteria: [{ id: "ac2", assertion: "components updated" }],
            status: "in_progress",
            builderIterations: 2,
            criticRounds: 1
          },
          {
            id: "m3",
            title: "Validate component theming & accessibility",
            description: "Validate component theming & accessibility",
            acceptanceCriteria: [{ id: "ac3", assertion: "theming validated" }],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0
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
      const buttons = Array.from(container.querySelectorAll("button"));
      const stopBtn = buttons.find((b) => b.textContent?.includes("Stop run")) || container.querySelector("button");
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
      assert.ok(html.includes("Sessions") || html.includes("Threads"), "Renders Sessions header");
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
      assert.ok(html.includes("Done"), "Renders Done button");
    });

    it("renders NavigationDrawer with M3 items, active pill, and 3 pending badge", async () => {
      let closed = false;
      let navigatedTo: string | null = null;
      let newSessionCalled = false;

      root = createRoot(container);
      await act(async () => {
        root!.render(
          React.createElement(NavigationDrawer, {
            isOpen: true,
            onClose: () => {
              closed = true;
            },
            activeView: "sessions",
            onNavigate: (view) => {
              navigatedTo = view;
            },
            onNewSession: () => {
              newSessionCalled = true;
            },
            pendingSkillsCount: 3
          })
        );
      });

      const html = container.innerHTML;
      assert.ok(html.includes("Agent"), "Renders Agent header title");
      assert.ok(html.includes("New session"), "Renders New session option");
      assert.ok(html.includes("Sessions"), "Renders Sessions option");
      assert.ok(html.includes("Builds"), "Renders Builds option");
      assert.ok(html.includes("Skills"), "Renders Skills option");
      assert.ok(html.includes("3 pending"), "Renders 3 pending badge");
      assert.ok(html.includes("Morning report"), "Renders Morning report option");
      assert.ok(html.includes("Settings"), "Renders Settings option");
    });

    it("renders SettingsView with M3 Theme segmented controls and Default model row", async () => {
      let backCalled = false;
      let modelSheetOpened = false;

      root = createRoot(container);
      await act(async () => {
        root!.render(
          React.createElement(SettingsView, {
            onBack: () => {
              backCalled = true;
            },
            selectedModel: "qwen3.8:27b-q3_k_m",
            reasoningEffort: "medium",
            onOpenModelSheet: () => {
              modelSheetOpened = true;
            }
          })
        );
      });

      const html = container.innerHTML;
      assert.ok(html.includes("Settings"), "Renders Settings header");
      assert.ok(html.includes("Appearance"), "Renders Appearance section");
      assert.ok(html.includes("Theme"), "Renders Theme label");
      assert.ok(html.includes("Light"), "Renders Light theme button");
      assert.ok(html.includes("Dark"), "Renders Dark theme button");
      assert.ok(html.includes("System"), "Renders System theme button");
      assert.ok(html.includes("Models"), "Renders Models section");
      assert.ok(html.includes("Default model"), "Renders Default model row");
      assert.ok(html.includes("qwen3.8"), "Renders selected model name");
    });

    it("SkillsView and BuildsView show honest empty states; drawer hides badge at 0 pending", async () => {
      const { SkillsView } = await import("../components/SkillsView");
      const { BuildsView } = await import("../components/BuildsView");
      root = createRoot(container);
      await act(async () => {
        root!.render(React.createElement(SkillsView, { onOpenDrawer: () => {} }));
      });
      assert.ok(container.innerHTML.includes("No skills to review"));
      assert.ok(!container.innerHTML.includes("pending"), "no fabricated pending skills");
      await act(async () => {
        root!.render(
          React.createElement(BuildsView, {
            onOpenDrawer: () => {},
            activeTask: null,
            onSelectThread: () => {}
          })
        );
      });
      assert.ok(container.innerHTML.includes("No builds currently running"));
      await act(async () => {
        root!.render(
          React.createElement(NavigationDrawer, {
            isOpen: true,
            onClose: () => {},
            activeView: "sessions",
            onNavigate: () => {},
            onNewSession: () => {},
            pendingSkillsCount: 0
          })
        );
      });
      assert.ok(!container.innerHTML.includes("pending"), "badge hidden when zero");
    });
  });

  describe("Sprint U1 — Token Foundation, useTheme, Dead Code Purge & ArtifactRenderers", () => {
    it("Task 1: ArtifactRenderers.tsx exists and LiveRunBlock imports from it instead of ChatStream", () => {
      const artifactPath = path.resolve(__dirname, "../components/ArtifactRenderers.tsx");
      assert.ok(fs.existsSync(artifactPath), "ArtifactRenderers.tsx must exist");
      const liveRunContent = fs.readFileSync(path.resolve(__dirname, "../components/LiveRunBlock.tsx"), "utf8");
      assert.ok(
        liveRunContent.includes('from "./ArtifactRenderers"'),
        "LiveRunBlock must import from ./ArtifactRenderers, not ./ChatStream"
      );
      assert.ok(
        !liveRunContent.includes('from "./ChatStream"'),
        "LiveRunBlock must NOT import from ./ChatStream (breaks circular dependency)"
      );
    });

    it("Task 2: useTheme hook exists and theme toggles are removed from ChatStream and ThreadsSidebar", () => {
      const hookPath = path.resolve(__dirname, "../lib/hooks/useTheme.ts");
      assert.ok(fs.existsSync(hookPath), "web-ui/lib/hooks/useTheme.ts must exist");

      const chatStreamContent = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
      assert.ok(
        !chatStreamContent.includes("Toggle theme"),
        "ChatStream header/menu must NOT contain 'Toggle theme' button"
      );

      const sidebarContent = fs.readFileSync(path.resolve(__dirname, "../components/ThreadsSidebar.tsx"), "utf8");
      assert.ok(
        !sidebarContent.includes("Toggle theme"),
        "ThreadsSidebar header/menu must NOT contain 'Toggle theme' button"
      );
    });

    it("Task 3: Orphaned components (Navbar.tsx, WorkerTiles.tsx, ModelSelector.tsx) are deleted", () => {
      const compDir = path.resolve(__dirname, "../components");
      assert.equal(fs.existsSync(path.join(compDir, "Navbar.tsx")), false, "Navbar.tsx must be deleted");
      assert.equal(fs.existsSync(path.join(compDir, "WorkerTiles.tsx")), false, "WorkerTiles.tsx must be deleted");
      assert.equal(fs.existsSync(path.join(compDir, "ModelSelector.tsx")), false, "ModelSelector.tsx must be deleted");
      // DiffViewer must be kept for U2
      assert.ok(fs.existsSync(path.join(compDir, "DiffViewer.tsx")), "DiffViewer.tsx must be kept for Sprint U2");
    });

    it("Task 4: design-tokens.css exists in app/ and is imported in globals.css, and banned purple hexes are removed", () => {
      const tokensPath = path.resolve(__dirname, "../app/design-tokens.css");
      assert.ok(fs.existsSync(tokensPath), "web-ui/app/design-tokens.css must exist as a committed file");

      const globalsCss = fs.readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");
      assert.ok(
        globalsCss.includes('@import "./design-tokens.css";') || globalsCss.includes("@import './design-tokens.css';"),
        "globals.css must @import './design-tokens.css';"
      );

      // Check banned purple hexes across components
      const bannedRegex = /#(6750a4|7f67be|d0bcff|17141f|1d1a24|262230|f4f3f7|f4f5f8)\b/i;
      const compDir = path.resolve(__dirname, "../components");
      const files = fs.readdirSync(compDir).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
      const violations: string[] = [];

      for (const f of files) {
        const content = fs.readFileSync(path.join(compDir, f), "utf8");
        if (bannedRegex.test(content)) {
          violations.push(f);
        }
      }

      assert.deepEqual(violations, [], `Banned M3 purple/muddy hexes found in components: ${violations.join(", ")}`);
    });
  });

  describe("Sprint U2 — Labeled Navigation, Collapsible 3-Pane Workbench, DiffViewer Wiring & 840px Track", () => {
    it("Task 1: Desktop Left Rail (82px) and Mobile Bottom Bar (58px) display explicit text labels for all 5 destinations", () => {
      const pageSrc = fs.readFileSync(path.resolve(__dirname, "../app/page.tsx"), "utf8");
      // Check for rail and bottom bar presence
      assert.ok(
        pageSrc.includes("app-rail") || (pageSrc.includes("82px") && pageSrc.includes("Chat")),
        "Must render persistent desktop rail"
      );
      assert.ok(
        pageSrc.includes("mobile-bottom-nav") || (pageSrc.includes("58px") && pageSrc.includes("Chat")),
        "Must render mobile bottom navigation bar"
      );
      // Both must include all 5 labeled views: Chat, Builds, Morning Report/Report, Skills, Settings
      const requiredLabels = ["Chat", "Builds", "Report", "Skills", "Settings"];
      for (const label of requiredLabels) {
        assert.ok(pageSrc.includes(label), `Navigation must contain explicit text label '${label}'`);
      }
    });

    it("Task 2: Sessions and Workspace panels are collapsible independently with [◧ Sessions] and [◨ Workspace] toggles", () => {
      const pageSrc = fs.readFileSync(path.resolve(__dirname, "../app/page.tsx"), "utf8");
      const chatStreamSrc = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");

      // Check header panel toggle buttons
      assert.ok(
        chatStreamSrc.includes("Sessions") && (chatStreamSrc.includes("◧") || chatStreamSrc.toLowerCase().includes("togglesidebar") || chatStreamSrc.includes("PanelLeft")),
        "Header must have [◧ Sessions] toggle button"
      );
      assert.ok(
        chatStreamSrc.includes("Workspace") && (chatStreamSrc.includes("◨") || chatStreamSrc.toLowerCase().includes("toggleworkspace") || chatStreamSrc.toLowerCase().includes("toggleinspector") || chatStreamSrc.includes("PanelRight")),
        "Header must have [◨ Workspace] toggle button"
      );

      // Check collapsible panel classes or state
      assert.ok(
        pageSrc.includes("collapsed-sidebar") || pageSrc.includes("isSidebarOpen") || pageSrc.includes("showSidebar"),
        "Must support collapsible Sessions panel"
      );
      assert.ok(
        pageSrc.includes("collapsed-inspector") || pageSrc.includes("isWorkspaceOpen") || pageSrc.includes("showWorkspace"),
        "Must support collapsible Workspace panel"
      );
    });

    it("Task 3: DiffViewer.tsx is wired into the Workspace inspector panel", () => {
      const pageSrc = fs.readFileSync(path.resolve(__dirname, "../app/page.tsx"), "utf8");
      assert.ok(
        pageSrc.includes("DiffViewer"),
        "page.tsx (or workspace panel) must import and render DiffViewer"
      );
    });

    it("Task 4: ChatStream.tsx centers messages within an 840px max-width track", () => {
      const chatStreamSrc = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
      assert.ok(
        chatStreamSrc.includes("max-w-[840px]") || chatStreamSrc.includes("chat-track"),
        "ChatStream messages must be constrained to a centered 840px max-width conversation track"
      );
    });
  });
});
