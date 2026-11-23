import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../app/api/chat/route";
import {
  ROUND_MAX_TOKENS,
  COMPACTION_THRESHOLD_RATIO,
  HYBRID_ESCALATION_RATIO,
} from "../lib/modelLimits";
import {
  CHAT_CONTEXT_BUDGET_TOKENS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimateTokens,
  fitConversationToBudget,
  canContinueToolLoop,
  type ContextMessage,
} from "../lib/contextBudget";
import {
  compactConversationHistory,
  runHybridCompaction,
  COMPACTION_MODEL_DIGEST_HEADER,
  COMPACTION_PROMPT_V1,
} from "../lib/conversationCompaction";
import { applyMicroElision } from "../lib/microElision";
import { normalizeOpenAIMessages } from "../lib/llm/provider";
import { ThreadStore, type Thread } from "../lib/threads/threadStore";

interface SseEvent {
  type?: string;
  [key: string]: unknown;
}

async function readSseEvents(response: Response): Promise<SseEvent[]> {
  const text = await response.text();
  const events: SseEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      events.push(JSON.parse(raw) as SseEvent);
    } catch {}
  }
  return events;
}

function startMockLlmServer(
  handler: (
    req: http.IncomingMessage,
    body: Record<string, unknown>,
    res: http.ServerResponse
  ) => void
): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        } catch {}
        handler(req, parsed, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("Batch D — Context Economics (F8a–F8e)", () => {
  describe("Directive #16 non-negotiable threshold constants", () => {
    it("pins ROUND_MAX_TOKENS=16384, COMPACTION_THRESHOLD_RATIO=0.85, HYBRID_ESCALATION_RATIO=0.65", () => {
      assert.equal(ROUND_MAX_TOKENS, 16384);
      assert.equal(COMPACTION_THRESHOLD_RATIO, 0.85);
      assert.equal(HYBRID_ESCALATION_RATIO, 0.65);
      assert.equal(CHAT_CONTEXT_BUDGET_TOKENS, 100000);
      assert.equal(DEFAULT_CONTEXT_WINDOW_TOKENS, 131072);
    });
  });

  describe("Fix D1 (F8a): Trigger compaction on measured truth & tool schemas, not raw chars/4 estimates", () => {
    it("triggers compaction when estimator says ~80K but measured prompt is 93K", () => {
      // Build a conversation whose chars/4 estimate is ~80,000 (< 85,000 trigger)
      const chunk = "c".repeat(32_000); // 8,000 estimated tokens each
      const messages: ContextMessage[] = [
        { role: "system", content: "System instructions." },
        { role: "user", content: "Original job brief: fix the module and run tests." },
      ];
      for (let i = 0; i < 10; i++) {
        messages.push({
          role: "assistant",
          content: `Step ${i}`,
          tool_calls: [
            {
              id: `c_${i}`,
              type: "function",
              function: {
                name: "workspace_run_command",
                arguments: JSON.stringify({ cmd: `t${i}` }),
              },
            },
          ],
        });
        messages.push({
          role: "tool",
          name: "workspace_run_command",
          tool_call_id: `c_${i}`,
          content: chunk,
        });
      }

      const estimated = estimateTokens(messages);
      assert.ok(
        estimated >= 78_000 && estimated <= 83_000,
        `Expected raw estimate near 80K, got ${estimated}`
      );

      // With measuredPromptTokens = 93,000 (> 85,000 trigger), compaction MUST fire
      const res = fitConversationToBudget(messages, {
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        measuredPromptTokens: 93_000,
      } as Parameters<typeof fitConversationToBudget>[1]);

      assert.equal(
        res.compacted,
        true,
        "Must compact when measured prompt is 93K despite 80K estimate"
      );
      assert.ok(res.actions.includes("compaction"), "Must engage compaction rung");
      assert.ok(
        res.tokensBefore >= 93_000,
        `tokensBefore must reflect measured truth, got ${res.tokensBefore}`
      );
    });

    it("includes tool schemas in round-0 compaction trigger estimate", () => {
      // ~80,500 estimated message tokens + ~6,000 tool schema tokens = ~86,500 >= 85,000
      const chunk = "k".repeat(32_000); // 8,000 estimated tokens each
      const messages: ContextMessage[] = [
        { role: "system", content: "System." },
        { role: "user", content: "Brief." },
      ];
      for (let i = 0; i < 10; i++) {
        messages.push({ role: "assistant", content: `Step ${i}` });
        messages.push({ role: "tool", name: "t", content: chunk });
      }
      const estimated = estimateTokens(messages);
      assert.ok(estimated < 85_000, `Messages alone must sit below 85K (got ${estimated})`);

      const largeTools = Array.from({ length: 12 }, (_, i) => ({
        type: "function",
        function: {
          name: `tool_${i}`,
          description: "D".repeat(2000),
          parameters: { type: "object", properties: { arg: { type: "string" } } },
        },
      }));
      const schemaTokens = estimateTokens(JSON.stringify(largeTools));
      assert.ok(estimated + schemaTokens >= 85_000, "Messages + tool schemas must cross 85K");

      const res = fitConversationToBudget(messages, {
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        tools: largeTools,
      } as Parameters<typeof fitConversationToBudget>[1]);

      assert.equal(
        res.compacted,
        true,
        "Round-0 compaction must fire when messages + tool schemas cross 85% threshold"
      );
      assert.ok(res.actions.includes("compaction"));
    });
  });

  describe("Fix D2 (F8b): Reserve ROUND_MAX_TOKENS output headroom", () => {
    it("blocks starting a round when measured input + ROUND_MAX_TOKENS exceeds the window", () => {
      const window = DEFAULT_CONTEXT_WINDOW_TOKENS; // 131,072
      const ceiling = window - ROUND_MAX_TOKENS; // 114,688

      // Even when raw chars/4 estimate is below 100K, if measured input is 115,000
      // (115,000 + 16,384 = 131,384 > 131,072), the round MUST NOT start.
      const blocked = canContinueToolLoop({
        round: 2,
        contextTokens: 90_000,
        measuredPromptTokens: ceiling + 1,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        contextWindowTokens: window,
        outputReserveTokens: ROUND_MAX_TOKENS,
        lastRoundTools: ["workspace_read_file"],
        webResearchCalls: 0,
      } as Parameters<typeof canContinueToolLoop>[0]);

      assert.equal(
        blocked.canContinue,
        false,
        "Round must not start when measured input + ROUND_MAX_TOKENS exceeds window"
      );
      assert.equal(blocked.stopReason, "budget");

      // Even research-only rounds must NEVER start when measured input + ROUND_MAX_TOKENS > window
      const blockedResearch = canContinueToolLoop({
        round: 2,
        contextTokens: 90_000,
        measuredPromptTokens: ceiling + 500,
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        contextWindowTokens: window,
        outputReserveTokens: ROUND_MAX_TOKENS,
        lastRoundTools: ["search_web"],
        webResearchCalls: 1,
      } as Parameters<typeof canContinueToolLoop>[0]);

      assert.equal(
        blockedResearch.canContinue,
        false,
        "Even web research rounds must not exceed window - ROUND_MAX_TOKENS"
      );
      assert.equal(blockedResearch.stopReason, "budget");
    });

    it("caps compaction trigger by effective input ceiling (window - ROUND_MAX_TOKENS) on smaller windows", () => {
      const customWindow = 80_000;
      const effectiveCeiling = customWindow - ROUND_MAX_TOKENS; // 63,616
      const expectedTrigger = Math.floor(effectiveCeiling * COMPACTION_THRESHOLD_RATIO); // 54,073

      // Build messages estimating ~56,000 tokens (> 54,073, < 85,000)
      const chunk = "z".repeat(28_000); // 7,000 tokens
      const messages: ContextMessage[] = [
        { role: "system", content: "System." },
        { role: "user", content: "Brief." },
      ];
      for (let i = 0; i < 8; i++) {
        messages.push({ role: "assistant", content: `Step ${i}` });
        messages.push({ role: "tool", name: "t", content: chunk });
      }
      const tokens = estimateTokens(messages);
      assert.ok(
        tokens > expectedTrigger && tokens < 85_000,
        `Tokens (${tokens}) should sit between ${expectedTrigger} and 85000`
      );

      const res = fitConversationToBudget(messages, {
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        contextWindowTokens: customWindow,
        outputReserveTokens: ROUND_MAX_TOKENS,
      } as Parameters<typeof fitConversationToBudget>[1]);

      assert.equal(
        res.compacted,
        true,
        "Compaction must trigger at 0.85 * (window - ROUND_MAX_TOKENS)"
      );
      assert.ok(
        res.tokensAfter <= effectiveCeiling,
        `Post-fit tokens (${res.tokensAfter}) must not exceed effective ceiling (${effectiveCeiling})`
      );
    });
  });

  describe("Fix D3 (F8c): Elide superseded write/patch args and superseded file reads", () => {
    it("stubs the first write's argument body after a file is written twice while keeping the second byte-identical and prose untouched", () => {
      const firstBody = "export const version = 1;\n" + "// line\n".repeat(120);
      const secondBody = "export const version = 2;\n" + "// updated\n".repeat(120);
      const firstProse = "I will create src/app.ts with the initial implementation.";
      const secondProse = "Now updating src/app.ts with version 2.";

      const messages = [
        { role: "system", content: "System." },
        { role: "user", content: "Write src/app.ts twice." },
        {
          role: "assistant",
          content: firstProse,
          tool_calls: [
            {
              id: "call_w1",
              type: "function",
              function: {
                name: "workspace_write_file",
                arguments: JSON.stringify({ path: "src/app.ts", content: firstBody }),
              },
            },
          ],
        },
        {
          role: "tool",
          name: "workspace_write_file",
          tool_call_id: "call_w1",
          content: JSON.stringify({ ok: true, path: "src/app.ts" }),
        },
        {
          role: "assistant",
          content: secondProse,
          tool_calls: [
            {
              id: "call_w2",
              type: "function",
              function: {
                name: "workspace_write_file",
                arguments: JSON.stringify({ path: "src/app.ts", content: secondBody }),
              },
            },
          ],
        },
        {
          role: "tool",
          name: "workspace_write_file",
          tool_call_id: "call_w2",
          content: JSON.stringify({ ok: true, path: "src/app.ts" }),
        },
      ];

      const originalSecondArgs = messages[4].tool_calls![0].function.arguments;
      const result = applyMicroElision(messages, 3);

      assert.ok(result.stubbed >= 1, "Superseded first write argument body must be stubbed");

      // First write argument body is a valid JSON stub with path + size + round
      const firstArgsParsed = JSON.parse(messages[2].tool_calls![0].function.arguments);
      assert.equal(firstArgsParsed.path, "src/app.ts", "Path must be preserved in stubbed args");
      assert.match(
        firstArgsParsed.content,
        /^\[Micro-elision:/,
        "First write content must be a stub"
      );
      assert.match(firstArgsParsed.content, /target=src\/app\.ts/);
      assert.match(firstArgsParsed.content, /originalChars=\d+/);
      assert.match(firstArgsParsed.content, /round=1/);

      // Second write argument body is BYTE-IDENTICAL
      assert.equal(
        messages[4].tool_calls![0].function.arguments,
        originalSecondArgs,
        "Latest write argument body must remain byte-identical"
      );

      // Assistant prose is NEVER elided
      assert.equal(messages[2].content, firstProse, "Assistant prose must remain byte-identical");
      assert.equal(messages[4].content, secondProse, "Assistant prose must remain byte-identical");

      // Idempotent on re-run
      const secondRun = applyMicroElision(messages, 4);
      assert.equal(secondRun.stubbed, 0, "Already-stubbed args must not re-elide");
    });

    it("elides a file read superseded by a later write to the same file while keeping post-write reads intact", () => {
      const oldReadPayload = JSON.stringify({
        path: "src/service.ts",
        content: "old content\n".repeat(40),
      });
      const newReadPayload = JSON.stringify({
        path: "src/service.ts",
        content: "new content\n".repeat(40),
      });

      const messages = [
        { role: "system", content: "System." },
        { role: "user", content: "Read, write, then re-read src/service.ts." },
        {
          role: "assistant",
          content: "Reading file first.",
          tool_calls: [
            {
              id: "call_r1",
              type: "function",
              function: {
                name: "host_read_file",
                arguments: JSON.stringify({ path: "src/service.ts" }),
              },
            },
          ],
        },
        { role: "tool", name: "host_read_file", tool_call_id: "call_r1", content: oldReadPayload },
        {
          role: "assistant",
          content: "Writing updated file.",
          tool_calls: [
            {
              id: "call_w1",
              type: "function",
              function: {
                name: "host_write_file",
                arguments: JSON.stringify({
                  path: "src/service.ts",
                  content: "new content\n".repeat(40),
                }),
              },
            },
          ],
        },
        {
          role: "tool",
          name: "host_write_file",
          tool_call_id: "call_w1",
          content: JSON.stringify({ ok: true }),
        },
        {
          role: "assistant",
          content: "Re-reading to verify.",
          tool_calls: [
            {
              id: "call_r2",
              type: "function",
              function: {
                name: "host_read_file",
                arguments: JSON.stringify({ path: "src/service.ts" }),
              },
            },
          ],
        },
        { role: "tool", name: "host_read_file", tool_call_id: "call_r2", content: newReadPayload },
      ];

      const res = applyMicroElision(messages, 4);
      assert.ok(res.stubbed >= 1, "Superseded read before write must be elided");
      assert.match(messages[3].content, /^\[Micro-elision:/, "Earlier read must be stubbed");
      assert.match(messages[3].content, /target=src\/service\.ts/);
      assert.equal(messages[7].content, newReadPayload, "Post-write read must stay byte-identical");
    });

    it("stubs earlier patch/replace arguments when the same file is patched again", () => {
      const messages = [
        { role: "system", content: "System." },
        { role: "user", content: "Patch src/util.ts twice." },
        {
          role: "assistant",
          content: "First patch.",
          tool_calls: [
            {
              id: "call_p1",
              type: "function",
              function: {
                name: "host_replace_string",
                arguments: JSON.stringify({
                  path: "src/util.ts",
                  old_string: "const a = 1;".repeat(20),
                  new_string: "const a = 2;".repeat(20),
                }),
              },
            },
          ],
        },
        {
          role: "tool",
          name: "host_replace_string",
          tool_call_id: "call_p1",
          content: '{"ok":true}',
        },
        {
          role: "assistant",
          content: "Second patch.",
          tool_calls: [
            {
              id: "call_p2",
              type: "function",
              function: {
                name: "host_replace_string",
                arguments: JSON.stringify({
                  path: "src/util.ts",
                  old_string: "const a = 2;".repeat(20),
                  new_string: "const a = 3;".repeat(20),
                }),
              },
            },
          ],
        },
        {
          role: "tool",
          name: "host_replace_string",
          tool_call_id: "call_p2",
          content: '{"ok":true}',
        },
      ];

      const latestPatchArgs = messages[4].tool_calls![0].function.arguments;
      const res = applyMicroElision(messages, 3);
      assert.ok(res.stubbed >= 1, "First patch must be elided when superseded");
      const firstParsed = JSON.parse(messages[2].tool_calls![0].function.arguments);
      assert.equal(firstParsed.path, "src/util.ts");
      assert.match(firstParsed.new_string, /^\[Micro-elision:/);
      assert.equal(messages[4].tool_calls![0].function.arguments, latestPatchArgs);
    });
  });

  describe("Fix D4 (F8d): Hybrid compaction works mid-turn for single-turn jobs", () => {
    it("compacts a single-turn thread (<=4 on-disk messages) mid-turn against its in-memory history and updates persisted thread record", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-econ-d4-"));
      try {
        const store = new ThreadStore(tmpDir);
        const brief =
          "JOB BRIEF: Inspect web-ui/lib/contextBudget.ts commit 86c8901c6433617cb9abe5db97123a0f52f58c89 https://github.com/test/repo and complete all requirements.";
        // On-disk thread mid-single-turn: ONLY 2 messages (user brief + streaming placeholder)
        const thread: Thread = {
          id: "thread-single-turn-hybrid",
          title: "Single-Turn Marathon",
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          model: "swift-15-27b-mtp",
          reasoningEffort: "medium",
          messages: [
            { id: "m-user-brief", role: "user", content: brief, timestamp: "now" },
            {
              id: "m-streaming-placeholder",
              role: "assistant",
              content: "",
              status: "streaming",
              timestamp: "now",
            },
          ],
        };
        store.saveThread(thread);

        // Long in-memory conversation (>85K total, >65K post-extraction so hybrid escalates)
        const olderFiller = "a".repeat(45_000 * 4);
        const recentFiller = "b".repeat(70_000 * 4);
        const liveMessages: ContextMessage[] = [
          { role: "system", content: "System instructions." },
          { role: "user", content: brief },
          { role: "assistant", content: "Round 1 working." },
          { role: "tool", name: "workspace_read_file", content: olderFiller },
          { role: "assistant", content: "Round 2 working." },
          { role: "tool", name: "workspace_run_command", content: "ok" },
          { role: "assistant", content: "Round 3 working." },
          { role: "tool", name: "workspace_read_file", content: recentFiller },
          { role: "assistant", content: "Round 4 working." },
          { role: "tool", name: "workspace_run_command", content: "tests pass" },
        ];

        let summarizeCalls = 0;
        const hybridResult = await store.compactThreadIncrementalHybrid(thread, {
          liveMessages,
          summarize: async ({ prompt, digest }) => {
            summarizeCalls++;
            assert.equal(prompt, COMPACTION_PROMPT_V1);
            assert.ok(digest.includes("web-ui/lib/contextBudget.ts"));
            return `${COMPACTION_MODEL_DIGEST_HEADER}\nPrior User Goals & Requests:\n- Inspect contextBudget\nRetained Identifiers & Artifacts:\n- File paths: web-ui/lib/contextBudget.ts\n- Git SHAs: 86c8901c6433617cb9abe5db97123a0f52f58c89\n- URLs: https://github.com/test/repo`;
          },
        } as Parameters<typeof store.compactThreadIncrementalHybrid>[1]);

        assert.equal(
          hybridResult.noop,
          false,
          "Single-turn mid-turn hybrid compaction must NOT no-op"
        );
        assert.equal(hybridResult.modelSummaryUsed, true, "Hybrid summarizer must have been used");
        assert.equal(summarizeCalls, 1, "Exactly one hybrid summarization pass");

        // Returned compacted messages carry the model digest AND preserve the original brief verbatim
        const compactedMsgs = (hybridResult as { messages?: ContextMessage[] }).messages;
        assert.ok(Array.isArray(compactedMsgs) && compactedMsgs.length > 0);
        assert.ok(
          compactedMsgs.some((m) => m.content.startsWith(COMPACTION_MODEL_DIGEST_HEADER)),
          "Compacted in-memory messages must include the hybrid model digest"
        );
        assert.ok(
          compactedMsgs.some((m) => m.role === "user" && m.content === brief),
          "Leading user brief must survive mid-turn hybrid compaction verbatim"
        );

        // Persisted thread record updated from the same result
        const saved = await store.getThread(thread.id);
        assert.ok(saved?.compaction, "Persisted thread must record the compaction boundary");
        assert.equal(saved.compaction.strategy, "hybrid");
        assert.ok(saved.compaction.summary.startsWith(COMPACTION_MODEL_DIGEST_HEADER));
        assert.ok(saved.compaction.extractionDigest, "Extraction audit digest must be retained");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("below-threshold liveMessages still no-ops without invoking summarize", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-econ-d4-noop-"));
      try {
        const store = new ThreadStore(tmpDir);
        const thread: Thread = {
          id: "thread-single-turn-small",
          title: "Small Turn",
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          model: "swift-15-27b-mtp",
          reasoningEffort: "medium",
          messages: [
            { id: "u1", role: "user", content: "Short brief", timestamp: "now" },
            { id: "a1", role: "assistant", content: "", status: "streaming", timestamp: "now" },
          ],
        };
        store.saveThread(thread);

        const smallLive: ContextMessage[] = [
          { role: "system", content: "System." },
          { role: "user", content: "Short brief" },
          { role: "assistant", content: "step 1" },
          { role: "tool", name: "t", content: "ok" },
          { role: "assistant", content: "step 2" },
          { role: "tool", name: "t", content: "ok" },
        ];

        let calls = 0;
        const res = await store.compactThreadIncrementalHybrid(thread, {
          liveMessages: smallLive,
          summarize: async () => {
            calls++;
            return "MUST NOT RUN";
          },
        } as Parameters<typeof store.compactThreadIncrementalHybrid>[1]);

        assert.equal(res.noop, true);
        assert.equal(calls, 0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("Fix D5 (F8e): The leading user brief survives every compaction rung verbatim", () => {
    const LONG_BRIEF =
      "START_OF_JOB_BRIEF\n" +
      "Requirement block A: ".repeat(150) +
      "\nMIDDLE_CONSTRAINTS_ALLOWLIST: only touch web-ui/lib/\n" +
      "Requirement block B: ".repeat(150) +
      "\nEND_OF_JOB_BRIEF_ACCEPTANCE_CRITERIA_EXACT_TOKEN_987654321";

    it("preserves a >4000-char leading user brief byte-identical through extraction compaction and does not trigger synthetic proceed", () => {
      assert.ok(LONG_BRIEF.length > 4000, "Brief fixture must exceed old 2000-char excerpt cap");

      const messages: ContextMessage[] = [
        { role: "system", content: "System instructions." },
        { role: "user", content: LONG_BRIEF },
      ];
      for (let i = 0; i < 12; i++) {
        messages.push({ role: "assistant", content: `Tool round ${i}` });
        messages.push({
          role: "tool",
          name: "workspace_run_command",
          content: `Output ${i}: ` + "x".repeat(32_000),
        });
      }

      const compacted = compactConversationHistory(messages, {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: COMPACTION_THRESHOLD_RATIO,
        preserveRecentMessages: 4,
      });

      assert.equal(compacted.compacted, true);
      const firstUser = compacted.messages.find((m) => m.role === "user");
      assert.ok(firstUser, "A real user message must exist in compacted messages");
      assert.equal(
        firstUser.content,
        LONG_BRIEF,
        "Leading user message must be byte-identical to the original brief"
      );

      // Provider normalizer must NOT inject "Proceed with the request."
      const normalized = normalizeOpenAIMessages(
        compacted.messages as unknown as Parameters<typeof normalizeOpenAIMessages>[0]
      );
      assert.ok(
        !normalized.some((m) => m.role === "user" && m.content === "Proceed with the request."),
        "Synthetic proceed fallback must not fire when real user brief exists"
      );
      const normUser = normalized.find((m) => m.role === "user");
      assert.equal(normUser?.content, LONG_BRIEF);
    });

    it("preserves the leading user brief verbatim across hybrid compaction, full fit ladder (rungs a-d), and repeated compactions", async () => {
      const messages: ContextMessage[] = [
        { role: "system", content: "System instructions." },
        { role: "user", content: LONG_BRIEF },
      ];
      for (let i = 0; i < 6; i++) {
        messages.push({ role: "assistant", content: `Round ${i}` });
        messages.push({ role: "tool", name: "host_read_file", content: "R".repeat(80_000) });
      }
      // Also include a mid-turn steer user message so Rung (c) sees >1 user message
      messages.push({ role: "user", content: "[Steer from user, mid-turn] Keep going." });
      messages.push({ role: "assistant", content: "Acknowledged steer." });
      messages.push({ role: "tool", name: "host_read_file", content: "L".repeat(280_000) });

      // Full fit ladder (rungs a/b/c/d)
      const fitted = fitConversationToBudget(messages, {
        budgetTokens: CHAT_CONTEXT_BUDGET_TOKENS,
      });
      assert.equal(fitted.compacted, true);
      const firstUserAfterLadder = fitted.messages.find((m) => m.role === "user");
      assert.equal(
        firstUserAfterLadder?.content,
        LONG_BRIEF,
        "Leading user brief must survive full fitConversationToBudget ladder verbatim"
      );

      // Second compaction after more rounds accumulate
      const secondWave: ContextMessage[] = [...fitted.messages];
      for (let i = 0; i < 12; i++) {
        secondWave.push({ role: "assistant", content: `Second wave ${i}` });
        secondWave.push({
          role: "tool",
          name: "workspace_run_command",
          content: "Q".repeat(32_000),
        });
      }
      const secondCompaction = compactConversationHistory(secondWave, {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
      });
      assert.equal(secondCompaction.compacted, true);
      assert.equal(
        secondCompaction.messages.find((m) => m.role === "user")?.content,
        LONG_BRIEF,
        "Leading user brief must survive repeated compactions byte-identical"
      );

      // Hybrid compaction
      const hybrid = await runHybridCompaction(
        [
          { role: "system", content: "System." },
          { role: "user", content: LONG_BRIEF },
          { role: "assistant", content: "Early work on web-ui/lib/contextBudget.ts" },
          { role: "tool", name: "workspace_read_file", content: "x".repeat(45_000 * 4) },
          { role: "assistant", content: "More work." },
          { role: "tool", name: "workspace_read_file", content: "y".repeat(70_000 * 4) },
          { role: "assistant", content: "Recent." },
          { role: "tool", name: "workspace_run_command", content: "ok" },
        ],
        {
          strategy: "hybrid",
          maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          summarize: async () =>
            `${COMPACTION_MODEL_DIGEST_HEADER}\nRetained Identifiers & Artifacts:\n- File paths: web-ui/lib/contextBudget.ts`,
        }
      );
      assert.equal(hybrid.compacted, true);
      assert.equal(hybrid.modelSummaryUsed, true);
      assert.equal(
        hybrid.messages.find((m) => m.role === "user")?.content,
        LONG_BRIEF,
        "Leading user brief must survive hybrid compaction verbatim"
      );
    });
  });

  describe("End-to-end POST /api/chat integration (D1, D2, D3, D5)", () => {
    let tmpThreadsDir: string;
    let origThreadsDir: string | undefined;
    let origLlmBaseUrl: string | undefined;
    let origLlmEngine: string | undefined;
    let origLlamaCppBaseUrl: string | undefined;
    let origMcpUrl: string | undefined;
    let origBrowserMcpUrl: string | undefined;
    let origCompactionStrategy: string | undefined;
    let server: http.Server | null = null;

    beforeEach(() => {
      tmpThreadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-econ-e2e-"));
      origThreadsDir = process.env.THREADS_DIR;
      origLlmBaseUrl = process.env.LLM_BASE_URL;
      origLlmEngine = process.env.LLM_ENGINE;
      origLlamaCppBaseUrl = process.env.LLAMACPP_BASE_URL;
      origMcpUrl = process.env.MCP_SERVER_URL;
      origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
      origCompactionStrategy = process.env.COMPACTION_STRATEGY;
      process.env.THREADS_DIR = tmpThreadsDir;
      process.env.LLM_ENGINE = "ollama";
      delete process.env.LLAMACPP_BASE_URL;
      process.env.MCP_SERVER_URL = "http://127.0.0.1:59997/mcp/sse";
      process.env.BROWSER_MCP_URL = "http://127.0.0.1:59996/browser/sse";
      delete process.env.COMPACTION_STRATEGY;
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
      if (origThreadsDir === undefined) delete process.env.THREADS_DIR;
      else process.env.THREADS_DIR = origThreadsDir;
      if (origLlmBaseUrl === undefined) delete process.env.LLM_BASE_URL;
      else process.env.LLM_BASE_URL = origLlmBaseUrl;
      if (origLlmEngine === undefined) delete process.env.LLM_ENGINE;
      else process.env.LLM_ENGINE = origLlmEngine;
      if (origLlamaCppBaseUrl === undefined) delete process.env.LLAMACPP_BASE_URL;
      else process.env.LLAMACPP_BASE_URL = origLlamaCppBaseUrl;
      if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
      else process.env.MCP_SERVER_URL = origMcpUrl;
      if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
      else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
      if (origCompactionStrategy === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = origCompactionStrategy;
      fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
    });

    it("D1+D5 e2e: when provider reports 93K promptTokens despite <85K estimate, next round compacts and preserves brief verbatim", async () => {
      const brief = "LONG_E2E_BRIEF_START " + "spec ".repeat(600) + " LONG_E2E_BRIEF_END";
      const capturedRequests: Array<{ messages: ContextMessage[] }> = [];
      let dispatch = 0;

      const mock = await startMockLlmServer((_req, body, res) => {
        dispatch++;
        capturedRequests.push({
          messages: JSON.parse(JSON.stringify(body.messages || [])) as ContextMessage[],
        });
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (dispatch <= 3) {
          // Rounds 1-3 execute tool calls; round 3 reports measured 93,000 prompt tokens
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: `Round ${dispatch} narration.`,
                tool_calls: [
                  {
                    id: `tc_${dispatch}`,
                    type: "function",
                    function: {
                      name: "workspace_get_tree",
                      arguments: JSON.stringify({ path: `dir_${dispatch}` }),
                    },
                  },
                ],
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: dispatch === 3 ? 93_000 : 12_000,
              eval_count: 100,
            })}\n`
          );
        } else {
          res.write(
            `${JSON.stringify({
              message: { role: "assistant", content: "All done after compaction." },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 15_000,
              eval_count: 80,
            })}\n`
          );
        }
        res.end();
      });
      server = mock.server;
      process.env.LLM_BASE_URL = mock.baseUrl;

      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-e2e-d1-d5",
          messages: [{ role: "user", content: brief }],
        }),
      });

      const res = await POST(req);
      const events = await readSseEvents(res);

      const compactionEvents = events.filter((e) => e.type === "compaction");
      assert.ok(
        compactionEvents.length >= 1,
        "Measured 93K promptTokens must trigger mid-turn compaction even when raw estimate is small"
      );

      assert.ok(capturedRequests.length >= 4, "Round 4 must dispatch after compaction");
      const postCompactMsgs = capturedRequests[3].messages;
      const preservedUser = postCompactMsgs.find((m) => m.role === "user");
      assert.equal(
        preservedUser?.content,
        brief,
        "Leading user brief must arrive byte-identical in the post-compaction round"
      );
      assert.ok(
        !postCompactMsgs.some(
          (m) => m.role === "user" && m.content === "Proceed with the request."
        ),
        "Synthetic proceed prompt must not appear"
      );
    });

    it("D2 e2e: a round does not start when measured input + ROUND_MAX_TOKENS exceeds the window", async () => {
      let dispatch = 0;

      const mock = await startMockLlmServer((_req, _body, res) => {
        dispatch++;
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        // Round 1 emits a tool call and reports 120,000 prompt tokens (120,000 + 16,384 > 131,072)
        // With only 1 tool round (4 total messages: sys, user, asst, tool), compaction cannot
        // reduce below the window - ROUND_MAX_TOKENS ceiling, so round 2 MUST NOT start.
        if (dispatch === 1) {
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "tc_over",
                    type: "function",
                    function: { name: "workspace_get_tree", arguments: "{}" },
                  },
                ],
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: DEFAULT_CONTEXT_WINDOW_TOKENS - ROUND_MAX_TOKENS + 5000,
              eval_count: 50,
            })}\n`
          );
        } else {
          res.write(
            `${JSON.stringify({
              message: { role: "assistant", content: "Synthesis." },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 5000,
              eval_count: 20,
            })}\n`
          );
        }
        res.end();
      });
      server = mock.server;
      process.env.LLM_BASE_URL = mock.baseUrl;

      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-e2e-d2-ceiling",
          messages: [
            { role: "user", content: "Huge prompt that exceeds window minus output reserve." },
          ],
        }),
      });

      const res = await POST(req);
      const events = await readSseEvents(res);
      const done = events.find((e) => e.type === "done");
      assert.ok(done, "Turn must settle cleanly");
      // The tool loop must stop at budget before dispatching a second tool round
      assert.equal(
        dispatch,
        1,
        `Tool loop must not start round 2 when measured input + ROUND_MAX_TOKENS exceeds window (dispatched=${dispatch})`
      );
    });

    it("D3 e2e: after writing a file twice across rounds, round 3 receives a stub for write 1 and byte-identical args for write 2", async () => {
      const v1 = "export const v = 1;\n" + "// body1\n".repeat(40);
      const v2 = "export const v = 2;\n" + "// body2\n".repeat(40);
      const capturedRequests: Array<{ messages: ContextMessage[] }> = [];
      let dispatch = 0;

      const mock = await startMockLlmServer((_req, body, res) => {
        dispatch++;
        capturedRequests.push({
          messages: JSON.parse(JSON.stringify(body.messages || [])) as ContextMessage[],
        });
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (dispatch === 1) {
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: "Writing version 1.",
                tool_calls: [
                  {
                    id: "w_1",
                    type: "function",
                    function: {
                      name: "workspace_write_file",
                      arguments: JSON.stringify({ path: "src/demo.ts", content: v1 }),
                    },
                  },
                ],
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 2000,
              eval_count: 100,
            })}\n`
          );
        } else if (dispatch === 2) {
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: "Writing version 2.",
                tool_calls: [
                  {
                    id: "w_2",
                    type: "function",
                    function: {
                      name: "workspace_write_file",
                      arguments: JSON.stringify({ path: "src/demo.ts", content: v2 }),
                    },
                  },
                ],
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 72_000,
              eval_count: 100,
            })}\n`
          );
        } else {
          res.write(
            `${JSON.stringify({
              message: { role: "assistant", content: "Done writing demo.ts twice." },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 2200,
              eval_count: 40,
            })}\n`
          );
        }
        res.end();
      });
      server = mock.server;
      process.env.LLM_BASE_URL = mock.baseUrl;

      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-e2e-d3-elision",
          messages: [{ role: "user", content: "Write src/demo.ts twice." }],
        }),
      });

      const res = await POST(req);
      await readSseEvents(res);

      assert.equal(capturedRequests.length, 3, "Must dispatch 3 rounds");
      const round3Msgs = capturedRequests[2].messages;
      const assistantWithCalls = round3Msgs.filter(
        (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
      );
      assert.equal(assistantWithCalls.length, 2, "Both assistant tool-call turns must be present");

      const firstArgsRaw = assistantWithCalls[0].tool_calls![0].function?.arguments;
      const firstArgs = typeof firstArgsRaw === "string" ? JSON.parse(firstArgsRaw) : firstArgsRaw;
      const secondArgsRaw = assistantWithCalls[1].tool_calls![0].function?.arguments;
      const secondArgs =
        typeof secondArgsRaw === "string" ? JSON.parse(secondArgsRaw) : secondArgsRaw;

      assert.match(
        String(firstArgs.content),
        /^\[Micro-elision:/,
        "First write's argument body must be stubbed in round 3 prompt"
      );
      assert.equal(firstArgs.path, "src/demo.ts");
      assert.equal(
        secondArgs.content,
        v2,
        "Second write's argument body must be byte-identical in round 3 prompt"
      );
      assert.equal(assistantWithCalls[0].content, "Writing version 1.", "Prose must not be elided");
      assert.equal(assistantWithCalls[1].content, "Writing version 2.", "Prose must not be elided");
    });

    it("D4 e2e: single-turn job with COMPACTION_STRATEGY=hybrid compacts mid-turn via the hybrid rung and updates persisted record", async () => {
      process.env.COMPACTION_STRATEGY = "hybrid";
      const brief =
        "HYBRID_SINGLE_TURN_BRIEF: inspect web-ui/lib/contextBudget.ts commit 86c8901c6433617cb9abe5db97123a0f52f58c89 https://github.com/test/repo and report results.";
      let mainDispatches = 0;
      let hybridSummaryDispatches = 0;
      const capturedMainRequests: ContextMessage[][] = [];

      const mock = await startMockLlmServer((_req, body, res) => {
        const msgs = (body.messages || []) as ContextMessage[];
        const isHybridSummaryCall =
          msgs[0]?.role === "system" &&
          typeof msgs[0]?.content === "string" &&
          msgs[0].content.includes("You are compacting the working memory");

        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (isHybridSummaryCall) {
          hybridSummaryDispatches++;
          const sourceDigest = typeof msgs[1]?.content === "string" ? msgs[1].content : "";
          const modelDigest = `${COMPACTION_MODEL_DIGEST_HEADER}\nPrior User Goals & Requests:\n- Inspect contextBudget\nRetained Identifiers & Artifacts:\n- File paths: web-ui/lib/contextBudget.ts\n- Git SHAs: 86c8901c6433617cb9abe5db97123a0f52f58c89\n- URLs: https://github.com/test/repo\n${sourceDigest}`;
          res.write(
            `${JSON.stringify({
              message: { role: "assistant", content: modelDigest },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 500,
              eval_count: 100,
            })}\n`
          );
          res.end();
          return;
        }

        mainDispatches++;
        capturedMainRequests.push(JSON.parse(JSON.stringify(msgs)) as ContextMessage[]);
        if (mainDispatches <= 3) {
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content:
                  `Round ${mainDispatches}: ` +
                  (mainDispatches === 3 ? "R".repeat(20_000) : "short"),
                tool_calls: [
                  {
                    id: `htc_${mainDispatches}`,
                    type: "function",
                    function: {
                      name: "workspace_get_tree",
                      arguments: JSON.stringify({ path: `d${mainDispatches}` }),
                    },
                  },
                ],
              },
              done: true,
              done_reason: "stop",
              prompt_eval_count: mainDispatches === 3 ? 93_000 : 10_000,
              eval_count: 100,
            })}\n`
          );
        } else {
          res.write(
            `${JSON.stringify({
              message: { role: "assistant", content: "Single-turn hybrid job complete." },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 18_000,
              eval_count: 50,
            })}\n`
          );
        }
        res.end();
      });
      server = mock.server;
      process.env.LLM_BASE_URL = mock.baseUrl;

      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-e2e-d4-hybrid",
          messages: [{ role: "user", content: brief }],
        }),
      });

      const res = await POST(req);
      const events = await readSseEvents(res);
      const compactionEvt = events.find((e) => e.type === "compaction");
      assert.ok(compactionEvt, "Compaction event must fire mid-turn");
      assert.equal(
        hybridSummaryDispatches,
        1,
        "Hybrid summarization pass must fire mid-turn on single-turn job"
      );
      assert.ok(
        Array.isArray(compactionEvt.actions) &&
          (compactionEvt.actions as string[]).includes("hybrid_model_digest"),
        `Expected hybrid_model_digest action, got ${JSON.stringify(compactionEvt.actions)}`
      );

      assert.ok(capturedMainRequests.length >= 4, "Post-compaction round 4 must dispatch");
      const round0User = capturedMainRequests[0].find((m) => m.role === "user");
      const postCompactMsgs = capturedMainRequests[3];
      assert.ok(
        postCompactMsgs.some((m) => m.content.startsWith(COMPACTION_MODEL_DIGEST_HEADER)),
        "Post-compaction round must carry the hybrid model digest"
      );
      const postCompactUser = postCompactMsgs.find((m) => m.role === "user");
      assert.equal(
        postCompactUser?.content,
        round0User?.content,
        "Post-compaction round must preserve the leading user message byte-identical"
      );
      assert.ok(
        postCompactUser?.content.includes(brief),
        "Post-compaction leading user message must contain the verbatim brief"
      );

      const store = new ThreadStore(tmpThreadsDir);
      const saved = await store.getThread("thread-e2e-d4-hybrid");
      assert.equal(saved?.compaction?.strategy, "hybrid");
      assert.ok(saved?.compaction?.summary.startsWith(COMPACTION_MODEL_DIGEST_HEADER));
      assert.ok(saved?.compaction?.extractionDigest);
    });
  });
});
