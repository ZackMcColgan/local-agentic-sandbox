import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  estimateTokens,
  fitContextWindow,
  clampToolOutput,
  EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER
} from "../lib/contextBudget.js";

describe("Chat Context-Budget Enforcement Suite", () => {
  describe("Task 1 (P0): fitContextWindow & Protected Message Retention", () => {
    it("preserves system prompt and latest user query verbatim while capping at 6000 tokens", () => {
      const systemMessage = {
        role: "system",
        content: "You are an intelligent autonomous AI engineering platform running on local hardware."
      };
      const userMessage = {
        role: "user",
        content: "Please analyze the entire workspace architecture and run all verification tests."
      };

      // 7 large tool outputs (~5,400 tokens / 21,600 chars each) -> ~38,000 tokens total
      const largeToolOutputs = Array.from({ length: 7 }, (_, i) => ({
        role: "tool",
        name: `workspace_grep_round_${i + 1}`,
        content: JSON.stringify({
          status: "SUCCESS",
          match_count: 500,
          details: "x".repeat(21600)
        })
      }));

      const conversationMessages = [
        systemMessage,
        userMessage,
        ...largeToolOutputs
      ];

      const initialTokens = estimateTokens(conversationMessages);
      assert.ok(
        initialTokens >= 37000,
        `Expected at least ~37,000 tokens before eviction, got ${initialTokens}`
      );

      const fitted = fitContextWindow(conversationMessages, { maxContentTokens: 6000 });

      // 1. Never mutates canonical history array
      assert.notEqual(fitted, conversationMessages, "fitContextWindow must return a new array");
      assert.equal(
        conversationMessages.length,
        9,
        "Original conversationMessages array length must not be modified"
      );
      assert.equal(
        conversationMessages[0].content,
        systemMessage.content,
        "Original system message content must remain unmutated"
      );

      // 2. System message survived verbatim
      const fittedSystem = fitted.find((m) => m.role === "system");
      assert.ok(fittedSystem, "System message must survive in fitted context");
      assert.equal(fittedSystem.content, systemMessage.content);

      // 3. Latest user query survived verbatim
      const fittedUser = [...fitted].reverse().find((m) => m.role === "user");
      assert.ok(fittedUser, "User query must survive in fitted context");
      assert.equal(fittedUser.content, userMessage.content);

      // 4. Estimated total <= 6,000 tokens
      const finalTokens = estimateTokens(fitted);
      assert.ok(
        finalTokens <= 6000,
        `Fitted messages must not exceed 6,000 tokens, got ${finalTokens}`
      );
    });

    it("evicts oldest tool outputs first and replaces each with the exact placeholder marker", () => {
      const systemMessage = { role: "system", content: "System instructions" };
      const userMessage = { role: "user", content: "Analyze tools" };

      // 5 sequential tool outputs of 8,000 chars (~2,000 tokens) each -> total 10,000 tokens
      const toolOutputs = [
        { role: "tool", name: "tool_alpha", content: `Alpha: ${"A".repeat(8000)}` },
        { role: "tool", name: "tool_beta", content: `Beta: ${"B".repeat(8000)}` },
        { role: "tool", name: "tool_gamma", content: `Gamma: ${"C".repeat(8000)}` },
        { role: "tool", name: "tool_delta", content: `Delta: ${"D".repeat(8000)}` },
        { role: "tool", name: "tool_epsilon", content: `Epsilon: ${"E".repeat(8000)}` }
      ];

      const messages = [systemMessage, userMessage, ...toolOutputs];
      const initialTokens = estimateTokens(messages);
      assert.ok(initialTokens > 10000, `Initial tokens should exceed 10000, got ${initialTokens}`);

      const fitted = fitContextWindow(messages, { maxContentTokens: 6000 });
      const fittedTokens = estimateTokens(fitted);
      assert.ok(fittedTokens <= 6000, `Fitted tokens must be <= 6000, got ${fittedTokens}`);

      const fittedTools = fitted.filter((m) => m.role === "tool");
      assert.equal(fittedTools.length, 5, "All 5 tool slots must be preserved in array");

      // Oldest tool outputs evicted first:
      // tool_alpha (oldest) must have been replaced with truncation placeholder
      assert.equal(
        fittedTools[0].content,
        EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER,
        "Oldest tool output (tool_alpha) must be replaced with truncation marker"
      );
      assert.equal(
        fittedTools[1].content,
        EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER,
        "Second oldest tool output (tool_beta) must be replaced with truncation marker"
      );
      assert.equal(
        fittedTools[2].content,
        EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER,
        "Third tool output (tool_gamma) must be replaced with truncation marker"
      );

      // Newer tool outputs (delta, epsilon) should remain intact
      assert.ok(
        fittedTools[3].content.startsWith("Delta:"),
        "Fourth tool output (tool_delta) must survive intact"
      );
      assert.ok(
        fittedTools[4].content.startsWith("Epsilon:"),
        "Fifth tool output (tool_epsilon) must survive intact"
      );
    });

    it("pathological case: truncates longest remaining content if only protected messages remain and still over budget", () => {
      const hugeSystem = {
        role: "system",
        content: "System prompt header. " + "S".repeat(16000)
      };
      const hugeUser = {
        role: "user",
        content: "User prompt query. " + "U".repeat(24000)
      };

      const messages = [hugeSystem, hugeUser];
      const fitted = fitContextWindow(messages, { maxContentTokens: 6000 });

      assert.ok(fitted.length === 2, "Both protected messages must remain in array");
      const tokens = estimateTokens(fitted);
      assert.ok(tokens <= 6000, `Even pathological protected messages must be capped <= 6000, got ${tokens}`);
      // The longer message (user) was truncated
      const fittedUser = fitted.find((m) => m.role === "user");
      assert.ok(fittedUser.content.includes("...[truncated]"));
    });
  });

  describe("Task 2 (P0): Tool Output Clamping at Route and MCP Source", () => {
    it("clamps 25,000-char tool outputs to <= 2,000 chars ending with truncation marker", () => {
      const raw25k = "A".repeat(25000);
      const clamped = clampToolOutput(raw25k);

      assert.ok(
        clamped.length <= 2000,
        `Clamped output must be <= 2,000 chars, got length ${clamped.length}`
      );
      assert.ok(
        clamped.endsWith("...[truncated]"),
        `Clamped output must end with truncation marker '...[truncated]', got: ${clamped.slice(-30)}`
      );
      assert.equal(clamped.length, 2000, "Should clamp exactly to 2,000 chars total length");

      // Small tool output is untouched
      const smallOutput = JSON.stringify({ status: "SUCCESS", file: "foo.txt" });
      assert.equal(clampToolOutput(smallOutput), smallOutput);
    });

    it("verifies chat/route.ts applies clampToolOutput to tool results before pushing tool message", () => {
      const chatRoutePath = path.resolve(__dirname, "../app/api/chat/route.ts");
      const content = fs.readFileSync(chatRoutePath, "utf8");

      assert.ok(
        content.includes("clampToolOutput") &&
        content.includes("role: \"tool\""),
        "chat/route.ts must clamp tool outputs using clampToolOutput before pushing role: 'tool' message"
      );
    });

    it("verifies browser-mcp limits: fetch_webpage_markdown ceiling is 4,000 chars and search_web ceiling is 3,000 chars", () => {
      const browserToolPath = path.resolve(__dirname, "../../browser-mcp/src/tools/browser.ts");
      const content = fs.readFileSync(browserToolPath, "utf8");

      // fetch_webpage_markdown ceiling: 4000
      assert.ok(
        content.includes("markdown.length > 4000") && content.includes("markdown.substring(0, 4000)"),
        "browser-mcp fetch_webpage_markdown ceiling must be lowered to 4,000 chars"
      );

      // search_web ceiling: 3000
      assert.ok(
        content.includes("bestCandidate.markdown.length > 3000") && content.includes("bestCandidate.markdown.substring(0, 3000)"),
        "browser-mcp search_web top_result_content ceiling must be lowered to 3,000 chars"
      );

      // Older bloated thresholds (25000 / 15000) must no longer exist in browser.ts
      assert.ok(
        !content.includes("markdown.length > 25000"),
        "browser-mcp must not retain old 25,000 char threshold"
      );
      assert.ok(
        !content.includes("bestCandidate.markdown.length > 15000"),
        "browser-mcp must not retain old 15,000 char threshold"
      );
    });
  });
});

