import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  evaluateTurnCompletion,
  extractDoneTurnStatus
} from "../lib/chatStatus";
import { ChatStream } from "../components/ChatStream";

describe("PACKAGE 2 (CHAT-1 & CHAT-3): Never-silent turns & message incomplete status", () => {
  describe("CHAT-1: Ban the canned 'Executed <tools>.' fallback & enforce honest turn completeness", () => {
    it("never produces 'Executed <tools>.' when tool traces exist but synthesis returned no text", () => {
      const result = evaluateTurnCompletion({
        content: "",
        round: 2,
        maxToolRounds: 8,
        tracesCount: 3
      });

      assert.notEqual(result.cleanedContent, "Executed workspace_read_file.");
      assert.ok(!result.cleanedContent.startsWith("Executed "));
      assert.equal(
        result.cleanedContent,
        "⚠️ [Turn incomplete: Tool execution concluded without synthesis text. Traces captured above.]"
      );
      assert.equal(result.turnStatus, "incomplete");
      assert.equal(result.isIncomplete, true);
    });

    it("marks turn as incomplete with pause warning when round reaches maxToolRounds and synthesis returned no text", () => {
      const result = evaluateTurnCompletion({
        content: "",
        round: 8,
        maxToolRounds: 8,
        tracesCount: 5
      });

      assert.equal(
        result.cleanedContent,
        "⚠️ [Turn paused: Tool execution limit reached (8 rounds). Traces captured above; synthesis returned no text.]"
      );
      assert.equal(result.turnStatus, "incomplete");
      assert.equal(result.isIncomplete, true);
    });

    it("appends pause warning and marks turn as incomplete when synthesis produced text but tool loop hit limit", () => {
      const synthesisText = "Here is what was discovered in the codebase before hitting the limit.";
      const result = evaluateTurnCompletion({
        content: synthesisText,
        round: 8,
        maxToolRounds: 8,
        tracesCount: 8
      });

      assert.ok(result.cleanedContent.startsWith(synthesisText));
      assert.ok(
        result.cleanedContent.includes(
          "⚠️ [Turn paused: Tool execution limit reached (8 rounds).]"
        )
      );
      assert.equal(result.turnStatus, "incomplete");
      assert.equal(result.isIncomplete, true);
    });

    it("leaves normal completed turns without warnings and with completed status", () => {
      const synthesisText = "All operations succeeded cleanly.";
      const result = evaluateTurnCompletion({
        content: synthesisText,
        round: 3,
        maxToolRounds: 8,
        tracesCount: 2
      });

      assert.equal(result.cleanedContent, synthesisText);
      assert.notEqual(result.turnStatus, "incomplete");
      assert.equal(result.isIncomplete, undefined);
    });

    it("falls back to standard greeting when both content and traces are empty", () => {
      const result = evaluateTurnCompletion({
        content: "",
        round: 0,
        maxToolRounds: 8,
        tracesCount: 0
      });

      assert.equal(
        result.cleanedContent,
        "I am ready to assist you. What would you like to build or explore?"
      );
      assert.equal(result.turnStatus, undefined);
      assert.equal(result.isIncomplete, undefined);
    });

    it("statically verifies route.ts bans 'Executed <tools>.' canned string and transmits status in done event", () => {
      const routePath = path.resolve(__dirname, "../app/api/chat/route.ts");
      const content = fs.readFileSync(routePath, "utf8");

      // Verify the canned fallback is deleted
      assert.ok(
        !content.includes('`Executed ${traces.map'),
        "route.ts must not contain `Executed ${traces.map` fallback"
      );
      assert.ok(
        !content.includes('"Executed " + traces.map'),
        "route.ts must not contain 'Executed ' + traces.map fallback"
      );

      // Verify done event transmits status and isIncomplete
      assert.ok(
        content.includes("status: turnStatus"),
        "route.ts must emit status: turnStatus in done event"
      );
      assert.ok(
        content.includes('isIncomplete: turnStatus === "incomplete"'),
        "route.ts must emit isIncomplete in done event"
      );
    });
  });

  describe("CHAT-1: Post-Tool Synthesis Thinking Emission", () => {
    it("statically verifies route.ts emits thinking events inside the post-tool synthesis loop", () => {
      const routePath = path.resolve(__dirname, "../app/api/chat/route.ts");
      const content = fs.readFileSync(routePath, "utf8");

      assert.ok(
        content.includes('type: "thinking"') || content.includes("type: 'thinking'"),
        "route.ts post-tool synthesis must emit thinking events"
      );
      assert.ok(
        content.includes("chunk.message?.thinking"),
        "route.ts must check chunk.message?.thinking during synthesis"
      );
    });
  });

  describe("CHAT-3: Message Incomplete & Error Status Badge UI", () => {
    it("extractDoneTurnStatus correctly resolves status from done events across all formats", () => {
      // 1. Explicit status
      assert.equal(
        extractDoneTurnStatus({ status: "incomplete" }),
        "incomplete"
      );
      assert.equal(
        extractDoneTurnStatus({ status: "completed" }),
        "completed"
      );
      assert.equal(
        extractDoneTurnStatus({ status: "error" }),
        "error"
      );

      // 2. isIncomplete flag
      assert.equal(
        extractDoneTurnStatus({ isIncomplete: true }),
        "incomplete"
      );

      // 3. Content markers fallback
      assert.equal(
        extractDoneTurnStatus({
          content: "⚠️ [Turn paused: Tool execution limit reached (8 rounds).]"
        }),
        "incomplete"
      );
      assert.equal(
        extractDoneTurnStatus({
          content: "⚠️ [Turn incomplete: Tool execution concluded without synthesis text.]"
        }),
        "incomplete"
      );

      // 4. Clean turn with no status
      assert.equal(
        extractDoneTurnStatus({ content: "Clean answer" }),
        undefined
      );
    });

    it("renders amber Incomplete badge when assistant message status is 'incomplete'", () => {
      const messages: any[] = [
        {
          id: "msg-asst-incomplete",
          role: "assistant",
          status: "incomplete",
          content: "⚠️ [Turn paused: Tool execution limit reached (8 rounds).]"
        }
      ];

      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages
        })
      );

      assert.ok(
        html.includes('data-testid="message-status-badge"'),
        "Must render data-testid='message-status-badge'"
      );
      assert.ok(
        html.includes("Incomplete"),
        "Must render 'Incomplete' badge label"
      );
      assert.ok(
        html.includes("text-amber-800") || html.includes("bg-amber-50"),
        "Must render amber styling for incomplete badge"
      );
    });

    it("renders red Error badge when assistant message status is 'error'", () => {
      const messages: any[] = [
        {
          id: "msg-asst-error",
          role: "assistant",
          status: "error",
          content: "An unexpected error occurred during model invocation."
        }
      ];

      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages
        })
      );

      assert.ok(
        html.includes('data-testid="message-status-badge"'),
        "Must render data-testid='message-status-badge'"
      );
      assert.ok(
        html.includes("Error"),
        "Must render 'Error' badge label"
      );
      assert.ok(
        html.includes("text-red-800") || html.includes("bg-red-50"),
        "Must render red styling for error badge"
      );
    });

    it("does not render status badge for standard completed messages", () => {
      const messages: any[] = [
        {
          id: "msg-asst-completed",
          role: "assistant",
          status: "completed",
          content: "Everything finished successfully."
        }
      ];

      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages
        })
      );

      assert.ok(
        !html.includes('data-testid="message-status-badge"'),
        "Must NOT render status badge for completed messages"
      );
    });
  });
});
