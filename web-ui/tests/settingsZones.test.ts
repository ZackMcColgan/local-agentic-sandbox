import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SettingsView } from "../components/SettingsView";

// uir-3: Settings reorganized into zones — Live Status Strip (pinned top),
// Appearance, Engine (incl. Models), Self-Deploy, Host & Git, Telegram,
// Memory, and a separated red Danger Zone pinned at the bottom.
// Long lists (deploy history, git activity) are capped at 2 + expand.

const ZONE_ORDER = [
  "settings-live-status-strip",
  "settings-zone-appearance",
  "settings-zone-engine",
  "settings-zone-self-deploy",
  "settings-host-git-card",
  "settings-notifications-card",
  "settings-memory-card",
  "settings-zone-danger"
];

describe("uir-3 Settings zones", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root | null = null;
  let gitActivity: any[] = [];

  const installFetch = () => {
    (globalThis as any).fetch = async (url: string, init?: any) => {
      const u = String(url);
      if (u.includes("/api/engine")) {
        if (init && init.method === "POST") {
          return { ok: true, json: async () => ({ message: "ok" }) };
        }
        return {
          ok: true,
          json: async () => ({
            status: "starting",
            reachable: true,
            model: "qwen3.8-flash-next-test",
            vram_mb: 16384
          })
        };
      }
      if (u.includes("/api/settings/host")) {
        if (init && init.method === "POST") {
          return { ok: true, json: async () => ({ hostAccessEnabled: true, allowUnattendedHostGit: false }) };
        }
        return {
          ok: true,
          json: async () => ({
            hostAccessEnabled: true,
            allowUnattendedHostGit: false,
            runnerAvailable: true,
            recentActivity: gitActivity
          })
        };
      }
      if (u.includes("/api/settings/notifications")) {
        return { ok: true, json: async () => ({ configured: true, enabled: true }) };
      }
      if (u.includes("/api/settings/memory")) {
        return { ok: true, json: async () => ({ text: "", updatedAt: new Date().toISOString() }) };
      }
      return { ok: true, json: async () => ({}) };
    };
  };

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    win = new GlobalWindow({ url: "http://localhost:3000" });
    globalThis.window = win as any;
    globalThis.document = win.document as any;
    globalThis.localStorage = win.localStorage as any;
    gitActivity = [];
    installFetch();
    const div = win.document.createElement("div");
    win.document.body.appendChild(div);
    container = div as unknown as HTMLDivElement;
  });

  afterEach(() => {
    if (root) root.unmount();
    root = null;
  });

  const render = async (props: any = {}) => {
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SettingsView, { onBack: () => {}, ...props }));
    });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  const zoneEl = (testid: string) => container.querySelector(`[data-testid="${testid}"]`) as any;

  it("renders all zones in the specified top-to-bottom order", async () => {
    await render();
    const html = container.innerHTML;
    let lastIdx = -1;
    for (const testid of ZONE_ORDER) {
      const idx = html.indexOf(`data-testid="${testid}"`);
      assert.ok(idx > -1, `zone ${testid} is rendered`);
      assert.ok(idx > lastIdx, `zone ${testid} appears after the previous zone`);
      lastIdx = idx;
    }
  });

  it("Live Status Strip shows live engine, host, model, and last-deploy values", async () => {
    await render({
      deployHistory: [
        {
          deployId: "dep-9",
          timestamp: new Date().toISOString(),
          branchName: "feature/example",
          previousSha: "0000000aaaa",
          newSha: "abc1234ffff",
          status: "deployed",
          rollbackStatus: "none"
        }
      ]
    });
    const strip = zoneEl("settings-live-status-strip");
    assert.ok(strip, "status strip exists");
    const stripHtml = strip.innerHTML;
    // Engine status comes from the /api/engine fetch (mock reports "starting",
    // which differs from the component's initial "running" state).
    assert.ok(stripHtml.includes("Starting"), "strip shows live engine status from /api/engine");
    // Host status comes from /api/settings/host (enabled + runner available).
    assert.ok(stripHtml.includes("Connected"), "strip shows live host connection status");
    // Model comes from the engine payload, not a hardcoded string.
    assert.ok(stripHtml.includes("qwen3.8-flash-next-test"), "strip shows the live engine model");
    // Deploy version comes from the deploy history prop (latest newSha, short form).
    assert.ok(stripHtml.includes("abc1234"), "strip shows the latest deploy SHA");
  });

  it("status strip is sticky so it stays pinned while Settings scrolls", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../components/SettingsView.tsx"), "utf8");
    const stripIdx = src.indexOf('data-testid="settings-live-status-strip"');
    assert.ok(stripIdx > -1, "strip testid present in source");
    const around = src.slice(Math.max(0, stripIdx - 400), stripIdx + 100);
    assert.ok(around.includes("sticky"), "strip container uses sticky positioning");
  });

  it("Engine zone contains the engine controls and the Models row", async () => {
    await render();
    const engineZone = zoneEl("settings-zone-engine");
    assert.ok(engineZone, "engine zone exists");
    assert.ok(
      engineZone.querySelector('[aria-label="Start llama-server"]'),
      "Start control lives in the Engine zone"
    );
    assert.ok(
      engineZone.querySelector('[aria-label="Stop llama-server"]'),
      "Stop control lives in the Engine zone"
    );
    assert.ok(
      engineZone.querySelector('[aria-label="Restart llama-server"]'),
      "Restart control lives in the Engine zone"
    );
    assert.ok(engineZone.innerHTML.includes("Default model"), "Models row lives in the Engine zone");
  });

  it("header-era controls exist exactly once (moved, not duplicated)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../components/SettingsView.tsx"), "utf8");
    for (const testid of ["host-access-toggle-btn", "notifications-test-btn", "settings-memory-textarea"]) {
      const count = src.split(`data-testid="${testid}"`).length - 1;
      assert.equal(count, 1, `${testid} appears exactly once in SettingsView source`);
    }
  });

  it("kill switch lives in the Danger Zone at the bottom, not in Self-Deploy, and still toggles", async () => {
    await render();
    const danger = zoneEl("settings-zone-danger");
    const selfDeploy = zoneEl("settings-zone-self-deploy");
    assert.ok(danger, "danger zone exists");
    assert.ok(selfDeploy, "self-deploy zone exists");
    const toggle = danger.querySelector('[data-testid="self-deploy-kill-switch-btn"]') as any;
    assert.ok(toggle, "kill switch toggle is inside the Danger Zone");
    assert.equal(
      selfDeploy.querySelector('[data-testid="self-deploy-kill-switch-btn"]'),
      null,
      "kill switch is not duplicated inside the Self-Deploy zone"
    );
    assert.ok(danger.innerHTML.includes("Danger Zone"), "danger zone is labeled");
    assert.equal(toggle.getAttribute("aria-checked"), "false", "kill switch starts OFF");
    await act(async () => {
      toggle.click();
    });
    assert.equal(toggle.getAttribute("aria-checked"), "true", "kill switch toggles ON from the Danger Zone");
  });

  it("deploy history is capped at 2 entries with an expand control", async () => {
    const mk = (n: number) => ({
      deployId: `dep-${n}`,
      timestamp: new Date(Date.now() - n * 1000).toISOString(),
      branchName: `branch-${n}`,
      previousSha: `prev-${n}`,
      newSha: `newsha-${n}`,
      status: "deployed" as const,
      rollbackStatus: "none" as const
    });
    await render({ deployHistory: [mk(1), mk(2), mk(3), mk(4)] });
    const zone = zoneEl("settings-zone-self-deploy");
    assert.ok(zone.innerHTML.includes("branch-1"), "first entry visible");
    assert.ok(zone.innerHTML.includes("branch-2"), "second entry visible");
    assert.ok(!zone.innerHTML.includes("branch-3"), "third entry hidden while collapsed");
    assert.ok(!zone.innerHTML.includes("branch-4"), "fourth entry hidden while collapsed");
    const expandBtn = zone.querySelector('[data-testid="deploy-history-expand-btn"]') as any;
    assert.ok(expandBtn, "expand control exists");
    assert.ok(expandBtn.textContent.includes("Show all 4"), "expand control names the full count");
    await act(async () => {
      expandBtn.click();
    });
    assert.ok(zone.innerHTML.includes("branch-3"), "third entry visible after expand");
    assert.ok(zone.innerHTML.includes("branch-4"), "fourth entry visible after expand");
  });

  it("unattended git activity is capped at 2 entries with an expand control", async () => {
    gitActivity = [1, 2, 3, 4, 5].map((n) => ({
      timestamp: new Date(Date.now() - (5 - n) * 60000).toISOString(),
      verb: `verb-${n}`,
      repo: "local-agentic-sandbox",
      branch: "develop",
      result: "success"
    }));
    installFetch();
    await render();
    const list = container.querySelector('[data-testid="host-git-activity-list"]') as any;
    assert.ok(list, "activity list exists");
    assert.equal(list.children.length, 2, "only 2 activity entries visible while collapsed");
    const expandBtn = container.querySelector('[data-testid="host-git-activity-expand-btn"]') as any;
    assert.ok(expandBtn, "activity expand control exists");
    await act(async () => {
      expandBtn.click();
    });
    const listAfter = container.querySelector('[data-testid="host-git-activity-list"]') as any;
    assert.equal(listAfter.children.length, 5, "all activity entries visible after expand");
  });

  it("static guard: zone order and Danger Zone label are in the source", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../components/SettingsView.tsx"), "utf8");
    let lastIdx = -1;
    for (const testid of ZONE_ORDER) {
      const idx = src.indexOf(`data-testid="${testid}"`);
      assert.ok(idx > lastIdx, `source order: ${testid} after previous zone`);
      lastIdx = idx;
    }
    assert.ok(src.includes("Danger Zone"), "source labels the Danger Zone");
  });
});
