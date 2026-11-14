import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SettingsView } from "../components/SettingsView";

describe("UI-043: Settings Telegram stale error date & persistent dismiss", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    win = new GlobalWindow();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = win as any;
    globalThis.document = win.document as any;
    globalThis.localStorage = win.localStorage as any;
    origFetch = globalThis.fetch;
    container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    act(() => {
      root.unmount();
    });
    win.close();
  });

  function mockFetchWithError(at: string, errorSummary: string) {
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.includes("/api/settings/notifications")) {
        return {
          ok: true,
          json: async () => ({
            configured: true,
            enabled: true,
            lastResult: {
              ok: false,
              event: "morning_report",
              at,
              errorSummary,
            },
          }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }) as any;
  }

  it("renders error date, dismisses persistently across reload, and re-shows on a new error", async () => {
    const oldAt = new Date(2026, 10, 12, 8, 15, 0).toISOString();
    mockFetchWithError(oldAt, "ETIMEDOUT");

    await act(async () => {
      root.render(React.createElement(SettingsView, { activeModel: "test", onSelectModel: () => {} } as any));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const card = container.querySelector("[data-testid='notifications-last-result']");
    assert.ok(card, "Telegram error card should be visible");
    assert.match(card!.textContent ?? "", /Nov\s+12/, "Error card should include date");

    const dismissBtn = container.querySelector("[data-testid='dismiss-telegram-error-btn']");
    assert.ok(dismissBtn, "Dismiss button should exist for error");

    act(() => {
      dismissBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as any);
    });

    assert.equal(container.querySelector("[data-testid='notifications-last-result']"), null, "Error card should hide after dismiss");

    // Simulate reload: unmount and remount with same error
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(SettingsView, { activeModel: "test", onSelectModel: () => {} } as any));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    assert.equal(container.querySelector("[data-testid='notifications-last-result']"), null, "Dismissed error should stay hidden across reload");

    // New, different error occurs -> re-shows
    const newAt = new Date(2026, 10, 13, 9, 0, 0).toISOString();
    mockFetchWithError(newAt, "ECONNREFUSED");
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(SettingsView, { activeModel: "test", onSelectModel: () => {} } as any));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    const newCard = container.querySelector("[data-testid='notifications-last-result']");
    assert.ok(newCard, "New error should re-show the card");
    assert.match(newCard!.textContent ?? "", /ECONNREFUSED/);
  });
});
