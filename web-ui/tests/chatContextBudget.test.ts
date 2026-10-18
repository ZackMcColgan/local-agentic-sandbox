import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  estimateTokens,
  fitContextWindow,
  clampToolOutput,
  runChatToolLoop,
  FINAL_ROUND_SYNTHESIS_DIRECTIVE,
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

  describe("Task 3 (P1): Per-Round Enforcement & Final-Round Forced Synthesis", () => {
    it("enforces context budget <= 6000 tokens on EVERY round across multi-round tool accumulation", async () => {
      const capturedPayloads: any[] = [];
      const messages: any[] = [
        { role: "system", content: "You are an autonomous AI engineering assistant." },
        { role: "user", content: "Perform deep research across 3 search rounds." }
      ];

      let callCount = 0;
      const mockStreamChat = async function* (payload: any) {
        capturedPayloads.push(JSON.parse(JSON.stringify(payload)));
        callCount++;
        if (callCount <= 2) {
          // Model emits tool call on rounds 0 and 1
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "workspace_grep",
                    arguments: JSON.stringify({ query: `search_round_${callCount}` })
                  }
                }
              ]
            }
          };
        } else {
          // Model concludes with final text answer
          yield {
            message: {
              content: "Here is the comprehensive synthesized research summary across all 3 rounds."
            }
          };
        }
      };

      const mockExecuteTool = async (toolCall: any) => {
        // Return a massive 25,000-char tool result to simulate heavy tool accumulation
        return {
          status: "SUCCESS",
          tool: toolCall.function?.name,
          data: "D".repeat(25000)
        };
      };

      const result = await runChatToolLoop({
        conversationMessages: messages,
        ollamaTools: [{ type: "function", function: { name: "workspace_grep" } }],
        maxToolRounds: 5,
        streamOllamaChat: mockStreamChat,
        executeTool: mockExecuteTool
      });

      assert.equal(capturedPayloads.length, 3, "Should have executed exactly 3 tool/synthesis rounds");
      assert.ok(result.finalContent.includes("comprehensive synthesized research"), "Turn must conclude with text answer");

      // Verify EVERY round payload was <= 6000 tokens
      capturedPayloads.forEach((payload, idx) => {
        const tokens = estimateTokens(payload.messages);
        assert.ok(
          tokens <= 6000,
          `Round ${idx + 1} payload exceeded 6,000 token budget! Got ${tokens} tokens.`
        );

        // System prompt and user query must remain in every round payload
        const sysMsg = payload.messages.find((m: any) => m.role === "system");
        assert.ok(sysMsg, `Round ${idx + 1} must preserve system prompt`);
        const userMsg = payload.messages.find((m: any) => m.role === "user");
        assert.ok(userMsg, `Round ${idx + 1} must preserve user query`);
      });
    });

    it("forces synthesis on the final round: omits tools from payload, appends directive, and finishes with text", async () => {
      const capturedPayloads: any[] = [];
      const messages: any[] = [
        { role: "system", content: "You are an autonomous AI engineering assistant." },
        { role: "user", content: "Keep gathering data endlessly." }
      ];

      const MAX_ROUNDS = 4;
      let callCount = 0;

      const mockStreamChat = async function* (payload: any) {
        capturedPayloads.push(JSON.parse(JSON.stringify(payload)));
        callCount++;

        // If tools are present, the model aggressively attempts more tool calls
        if (payload.tools && payload.tools.length > 0) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "search_web",
                    arguments: JSON.stringify({ query: `query_${callCount}` })
                  }
                }
              ]
            }
          };
        } else {
          // On final round without tools, model produces text synthesis
          yield {
            message: {
              content: "Synthesized final answer from gathered data."
            }
          };
        }
      };

      const mockExecuteTool = async (toolCall: any) => {
        return { status: "SUCCESS", result: "sample tool data" };
      };

      const result = await runChatToolLoop({
        conversationMessages: messages,
        ollamaTools: [{ type: "function", function: { name: "search_web" } }],
        maxToolRounds: MAX_ROUNDS,
        streamOllamaChat: mockStreamChat,
        executeTool: mockExecuteTool
      });

      assert.equal(capturedPayloads.length, MAX_ROUNDS, `Should have run to MAX_ROUNDS (${MAX_ROUNDS})`);
      assert.equal(result.roundsCompleted, MAX_ROUNDS);
      assert.ok(result.finalContent.includes("Synthesized final answer"), "Turn must end with text answer");

      // Rounds 0, 1, 2 must include tools
      for (let i = 0; i < MAX_ROUNDS - 1; i++) {
        assert.ok(
          Array.isArray(capturedPayloads[i].tools) && capturedPayloads[i].tools.length > 0,
          `Round ${i} must include tools`
        );
      }

      // Final round (round === MAX_ROUNDS - 1) MUST omit tools
      const finalPayload = capturedPayloads[MAX_ROUNDS - 1];
      assert.equal(
        finalPayload.tools,
        undefined,
        "Final round payload MUST omit tools so model cannot call more tools"
      );

      // Final round MUST contain the synthesis directive in system message at index 0
      const synthesisMsg = finalPayload.messages[0];
      assert.equal(synthesisMsg?.role, "system");
      assert.ok(
        synthesisMsg?.content.includes(FINAL_ROUND_SYNTHESIS_DIRECTIVE),
        `Final round payload must include the synthesis directive in system message`
      );
      // Invariant: zero system messages at index > 0
      const midSystem = finalPayload.messages.filter((m: any, idx: number) => idx > 0 && m.role === "system");
      assert.equal(midSystem.length, 0, "Final round payload must have zero system messages at index > 0");
    });

    it("verifies chat/route.ts contains final round forced synthesis check and omits tools", () => {
      const chatRoutePath = path.resolve(__dirname, "../app/api/chat/route.ts");
      const content = fs.readFileSync(chatRoutePath, "utf8");

      assert.ok(
        content.includes("round === MAX_TOOL_ROUNDS - 1") ||
        content.includes("round >= MAX_TOOL_ROUNDS - 1"),
        "chat/route.ts must check for final round (round === MAX_TOOL_ROUNDS - 1)"
      );

      assert.ok(
        content.includes("FINAL_ROUND_SYNTHESIS_DIRECTIVE") ||
        content.includes("buildSynthesisDirective") ||
        content.includes("You have gathered enough information. Synthesize your final answer now"),
        "chat/route.ts must handle final round synthesis directive"
      );

      assert.ok(
        content.includes("round < MAX_TOOL_ROUNDS - 1") ||
        content.includes("!isFinalRound"),
        "chat/route.ts must omit tools from payload on final round"
      );
    });
  });

  describe("Task 3: Jinja 500 Elimination & System Message Invariant", () => {
    it("mergeSystemDirective never places a system message at index > 0", async () => {
      const { mergeSystemDirective, WEB_BUDGET_EXHAUSTED_DIRECTIVE } = await import("../lib/contextBudget.js") as any;
      assert.ok(typeof mergeSystemDirective === "function", "mergeSystemDirective must be exported");

      const messages = [
        { role: "system", content: "Base system instructions." },
        { role: "user", content: "What is the weather?" },
        { role: "tool", content: "Sunny 75F" }
      ];

      mergeSystemDirective(messages, WEB_BUDGET_EXHAUSTED_DIRECTIVE);

      assert.equal(messages[0].role, "system");
      assert.ok(messages[0].content.includes("Base system instructions."));
      assert.ok(messages[0].content.includes(WEB_BUDGET_EXHAUSTED_DIRECTIVE));

      const trailingSystem = messages.filter((m, idx) => idx > 0 && m.role === "system");
      assert.equal(trailingSystem.length, 0, "No system messages allowed at index > 0");
    });

    it("mergeSystemDirective inserts at index 0 when no leading system message exists", async () => {
      const { mergeSystemDirective } = await import("../lib/contextBudget.js") as any;

      const messages = [
        { role: "user", content: "Hello" }
      ];

      mergeSystemDirective(messages, "Directive A");

      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, "system");
      assert.equal(messages[0].content, "Directive A");
      assert.equal(messages[1].role, "user");
    });

    it("mergeSystemDirective does not duplicate directive when called multiple times with same text", async () => {
      const { mergeSystemDirective } = await import("../lib/contextBudget.js") as any;

      const messages = [
        { role: "system", content: "Initial prompt" }
      ];

      mergeSystemDirective(messages, "Unique Directive");
      mergeSystemDirective(messages, "Unique Directive");

      const occurrences = (messages[0].content.match(/Unique Directive/g) || []).length;
      assert.equal(occurrences, 1, "Directive must not be duplicated in system prompt");
    });

    it("fitContextWindow consolidates stray mid-array system messages into index 0", async () => {
      const strayMessages = [
        { role: "system", content: "Initial prompt" },
        { role: "user", content: "Question" },
        { role: "assistant", content: "Working..." },
        { role: "system", content: "Mid-array directive 1" },
        { role: "tool", content: "Tool output" },
        { role: "system", content: "Mid-array directive 2" }
      ];

      const fitted = fitContextWindow(strayMessages);

      assert.equal(fitted[0].role, "system");
      assert.ok(fitted[0].content.includes("Initial prompt"));
      assert.ok(fitted[0].content.includes("Mid-array directive 1"));
      assert.ok(fitted[0].content.includes("Mid-array directive 2"));

      const nonIndex0System = fitted.filter((m, idx) => idx > 0 && m.role === "system");
      assert.equal(nonIndex0System.length, 0, "fitContextWindow must eliminate all system messages at index > 0");
    });

    it("fitContextWindow reserves tool schema token budget when tools option is provided", () => {
      // 10 mock tools totaling ~2,000 tokens
      const mockTools = Array.from({ length: 10 }, (_, i) => ({
        type: "function",
        function: {
          name: `mock_tool_${i}`,
          description: `Description for mock tool ${i} with extended schema details to simulate real MCP definitions.`,
          parameters: {
            type: "object",
            properties: {
              param1: { type: "string", description: "First parameter description" },
              param2: { type: "number", description: "Second parameter description" },
              param3: { type: "boolean", description: "Third parameter description" }
            },
            required: ["param1"]
          }
        }
      }));

      // Generate messages that fit within 6,000 tokens without tools
      const messages = [
        { role: "system", content: "System header" },
        { role: "user", content: "User question" },
        { role: "tool", name: "tool_1", content: "x".repeat(18000) } // ~4,500 tokens
      ];

      // Without tools: 4,500 tokens fits in default 6,000 maxContentTokens
      const fittedWithoutTools = fitContextWindow(messages, { maxContentTokens: 6000 });
      const toolMsgWithout = fittedWithoutTools.find((m) => m.role === "tool");
      assert.ok(!toolMsgWithout?.content.includes(EARLIER_TOOL_OUTPUT_TRUNCATED_MARKER));

      // With tools: tools schema takes ~1,500-2,000 tokens, so available message budget must shrink
      const fittedWithTools = fitContextWindow(messages, { maxContentTokens: 6000, tools: mockTools } as any);
      const totalFittedTokens = estimateTokens(fittedWithTools);
      const toolSchemaTokens = estimateTokens(JSON.stringify(mockTools));

      assert.ok(
        totalFittedTokens + toolSchemaTokens <= 6000,
        `Messages (${totalFittedTokens}) + Tools (${toolSchemaTokens}) must not exceed 6,000 budget`
      );
    });

    it("estimateTokens includes tool_calls on assistant messages", () => {
      const msgWithoutCalls = {
        role: "assistant",
        content: "Here is the call:"
      };
      const msgWithCalls = {
        role: "assistant",
        content: "Here is the call:",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "workspace_write_file",
              arguments: JSON.stringify({ path: "test.ts", content: "const x = 1;" })
            }
          }
        ]
      };

      const tokensWithout = estimateTokens(msgWithoutCalls);
      const tokensWith = estimateTokens(msgWithCalls);

      assert.ok(tokensWith > tokensWithout + 20, "estimateTokens must account for assistant tool_calls JSON");
    });

    it("verifies web-ui/app/api/chat/route.ts has ZERO .push({ role: 'system' occurrences", () => {
      const chatRoutePath = path.resolve(__dirname, "../app/api/chat/route.ts");
      const content = fs.readFileSync(chatRoutePath, "utf8");

      const matches = content.match(/\.push\(\s*\{\s*role:\s*["']system["']/g);
      assert.equal(
        matches,
        null,
        `route.ts must not push system messages directly mid-array, found: ${matches?.length} matches`
      );
    });
  });

  describe("Task 4 (WS-B): Artifact Output Headroom Reservation & Fast Synthesis Reasoning", () => {
    it("reserves >= 3,000 tokens of output headroom in an 8,192-token context window on artifact turns", async () => {
      const { ARTIFACT_OUTPUT_HEADROOM_TOKENS } = await import("../lib/contextBudget.js") as any;
      assert.equal(ARTIFACT_OUTPUT_HEADROOM_TOKENS, 3000);

      const mockTools = Array.from({ length: 8 }, (_, i) => ({
        type: "function",
        function: {
          name: `tool_${i}`,
          description: "x".repeat(600),
          parameters: { type: "object", properties: { q: { type: "string" } } }
        }
      }));
      const toolTokens = estimateTokens(JSON.stringify(mockTools));

      const messages = [
        { role: "system", content: "You are an autonomous assistant. " + "S".repeat(1200) },
        { role: "user", content: "Create an SVG architecture diagram of the cluster" },
        { role: "tool", name: "tool_0", content: "A".repeat(12000) },
        { role: "tool", name: "tool_1", content: "B".repeat(12000) }
      ];

      const fitted = fitContextWindow(messages, {
        isArtifactTurn: true,
        tools: mockTools
      } as any);

      const inputTokens = estimateTokens(fitted);
      assert.ok(
        inputTokens + toolTokens <= 8192 - 3000,
        `Expected inputTokens (${inputTokens}) + toolTokens (${toolTokens}) <= 5192 so >= 3000 output headroom remains`
      );
      assert.equal(fitted[0].role, "system");
      const lastUser = [...fitted].reverse().find((m) => m.role === "user");
      assert.equal(lastUser?.content, "Create an SVG architecture diagram of the cluster");
    });

    it("resolveRoundModelOptions drops effort to 'low' and omits num_predict on artifact synthesis/post-tool rounds", async () => {
      const { resolveRoundModelOptions } = await import("../lib/contextBudget.js") as any;
      assert.equal(typeof resolveRoundModelOptions, "function");

      const opts = resolveRoundModelOptions({
        model: "swift-15-27b-mtp",
        requestedEffort: "xhigh",
        userPrompt: "Create a svg of the weather in Spanish Fort AL",
        isSynthesisOrFinalRound: false,
        hasCompletedToolCalls: true
      });

      assert.equal(opts.temperature, 0.2, "Should drop to low effort (temperature 0.2) after tool calls on artifact turn");
      assert.equal(opts.num_predict, undefined, "Must omit num_predict so LlamaCppProvider does not cap max_tokens");
    });

    it("constrained-context artifact completion regression: delivers complete untruncated <svg>...</svg> when tool outputs exceed 10,000 chars", async () => {
      const { extractSvgsFromMessage } = await import("../lib/svgUtils.js");
      const completeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><rect width="800" height="500" fill="#0f172a"/><text x="40" y="80" fill="#38bdf8">Spanish Fort, AL — 78°F Sunny</text></svg>`;

      const conversationMessages: any[] = [
        { role: "system", content: "System instructions for artifact creation." },
        { role: "user", content: "Create an SVG weather card for Spanish Fort AL" }
      ];

      const capturedPayloads: any[] = [];
      const traces: any[] = [];
      let roundIdx = 0;

      const mockStreamChat = async function* (payload: any) {
        capturedPayloads.push(JSON.parse(JSON.stringify(payload)));
        roundIdx++;
        if (roundIdx === 1) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "search_web",
                    arguments: JSON.stringify({ query: "Spanish Fort AL weather" })
                  }
                }
              ]
            }
          };
        } else if (roundIdx === 2) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "workspace_write_file",
                    arguments: JSON.stringify({ path: "spanish-fort-weather.svg", content: completeSvg })
                  }
                }
              ]
            }
          };
        } else {
          yield {
            message: {
              content: "Saved the complete Spanish Fort AL weather SVG diagram."
            }
          };
        }
      };

      const mockExecuteTool = async (toolCall: any) => {
        const name = toolCall.function?.name;
        const args = typeof toolCall.function?.arguments === "string"
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function?.arguments;
        const result = name === "search_web"
          ? { status: "SUCCESS", raw_markdown: "W".repeat(12000) }
          : { status: "SUCCESS", path: args.path };
        traces.push({ tool: name, args, result });
        return result;
      };

      const loopRes = await runChatToolLoop({
        conversationMessages,
        activeModel: "swift-15-27b-mtp",
        effectiveReasoningEffort: "xhigh",
        ollamaTools: [
          { type: "function", function: { name: "search_web" } },
          { type: "function", function: { name: "workspace_write_file" } }
        ],
        maxToolRounds: 5,
        streamOllamaChat: mockStreamChat,
        executeTool: mockExecuteTool
      });

      // Verify output headroom was preserved on every round
      for (const p of capturedPayloads) {
        const msgTokens = estimateTokens(p.messages);
        const tTokens = p.tools ? estimateTokens(JSON.stringify(p.tools)) : 0;
        assert.ok(
          msgTokens + tTokens <= 8192 - 3000,
          `Round payload tokens (${msgTokens + tTokens}) must leave >= 3000 tokens of headroom in 8192 window`
        );
      }

      // Round 2+ (after tool calls completed on artifact turn) must omit num_predict and use fast effort
      assert.equal(capturedPayloads[1].options.num_predict, undefined);
      assert.equal(capturedPayloads[1].options.temperature, 0.2);

      const extracted = extractSvgsFromMessage({
        id: "msg-1",
        content: loopRes.finalContent,
        traces
      });
      assert.equal(extracted.length, 1, "Must extract exactly 1 complete SVG artifact");
      assert.ok(extracted[0].code?.startsWith("<svg") && extracted[0].code?.endsWith("</svg>"), "SVG must be complete and untruncated");
      assert.ok(extracted[0].code?.includes("Spanish Fort, AL — 78°F Sunny"));
    });
  });
});



