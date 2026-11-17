import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
  shouldAdvertiseUnattendedGitTools,
  UNATTENDED_GIT_TOOLS_DEFINITIONS
} from "../lib/hostMode";
import {
  getHostSettings,
  setHostSettings,
  getHostSettingsFilePath
} from "../lib/hostSettings";

describe("Unattended Host Git Tool Admission & Settings (Part 1)", () => {
  const originalSettingsDir = process.env.SETTINGS_DIR;
  let tempSettingsDir: string;

  beforeEach(() => {
    tempSettingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-settings-test-"));
    process.env.SETTINGS_DIR = tempSettingsDir;
  });

  afterEach(() => {
    process.env.SETTINGS_DIR = originalSettingsDir;
    try {
      fs.rmSync(tempSettingsDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Two-Key Admission Gate (Key a: Settings Switch)", () => {
    it("advertises zero git verbs when settings switch is false even if capability is present and runner is ready", () => {
      const capability = { repo: "local-agentic-sandbox", branch: "feature/my-task" };
      const admitted = shouldAdvertiseUnattendedGitTools(false, capability, "READY");
      assert.equal(admitted, false);
    });

    it("advertises zero git verbs when capability is missing even if settings switch is true", () => {
      const admittedNoCap = shouldAdvertiseUnattendedGitTools(true, null, "READY");
      assert.equal(admittedNoCap, false);

      const admittedEmptyCap = shouldAdvertiseUnattendedGitTools(true, { repo: "", branch: "" }, "READY");
      assert.equal(admittedEmptyCap, false);
    });

    it("advertises zero git verbs when host runner is not ready even if settings and capability are valid", () => {
      const capability = { repo: "local-agentic-sandbox", branch: "feature/my-task" };
      const admittedDisabled = shouldAdvertiseUnattendedGitTools(true, capability, "DISABLED");
      assert.equal(admittedDisabled, false);

      const admittedUnavailable = shouldAdvertiseUnattendedGitTools(true, capability, "UNAVAILABLE");
      assert.equal(admittedUnavailable, false);
    });

    it("admits git verbs only when settings is true, capability is valid, and runner is READY", () => {
      const capability = { repo: "local-agentic-sandbox", branch: "feature/my-task" };
      const admitted = shouldAdvertiseUnattendedGitTools(true, capability, "READY");
      assert.equal(admitted, true);
    });

    it("verifies UNATTENDED_GIT_TOOLS_DEFINITIONS exports all 11 railed git verbs", () => {
      const names = UNATTENDED_GIT_TOOLS_DEFINITIONS.map((t) => t.function.name);
      assert.equal(names.length, 11);
      assert.ok(names.includes("host_git_status"));
      assert.ok(names.includes("host_git_fetch"));
      assert.ok(names.includes("host_git_pull_ff"));
      assert.ok(names.includes("host_git_branch_create"));
      assert.ok(names.includes("host_git_checkout"));
      assert.ok(names.includes("host_git_add"));
      assert.ok(names.includes("host_git_commit"));
      assert.ok(names.includes("host_git_push"));
      assert.ok(names.includes("host_git_pr_create"));
      assert.ok(names.includes("host_git_pr_status"));
      assert.ok(names.includes("host_git_pr_merge"));
    });
  });

  describe("Settings Persistence", () => {
    it("defaults allowUnattendedHostGit to false", () => {
      const s = getHostSettings();
      assert.equal(s.allowUnattendedHostGit, false);
    });

    it("persists allowUnattendedHostGit updates to disk", () => {
      const updated = setHostSettings({ allowUnattendedHostGit: true });
      assert.equal(updated.allowUnattendedHostGit, true);

      const reloaded = getHostSettings();
      assert.equal(reloaded.allowUnattendedHostGit, true);
    });
  });
});
