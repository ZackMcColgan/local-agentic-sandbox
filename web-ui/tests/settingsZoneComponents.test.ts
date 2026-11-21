import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveStatusStrip } from "../components/settings/LiveStatusStrip";
import { AppearanceZone } from "../components/settings/AppearanceZone";
import { EngineZone } from "../components/settings/EngineZone";
import { SelfDeployZone } from "../components/settings/SelfDeployZone";
import { HostZone } from "../components/settings/HostZone";
import { NotificationsZone } from "../components/settings/NotificationsZone";
import { MemoryZone } from "../components/settings/MemoryZone";
import { AboutZone } from "../components/settings/AboutZone";
import { TracesZone } from "../components/settings/TracesZone";
import { DangerZone } from "../components/settings/DangerZone";
import { getHostCardPresentation, formatEngineActionMessage } from "../components/settings/hostCard";

describe("Settings zone components — Step 1 (Top zones)", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    win = new GlobalWindow({ url: "http://localhost:3000" });
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;
    const div = win.document.createElement("div");
    win.document.body.appendChild(div);
    container = div as unknown as HTMLDivElement;
  });

  afterEach(() => {
    if (root) root.unmount();
    root = null;
  });

  it("LiveStatusStrip renders engine, host, model, and last deploy values", () => {
    const html = renderToStaticMarkup(
      React.createElement(LiveStatusStrip, {
        engineDotClass: "bg-emerald-500",
        engineStatusLabel: "Running",
        hostDotClass: "bg-emerald-500",
        hostStatusLabel: "Connected",
        stripModel: "qwen3.8-flash-next",
        latestDeployLabel: "abc1234 · Deployed",
      })
    );
    assert.ok(html.includes("Running"));
    assert.ok(html.includes("Connected"));
    assert.ok(html.includes("qwen3.8-flash-next"));
    assert.ok(html.includes("abc1234 · Deployed"));
  });

  it("AppearanceZone invokes onThemeChange when theme buttons are clicked", async () => {
    const selected: string[] = [];
    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(AppearanceZone, {
          themeMode: "dark",
          onThemeChange: (mode) => selected.push(mode),
        })
      );
    });
    assert.ok(container.innerHTML.includes("Dark — low light comfort with high contrast."));
    const buttons = Array.from(container.querySelectorAll("button"));
    const lightBtn = buttons.find((b) => b.textContent?.includes("Light"));
    const systemBtn = buttons.find((b) => b.textContent?.includes("System"));
    assert.ok(lightBtn && systemBtn, "Light and System buttons rendered");
    await act(async () => {
      lightBtn!.click();
      systemBtn!.click();
    });
    assert.deepEqual(selected, ["light", "system"]);
  });

  it("EngineZone renders controls, disables Start when running, and dispatches actions", async () => {
    const actions: string[] = [];
    let openedSheet = false;
    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(EngineZone, {
          engineData: {
            status: "running",
            reachable: true,
            engine: "llama-server",
            backend: "ROCm",
            model: null,
            vram_mb: null,
          },
          engineLoading: false,
          engineMessage: "Ready",
          activeModel: "qwen3.8-flash-next-gyro-gyro-s",
          reasoningEffort: "medium",
          onEngineAction: (a) => actions.push(a),
          onOpenModelSheet: () => {
            openedSheet = true;
          },
        })
      );
    });

    assert.ok(container.innerHTML.includes("Engine Management"));
    assert.ok(container.innerHTML.includes("llama-server"));
    assert.ok(container.innerHTML.includes("Not reported by this engine"));
    assert.ok(container.innerHTML.includes("Balanced"));
    assert.ok(container.innerHTML.includes("Ready"));

    const startBtn = container.querySelector(
      '[aria-label="Start llama-server"]'
    ) as HTMLButtonElement;
    const stopBtn = container.querySelector(
      '[aria-label="Stop llama-server"]'
    ) as HTMLButtonElement;
    const restartBtn = container.querySelector(
      '[aria-label="Restart llama-server"]'
    ) as HTMLButtonElement;
    assert.equal(startBtn.disabled, true, "Start is disabled when running");
    assert.equal(stopBtn.disabled, false, "Stop is enabled when running");
    assert.equal(restartBtn.disabled, false, "Restart is enabled when running");

    await act(async () => {
      stopBtn.click();
      restartBtn.click();
    });
    assert.deepEqual(actions, ["stop", "restart"]);

    const modelRow = Array.from(container.querySelectorAll("div")).find((d) =>
      d.textContent?.includes("Default model") && d.className.includes("cursor-pointer")
    );
    assert.ok(modelRow, "Default model row exists");
    await act(async () => {
      modelRow!.click();
    });
    assert.equal(openedSheet, true);
  });
});

