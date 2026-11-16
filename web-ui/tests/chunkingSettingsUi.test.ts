import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "fs";
import path from "path";
import { SettingsView } from "../components/SettingsView";

describe("Phase 3: Job Chunking Settings UI", () => {
  it("1. Renders Job chunking toggle with default ON (aria-checked=true) and honest copy", () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsView as any, {
        theme: "dark",
        onThemeChange: () => {},
        onResetOnboarding: () => {},
      })
    );
    assert.ok(html.includes("Job chunking"), "Expected SettingsView to display 'Job chunking'");
    assert.ok(
      html.includes("When off, long jobs run in a single turn without banking checkpoints."),
      "Expected SettingsView to display honest copy for job chunking"
    );
    assert.ok(
      html.includes('data-testid="job-chunking-toggle-btn"'),
      "Expected job-chunking-toggle-btn testid"
    );
    assert.ok(
      html.includes('data-testid="job-chunking-toggle-btn" aria-checked="true"'),
      "Expected job chunking toggle to default to aria-checked='true'"
    );
  });

  it("2. SettingsView reads and writes jobChunkingEnabled through /api/settings/host", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "components", "SettingsView.tsx"),
      "utf8"
    );
    assert.ok(
      src.includes("jobChunkingEnabled: nextState"),
      "Expected SettingsView to POST jobChunkingEnabled to /api/settings/host"
    );
    assert.ok(
      src.includes("handleToggleJobChunking"),
      "Expected handleToggleJobChunking handler in SettingsView"
    );
  });
});
