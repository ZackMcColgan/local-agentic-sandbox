import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isCompactCommand } from "../lib/chat/compactCommand";

describe("BOARD #139 — /compact slash command in the composer", () => {
  const chatStreamPath = path.join(__dirname, "../components/ChatStream.tsx");
  const chatStreamSource = fs.readFileSync(chatStreamPath, "utf8");
  const testGatePath = path.join(__dirname, "../lib/testGate.ts");
  const testGateSource = fs.readFileSync(testGatePath, "utf8");

  describe("isCompactCommand predicate", () => {
    it("matches exact /compact regardless of case and surrounding whitespace", () => {
      assert.equal(isCompactCommand("/compact"), true);
      assert.equal(isCompactCommand("/COMPACt"), true);
      assert.equal(isCompactCommand("  /compact  "), true);
    });

    it("does NOT match longer text that merely contains /compact", () => {
      assert.equal(isCompactCommand("/compact please"), false);
      assert.equal(isCompactCommand("run /compact now"), false);
      assert.equal(isCompactCommand("/compactx"), false);
      assert.equal(isCompactCommand("/compact /compact"), false);
      assert.equal(isCompactCommand(""), false);
      assert.equal(isCompactCommand("   "), false);
    });
  });

  describe("ChatStream interception contract", () => {
    const interceptStart = chatStreamSource.indexOf("isCompactCommand(prompt)");
    const dispatchStart = chatStreamSource.indexOf("decideSendAction({");

    it("intercepts before the send-action dispatch so no turn or queue starts", () => {
      assert.ok(interceptStart !== -1, "handleSend must check isCompactCommand(prompt)");
      assert.ok(dispatchStart !== -1, "decideSendAction dispatch must still exist");
      assert.ok(
        interceptStart < dispatchStart,
        "compact interception must run before decideSendAction dispatch"
      );
    });

    it("intercepted branch runs the compact endpoint and never appends a user message", () => {
      const block = chatStreamSource.slice(interceptStart, dispatchStart);
      assert.ok(
        block.includes("runManualCompaction"),
        "intercepted branch must reuse the manual compaction path"
      );
      assert.ok(
        chatStreamSource.includes("/compact`"),
        "manual compaction must POST the /api/threads/<id>/compact endpoint"
      );
      assert.ok(!block.includes('role: "user"'), "no user message may be appended by /compact");
      assert.ok(!block.includes("onEnsureThread"), "/compact must never create a thread");
    });

    it("empty new thread shows Nothing to compact yet without creating a thread", () => {
      const block = chatStreamSource.slice(interceptStart, dispatchStart);
      assert.ok(
        block.includes("Nothing to compact yet"),
        "empty-thread case must surface the nothing-to-compact notice"
      );
    });

    it("mid-turn refusal uses the same unavailable-mid-turn reason as the manual compact path", () => {
      const block = chatStreamSource.slice(interceptStart, dispatchStart);
      assert.ok(
        block.includes("A turn is streaming — wait for it to finish."),
        "mid-turn /compact must refuse with the ContextSheet unavailable reason"
      );
    });

    it("success feedback shows tokens before to after in place", () => {
      const block = chatStreamSource.slice(interceptStart, dispatchStart);
      assert.ok(block.includes("tokensBefore"), "success notice must show tokensBefore");
      assert.ok(block.includes("tokensAfter"), "success notice must show tokensAfter");
      assert.ok(
        chatStreamSource.includes('data-testid="compact-command-notice"'),
        "in-place composer notice must be rendered"
      );
    });

    it("failed compaction surfaces the error and leaves composer text intact for retry", () => {
      const block = chatStreamSource.slice(interceptStart, dispatchStart);
      assert.ok(
        block.includes("setInput(rawPrompt)"),
        "on compaction failure the composer text must be restored intact"
      );
    });
  });

  describe("testGate wiring", () => {
    it("MAPPING_RULES maps the compact command sources to this suite", () => {
      assert.ok(
        testGateSource.includes("compactSlashCommand.test.ts"),
        "compactSlashCommand.test.ts must be wired into testGate MAPPING_RULES"
      );
      assert.ok(
        testGateSource.includes("lib/chat/compactCommand"),
        "mapping rule must cover lib/chat/compactCommand"
      );
    });
  });
});
