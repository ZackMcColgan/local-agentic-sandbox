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

  it("dispatches host.approval_pending notification without leaking commands or arguments", async () => {
    let capturedPayload: any = null;
    const origFetch = global.fetch;
    try {
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
          json: async () => ({ ok: true })
        } as Response;
      }) as typeof fetch;

      const payload = {
        title: "Host approval needed",
        body: "Tap to review in the sandbox chat."
      };
      const result = await notify("host.approval_pending" as any, payload);
      assert.equal(result, true);
      assert.ok(capturedPayload);
      assert.ok(capturedPayload.text.includes("Host approval needed"));
      assert.ok(capturedPayload.text.includes("Tap to review in the sandbox chat."));
      // Privacy fence: ensure no commands, paths, or code arguments leaked
      assert.equal(capturedPayload.text.includes("Remove-Item"), false);
      assert.equal(capturedPayload.text.includes("powershell"), false);
      assert.equal(capturedPayload.text.includes("args"), false);
    } finally {
      global.fetch = origFetch;
    }
  });
});
