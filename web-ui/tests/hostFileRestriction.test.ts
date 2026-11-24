import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import http from "node:http";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getHostSettings, setHostSettings, getHostSettingsFilePath } from "../lib/hostSettings";
import {
  isPathWithinAllowedFolders,
  collectPathArguments,
  evaluateFileRestriction,
} from "../lib/hostPathRestriction";
import { executeHostTool } from "../lib/hostMode";
import { HostZone } from "../components/settings/HostZone";
import { SettingsView } from "../components/SettingsView";

/**
 * Board #132 - Host file restriction as an OPT-IN Settings toggle (default OFF).
 * Owner spec: a setting to restrict host file tools to owner-entered folders;
 * the owner can bypass or turn it off at any time; the default must be OFF.
 */
describe("Board #132: Host File Restriction Opt-In Setting", () => {
  let settingsFile: string;
  let originalContent: string | null = null;
  let prevRunnerUrl: string | undefined;
  let prevSettingsDir: string | undefined;
  let isolatedDir: string;

  beforeEach(() => {
    // Isolate the server-side settings store in a temp dir (SETTINGS_DIR override)
    // so concurrent gate-batch processes never read a restriction we toggled ON.
    isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "b132-settings-"));
    prevSettingsDir = process.env.SETTINGS_DIR;
    process.env.SETTINGS_DIR = isolatedDir;
    settingsFile = getHostSettingsFilePath();
    originalContent = null;
    prevRunnerUrl = process.env.HOST_RUNNER_URL;
  });

  afterEach(() => {
    if (prevSettingsDir === undefined) delete process.env.SETTINGS_DIR;
    else process.env.SETTINGS_DIR = prevSettingsDir;
    fs.rmSync(isolatedDir, { recursive: true, force: true });
    if (prevRunnerUrl === undefined) delete process.env.HOST_RUNNER_URL;
    else process.env.HOST_RUNNER_URL = prevRunnerUrl;
  });

  it("1. Fresh state defaults fileRestrictionEnabled to OFF with an empty allowed-paths list", () => {
    assert.equal(fs.existsSync(settingsFile), false, "Settings file must not exist in fresh state");
    const settings = getHostSettings();
    assert.equal(
      settings.fileRestrictionEnabled,
      false,
      "Fresh state must default fileRestrictionEnabled to false (owner does NOT want it turned on)"
    );
    assert.deepEqual(
      settings.allowedHostPaths,
      [],
      "Fresh state must default allowedHostPaths to []"
    );
  });

  it("2. Toggle ON persists; toggle OFF bypasses at any time (server-side file store)", () => {
    setHostSettings({
      fileRestrictionEnabled: true,
      allowedHostPaths: ["C:\\Users\\zackm\\Desktop\\repos"],
    });
    const raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(raw.fileRestrictionEnabled, true);
    assert.deepEqual(raw.allowedHostPaths, ["C:\\Users\\zackm\\Desktop\\repos"]);

    const reloaded = getHostSettings();
    assert.equal(reloaded.fileRestrictionEnabled, true);
    assert.deepEqual(reloaded.allowedHostPaths, ["C:\\Users\\zackm\\Desktop\\repos"]);

    // Owner bypass: turn it off, enforcement stops immediately.
    setHostSettings({ fileRestrictionEnabled: false });
    assert.equal(getHostSettings().fileRestrictionEnabled, false);
  });

  it("3. Allowed-paths list is editable and sanitized (trim, dedupe, drop blanks)", () => {
    setHostSettings({
      fileRestrictionEnabled: true,
      allowedHostPaths: ["  C:\\A\\B  ", "C:\\A\\B", "", "   ", "C:\\C"],
    });
    assert.deepEqual(getHostSettings().allowedHostPaths, ["C:\\A\\B", "C:\\C"]);
  });

  it("4. Folder containment is exact-directory scoped, case- and slash-insensitive", () => {
    const allowed = ["C:\\Users\\zackm\\Desktop\\repos"];
    assert.equal(
      isPathWithinAllowedFolders("C:\\Users\\zackm\\Desktop\\repos\\ls\\a.ts", allowed),
      true
    );
    assert.equal(isPathWithinAllowedFolders("C:\\Users\\zackm\\Desktop\\repos", allowed), true);
    assert.equal(
      isPathWithinAllowedFolders("c:\\users\\zackm\\desktop\\repos\\LS\\a.ts", allowed),
      true
    );
    assert.equal(isPathWithinAllowedFolders("C:/Users/zackm/Desktop/repos/ls/a.ts", allowed), true);
    // Sibling folder sharing a name prefix must NOT match (no naive string-prefix leak).
    assert.equal(
      isPathWithinAllowedFolders("C:\\Users\\zackm\\Desktop\\reposX\\secret.txt", allowed),
      false
    );
    assert.equal(
      isPathWithinAllowedFolders("C:\\Users\\zackm\\Desktop\\other\\a.ts", allowed),
      false
    );
    assert.equal(isPathWithinAllowedFolders("C:\\Windows\\system32\\x.dll", allowed), false);
    // Empty allow-list restricts nothing when the toggle is off; predicate itself is pure.
    assert.equal(isPathWithinAllowedFolders("C:\\anything\\a.ts", []), false);
  });

  it("5. collectPathArguments extracts every path-bearing arg across host file tools", () => {
    assert.deepEqual(collectPathArguments("host_read_file", { path: "C:\\a\\b.txt" }), [
      "C:\\a\\b.txt",
    ]);
    assert.deepEqual(collectPathArguments("host_read_file", { paths: ["C:\\a", "C:\\b"] }), [
      "C:\\a",
      "C:\\b",
    ]);
    assert.deepEqual(collectPathArguments("host_read_file", { path: "C:\\a", paths: ["C:\\b"] }), [
      "C:\\a",
      "C:\\b",
    ]);
    assert.deepEqual(
      collectPathArguments("host_write_file", { path: "C:\\a\\new.txt", content: "x" }),
      ["C:\\a\\new.txt"]
    );
    assert.deepEqual(collectPathArguments("host_replace_string", { path: "C:\\a\\f.txt" }), [
      "C:\\a\\f.txt",
    ]);
    assert.deepEqual(collectPathArguments("host_list_dir", { path: "C:\\a" }), ["C:\\a"]);
    assert.deepEqual(collectPathArguments("host_delete_path", { path: "C:\\a\\gone" }), [
      "C:\\a\\gone",
    ]);
    assert.deepEqual(collectPathArguments("host_run_powershell", { command: "ls", cwd: "C:\\a" }), [
      "C:\\a",
    ]);
    assert.deepEqual(collectPathArguments("host_run_powershell", { command: "ls" }), []);
    assert.deepEqual(collectPathArguments("host_git_status", {}), []);
  });

  it("6. evaluateFileRestriction: OFF allows everything; ON blocks outside folders", () => {
    const off = evaluateFileRestriction(
      { fileRestrictionEnabled: false, allowedHostPaths: ["C:\\only"] },
      "host_write_file",
      { path: "C:\\elsewhere\\file.txt" }
    );
    assert.equal(off.allowed, true, "Toggle OFF must never restrict anything (opt-in only)");

    const onInside = evaluateFileRestriction(
      { fileRestrictionEnabled: true, allowedHostPaths: ["C:\\only"] },
      "host_write_file",
      { path: "C:\\only\\sub\\file.txt" }
    );
    assert.equal(onInside.allowed, true);

    const onOutside = evaluateFileRestriction(
      { fileRestrictionEnabled: true, allowedHostPaths: ["C:\\only"] },
      "host_write_file",
      { path: "C:\\elsewhere\\file.txt" }
    );
    assert.equal(onOutside.allowed, false);
    assert.ok(onOutside.reason && onOutside.reason.includes("C:\\elsewhere\\file.txt"));
    assert.ok(
      onOutside.reason && /Settings/i.test(onOutside.reason),
      "reason must point at Settings"
    );
  });

  it("7. executeHostTool enforces the gate: blocked calls never reach the runner", async () => {
    let runnerHits = 0;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        runnerHits += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, echo: body }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    process.env.HOST_RUNNER_URL = `http://127.0.0.1:${port}`;

    try {
      // Toggle ON with one allowed folder.
      setHostSettings({
        fileRestrictionEnabled: true,
        allowedHostPaths: ["C:\\Users\\zackm\\Desktop\\repos"],
      });

      const blocked = await executeHostTool("host_read_file", {
        path: "C:\\Users\\zackm\\Documents\\secret-notes.txt",
      });
      assert.equal(blocked.ok, false, "Blocked host file call must return ok:false");
      assert.ok(
        blocked.error && blocked.error.includes("file restriction"),
        "error must name the restriction"
      );
      assert.equal(runnerHits, 0, "Blocked call must NOT reach the host runner");

      const allowed = await executeHostTool("host_read_file", {
        path: "C:\\Users\\zackm\\Desktop\\repos\\local-agentic-sandbox\\README.md",
      });
      assert.equal(allowed.ok, true, "In-folder call must pass the gate and reach the runner");
      assert.equal(runnerHits, 1);

      // Owner bypass: toggle OFF mid-session, enforcement stops immediately.
      setHostSettings({ fileRestrictionEnabled: false });
      const bypassed = await executeHostTool("host_read_file", {
        path: "C:\\Users\\zackm\\Documents\\secret-notes.txt",
      });
      assert.equal(bypassed.ok, true, "Toggle OFF must bypass the restriction instantly");
      assert.equal(runnerHits, 2);
    } finally {
      server.close();
    }
  });

  it("8. HostZone renders the restriction toggle default OFF plus an editable paths editor", () => {
    const html = renderToStaticMarkup(
      React.createElement(HostZone, {
        hostSettings: {
          hostAccessEnabled: true,
          allowUnattendedHostGit: false,
          jobChunkingEnabled: true,
          fileRestrictionEnabled: false,
          allowedHostPaths: [],
          runnerAvailable: true,
          recentActivity: [],
        },
        hostPresentation: {
          stripLabel: "Connected",
          reasonText: "Host access is enabled and the host runner daemon is verified ready.",
          badgeClass: "border-emerald-200",
          badgeLabel: "Ready",
          dotClass: "bg-emerald-500",
        },
        gitActivityExpanded: false,
        onToggleHostAccess: () => {},
        onToggleJobChunking: () => {},
        onToggleUnattendedGit: () => {},
        onToggleFileRestriction: () => {},
        onAllowedPathsChange: () => {},
        onToggleGitActivityExpanded: () => {},
      })
    );
    assert.ok(
      html.includes("Host file restriction"),
      "Expected HostZone to display the restriction control"
    );
    assert.ok(
      html.includes('data-testid="file-restriction-toggle-btn"'),
      "Expected file-restriction-toggle-btn testid"
    );
    assert.ok(
      html.includes('data-testid="file-restriction-toggle-btn" aria-checked="false"'),
      "Expected the restriction toggle to default to aria-checked='false' (default OFF)"
    );
    assert.ok(
      html.includes('data-testid="host-allowed-paths-editor"'),
      "Expected an editable allowed-paths editor testid"
    );
    assert.ok(
      html.includes("Default is OFF"),
      "Expected honest copy stating the restriction defaults to OFF"
    );
  });

  it("9. SettingsView wires fileRestrictionEnabled + allowedHostPaths through /api/settings/host", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "components", "SettingsView.tsx"),
      "utf8"
    );
    assert.ok(
      src.includes("handleToggleFileRestriction"),
      "Expected handleToggleFileRestriction handler"
    );
    assert.ok(
      src.includes("fileRestrictionEnabled: nextState"),
      "Expected POST of fileRestrictionEnabled"
    );
    assert.ok(src.includes("handleSaveAllowedPaths"), "Expected handleSaveAllowedPaths handler");
    assert.ok(src.includes("allowedHostPaths: parsedLines"), "Expected POST of allowedHostPaths");
  });
});
