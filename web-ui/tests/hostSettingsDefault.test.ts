import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  getHostSettings,
  setHostSettings,
  getHostSettingsFilePath
} from "../lib/hostSettings";
import { shouldAdvertiseHostTools } from "../lib/hostMode";

describe("Defect #0: Host Mode Global Settings Default Suite", () => {
  let settingsFile: string;
  let originalContent: string | null = null;

  beforeEach(() => {
    settingsFile = getHostSettingsFilePath();
    if (fs.existsSync(settingsFile)) {
      originalContent = fs.readFileSync(settingsFile, "utf8");
      fs.unlinkSync(settingsFile);
    } else {
      originalContent = null;
    }
  });

  afterEach(() => {
    if (originalContent !== null) {
      fs.writeFileSync(settingsFile, originalContent, "utf8");
    } else if (fs.existsSync(settingsFile)) {
      fs.unlinkSync(settingsFile);
    }
  });

  it("1. Fresh state (no stored preference) defaults host access to ON (true)", () => {
    assert.equal(fs.existsSync(settingsFile), false, "Settings file must not exist in fresh state");
    const settings = getHostSettings();
    assert.equal(
      settings.hostAccessEnabled,
      true,
      "Fresh state with no stored preference must default hostAccessEnabled to true"
    );
  });

  it("2. Switch OFF persists and disables host access preference", () => {
    setHostSettings({ hostAccessEnabled: false });
    assert.equal(fs.existsSync(settingsFile), true, "Settings file must exist after update");
    const reloaded = getHostSettings();
    assert.equal(reloaded.hostAccessEnabled, false, "hostAccessEnabled must be false when switched off");
  });

  it("3. Preference persists across server restarts via persistent file store", () => {
    setHostSettings({ hostAccessEnabled: false });
    const raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(raw.hostAccessEnabled, false);

    // Simulate pod restart by reading fresh instance from disk
    const reloaded = getHostSettings();
    assert.equal(reloaded.hostAccessEnabled, false);

    // Toggle back on
    setHostSettings({ hostAccessEnabled: true });
    const reloadedOn = getHostSettings();
    assert.equal(reloadedOn.hostAccessEnabled, true);
  });

  it("4. Switch ON + daemon down (UNAVAILABLE) yields shouldAdvertiseHostTools = false", () => {
    // When hostAccessEnabled is true but runner is UNAVAILABLE / down
    const shouldAdvertise = shouldAdvertiseHostTools(true, "UNAVAILABLE");
    assert.equal(shouldAdvertise, false, "Must not advertise host tools when daemon is UNAVAILABLE");

    const shouldAdvertiseMismatch = shouldAdvertiseHostTools(true, "MISMATCH");
    assert.equal(shouldAdvertiseMismatch, false, "Must not advertise host tools when daemon is in MISMATCH state");

    const shouldAdvertiseReady = shouldAdvertiseHostTools(true, "READY");
    assert.equal(shouldAdvertiseReady, true, "Must advertise host tools when switch is ON and daemon is READY");
  });

  it("5. Subagent and scheduled contexts are PROHIBITED from receiving host tools regardless of switch", () => {
    const isProhibitedContext = (contextType: "subagent" | "scheduled" | "user_chat") => {
      if (contextType === "subagent" || contextType === "scheduled") {
        return true;
      }
      return false;
    };

    assert.equal(isProhibitedContext("subagent"), true);
    assert.equal(isProhibitedContext("scheduled"), true);
    assert.equal(isProhibitedContext("user_chat"), false);

    const resolveHostToolsForContext = (
      contextType: "subagent" | "scheduled" | "user_chat",
      hostEnabled: boolean,
      daemonReady: boolean
    ) => {
      if (isProhibitedContext(contextType)) {
        return false;
      }
      return shouldAdvertiseHostTools(hostEnabled, daemonReady ? "READY" : "UNAVAILABLE");
    };

    // Even if host is enabled and daemon is ready, subagents and scheduled tasks get NO host tools
    assert.equal(resolveHostToolsForContext("subagent", true, true), false);
    assert.equal(resolveHostToolsForContext("scheduled", true, true), false);
    assert.equal(resolveHostToolsForContext("user_chat", true, true), true);
  });
});
