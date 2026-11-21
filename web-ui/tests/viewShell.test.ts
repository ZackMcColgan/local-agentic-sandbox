import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ViewShell, type ViewShellProps } from "../components/ViewShell";
import { DEFAULT_AGENT_MODE, DEFAULT_PRIMARY_MODEL } from "../config/models";
import type { NavView } from "../components/NavigationDrawer";

function makeBaseProps(overrides: Partial<ViewShellProps> = {}): ViewShellProps {
  return {
    activeNavView: "sessions",
    viewMode: "unified",
    isDrawerOpen: false,
    isSidebarOpen: true,
    isWorkspaceOpen: false,
    isExplorerOpen: false,
    isModelSheetOpen: false,
    workspaceTab: "diff",
    selectedWorkspaceFile: null,
    onSetActiveNavView: () => {},
    onSetViewMode: () => {},
    onSetDrawerOpen: () => {},
    onSetSidebarOpen: () => {},
    onSetWorkspaceOpen: () => {},
    onSetExplorerOpen: () => {},
    onSetModelSheetOpen: () => {},
    onSetWorkspaceTab: () => {},
    onSetSelectedWorkspaceFile: () => {},
    onNavigate: () => {},
    onPreviewWorkspaceFile: () => {},
    threads: [],
    isLoadingThreads: false,
    selectedThreadId: null,
    currentThread: null,
    messages: [],
    setMessages: () => {},
    draftComposerPrompt: null,
    onClearDraftPrompt: () => {},
    traces: [],
    onTracesUpdate: () => {},
    initialSimulation: null,
    onSelectThread: () => {},
    onBackToList: () => {},
    onNewThread: () => {},
    onDeleteThread: () => {},
    onEnsureThread: async () => null,
    onThreadUpdated: () => {},
    agentMode: DEFAULT_AGENT_MODE,
    selectedModel: DEFAULT_PRIMARY_MODEL,
    reasoningEffort: "low",
    installedModels: [],
    securityPosture: undefined,
    onModelChange: () => {},
    onReasoningChange: () => {},
    activeTask: null,
    tasks: [],
    plannedFiles: [],
    onSetActiveTask: () => {},
    onLaunchTask: async () => {},
    onStopRun: async () => {},
    onDeployRun: async () => {},
    boardItems: [],
    boardControlState: "stopped",
    boardStopAtBoundary: false,
    isBoardControlPending: false,
    onBoardItemCreated: () => {},
    onBoardControlAction: () => {},
    onAskAssistantFromBoard: () => {},
    projects: [],
    selectedProjectId: null,
    onSelectProject: () => {},
    onRegisterProject: async () => {},
    onToggleAllowlist: async () => {},
    onDeleteProject: async () => {},
    pendingSkillsCount: 0,
    selfDeployEnabled: false,
    onToggleSelfDeploy: () => {},
    deployHistory: [],
    morningReport: null,
    overnightReport: null,
    ...overrides,
  };
}

describe("ViewShell presentational component", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    win = new GlobalWindow();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;
    globalThis.localStorage = win.localStorage as unknown as Storage;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({}),
      }) as unknown as Response) as typeof globalThis.fetch;
    container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(
      container as unknown as Parameters<typeof win.document.body.appendChild>[0]
    );
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    globalThis.fetch = originalFetch;
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("renders the primary navigation rail and invokes view callbacks on rail clicks", async () => {
    const navCalls: NavView[] = [];
    const modeCalls: Array<"unified" | "security"> = [];

    await act(async () => {
      root.render(
        React.createElement(
          ViewShell,
          makeBaseProps({
            activeNavView: "sessions",
            pendingSkillsCount: 3,
            onSetActiveNavView: (v) => navCalls.push(v),
            onSetViewMode: (m) => modeCalls.push(m),
          })
        )
      );
    });

    const rail = container.querySelector('nav[aria-label="Primary Navigation"]');
    assert.ok(rail, "Primary navigation rail must render");

    const boardBtn = rail.querySelector('button[title="Board"]') as HTMLButtonElement;
    const settingsBtn = rail.querySelector('button[title="System Settings"]') as HTMLButtonElement;
    const skillsBtn = rail.querySelector('button[title="Skills Flywheel"]') as HTMLButtonElement;
    assert.ok(boardBtn && settingsBtn && skillsBtn, "Rail buttons must render");
    assert.ok(
      (skillsBtn.textContent || "").includes("3"),
      "Skills rail button must show pending count badge"
    );

    await act(async () => {
      boardBtn.click();
      settingsBtn.click();
    });
    assert.deepEqual(navCalls, ["board", "settings"]);
    assert.deepEqual(modeCalls, ["unified", "unified"]);
  });

  it("mounts the active view for sessions, board, projects, settings, skills, morning-report, and security", async () => {
    // Sessions view
    await act(async () => {
      root.render(React.createElement(ViewShell, makeBaseProps({ activeNavView: "sessions" })));
    });
    assert.ok(container.querySelector("main.app-main"), "Sessions main stage must render");

    // Board view
    await act(async () => {
      root.render(React.createElement(ViewShell, makeBaseProps({ activeNavView: "board" })));
    });
    assert.ok(
      (container.textContent || "").includes("Board"),
      "BoardView must render when activeNavView is board"
    );

    // Projects view
    await act(async () => {
      root.render(React.createElement(ViewShell, makeBaseProps({ activeNavView: "projects" })));
    });
    assert.ok(
      (container.textContent || "").includes("Projects"),
      "ProjectsView must render when activeNavView is projects"
    );

    // Settings view
    await act(async () => {
      root.render(React.createElement(ViewShell, makeBaseProps({ activeNavView: "settings" })));
    });
    assert.ok(
      (container.textContent || "").includes("Settings"),
      "SettingsView must render when activeNavView is settings"
    );

    // Skills view
    await act(async () => {
      root.render(React.createElement(ViewShell, makeBaseProps({ activeNavView: "skills" })));
    });
    assert.ok(
      (container.textContent || "").includes("Skills"),
      "SkillsView must render when activeNavView is skills"
    );

    // Morning Report view
    await act(async () => {
      root.render(
        React.createElement(ViewShell, makeBaseProps({ activeNavView: "morning-report" }))
      );
    });
    assert.ok(
      (container.textContent || "").includes("Morning Report"),
      "Morning Report view must render when activeNavView is morning-report"
    );

    // Security Telemetry view
    await act(async () => {
      root.render(
        React.createElement(
          ViewShell,
          makeBaseProps({ activeNavView: "sessions", viewMode: "security" })
        )
      );
    });
    assert.ok(
      (container.textContent || "").includes("System Architecture & Security Telemetry"),
      "Security telemetry view must render when viewMode is security"
    );
  });
});
