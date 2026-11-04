import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  resolveHermesTelegramConfig,
  setTelegramConfig,
  resetTelegramConfigOverride,
  getPublicNotificationStatus,
  notify,
  resolveSettingsDir,
  getNotificationSettingsFilePath
} from "../lib/notifications";
import { GET, POST } from "../app/api/settings/notifications/route";
import { SettingsView } from "../components/SettingsView";
import { ModelBottomSheet } from "../components/ModelBottomSheet";

describe("Outbound Telegram Notifications Suite", () => {
  const origEnv = { ...process.env };
  const origFetch = global.fetch;
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notifications-test-"));
    process.env.SETTINGS_DIR = tempDir;
    if (typeof resetTelegramConfigOverride === "function") {
      resetTelegramConfigOverride();
    }
  });

  afterEach(() => {
    global.fetch = origFetch;
    process.env = { ...origEnv };
    if (typeof resetTelegramConfigOverride === "function") {
      resetTelegramConfigOverride();
    }
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("1. Env-only resolution & zero host-path guessing (F6.1)", () => {
    // Inspect source of web-ui/lib/notifications.ts to assert zero references to AppData, hermes, config.yaml
    const libSourcePath = path.resolve(__dirname, "../lib/notifications.ts");
    const source = fs.readFileSync(libSourcePath, "utf8");

    assert.equal(
      source.includes("AppData"),
      false,
      "notifications.ts must not reference AppData"
    );
    assert.equal(
      source.includes("USERPROFILE"),
      false,
      "notifications.ts must not reference USERPROFILE"
    );
    assert.equal(
      source.includes("config.yaml"),
      false,
      "notifications.ts must not reference config.yaml"
    );
    assert.equal(
      source.includes("hermes.env"),
      false,
      "notifications.ts must not reference hermes.env"
    );

    // When TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are unset in process.env (and no test override is set)
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_NOTIFICATIONS_ENABLED;
    if (typeof resetTelegramConfigOverride === "function") {
      resetTelegramConfigOverride();
    }

    const status = getPublicNotificationStatus();
    assert.deepEqual(status, {
      configured: false,
      enabled: true,
      reason: "missing_credentials"
    });

    // Verify deploy/k8s/web-ui.yaml wires credentials
    const k8sManifestPath = path.resolve(__dirname, "../../deploy/k8s/web-ui.yaml");
    const k8sYaml = fs.readFileSync(k8sManifestPath, "utf8");
    assert.ok(
      k8sYaml.includes("name: TELEGRAM_BOT_TOKEN"),
      "k8s manifest must define TELEGRAM_BOT_TOKEN"
    );
    assert.ok(
      k8sYaml.includes("name: TELEGRAM_CHAT_ID"),
      "k8s manifest must define TELEGRAM_CHAT_ID"
    );
    assert.ok(
      k8sYaml.includes("name: sandbox-telegram"),
      "k8s manifest must reference sandbox-telegram secret"
    );
  });

  it("2. Persisted toggle & lastResult across module/store reloads (F6.2)", async () => {
    assert.ok(tempDir, "tempDir must exist");
    process.env.TELEGRAM_BOT_TOKEN = "111111:AAABBBCCC";
    process.env.TELEGRAM_CHAT_ID = "222222";

    // Toggle enabled: false via POST /api/settings/notifications
    const toggleReq = new Request("http://localhost/api/settings/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle", enabled: false })
    });
    const toggleRes = await POST(toggleReq);
    assert.equal(toggleRes.status, 200);

    const settingsFile = path.join(tempDir, "notifications.json");
    assert.ok(fs.existsSync(settingsFile), "notifications.json must be persisted on disk");
    const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(saved.enabled, false);

    // Verify GET reflects persisted disabled state
    const getRes = await GET();
    const getData = await getRes.json();
    assert.equal(getData.enabled, false);
    assert.equal(getData.reason, "disabled");

    // Toggle back to enabled: true
    const enableReq = new Request("http://localhost/api/settings/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle", enabled: true })
    });
    await POST(enableReq);

    // Mock notify with successful message_id
    global.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { message_id: 4242 }
        })
      } as Response;
    }) as typeof fetch;

    const notifyResult = await notify("test.ping", {
      title: "Ping Title",
      body: "Ping Body"
    });
    assert.equal(notifyResult, true);

    // Verify lastResult persisted on disk
    const updated = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.ok(updated.lastResult, "lastResult must be persisted on disk");
    assert.equal(updated.lastResult.ok, true);
    assert.equal(updated.lastResult.event, "test.ping");
    assert.equal(updated.lastResult.messageId, 4242);
    assert.ok(typeof updated.lastResult.at === "string");
  });

  it("3. No credential leakage in /api/settings/notifications (F6.3)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "999999:SECRET_TOKEN_XYZ";
    process.env.TELEGRAM_CHAT_ID = "888777666";

    // GET
    const getRes = await GET();
    const getBody = JSON.stringify(await getRes.json());
    assert.equal(getBody.includes("999999"), false);
    assert.equal(getBody.includes("SECRET_TOKEN_XYZ"), false);
    assert.equal(getBody.includes("888777666"), false);
    assert.equal(getBody.includes("888***66"), false);
    assert.equal(getBody.includes('"chatId"'), false);
    assert.equal(getBody.includes('"chatIdMasked"'), false);

    // POST toggle
    const toggleReq = new Request("http://localhost/api/settings/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle", enabled: true })
    });
    const toggleRes = await POST(toggleReq);
    const toggleBody = JSON.stringify(await toggleRes.json());
    assert.equal(toggleBody.includes("999999"), false);
    assert.equal(toggleBody.includes("SECRET_TOKEN_XYZ"), false);
    assert.equal(toggleBody.includes("888777666"), false);
    assert.equal(toggleBody.includes("888***66"), false);
    assert.equal(toggleBody.includes('"chatId"'), false);
    assert.equal(toggleBody.includes('"chatIdMasked"'), false);

    // POST test with mock fetch
    global.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 101 } })
      } as Response;
    }) as typeof fetch;

    const testReq = new Request("http://localhost/api/settings/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test" })
    });
    const testRes = await POST(testReq);
    const testBody = JSON.stringify(await testRes.json());
    assert.equal(testBody.includes("999999"), false);
    assert.equal(testBody.includes("SECRET_TOKEN_XYZ"), false);
    assert.equal(testBody.includes("888777666"), false);
    assert.equal(testBody.includes("888***66"), false);
    assert.equal(testBody.includes('"chatId"'), false);
    assert.equal(testBody.includes('"chatIdMasked"'), false);
  });

  it("4. Plain-text Telegram sends with special Markdown characters (F6.5)", async () => {
    setTelegramConfig({
      botToken: "123456:FAKE_TOKEN",
      chatId: "987654",
      enabled: true
    });

    let capturedBody: any = null;
    global.fetch = (async (_url: any, init?: any) => {
      capturedBody = JSON.parse(init?.body || "{}");
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 8888 } })
      } as Response;
    }) as typeof fetch;

    const result = await notify("task.completed", {
      title: "Fix file_name_v2.ts * [draft]",
      body: "Updated path/to/my_file_1.ts & [link](test) _unclosed_ *bold*"
    });

    assert.equal(result, true);
    assert.ok(capturedBody);
    assert.equal(
      capturedBody.parse_mode,
      undefined,
      "Telegram payload must not include parse_mode (plain-text send)"
    );
    assert.ok(
      capturedBody.text.includes("file_name_v2.ts * [draft]"),
      "Message text must contain unescaped characters"
    );
    assert.ok(
      capturedBody.text.includes("path/to/my_file_1.ts"),
      "Message text must contain unescaped paths"
    );
  });

  it("5. UI Consolidation in SettingsView and removal from ModelBottomSheet (F6.4)", () => {
    // SettingsView rendering
    const settingsHtml = renderToString(React.createElement(SettingsView));
    assert.ok(
      settingsHtml.includes('data-testid="settings-notifications-card"'),
      "SettingsView must render settings-notifications-card"
    );
    assert.ok(
      settingsHtml.includes('data-testid="notifications-status-badge"'),
      "SettingsView must render notifications-status-badge"
    );
    assert.ok(
      settingsHtml.includes('data-testid="notifications-test-btn"'),
      "SettingsView must render notifications-test-btn"
    );
    assert.ok(
      settingsHtml.includes("Send test notification"),
      "SettingsView must contain 'Send test notification' button text"
    );

    // ModelBottomSheet rendering
    const bottomSheetHtml = renderToString(
      React.createElement(ModelBottomSheet, {
        isOpen: true,
        onClose: () => {},
        selectedModel: "qwen3.8-flash-next-gyro-gyro-s",
        onModelChange: () => {},
        reasoningEffort: "medium"
      })
    );
    assert.equal(
      bottomSheetHtml.includes("Telegram Notifications"),
      false,
      "ModelBottomSheet must not contain Telegram Notifications card"
    );
    assert.equal(
      bottomSheetHtml.includes("Test Ping"),
      false,
      "ModelBottomSheet must not contain Test Ping button"
    );
  });

  it("6. Privacy fence for host.approval_pending without leaking commands or arguments", async () => {
    let capturedPayload: any = null;
    setTelegramConfig({
      botToken: "123456:VALID_TEST_TOKEN",
      chatId: "999999",
      enabled: true
    });
    global.fetch = (async (_url: any, init?: any) => {
      const body = JSON.parse(init?.body || "{}");
      capturedPayload = body;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 10 } })
      } as Response;
    }) as typeof fetch;

    const payload = {
      title: "Host approval needed",
      body: "Tap to review in the sandbox chat."
    };
    const result = await notify("host.approval_pending", payload);
    assert.equal(result, true);
    assert.ok(capturedPayload);
    assert.ok(capturedPayload.text.includes("Host approval needed"));
    assert.ok(capturedPayload.text.includes("Tap to review in the sandbox chat."));
    // Privacy fence: ensure no commands, paths, or code arguments leaked
    assert.equal(capturedPayload.text.includes("Remove-Item"), false);
    assert.equal(capturedPayload.text.includes("powershell"), false);
    assert.equal(capturedPayload.text.includes("args"), false);
  });
});