describe("Settings zone components — Step 2 (Middle zones)", () => {
  it("SelfDeployZone renders status and deploy history cap", () => {
    const html = renderToStaticMarkup(
      React.createElement(SelfDeployZone, {
        isSelfDeployActive: true,
        deployHistory: [
          {
            deployId: "d1",
            timestamp: new Date().toISOString(),
            branchName: "feature/one",
            previousSha: "1111111",
            newSha: "2222222",
            status: "deployed",
            rollbackStatus: "none",
          },
        ],
        deployHistoryExpanded: false,
        onToggleDeployHistoryExpanded: () => {},
      })
    );
    assert.ok(html.includes("Self-deploy is ON"));
    assert.ok(html.includes("feature/one"));
  });

  it("HostZone renders host presentation and git activity", () => {
    const presentation = getHostCardPresentation({
      hostAccessEnabled: true,
      runnerAvailable: true,
      runnerState: "READY",
    });
    const html = renderToStaticMarkup(
      React.createElement(HostZone, {
        hostSettings: {
          hostAccessEnabled: true,
          allowUnattendedHostGit: false,
          jobChunkingEnabled: true,
          runnerAvailable: true,
          recentActivity: [],
        },
        hostPresentation: presentation,
        gitActivityExpanded: false,
        onToggleHostAccess: () => {},
        onToggleJobChunking: () => {},
        onToggleUnattendedGit: () => {},
        onToggleGitActivityExpanded: () => {},
      })
    );
    assert.ok(html.includes("Host Access"));
    assert.ok(html.includes("Job chunking"));
    assert.ok(html.includes("No unattended git operations recorded yet."));
  });

  it("NotificationsZone renders Telegram status and test button", () => {
    const html = renderToStaticMarkup(
      React.createElement(NotificationsZone, {
        notifStatus: { configured: true, enabled: true },
        notifTesting: false,
        notifTestMessage: "Test sent!",
        onToggleNotifications: () => {},
        onTestNotification: () => {},
        onDismissError: () => {},
      })
    );
    assert.ok(html.includes("Telegram Notifications"));
    assert.ok(html.includes("Connected"));
    assert.ok(html.includes("Test sent!"));
  });

  it("MemoryZone renders counter, privacy note, and save button", () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryZone, {
        memoryText: "hello",
        memoryMessage: "Saved.",
        memorySaving: false,
        memoryTextareaRef: { current: null },
        onMemoryTextChange: () => {},
        onSaveMemory: () => {},
      })
    );
    assert.ok(html.includes("5 / 2000"));
    assert.ok(html.includes("Saved."));
    assert.ok(html.includes("Stored on this machine only. Never committed to the repository."));
    assert.equal(formatEngineActionMessage("start", true, 200, {}), "Engine starting up...");
  });
});

describe("Settings zone components — Step 3 (Bottom zones)", () => {
  it("AboutZone renders app version", () => {
    const html = renderToStaticMarkup(React.createElement(AboutZone, { appVersion: "1.2.3" }));
    assert.ok(html.includes("Local Agentic Sandbox"));
    assert.ok(html.includes("v1.2.3"));
  });

  it("TracesZone renders Jaeger link", () => {
    const html = renderToStaticMarkup(React.createElement(TracesZone));
    assert.ok(html.includes("OpenTelemetry Traces"));
    assert.ok(html.includes('href="/jaeger/"'));
  });

  it("DangerZone renders Enable self-deploy switch with aria-checked", () => {
    const html = renderToStaticMarkup(
      React.createElement(DangerZone, {
        isSelfDeployActive: true,
        onToggleSelfDeploy: () => {},
      })
    );
    assert.ok(html.includes("Danger Zone"));
    assert.ok(html.includes("Enable self-deploy"));
    assert.ok(html.includes('aria-checked="true"'));
  });
});
