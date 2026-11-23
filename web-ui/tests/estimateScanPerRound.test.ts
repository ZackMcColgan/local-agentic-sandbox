import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runChatToolLoop,
  setEstimateTokensObserver,
  estimateTokens,
  type ContextMessage,
} from "../lib/contextBudget";

/**
 * Board #130 (Perf P6): the per-round prompt estimate must be measured ONCE and
 * threaded through the fit ladder, continuation check, and provider payload fit.
 *
 * The observer seam counts every estimateTokens() invocation whose input is an
 * ARRAY (a full-history scan). On the standard round path (no compaction, no
 * micro-elision, no artifact directives) the count must drop to at most 2 array
 * scans per round (one raw, one effective).
 */
function makeStandardHistory(): ContextMessage[] {
  return [
    { role: "system", content: "You are a helpful coding agent." },
    { role: "user", content: "Summarize the repo layout." },
  ];
}

function makeTools() {
  return [
    {
      type: "function",
      function: {
        name: "workspace_get_tree",
        description: "List directory tree.",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
}

describe("Board #130 — estimateTokens measured once per round (Perf P6)", () => {
  it("counts at most 2 full-history array scans per round on the standard path", async () => {
    let arrayScans = 0;
    setEstimateTokensObserver((input) => {
      if (Array.isArray(input)) arrayScans++;
    });

    try {
      let roundIndex = 0;
      const streamLlmChat = async function* (payload: Record<string, unknown>) {
        roundIndex++;
        if (roundIndex === 1) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "workspace_get_tree", arguments: "{}" },
                },
              ],
            },
          };
        } else {
          yield { message: { content: "The repo has web-ui and host-bridge." } };
        }
      };

      const result = await runChatToolLoop({
        conversationMessages: makeStandardHistory(),
        llmTools: makeTools(),
        streamLlmChat,
        executeTool: async () => ({ tree: "web-ui/\nhost-bridge/" }),
        maxToolRounds: 5,
      });

      assert.equal(result.roundsCompleted, 2, "two rounds executed");
      // At most 2 array scans per round (one raw, one effective).
      assert.ok(
        arrayScans <= 2 * result.roundsCompleted,
        `expected <= ${2 * result.roundsCompleted} array scans, got ${arrayScans}`
      );
    } finally {
      setEstimateTokensObserver(null);
    }
  });

  it("golden: estimator math unchanged — estimateTokens still ceil(len/4)", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
    assert.equal(
      estimateTokens([{ role: "user", content: "hello world" }]),
      Math.ceil(("hello world".length + "user".length) / 4)
    );
  });
});
