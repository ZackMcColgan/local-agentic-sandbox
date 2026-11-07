import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { decideSendAction } from "../lib/chatQueue";

describe("CHAT-STEER-SUBMIT UX — Mid-Turn Submit & Affordance Suite", () => {
  const chatStreamPath = path.join(__dirname, "../components/ChatStream.tsx");
  const chatStreamSource = fs.readFileSync(chatStreamPath, "utf8");

  describe("decideSendAction behavioral contract", () => {
    it("preserves running + text -> enqueue action for queue/steer dispatch", () => {
      const action = decideSendAction({
        running: true,
        hasAttachments: false,
        text: "Direct steering instruction"
      });
      assert.equal(action, "enqueue");
    });

    it("empty text remains blocked-attachments when running", () => {
      const action = decideSendAction({
        running: true,
        hasAttachments: false,
        text: "   "
      });
      assert.equal(action, "blocked-attachments");
    });
  });

  describe("ChatStream source inspection for non-negotiable UX affordances", () => {
    it("Stop button and Send button coexist without mutual exclusion", () => {
      // Must not use ternary {isGeneratingOrRunning ? <Stop> : <Send>}
      const hasTernaryMorph = /\{isGeneratingOrRunning\s*\?\s*\(\s*<button[^>]*data-testid="stop-button"[\s\S]*?\)\s*:\s*\(\s*<button[^>]*data-testid="send-button"/m.test(
        chatStreamSource
      );
      assert.equal(hasTernaryMorph, false, "Send button must NOT be morphed/replaced by Stop button");

      // Both buttons must be rendered independently
      assert.ok(chatStreamSource.includes('data-testid="stop-button"'), "Stop button must exist");
      assert.ok(chatStreamSource.includes('data-testid="send-button"'), "Send button must exist");
    });

    it("Send button is visible during active runs when input has non-empty text", () => {
      // Check condition: (!isGeneratingOrRunning || input.trim().length > 0)
      assert.ok(
        chatStreamSource.includes("!isGeneratingOrRunning || input.trim().length > 0"),
        "Send button condition must allow rendering during active run when input has text"
      );
    });

    it("pending-steer visual feedback deck is rendered when pendingSteers exist", () => {
      assert.ok(
        chatStreamSource.includes('data-testid="chat-steer-pending-deck"'),
        "Pending steer deck must be rendered"
      );
      assert.ok(
        chatStreamSource.includes('data-testid="chat-steer-pending-chip"'),
        "Pending steer chip must be rendered"
      );
    });

    it("steer failure restores text to composer without silent swallowing", () => {
      assert.ok(
        chatStreamSource.includes("setInput(prompt)"),
        "On steer delivery failure, input must be restored to prompt"
      );
    });

    it("midTurnAction preference is persisted per thread in localStorage", () => {
      assert.ok(
        chatStreamSource.includes("chat-followup-action:"),
        "Thread follow-up choice must persist in localStorage"
      );
    });
  });
});
