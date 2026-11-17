import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  canContinueToolLoop,
  runChatToolLoop,
  estimateTokens,
  TOOL_ROUND_BACKSTOP,
  CHAT_CONTEXT_BUDGET_TOKENS,
  MAX_WEB_RESEARCH_CALLS
} from "../lib/contextBudget.js";

describe("CHAT-7: Budget-Governed Tool Rounds (no fixed 8-round ceiling, 1000-round backstop)", () => {
  describe("canContinueToolLoop decision shape", () => {
    it("exports TOOL_ROUND_BACKSTOP = 1000 as the runaway guard", () => {
      assert.equal(TOOL_ROUND_BACKSTOP, 1000);
    });

    it("REGRESSION: round 0 with lastRoundTools [] and tokens under budget MUST continue", () => {
      // route.ts initializes lastRoundTools = [] and checks continuation BEFORE
      // round 0 has run. A 'completed' stop here means zero tool rounds ever execute.
      const decision = canContinueToolLoop({
        round: 0,
        contextTokens: 1000,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: [],
        webResearchCalls: 0
      });
      assert.equal(decision.canContinue, true, "round 0 must never be treated as completed");
      assert.equal(decision.stopReason, undefined);
      assert.equal(decision.forceSynthesis, false);
    });

    it("round 0 with tools already known continues with tools (no forced synthesis)", () => {
      const decision = canContinueToolLoop({
        round: 0,
        contextTokens: 2000,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: ["workspace_grep"],
        webResearchCalls: 0
      });
      assert.equal(decision.canContinue, true);
      assert.equal(decision.forceSynthesis, false);
    });

    it("a round that ran and produced no tool calls stops as 'completed'", () => {
      const decision = canContinueToolLoop({
        round: 1,
        contextTokens: 2000,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: [],
        webResearchCalls: 0
      });
      assert.equal(decision.canContinue, false);
      assert.equal(decision.stopReason, "completed");
    });

    it("an injected grounding directive keeps the loop open despite an empty last round", () => {
      // Grounding enforcement demands a tool round after a text-only answer; the
      // 'completed' stop must not swallow that mandated round.
      const decision = canContinueToolLoop({
        round: 1,
        contextTokens: 2000,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: [],
        webResearchCalls: 0,
        awaitingToolRound: true
      });
      assert.equal(decision.canContinue, true);
      assert.equal(decision.stopReason, undefined);

      const guardedByBackstop = canContinueToolLoop({
        round: TOOL_ROUND_BACKSTOP,
        contextTokens: 2000,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: [],
        webResearchCalls: 0,
        awaitingToolRound: true
      });
      assert.equal(guardedByBackstop.canContinue, false);
      assert.equal(guardedByBackstop.stopReason, "backstop");
    });

    it("headroom remaining keeps the loop open regardless of round count", () => {
      for (const round of [1, 5, 20, 40, 998]) {
        const decision = canContinueToolLoop({
          round,
          contextTokens: CHAT_CONTEXT_BUDGET_TOKENS - 1,
          budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          lastRoundTools: ["workspace_read_file"],
          webResearchCalls: 0
        });
        assert.equal(decision.canContinue, true, `round ${round} with headroom must continue`);
        assert.equal(decision.forceSynthesis, false, `round ${round} is not the last permitted round`);
      }
      // Round 999 is the last round the backstop permits: synthesis is forced there.
      const lastPermitted = canContinueToolLoop({
        round: TOOL_ROUND_BACKSTOP - 1,
        contextTokens: CHAT_CONTEXT_BUDGET_TOKENS - 1,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: ["workspace_read_file"],
        webResearchCalls: 0
      });
      assert.equal(lastPermitted.canContinue, true);
      assert.equal(lastPermitted.forceSynthesis, true);
    });

    it("budget exhaustion stops non-research rounds with stopReason 'budget'", () => {
      const overBudget = CHAT_CONTEXT_BUDGET_TOKENS + 5000;
      const single = canContinueToolLoop({
        round: 12,
        contextTokens: overBudget,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: ["workspace_write_file"],
        webResearchCalls: 5
      });
      assert.equal(single.canContinue, false);
      assert.equal(single.stopReason, "budget");

      const mixed = canContinueToolLoop({
        round: 12,
        contextTokens: overBudget,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: ["search_web", "workspace_write_file"],
        webResearchCalls: 5
      });
      assert.equal(mixed.canContinue, false);
      assert.equal(mixed.stopReason, "budget");
    });

    it("budget exhaustion still permits research-only extension rounds (Round-1 item 2 semantics)", () => {
      const overBudget = CHAT_CONTEXT_BUDGET_TOKENS + 5000;
      const search = canContinueToolLoop({
        round: 12,
        contextTokens: overBudget,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: ["search_web"],
        webResearchCalls: 8
      });
      assert.equal(search.canContinue, true);
      assert.equal(search.forceSynthesis, false, "research rounds must keep tools");

      const fetchOnly = canContinueToolLoop({
        round: 24,
        contextTokens: overBudget,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: ["fetch_webpage_markdown"],
        webResearchCalls: 40
      });
      assert.equal(fetchOnly.canContinue, true);
    });

    it("research extension stops at the web-research call cap with stopReason 'web-research-cap'", () => {
      const decision = canContinueToolLoop({
        round: 120,
        contextTokens: CHAT_CONTEXT_BUDGET_TOKENS + 5000,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: ["search_web"],
        webResearchCalls: MAX_WEB_RESEARCH_CALLS
      });
      assert.equal(decision.canContinue, false);
      assert.equal(decision.stopReason, "web-research-cap");
    });

    it("the 1000-round backstop stops a runaway loop", () => {
      const decision = canContinueToolLoop({
        round: TOOL_ROUND_BACKSTOP,
        contextTokens: 100,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: ["workspace_grep"],
        webResearchCalls: 0
      });
      assert.equal(decision.canContinue, false);
      assert.equal(decision.stopReason, "backstop");
    });

    it("an explicit tight backstop forces synthesis on its last permitted round", () => {
      const last = canContinueToolLoop({
        round: 3,
        contextTokens: 1000,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: ["workspace_grep"],
        webResearchCalls: 0,
        roundBackstop: 4
      });
      assert.equal(last.canContinue, true);
      assert.equal(last.forceSynthesis, true, "last permitted round must omit tools and synthesize");

      const past = canContinueToolLoop({
        round: 4,
        contextTokens: 1000,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        lastRoundTools: ["workspace_grep"],
        webResearchCalls: 0,
        roundBackstop: 4
      });
      assert.equal(past.canContinue, false);
      assert.equal(past.stopReason, "backstop");
    });
  });

  describe("runChatToolLoop runs past the legacy 8-round ceiling when headroom remains", () => {
    it("executes >8 tool rounds without an explicit cap (budget-governed)", async () => {
      const capturedPayloads: any[] = [];
      const messages: any[] = [
        { role: "system", content: "You are an autonomous AI engineering assistant." },
        { role: "user", content: "Inspect every module in the repo and summarize the findings." }
      ];
      let callCount = 0;

      const mockStreamChat = async function* (payload: any) {
        capturedPayloads.push(JSON.parse(JSON.stringify(payload)));
        callCount++;
        if (callCount <= 9) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "workspace_grep",
                    arguments: JSON.stringify({ query: `module_${callCount}` })
                  }
                }
              ]
            }
          };
        } else {
          yield { message: { content: "Synthesized findings across all inspected modules." } };
        }
      };

      const mockExecuteTool = async (toolCall: any) => ({
        status: "SUCCESS",
        tool: toolCall.function?.name,
        data: "X".repeat(800)
      });

      const result = await runChatToolLoop({
        conversationMessages: messages,
        llmTools: [{ type: "function", function: { name: "workspace_grep" } }],
        streamLlmChat: mockStreamChat,
        executeTool: mockExecuteTool
      });

      assert.ok(
        capturedPayloads.length > 8,
        `Budget-governed loop must exceed the legacy 8-round ceiling; got ${capturedPayloads.length} rounds`
      );
      assert.equal(result.roundsCompleted, capturedPayloads.length);
      assert.ok(result.finalContent.includes("Synthesized findings"), "turn concludes with text answer");
      for (const payload of capturedPayloads) {
        assert.ok(
          estimateTokens(payload.messages) <= CHAT_CONTEXT_BUDGET_TOKENS,
          "every round payload stays inside the context budget"
        );
      }
    });
  });

  describe("chat/route.ts wiring (static)", () => {
    const routePath = path.resolve(__dirname, "../app/api/chat/route.ts");
    const content = fs.readFileSync(routePath, "utf8");

    it("passes context headroom into canContinueToolLoop", () => {
      assert.ok(
        content.includes("canContinueToolLoop({"),
        "route.ts must call canContinueToolLoop"
      );
      assert.ok(content.includes("contextTokens: estimateTokens(conversationMessages)"), "must pass headroom estimate");
      assert.ok(content.includes("budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS"), "must pass the budget");
      assert.ok(content.includes("roundBackstop: TOOL_ROUND_BACKSTOP"), "must pass the backstop");
    });

    it("no fixed 8-round ceiling remains", () => {
      assert.ok(!content.includes("const MAX_TOOL_ROUNDS"), "route.ts must not define a fixed MAX_TOOL_ROUNDS ceiling");
      assert.ok(!content.includes("maxToolRounds:"), "route.ts must not pass the legacy maxToolRounds option");
    });

    it("records the stop reason and emits honest per-reason pause markers", () => {
      assert.ok(content.includes("toolLoopStopReason = continuation.stopReason"), "route.ts must capture the stop reason");
      assert.ok(content.includes("toolLoopStopReason === \"budget\""), "budget marker must be keyed on stop reason");
      assert.ok(content.includes("toolLoopStopReason === \"backstop\""), "backstop marker must be keyed on stop reason");
      assert.ok(content.includes("Context budget exhausted"), "budget pause text must exist");
      assert.ok(
        content.includes("⚠️ [Turn paused:"),
        "pause markers must keep the ⚠️ [Turn paused: prefix the client status parser relies on"
      );
    });

    it("forced synthesis is driven by the decision, not a round counter", () => {
      assert.ok(
        content.includes("const isFinalRound = continuation.forceSynthesis === true"),
        "route.ts must derive final-round synthesis from the decision"
      );
    });
  });
});
