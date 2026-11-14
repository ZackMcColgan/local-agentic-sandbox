import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsView } from "../components/SettingsView";
import { ProjectsView } from "../components/ProjectsView";

describe("E3: Flash-Next model identity & LOW effort default (UI-035)", () => {
  it("SettingsView displays 'Flash-Next' and 'Low' by default", () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsView, {
        theme: "dark",
        onThemeChange: () => {},
        onResetOnboarding: () => {},
      })
    );
    assert.equal(html.includes("Flash-Next"), true, "Expected SettingsView to display 'Flash-Next'");
    assert.equal(html.includes("Fast"), true, "Expected SettingsView to display 'Fast' (low effort)");
    assert.equal(html.includes("swift-15-27b-mtp"), false, "Expected no stale 'swift-15-27b-mtp'");
  });

  it("ProjectsView displays 'Engine: Flash-Next' instead of 'Swift 1.5'", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProjectsView, {})
    );
    assert.equal(html.includes("Swift 1.5"), false, "Expected no stale 'Swift 1.5' in ProjectsView");
  });
});

describe("E7: Settings view nits (UI-043)", () => {
  it("Self-Deploy section contains href='#settings-danger-zone' matching id='settings-danger-zone'", () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsView, {
        theme: "dark",
        onThemeChange: () => {},
        onResetOnboarding: () => {},
      })
    );
    assert.ok(html.includes('href="#settings-danger-zone"'), "Expected href='#settings-danger-zone'");
    assert.ok(html.includes('id="settings-danger-zone"'), "Expected id='settings-danger-zone'");
    assert.equal(html.includes("Stop engine to reclaim 16GB VRAM."), false, "Expected duplicate VRAM sentence trimmed");
  });
});
