import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsView, getHostCardPresentation } from "../components/SettingsView";
import { ProjectsView } from "../components/ProjectsView";

describe("E3: Flash-Next model identity & LOW effort default (UI-035)", () => {
  it("SettingsView displays 'Flash-Next' and 'Low' by default", () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsView as any, {
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
      React.createElement(ProjectsView as any, {})
    );
    assert.equal(html.includes("Swift 1.5"), false, "Expected no stale 'Swift 1.5' in ProjectsView");
  });
});

describe("E7: Settings view nits (UI-043)", () => {
  it("Self-Deploy section contains href='#settings-danger-zone' matching id='settings-danger-zone'", () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsView as any, {
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

describe("Settings engine card honesty", () => {
  it("does not fabricate llama.cpp identity, GPU name, or 16,384 MB VRAM when unreported", () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsView as any, {
        theme: "dark",
        onThemeChange: () => {},
      })
    );
    assert.equal(html.includes("Standalone llama.cpp"), false, "Should not hardcode 'Standalone llama.cpp'");
    assert.equal(html.includes("AMD Radeon RX 9070 XT"), false, "Should not hardcode GPU model");
    assert.equal(html.includes("16,384 MB"), false, "Should not fabricate 16,384 MB VRAM");
    assert.ok(
      html.toLowerCase().includes("not reported by this engine"),
      "Should display explicit 'not reported by this engine' copy when VRAM is null"
    );
  });
});

describe("Settings host card MISMATCH state", () => {
  it("renders MISMATCH distinctly from DISABLED, UNAVAILABLE, and READY", () => {
    const mismatch = getHostCardPresentation({
      hostAccessEnabled: true,
      runnerAvailable: false,
      runnerState: "MISMATCH",
    });
    const unavailable = getHostCardPresentation({
      hostAccessEnabled: true,
      runnerAvailable: false,
      runnerState: "UNAVAILABLE",
    });
    const ready = getHostCardPresentation({
      hostAccessEnabled: true,
      runnerAvailable: true,
      runnerState: "READY",
    });
    const disabled = getHostCardPresentation({
      hostAccessEnabled: false,
      runnerAvailable: false,
      runnerState: "DISABLED",
    });

    assert.notEqual(mismatch.badgeLabel, unavailable.badgeLabel);
    assert.notEqual(mismatch.badgeLabel, ready.badgeLabel);
    assert.notEqual(mismatch.badgeLabel, disabled.badgeLabel);
    assert.ok(
      mismatch.badgeLabel.toLowerCase().includes("mismatch"),
      `Expected mismatch badge label, got: ${mismatch.badgeLabel}`
    );
    assert.ok(
      mismatch.reasonText.toLowerCase().includes("match") ||
        mismatch.reasonText.toLowerCase().includes("mismatch"),
      `Expected mismatch explanation copy, got: ${mismatch.reasonText}`
    );
  });
});
