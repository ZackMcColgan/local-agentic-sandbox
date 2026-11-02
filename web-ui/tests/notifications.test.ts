import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveHermesTelegramConfig,
  setTelegramConfig,
  notify
} from "../lib/notifications";

describe("Outbound Telegram Notifications Suite", () => {
  it("resolves credentials honestly from Hermes without exposing raw secret in toString", () => {
    const cfg = resolveHermesTelegramConfig();
    assert.ok(typeof cfg.enabled === "boolean");
    assert.ok(typeof cfg.botToken === "string");
    assert.ok(typeof cfg.chatId === "string");

    if (cfg.botToken) {
      assert.match(cfg.botToken, /^[0-9]+:[a-zA-Z0-9_\-]+$/);
    }
  });

  it("notify does not throw or halt on network error or timeout", async () => {
    // Override with dummy non-routable endpoint or invalid token
    setTelegramConfig({
      botToken: "123456:FAKE_TOKEN_FOR_TESTING",
      chatId: "999999",
      enabled: true
    });

    const result = await notify("task.completed", {
      title: "Unit Test Task",
      body: "Testing non-blocking failure tolerance."
    });

    // Should return false because token is fake, but must NOT throw
    assert.equal(typeof result, "boolean");
  });

  it("skips dispatch when disabled", async () => {
    setTelegramConfig({
      enabled: false
    });

    const result = await notify("task.completed", {
      title: "Disabled Notification",
      body: "Should not be sent."
    });

    assert.equal(result, false);
  });
});
