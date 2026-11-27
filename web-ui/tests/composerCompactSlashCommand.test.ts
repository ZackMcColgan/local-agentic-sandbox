import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isCompactCommand } from "../lib/chat/compactCommand";

describe("COMPOSER /COMPACT SLASH COMMAND — Manual Compaction Interception Suite", () => {
  const chatStreamPath = path.join(__dirname, "../components/ChatStream.tsx");
  const chatStreamSource = fs.readFileSync(chatStreamPath, "utf8");

  describe("isCompactCommand exact-match contract", () => {
    it("intercepts exact /compact", () => {
      assert.equal(isCompactCommand("/compact"), true);
    });

    it("intercepts case-insensitive variants such as /COMPACt", () => {
      assert.equal(isCompactCommand("/COMPACt"), true);
      assert.equal(isCompactCommand("/COMPACT"), true);
      assert.equal(isCompactCommand("/CoMpAcT"), true);
    });

    it("intercepts surrounding whitespace only", () => {
      assert.equal(isCompactCommand("  /compact  "), true);
      assert.equal(isCompactCommand("\n/compact\n"), true);
    });

    it("does NOT intercept longer text that merely contains /compact", () => {
      assert.equal(isCompactCommand("/compact please"), false);
      assert.equal(isCompactCommand("run /compact now"), false);
      assert.equal(isCompactCommand("/compact me"), false);
      assert.equal(isCompactCommand("/compaction"), false);
      assert.equal(isCompactCommand("/compact/"), false);
      assert.equal(isCompactCommand("hello"), false);
      assert.equal(isCompactCommand(""), false);
      assert.equal(isCompactCommand("   "), false);
    });
  });

  describe("ChatStream wiring: /compact never becomes a chat turn", () => {
    it("intercepts before send dispatch and before thread creation", () => {
      const idx = chatStreamSource.indexOf("isCompactCommand(prompt)");
      assert.ok(idx > 0, "handleSend must check isCompactCommand(prompt)");
      const after = chatStreamSource.slice(idx);
      assert.ok(
        after.indexOf("decideSendAction") > 0,
        "interception must precede decideSendAction dispatch"
      );
      assert.ok(
        after.indexOf("onEnsureThread") > 0,
        "interception must precede onEnsureThread (no thread creation)"
      );
    });

    it("calls the compact endpoint via POST, same path as the manual compact action", () => {
      assert.ok(
        /fetch\(`\/api\/threads\/\$\{encodeURIComponent\(currentThreadId\)\}\/compact`/.test(
          chatStreamSource
        ),
        "must POST to /api/threads/<id>/compact"
      );
    });

    it("empty thread shows nothing-to-compact and creates no thread", () => {
      assert.ok(
        chatStreamSource.includes("Nothing to compact yet"),
        "empty-thread notice must exist"
      );
    });

    it("mid-turn compaction is refused with the unavailable-mid-turn notice", () => {
      assert.ok(
        chatStreamSource.includes("Compaction is unavailable while a turn is streaming"),
        "mid-turn refusal notice must exist"
      );
    });

    it("success feedback shows tokens before to after in place", () => {
      assert.ok(chatStreamSource.includes("tokensBefore"), "success notice must show tokensBefore");
      assert.ok(chatStreamSource.includes("tokensAfter"), "success notice must show tokensAfter");
      assert.ok(
        chatStreamSource.includes('data-testid="compact-notice"'),
        "notice must render with a stable test id"
      );
    });

    it("failed compaction surfaces the error and restores composer text for retry", () => {
      assert.ok(
        chatStreamSource.includes("setInput(prompt)"),
        "composer text must be restored on compaction failure"
      );
    });
  });
});
