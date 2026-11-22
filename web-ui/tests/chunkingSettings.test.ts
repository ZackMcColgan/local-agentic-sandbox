import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { getHostSettings, setHostSettings, getHostSettingsFilePath } from "../lib/hostSettings";
import { GET, POST } from "../app/api/settings/host/route";

describe("Job Chunking Global Setting", () => {
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

  it("1. Fresh state (no stored preference) defaults jobChunkingEnabled to true (ON)", () => {
    assert.equal(fs.existsSync(settingsFile), false, "Settings file must not exist in fresh state");
    const settings = getHostSettings();
    assert.equal(
      settings.jobChunkingEnabled,
      true,
      "Fresh state with no stored preference must default jobChunkingEnabled to true"
    );
  });

  it("2. Switch OFF persists and disables jobChunkingEnabled", () => {
    setHostSettings({ jobChunkingEnabled: false });
    assert.equal(fs.existsSync(settingsFile), true, "Settings file must exist after update");
    const reloaded = getHostSettings();
    assert.equal(
      reloaded.jobChunkingEnabled,
      false,
      "jobChunkingEnabled must be false when switched off"
    );
  });

  it("3. Preference persists across simulated restarts via persistent file store", () => {
    setHostSettings({ jobChunkingEnabled: false });
    const raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(raw.jobChunkingEnabled, false);

    const reloaded = getHostSettings();
    assert.equal(reloaded.jobChunkingEnabled, false);

    setHostSettings({ jobChunkingEnabled: true });
    const reloadedOn = getHostSettings();
    assert.equal(reloadedOn.jobChunkingEnabled, true);
  });

  it("4. GET and POST /api/settings/host read and update jobChunkingEnabled", async () => {
    const getRes1 = await GET();
    const getBody1 = await getRes1.json();
    assert.equal(getRes1.status, 200);
    assert.equal(getBody1.jobChunkingEnabled, true);

    const postReq = new Request("http://localhost:3000/api/settings/host", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobChunkingEnabled: false }),
    });
    const postRes = await POST(postReq);
    const postBody = await postRes.json();
    assert.equal(postRes.status, 200);
    assert.equal(postBody.success, true);
    assert.equal(postBody.jobChunkingEnabled, false);

    const getRes2 = await GET();
    const getBody2 = await getRes2.json();
    assert.equal(getRes2.status, 200);
    assert.equal(getBody2.jobChunkingEnabled, false);
  });
});
