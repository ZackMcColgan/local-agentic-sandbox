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
  MAX_WEB_RESEARCH_CALLS,
  WEB_BUDGET_EXHAUSTED_DIRECTIVE,
  appendTrailingDirective,
  estimateTokens,
  filterToolsForWebBudget,
  runChatToolLoop,
} from "../lib/contextBudget";
import { runSynthesisPass } from "../lib/chat/turnEngine";
import { LlamaCppProvider, type LLMChatRequest } from "../lib/llm/provider";
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

describe("Phase 1 (P1): Synthesis rounds and mid-turn directives keep their cached system+tools prefix", () => {
  const sampleTools = [
    { type: "function", function: { name: "search_web", description: "Search the web" } },
    { type: "function", function: { name: "fetch_webpage_markdown", description: "Fetch page" } },
    { type: "function", function: { name: "workspace_read_file", description: "Read file" } },
    { type: "function", function: { name: "workspace_write_file", description: "Write file" } },
  ];

  it("synthesis and final rounds carry the exact same tools payload as working rounds with tool_choice set to 'none'", async () => {
    const capturedPayloads: Array<Record<string, unknown>> = [];
    const messages = [
      { role: "system", content: "Static system header." },
      { role: "user", content: "Gather facts and synthesize." },
    ];

    let callIdx = 0;
    const loopRes = await runChatToolLoop({
      conversationMessages: messages,
      llmTools: sampleTools,
      maxToolRounds: 2,
      streamLlmChat: async function* (payload) {
        capturedPayloads.push(JSON.parse(JSON.stringify(payload)));
        callIdx++;
        if (callIdx === 1) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "README.md" }),
                  },
                },
              ],
            },
          };
        } else {
          yield {
            message: {
              content: "Final synthesized answer.",
            },
          };
        }
      },
      executeTool: async () => ({ ok: true, content: "readme contents" }),
    });

    assert.equal(loopRes.roundsCompleted, 2);
    assert.equal(capturedPayloads.length, 2);
    // Working round (round 0) and final forced-synthesis round (round 1) carry identical tools
    assert.deepEqual(capturedPayloads[0].tools, sampleTools);
    assert.deepEqual(
      capturedPayloads[1].tools,
      sampleTools,
      "Final synthesis round must retain byte-identical tools payload"
    );
    assert.equal(
      capturedPayloads[1].tool_choice,
      "none",
      "Final synthesis round must suppress tool calls via tool_choice: 'none'"
    );

    // Also verify runSynthesisPass in turnEngine forwards tools + tool_choice: 'none'
    const synthPayloads: LLMChatRequest[] = [];
    const turnAc = new AbortController();
    await runSynthesisPass({
      llmBaseUrl: "http://127.0.0.1:8080",
      activeModel: "test-model",
      conversationMessages: [
        { role: "system", content: "Static system header." },
        { role: "user", content: "Summarize." },
      ],
      tools: sampleTools,
      isArtifactRequest: false,
      turnAbortSignal: turnAc.signal,
      synthOptions: {},
      accumulatedThoughts: [],
      getAccumulatedStreamedTokens: () => "",
      setAccumulatedStreamedTokens: () => {},
      onFinishReason: () => {},
      onPromptTokens: () => {},
      onOutputTokens: () => {},
      maybeWriteSnapshot: () => {},
      sendEvent: async () => {},
      streamChat: async function* (_url, payload) {
        synthPayloads.push(JSON.parse(JSON.stringify(payload)));
        yield { message: { content: "Synthesized output." }, finish_reason: "stop" };
      },
      log: () => {},
    });

    assert.equal(synthPayloads.length, 1);
    assert.deepEqual(synthPayloads[0].tools, sampleTools);
    assert.equal(synthPayloads[0].tool_choice, "none");

    // Verify LlamaCppProvider forwards tool_choice: "none" alongside tools in the HTTP request body
    const origFetch = globalThis.fetch;
    let sentBody: Record<string, unknown> | null = null;
    try {
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body || "{}"));
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }) as typeof globalThis.fetch;

      const provider = new LlamaCppProvider();
      for await (const _ of provider.streamChat("http://127.0.0.1:8080", {
        model: "test-model",
        messages: [{ role: "user", content: "Summarize" }],
        tools: sampleTools,
        tool_choice: "none",
      })) {
      }
      assert.ok(sentBody);
      assert.deepEqual((sentBody as Record<string, unknown>).tools, sampleTools);
      assert.equal((sentBody as Record<string, unknown>).tool_choice, "none");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("keeps messages[0] content byte-identical before and after a dynamic directive is applied mid-turn", async () => {
    const initialSystemContent =
      "Static system prompt with operator memory and host state directive.";
    const messages = [
      { role: "system", content: initialSystemContent },
      { role: "user", content: "Create an SVG diagram and research facts." },
    ];
    const systemSnapshotBefore = messages[0].content;

    assert.equal(typeof appendTrailingDirective, "function");
    appendTrailingDirective(messages, WEB_BUDGET_EXHAUSTED_DIRECTIVE);
    // Calling a second time with the same directive must be idempotent
    appendTrailingDirective(messages, WEB_BUDGET_EXHAUSTED_DIRECTIVE);

    assert.equal(
      messages[0].content,
      systemSnapshotBefore,
      "messages[0].content must remain byte-identical after mid-turn directive injection"
    );
    assert.equal(
      messages.filter((m, idx) => idx > 0 && m.role === "system").length,
      0,
      "No mid-array or trailing system messages may be added"
    );
    const trailingMsg = messages[messages.length - 1];
    assert.equal(trailingMsg.role, "user");
    assert.ok(trailingMsg.content.includes(WEB_BUDGET_EXHAUSTED_DIRECTIVE));
    assert.equal(
      messages.filter((m) => m.content.includes(WEB_BUDGET_EXHAUSTED_DIRECTIVE)).length,
      1,
      "Duplicate trailing directive must not be appended"
    );

    // Also verify across a multi-round runChatToolLoop turn that triggers highWater + final synthesis + artifact headroom
    const capturedSystemPrompts: string[] = [];
    const loopMessages = [
      { role: "system", content: initialSystemContent },
      { role: "user", content: "Draw an SVG flowchart diagram of the service." },
    ];
    let roundCount = 0;
    await runChatToolLoop({
      conversationMessages: loopMessages,
      llmTools: sampleTools,
      maxToolRounds: 2,
      streamLlmChat: async function* (payload) {
        const msgs = payload.messages as Array<{ role: string; content: string }>;
        capturedSystemPrompts.push(msgs[0].content);
        roundCount++;
        if (roundCount === 1) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "service.ts" }),
                  },
                },
              ],
            },
          };
        } else {
          yield { message: { content: "```svg\n<svg></svg>\n```" } };
        }
      },
      executeTool: async () => ({ ok: true }),
    });

    assert.equal(capturedSystemPrompts.length, 2);
    assert.equal(capturedSystemPrompts[0], initialSystemContent);
    assert.equal(
      capturedSystemPrompts[1],
      initialSystemContent,
      "messages[0].content must remain byte-identical across working and final synthesis rounds"
    );
  });

  it("keeps the tools schema list byte-identical across a turn where the web-research budget is exhausted mid-turn and rejects excess web calls at dispatch", async () => {
    const capturedToolLists: string[] = [];
    let executedWebCalls = 0;
    const messages = [
      { role: "system", content: "Static system prompt." },
      { role: "user", content: "Search the web repeatedly." },
    ];

    let roundNum = 0;
    await runChatToolLoop({
      conversationMessages: messages,
      llmTools: sampleTools,
      maxToolRounds: MAX_WEB_RESEARCH_CALLS + 3,
      streamLlmChat: async function* (payload) {
        capturedToolLists.push(JSON.stringify(payload.tools));
        roundNum++;
        if (roundNum <= MAX_WEB_RESEARCH_CALLS + 1) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "search_web",
                    arguments: JSON.stringify({ query: `query ${roundNum}` }),
                  },
                },
              ],
            },
          };
        } else {
          yield { message: { content: "Completed after web budget exhaustion." } };
        }
      },
      executeTool: async () => {
        executedWebCalls++;
        return { status: "SUCCESS", results: [] };
      },
    });

    assert.ok(capturedToolLists.length > MAX_WEB_RESEARCH_CALLS);
    const baselineSchemaJson = JSON.stringify(sampleTools);
    for (let i = 0; i < capturedToolLists.length; i++) {
      assert.equal(
        capturedToolLists[i],
        baselineSchemaJson,
        `Round ${i} tools schema list must remain byte-identical even after web budget exhaustion`
      );
    }
    assert.equal(
      executedWebCalls,
      MAX_WEB_RESEARCH_CALLS,
      "Excess web research call past MAX_WEB_RESEARCH_CALLS must be rejected at dispatch without invoking executeTool"
    );
  });
});
