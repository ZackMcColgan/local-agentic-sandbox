import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
  loadUserProfile,
  recordProfileEntry,
  extractDurablePreferences,
  formatProfileForContext,
  getUserProfilePath,
  UserProfile,
} from "../lib/memory/profile.js";

describe("Phase C — Tier 1 User Profile Memory Suite", () => {
  it("getUserProfilePath respects USER_PROFILE_PATH and defaults to homedir/.local-agentic-sandbox", () => {
    const originalEnv = process.env.USER_PROFILE_PATH;
    try {
      const custom = path.join(os.tmpdir(), "custom_profile.json");
      process.env.USER_PROFILE_PATH = custom;
      assert.equal(getUserProfilePath(), path.resolve(custom));

      delete process.env.USER_PROFILE_PATH;
      const defaultPath = getUserProfilePath();
      assert.ok(defaultPath.includes(".local-agentic-sandbox"));
      assert.ok(defaultPath.endsWith("user_profile.json"));
    } finally {
      if (originalEnv) {
        process.env.USER_PROFILE_PATH = originalEnv;
      } else {
        delete process.env.USER_PROFILE_PATH;
      }
    }
  });

  it("loads clean default profile when file does not exist", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-test-"));
    const pPath = path.join(tempDir, "missing.json");
    try {
      const profile = loadUserProfile(pPath);
      assert.equal(profile.version, 1);
      assert.deepEqual(profile.entries, {});
      assert.ok(profile.updatedAt);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("corruption resilience: handles garbage bytes without crashing, logs warning, returns empty profile", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-test-"));
    const pPath = path.join(tempDir, "corrupted.json");
    fs.writeFileSync(pPath, "{ invalid json garbage ::: \x00\x01 ]]]", "utf8");
    try {
      const profile = loadUserProfile(pPath);
      assert.equal(profile.version, 1);
      assert.deepEqual(profile.entries, {});
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("gated recording: records explicit user preferences with sourceSessionId, ISO-8601 timestamp, and origin", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-test-"));
    const pPath = path.join(tempDir, "user_profile.json");
    try {
      const sessId = "session_alpha_123";
      const beforeTime = new Date().toISOString();
      const res = recordProfileEntry(
        "preferred_name",
        "Zack",
        {
          sessionId: sessId,
          origin: "user-stated",
        },
        pPath
      );

      assert.equal(res.created, true);
      assert.equal(res.updated, false);
      assert.equal(res.entry.key, "preferred_name");
      assert.equal(res.entry.value, "Zack");
      assert.equal(res.entry.sourceSessionId, sessId);
      assert.equal(res.entry.origin, "user-stated");
      assert.ok(res.entry.timestamp >= beforeTime);
      assert.deepEqual(res.entry.history, []);

      // Verify file persistence on disk
      const loaded = loadUserProfile(pPath);
      assert.equal(loaded.entries["preferred_name"].value, "Zack");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("negative recording: chatter queries produce zero entries and leave profile byte-identical", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-test-"));
    const pPath = path.join(tempDir, "user_profile.json");
    try {
      // Initialize with an established profile
      recordProfileEntry(
        "preferred_name",
        "Zack",
        {
          sessionId: "init_sess",
          origin: "user-stated",
        },
        pPath
      );
      const initialBytes = fs.readFileSync(pPath, "utf8");

      // Test a series of chatter queries
      const chatter = [
        "What is the weather in Tokyo?",
        "Tell me a joke about robots.",
        "Can you help me refactor this function?",
        "Good morning! How are you today?",
        "npm run test",
      ];

      for (const msg of chatter) {
        const extracted = extractDurablePreferences(msg, "chatter_sess");
        assert.equal(extracted.length, 0, `Expected zero extractions for chatter: "${msg}"`);
      }

      // Check byte-identity of the profile file
      const afterBytes = fs.readFileSync(pPath, "utf8");
      assert.equal(
        afterBytes,
        initialBytes,
        "Profile file must remain byte-identical after chatter"
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("corrections: new value supersedes existing value and preserves history with timestamps", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-test-"));
    const pPath = path.join(tempDir, "user_profile.json");
    try {
      const sess1 = "sess_original";
      const sess2 = "sess_correction";

      // 1. Initial statement
      const r1 = recordProfileEntry(
        "preferred_name",
        "Zachary",
        {
          sessionId: sess1,
          origin: "user-stated",
        },
        pPath
      );
      assert.equal(r1.created, true);

      // 2. Correction
      const r2 = recordProfileEntry(
        "preferred_name",
        "Zack",
        {
          sessionId: sess2,
          origin: "corrected",
        },
        pPath
      );
      assert.equal(r2.created, false);
      assert.equal(r2.updated, true);
      assert.equal(r2.entry.value, "Zack");
      assert.equal(r2.entry.origin, "corrected");
      assert.equal(r2.entry.sourceSessionId, sess2);

      // Verify history
      assert.equal(r2.entry.history.length, 1);
      assert.equal(r2.entry.history[0].value, "Zachary");
      assert.equal(r2.entry.history[0].sourceSessionId, sess1);
      assert.equal(r2.entry.history[0].origin, "user-stated");

      // Verify disk state
      const loaded = loadUserProfile(pPath);
      assert.equal(loaded.entries["preferred_name"].value, "Zack");
      assert.equal(loaded.entries["preferred_name"].history.length, 1);
      assert.equal(loaded.entries["preferred_name"].history[0].value, "Zachary");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("schema tolerance: preserves unknown keys additively during load and save", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-test-"));
    const pPath = path.join(tempDir, "user_profile.json");
    try {
      const rawPayload = {
        version: 2,
        entries: {},
        updatedAt: "2026-10-03T00:00:00.000Z",
        customSchemaField: "future_extension_data",
        clusterPreferences: { k8s: true },
      };
      fs.writeFileSync(pPath, JSON.stringify(rawPayload, null, 2), "utf8");

      // Load profile
      const loaded = loadUserProfile(pPath);
      assert.equal(loaded.customSchemaField, "future_extension_data");
      assert.deepEqual(loaded.clusterPreferences, { k8s: true });

      // Add entry and save
      recordProfileEntry("editor", "neovim", { sessionId: "s1" }, pPath);
      const reloaded = loadUserProfile(pPath);
      assert.equal(reloaded.customSchemaField, "future_extension_data");
      assert.deepEqual(reloaded.clusterPreferences, { k8s: true });
      assert.equal(reloaded.entries["editor"].value, "neovim");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("context formatting: formats non-empty profile and returns empty string for empty profile", () => {
    const emptyProfile: UserProfile = { version: 1, entries: {}, updatedAt: "" };
    assert.equal(formatProfileForContext(emptyProfile), "");

    const populated: UserProfile = {
      version: 1,
      entries: {
        preferred_name: {
          key: "preferred_name",
          value: "Zack",
          sourceSessionId: "s1",
          timestamp: new Date().toISOString(),
          origin: "user-stated",
          history: [],
        },
        preferred_language: {
          key: "preferred_language",
          value: "typescript",
          sourceSessionId: "s1",
          timestamp: new Date().toISOString(),
          origin: "user-stated",
          history: [],
        },
      },
      updatedAt: "",
    };

    const formatted = formatProfileForContext(populated);
    assert.ok(formatted.includes("USER PROFILE & DURABLE PREFERENCES"));
    assert.ok(formatted.includes("Always address the user as 'Zack'"));
    assert.ok(formatted.includes("preferred_language: typescript"));
  });

  it("getUserProfilePath prefers WORKSPACE_DIR/.agent/settings/user_profile.json when USER_PROFILE_PATH is unset", () => {
    const origProfilePath = process.env.USER_PROFILE_PATH;
    const origWorkspace = process.env.WORKSPACE_DIR;
    const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "profile-ws-test-"));

    try {
      delete process.env.USER_PROFILE_PATH;
      process.env.WORKSPACE_DIR = tmpWorkspace;

      assert.equal(
        getUserProfilePath(),
        path.join(path.resolve(tmpWorkspace), ".agent", "settings", "user_profile.json")
      );
    } finally {
      if (origProfilePath !== undefined) process.env.USER_PROFILE_PATH = origProfilePath;
      else delete process.env.USER_PROFILE_PATH;
      if (origWorkspace !== undefined) process.env.WORKSPACE_DIR = origWorkspace;
      else delete process.env.WORKSPACE_DIR;
      fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    }
  });

  it("startup migration copies legacy user_profile.json to persistent target when missing, and does not overwrite existing target", () => {
    const origProfilePath = process.env.USER_PROFILE_PATH;
    const origWorkspace = process.env.WORKSPACE_DIR;
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "profile-migrate-test-"));
    const fakeHome = path.join(tmpRoot, "home");
    const fakeWorkspace = path.join(tmpRoot, "workspace");
    const legacyDir = path.join(fakeHome, ".local-agentic-sandbox");
    const legacyPath = path.join(legacyDir, "user_profile.json");
    const targetPath = path.join(fakeWorkspace, ".agent", "settings", "user_profile.json");

    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(fakeWorkspace, { recursive: true });

    try {
      recordProfileEntry("preferred_name", "LegacyUser", { sessionId: "s-legacy" }, legacyPath);

      delete process.env.USER_PROFILE_PATH;
      process.env.WORKSPACE_DIR = fakeWorkspace;
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;

      // Target does not exist yet: loadUserProfile must migrate legacy file to persistent target
      const migrated = loadUserProfile();
      assert.ok(fs.existsSync(targetPath), "Target user_profile.json must be created by migration");
      assert.ok(fs.existsSync(legacyPath), "Legacy source user_profile.json must remain");
      assert.equal(migrated.entries["preferred_name"]?.value, "LegacyUser");

      // Existing target must NOT be overwritten on subsequent load
      const secondTarget = path.join(tmpRoot, "existing", "user_profile.json");
      recordProfileEntry("preferred_name", "ExistingTargetUser", { sessionId: "s-target" }, secondTarget);
      process.env.USER_PROFILE_PATH = secondTarget;

      const loadedExisting = loadUserProfile();
      assert.equal(
        loadedExisting.entries["preferred_name"]?.value,
        "ExistingTargetUser",
        "Migration must NOT overwrite an already-existing target user_profile.json"
      );
    } finally {
      if (origProfilePath !== undefined) process.env.USER_PROFILE_PATH = origProfilePath;
      else delete process.env.USER_PROFILE_PATH;
      if (origWorkspace !== undefined) process.env.WORKSPACE_DIR = origWorkspace;
      else delete process.env.WORKSPACE_DIR;
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
      else delete process.env.USERPROFILE;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
