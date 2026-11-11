import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SettingsView } from "../components/SettingsView";

describe("Settings Memory — SettingsView Memory card", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root | null = null;
  let savedBodies: string[] = [];

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    win = new GlobalWindow({ url: "http://localhost:3000" });
    globalThis.window = win as any;
    globalThis.document = win.document as any;
    globalThis.localStorage = win.localStorage as any;

    savedBodies = [];
    (globalThis as any).fetch = async (url: string, init?: any) => {
      if (String(url).includes("/api/settings/memory")) {
        if (init && init.method === "PUT") {
          savedBodies.push(init.body);
          return { ok: true, json: async () => ({ success: true, text: JSON.parse(init.body).text }) };
        }
        return { ok: true, json: async () => ({ text: "existing stored fact", updatedAt: new Date().toISOString() }) };
      }
      return { ok: true, json: async () => ({ hostAccessEnabled: true, allowUnattendedHostGit: false, runnerAvailable: false, recentActivity: [] }) };
    };

    const div = win.document.createElement("div");
    win.document.body.appendChild(div);
    container = div as unknown as HTMLDivElement;
  });

  afterEach(() => {
    if (root) root.unmount();
    root = null;
  });

  it("renders the Memory card with heading, subheading, textarea, counter, note, and Save", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SettingsView, { onBack: () => {} }));
    });
    await act(async () => { await Promise.resolve(); });

    const html = container.innerHTML;
    assert.ok(html.includes("Memory"), "renders Memory heading");
    assert.ok(html.includes("What the assistant should always know"), "renders Memory subheading");
    assert.ok(html.includes("Stored on this machine only. Never committed to the repository."), "renders privacy note");
    assert.ok(html.includes("/ 2000"), "renders live character counter against 2000 cap");

    const textarea = container.querySelector('[data-testid="settings-memory-textarea"]') as any;
    assert.ok(textarea, "textarea bound to stored text exists");
    assert.equal(textarea.value, "existing stored fact", "card loads current saved text on open");

    const saveBtn = container.querySelector('[data-testid="settings-memory-save-btn"]') as any;
    assert.ok(saveBtn, "Save action exists");
  });

  it("typing updates the counter and Save PUTs the text via the memory API", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SettingsView, { onBack: () => {} }));
    });
    await act(async () => { await Promise.resolve(); });

    const textarea = container.querySelector('[data-testid="settings-memory-textarea"]') as any;
    await act(async () => {
      textarea.value = "new standing fact";
      textarea.dispatchEvent(new win.Event("input"));
    });
    assert.ok(container.innerHTML.includes("15 / 2000"), "live counter reflects typed length");

    const saveBtn = container.querySelector('[data-testid="settings-memory-save-btn"]') as any;
    await act(async () => {
      saveBtn.click();
    });
    assert.equal(savedBodies.length, 1, "Save issues exactly one PUT");
    assert.equal(JSON.parse(savedBodies[0]).text, "new standing fact");
  });

  it("counter blocks saving beyond the 2000-character cap", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SettingsView, { onBack: () => {} }));
    });
    await act(async () => { await Promise.resolve(); });

    const textarea = container.querySelector('[data-testid="settings-memory-textarea"]') as any;
    await act(async () => {
      textarea.value = "x".repeat(2001);
      textarea.dispatchEvent(new win.Event("input"));
    });
    assert.ok(container.innerHTML.includes("2001 / 2000"), "counter shows over-cap count");

    const saveBtn = container.querySelector('[data-testid="settings-memory-save-btn"]') as any;
    await act(async () => {
      saveBtn.click();
    });
    assert.equal(savedBodies.length, 0, "Save must be blocked beyond the cap");
  });

  it("empty is a valid state: empty textarea renders with 0 / 2000", async () => {
    (globalThis as any).fetch = async (url: string) => {
      if (String(url).includes("/api/settings/memory")) {
        return { ok: true, json: async () => ({ text: "", updatedAt: new Date().toISOString() }) };
      }
      return { ok: true, json: async () => ({ hostAccessEnabled: true, allowUnattendedHostGit: false, runnerAvailable: false, recentActivity: [] }) };
    };
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SettingsView, { onBack: () => {} }));
    });
    await act(async () => { await Promise.resolve(); });

    const textarea = container.querySelector('[data-testid="settings-memory-textarea"]') as any;
    assert.equal(textarea.value, "", "empty memory renders as empty textarea");
    assert.ok(container.innerHTML.includes("0 / 2000"), "counter shows 0 / 2000");
  });

  it("static guard: SettingsView source contains the exact privacy note verbatim", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../components/SettingsView.tsx"), "utf8");
    assert.ok(
      src.includes("Stored on this machine only. Never committed to the repository."),
      "exact note text must appear in SettingsView source"
    );
  });
});
