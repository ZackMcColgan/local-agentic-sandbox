import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  MICRO_ELISION_MIN_RESULT_CHARS,
  MICRO_ELISION_PRESSURE_RATIO,
  MICRO_ELISION_REARM_DELTA_TOKENS,
  MICRO_ELISION_RECENT_WINDOW,
  applyMicroElision,
  computeMicroElisionTriggerTokens,
  shouldDeferMicroElisionForPrefixCache,
} from "../lib/microElision";
import {
  CHAT_CONTEXT_BUDGET_TOKENS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimateTokens,
} from "../lib/contextBudget";
import { ROUND_MAX_TOKENS } from "../lib/modelLimits";

type TestMessage = {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  elided?: boolean;
};

function makeMultiRoundReadWriteHistory(): TestMessage[] {
  const messages: TestMessage[] = [
    { role: "system", content: "Static system prompt and tool schemas." },
    { role: "user", content: "Investigate and patch src/app.ts across several rounds." },
  ];

  // Round 1: large read of src/app.ts (eligible for both Pass 2 and Pass 3)
  messages.push({
    role: "assistant",
    content: "Reading src/app.ts.",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "workspace_read_file",
          arguments: JSON.stringify({ path: "src/app.ts" }),
        },
      },
    ],
  });
  messages.push({
    role: "tool",
    name: "workspace_read_file",
    tool_call_id: "call_1",
    content: JSON.stringify({ path: "src/app.ts", content: "line\n".repeat(1200) }),
  });

  // Round 2: first write to src/app.ts (will be superseded by Round 4 write)
  messages.push({
    role: "assistant",
    content: "First patch to src/app.ts.",
    tool_calls: [
      {
        id: "call_2",
        type: "function",
        function: {
          name: "workspace_write_file",
          arguments: JSON.stringify({ path: "src/app.ts", content: "v1\n".repeat(400) }),
        },
      },
    ],
  });
  messages.push({
    role: "tool",
    name: "workspace_write_file",
    tool_call_id: "call_2",
    content: JSON.stringify({ ok: true, output: "a".repeat(3000) }),
  });

  // Rounds 3..8: additional large reads/commands plus a second write to src/app.ts
  for (let r = 3; r <= 8; r++) {
    const isSecondWrite = r === 4;
    messages.push({
      role: "assistant",
      content: `Round ${r} step.`,
      tool_calls: [
        {
          id: `call_${r}`,
          type: "function",
          function: isSecondWrite
            ? {
                name: "workspace_write_file",
                arguments: JSON.stringify({ path: "src/app.ts", content: "v2\n".repeat(400) }),
              }
            : {
                name: "workspace_read_file",
                arguments: JSON.stringify({ path: `src/mod-${r}.ts` }),
              },
        },
      ],
    });
    messages.push({
      role: "tool",
      name: isSecondWrite ? "workspace_write_file" : "workspace_read_file",
      tool_call_id: `call_${r}`,
      content: JSON.stringify({ ok: true, output: "b".repeat(3500) }),
    });
  }

  return messages;
}

