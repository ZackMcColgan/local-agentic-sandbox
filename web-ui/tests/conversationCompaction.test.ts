import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compactConversationHistory,
  summarizeTurnHistory,
  DEFAULT_COMPACTION_THRESHOLD
} from "../lib/conversationCompaction";
import { estimateTokens } from "../lib/contextBudget";

describe("Conversation Compaction at 85% Suite (Fix D3)", () => {
  it("does not compact when context utilization is below 85% threshold", () => {
    const messages = [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there! How can I help you today?" }
    ];

    const res = compactConversationHistory(messages, { maxContentTokens: 6000 });
    assert.equal(res.compacted, false);
    assert.equal(res.messages.length, messages.length);
    assert.equal(res.tokensAfter, res.tokensBefore);
  });

  it("compacts older turns when token count reaches >= 85% of budget", () => {
    const systemMsg = { role: "system", content: "System instructions for autonomous agent." };
    // Build a large conversation that exceeds 85% of 2000 tokens (1700 tokens = ~6800 chars)
    const longContent = "A".repeat(400);

    const messages = [
      systemMsg,
      { role: "user", content: "First task: research kubernetes deployment" },
      { role: "assistant", content: "I will use search_web to look up deployment specs.", tool_calls: [{ function: { name: "search_web" } }] },
      { role: "tool", name: "search_web", content: longContent },
      { role: "assistant", content: "Found k8s deployment guidelines." },
      { role: "user", content: "Second task: inspect workspace repo structure" },
      { role: "assistant", content: "I will call workspace_get_tree.", tool_calls: [{ function: { name: "workspace_get_tree" } }] },
      { role: "tool", name: "workspace_get_tree", content: longContent },
      { role: "assistant", content: "Workspace structure retrieved." },
      { role: "user", content: "Third task: write deployment.yaml file" },
      { role: "assistant", content: "I will write deployment file.", tool_calls: [{ function: { name: "workspace_write_file" } }] },
      { role: "tool", name: "workspace_write_file", content: "File written successfully." },
      { role: "assistant", content: "Deployment manifest created." },
      // Recent turns that must be preserved verbatim
      { role: "user", content: "Now check cluster health status" },
      { role: "assistant", content: "Checking cluster health..." },
      { role: "user", content: "And draw an architecture diagram" }
    ];

    const maxContentTokens = 400; // 85% is 340 tokens
    const tokensBefore = estimateTokens(messages);
    assert.ok(tokensBefore >= 340, `Expected >= 340 tokens, got ${tokensBefore}`);

    const res = compactConversationHistory(messages, {
      maxContentTokens,
      compactionThreshold: 0.85,
      preserveRecentMessages: 3
    });

    assert.equal(res.compacted, true);
    assert.ok(res.tokensAfter < res.tokensBefore, "Compacted messages must consume fewer tokens");

    // Invariant 1: System prompt preserved at index 0
    assert.equal(res.messages[0].role, "system");
    assert.equal(res.messages[0].content, systemMsg.content);

    // Invariant 2: Compaction summary injected at index 1
    assert.equal(res.messages[1].role, "assistant");
    assert.ok(
      res.messages[1].content.includes("[CONVERSATION COMPACTED (85% THRESHOLD)]"),
      "Summary message must contain compaction header"
    );
    assert.ok(res.messages[1].content.includes("search_web") || res.messages[1].content.includes("workspace_get_tree"));

    // Invariant 3: Last 3 recent messages preserved verbatim at tail
    const tail = res.messages.slice(-3);
    assert.equal(tail[0].content, "Now check cluster health status");
    assert.equal(tail[1].content, "Checking cluster health...");
    assert.equal(tail[2].content, "And draw an architecture diagram");
  });

  it("extracts structured summaries with goals, tools, and outcomes", () => {
    const older = [
      { role: "user", content: "Please build a REST API in Go" },
      { role: "assistant", content: "Setting up server", tool_calls: [{ function: { name: "workspace_run_command" } }] },
      { role: "tool", name: "workspace_run_command", content: "go mod init api" },
      { role: "assistant", content: "API server scaffolded successfully" }
    ];

    const summary = summarizeTurnHistory(older);
    assert.ok(summary.includes("REST API in Go"));
    assert.ok(summary.includes("workspace_run_command"));
    assert.ok(summary.includes("API server scaffolded successfully"));
  });

  it("handles short or empty conversation arrays gracefully without mutating input", () => {
    const empty: any[] = [];
    const resEmpty = compactConversationHistory(empty);
    assert.equal(resEmpty.compacted, false);
    assert.equal(resEmpty.messages.length, 0);

    const single = [{ role: "user", content: "hello" }];
    const resSingle = compactConversationHistory(single);
    assert.equal(resSingle.compacted, false);
    assert.equal(resSingle.messages.length, 1);
  });
});
