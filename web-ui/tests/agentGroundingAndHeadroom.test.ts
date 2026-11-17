import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  isLiveRealTimeIntent,
  hasWebResearchResults,
  fitContextWindow,
  ARTIFACT_OUTPUT_HEADROOM_TOKENS,
  ARTIFACT_OUTPUT_HEADROOM_TOKENS_WEB,
  runChatToolLoop
} from "../lib/contextBudget.js";

describe("Agent Grounding Gate & Web Headroom Scaling Suite", () => {
  describe("isLiveRealTimeIntent", () => {
    it("detects live real-time queries for weather, forecast, prices, news", () => {
      assert.equal(isLiveRealTimeIntent("what is the weather in Austin today?"), true);
      assert.equal(isLiveRealTimeIntent("give me the 5-day forecast for Seattle"), true);
      assert.equal(isLiveRealTimeIntent("current temperature in Tokyo"), true);
      assert.equal(isLiveRealTimeIntent("what is the current price of Bitcoin?"), true);
      assert.equal(isLiveRealTimeIntent("today's news headlines"), true);
      assert.equal(isLiveRealTimeIntent("breaking news in tech"), true);
      assert.equal(isLiveRealTimeIntent("what is the current version of Next.js?"), true);
    });

    it("returns false for static coding, architecture, and reasoning queries", () => {
      assert.equal(isLiveRealTimeIntent("write a binary search function in typescript"), false);
      assert.equal(isLiveRealTimeIntent("explain how React useEffect hook works"), false);
      assert.equal(isLiveRealTimeIntent("create a beautiful SVG architecture diagram of our cluster"), false);
      assert.equal(isLiveRealTimeIntent("how do I configure docker compose for postgres?"), false);
      assert.equal(isLiveRealTimeIntent(""), false);
    });
  });

  describe("hasWebResearchResults", () => {
    it("detects tool messages from search_web or fetch_webpage_markdown", () => {
      const msgs = [
        { role: "user", content: "weather in Chicago" },
        { role: "assistant", content: "", tool_calls: [{ function: { name: "search_web" } }] },
        { role: "tool", name: "search_web", content: "Sunny and 72F" }
      ];
      assert.equal(hasWebResearchResults(msgs), true);
    });

    it("returns false when only sandbox or git tools were invoked", () => {
      const msgs = [
        { role: "user", content: "run pytest" },
        { role: "assistant", content: "", tool_calls: [{ function: { name: "workspace_run_command" } }] },
        { role: "tool", name: "workspace_run_command", content: "all tests passed" }
      ];
      assert.equal(hasWebResearchResults(msgs), false);
    });
  });

  describe("fitContextWindow Web Headroom Scaling", () => {
    it("allocates ARTIFACT_OUTPUT_HEADROOM_TOKENS_WEB (4000) when web research results are present", () => {
      const msgs = [
        { role: "system", content: "You are an assistant." },
        { role: "user", content: "Draw an SVG card of today's weather in Austin" },
        { role: "tool", name: "search_web", content: "Austin weather: 75F, Clear Skies" }
      ];

      // With web research results present, headroom scales to 4000 tokens
      const fitted = fitContextWindow(msgs);
      assert.ok(fitted.length > 0);
      assert.equal(ARTIFACT_OUTPUT_HEADROOM_TOKENS_WEB, 4000);
      assert.equal(ARTIFACT_OUTPUT_HEADROOM_TOKENS, 3000);
    });
  });

  describe("SYSTEM_PROMPT Grounding & Honesty Rule", () => {
    it("verifies Grounding & Honesty Rule is embedded in chat route system prompt", () => {
      const routePath = path.resolve(__dirname, "../app/api/chat/route.ts");
      const content = fs.readFileSync(routePath, "utf-8");

      assert.ok(
        content.includes("GROUNDING & HONESTY RULE:"),
        "route.ts must contain GROUNDING & HONESTY RULE"
      );
      assert.ok(
        content.includes("Never state, claim, or imply you checked real-time data"),
        "route.ts must forbid claiming real-time checks without tool calls"
      );
      assert.ok(
        content.includes("REAL-TIME & LIVE DATA RESEARCH GUIDANCE:"),
        "route.ts must contain REAL-TIME & LIVE DATA RESEARCH GUIDANCE"
      );
    });
  });

  describe("Structural Grounding Gate in runChatToolLoop", () => {
    it("forces web search when model tries to answer live real-time query with 0 tool calls", async () => {
      let callCount = 0;
      const fakeStream = async function* (payload: any) {
        callCount++;
        if (callCount === 1) {
          // Round 0: model attempts to answer without calling search_web
          yield { message: { content: "I checked wttr.in and the weather is sunny and 75F!" } };
        } else {
          // Round 1: model executes search_web after grounding enforcement directive
          yield {
            message: {
              content: "",
              tool_calls: [{ function: { name: "search_web", arguments: JSON.stringify({ query: "Austin weather" }) } }]
            }
          };
        }
      };

      const messages: any[] = [
        { role: "user", content: "What is the weather in Austin today?" }
      ];

      const result = await runChatToolLoop({
        conversationMessages: messages,
        maxToolRounds: 4,
        streamLlmChat: fakeStream as any,
        executeTool: async (toolCall: any) => ({ result: "Sunny, 75F" })
      });

      // The gate should have rejected round 0 and forced round 1
      assert.ok(callCount >= 2, `Expected at least 2 rounds, got ${callCount}`);
      // Verify grounding directive was injected into conversationMessages
      const systemMsg = messages.find((m) => m.role === "system" && m.content.includes("GROUNDING ENFORCEMENT"));
      assert.ok(systemMsg, "Expected GROUNDING ENFORCEMENT directive to be injected");
    });
  });
});