describe("Prefix-preserving batch-gated micro-elision", () => {
  it("computes the batch trigger at 70% of effective input budget and respects rearm floors", () => {
    assert.equal(MICRO_ELISION_PRESSURE_RATIO, 0.7);
    assert.ok(MICRO_ELISION_REARM_DELTA_TOKENS >= 5000);

    // 131K window -> effective ceiling 114,688 -> capped at 100K budget -> 70% = 70,000
    const trigger131k = computeMicroElisionTriggerTokens({
      budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      outputReserveTokens: ROUND_MAX_TOKENS,
    });
    assert.equal(trigger131k, 70000);

    // 64K window -> effective ceiling 49,152 -> 70% = 34,406
    const trigger64k = computeMicroElisionTriggerTokens({
      budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
      contextWindowTokens: 65536,
      outputReserveTokens: ROUND_MAX_TOKENS,
    });
    assert.equal(trigger64k, Math.floor((65536 - ROUND_MAX_TOKENS) * 0.7));

    // Rearm floor prevents oscillation when post-elision size remains above base trigger
    const triggerWithRearm = computeMicroElisionTriggerTokens({
      budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      outputReserveTokens: ROUND_MAX_TOKENS,
      rearmFloorTokens: 82000,
    });
    assert.equal(triggerWithRearm, 82000);
  });

  it("defers elision with zero mutations when prompt tokens are below minPromptTokens", () => {
    const messages = makeMultiRoundReadWriteHistory();
    const snapshotBefore = JSON.stringify(messages);

    assert.equal(
      shouldDeferMicroElisionForPrefixCache({
        currentPromptTokens: 35000,
        minPromptTokens: 70000,
      }),
      true
    );

    const res = applyMicroElision(messages, 9, {
      currentPromptTokens: 35000,
      minPromptTokens: 70000,
    });

    assert.equal(res.stubbed, 0);
    assert.equal(res.elisions.length, 0);
    assert.equal(res.deferredForPrefixCache, true);
    assert.equal(
      JSON.stringify(messages),
      snapshotBefore,
      "all earlier tool results, superseded reads, and superseded write args must stay byte-identical below pressure threshold"
    );
  });

  it("executes a single full batch elision across all three passes once prompt crosses minPromptTokens", () => {
    const messages = makeMultiRoundReadWriteHistory();

    assert.equal(
      shouldDeferMicroElisionForPrefixCache({
        currentPromptTokens: 70000,
        minPromptTokens: 70000,
      }),
      false
    );

    const res = applyMicroElision(messages, 9, {
      currentPromptTokens: 70000,
      minPromptTokens: 70000,
    });

    assert.ok(res.stubbed >= 3, `expected batch sweep across passes 1-3, got ${res.stubbed}`);
    assert.equal(res.deferredForPrefixCache, false);
    // Pass 1: Round 2 write args stubbed
    assert.match(messages[4].tool_calls![0].function.arguments, /\[Micro-elision:/);
    // Pass 2: Round 1 read of src/app.ts stubbed
    assert.match(messages[3].content, /^\[Micro-elision:/);
    // Pass 3: Round 3 read outside recent window (5) stubbed
    assert.match(messages[7].content, /^\[Micro-elision:/);
  });

  it("preserves append-only prefix byte-for-byte across a 38-round <40K workload (Item #124 regression)", () => {
    const triggerTokens = computeMicroElisionTriggerTokens({
      budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      outputReserveTokens: ROUND_MAX_TOKENS,
    });

    const messages: TestMessage[] = [
      { role: "system", content: "S".repeat(10000) },
      { role: "user", content: "U".repeat(2000) },
    ];

    let totalStubbed = 0;
    for (let round = 0; round < 38; round++) {
      const prefixBeforeRound = JSON.stringify(messages);
      const currentPromptTokens = estimateTokens(messages) + 1200;
      const res = applyMicroElision(messages, round + 1, {
        currentPromptTokens,
        minPromptTokens: triggerTokens,
      });
      totalStubbed += res.stubbed;

      // Exact prefix before appending this round's assistant+tool pair must never mutate
      assert.equal(
        JSON.stringify(messages),
        prefixBeforeRound,
        `round ${round} mutated already-sent prefix below pressure threshold`
      );

      messages.push({
        role: "assistant",
        content: `Step ${round}`,
        tool_calls: [
          {
            id: `call_${round}`,
            type: "function",
            function: {
              name: "workspace_read_file",
              arguments: JSON.stringify({ path: `src/file-${round}.ts` }),
            },
          },
        ],
      });
      messages.push({
        role: "tool",
        name: "workspace_read_file",
        tool_call_id: `call_${round}`,
        content: JSON.stringify({
          ok: true,
          content: "x".repeat(MICRO_ELISION_MIN_RESULT_CHARS + 500),
        }),
      });
    }

    assert.equal(totalStubbed, 0);
    assert.ok(messages.length === 2 + 38 * 2);
  });

  it("prevents round-by-round oscillation after a batch sweep via rearm floor", () => {
    const messages = makeMultiRoundReadWriteHistory();

    // First crossing at 72K fires batch elision
    const firstTrigger = computeMicroElisionTriggerTokens({
      budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      outputReserveTokens: ROUND_MAX_TOKENS,
      rearmFloorTokens: 0,
    });
    const firstRes = applyMicroElision(messages, 9, {
      currentPromptTokens: 72000,
      minPromptTokens: firstTrigger,
    });
    assert.ok(firstRes.stubbed > 0);

    // Suppose post-elision prompt still sits at 70.5K (heavy prose + 5 huge recent reads)
    const rearmFloor = 70500 + MICRO_ELISION_REARM_DELTA_TOKENS; // 80,500
    const nextTrigger = computeMicroElisionTriggerTokens({
      budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      outputReserveTokens: ROUND_MAX_TOKENS,
      rearmFloorTokens: rearmFloor,
    });

    // Append another large round pushing prompt to 74K -> must defer (no thrash!)
    messages.push({
      role: "assistant",
      content: "Next step",
      tool_calls: [
        {
          id: "call_9",
          type: "function",
          function: {
            name: "workspace_read_file",
            arguments: JSON.stringify({ path: "src/mod-9.ts" }),
          },
        },
      ],
    });
    messages.push({
      role: "tool",
      name: "workspace_read_file",
      tool_call_id: "call_9",
      content: JSON.stringify({ ok: true, output: "c".repeat(4000) }),
    });

    const snapshotAfterRound9 = JSON.stringify(messages);
    const secondRes = applyMicroElision(messages, 10, {
      currentPromptTokens: 74000,
      minPromptTokens: nextTrigger,
    });
    assert.equal(secondRes.stubbed, 0);
    assert.equal(secondRes.deferredForPrefixCache, true);
    assert.equal(JSON.stringify(messages), snapshotAfterRound9);

    // Once +10K more tokens accumulate (81K >= 80.5K), next batch sweep fires
    const thirdRes = applyMicroElision(messages, 11, {
      currentPromptTokens: 81000,
      minPromptTokens: nextTrigger,
    });
    assert.ok(
      thirdRes.stubbed >= 1 && MICRO_ELISION_RECENT_WINDOW === 5,
      "batch sweep resumes once rearm delta is crossed"
    );
  });

  it("keeps backward-compatible unconditional elision when options are omitted", () => {
    const messages = makeMultiRoundReadWriteHistory();
    const res = applyMicroElision(messages, 9);
    assert.ok(res.stubbed >= 3);
    assert.equal(res.deferredForPrefixCache, false);
  });
});

describe("Prefix-preserving micro-elision wiring (structural guard)", () => {
  const roundLoopSrc = fs.readFileSync(path.resolve(__dirname, "../lib/chat/roundLoop.ts"), "utf8");

  it("roundLoop passes currentPromptTokens and minPromptTokens into applyMicroElision and tracks rearm floor", () => {
    assert.match(roundLoopSrc, /computeMicroElisionTriggerTokens/);
    assert.match(roundLoopSrc, /MICRO_ELISION_REARM_DELTA_TOKENS/);
    assert.match(
      roundLoopSrc,
      /applyMicroElision\(conversationMessages,\s*round\s*\+\s*1,\s*\{[\s\S]*currentPromptTokens:[\s\S]*minPromptTokens:/
    );
  });
});
