import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  CHAT_CONTEXT_BUDGET_TOKENS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  canContinueToolLoop,
  fitConversationToBudget,
  resolveRoundModelOptions,
  type ContextMessage,
} from "../lib/contextBudget";
import {
  COMPACTION_THRESHOLD_RATIO,
  HYBRID_ESCALATION_RATIO,
  ROUND_MAX_TOKENS,
} from "../lib/modelLimits";
import {
  CONTEXT_BUDGET_HEADROOM_TOKENS,
  MEASURED_SYSTEM_TOOLS_FOOTPRINT_TOKENS,
  deriveContextBudget,
  parseEngineMaxContext,
  resolveEngineContextBudget,
  clearEngineContextBudgetCache,
} from "../lib/engineContextBudget";
import { GET as getEngineRoute } from "../app/api/engine/route";
import { ContextSheet } from "../components/ContextSheet";

function makeConversation(approxTokens: number): ContextMessage[] {
  const messages: ContextMessage[] = [
    { role: "system", content: "System instructions." },
    { role: "user", content: "Initial task brief." },
  ];
  // ~4,000 tokens per assistant+tool pair (16,000 chars)
  const pairs = Math.max(4, Math.floor(approxTokens / 4000));
  const chunk = "x".repeat(15800);
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: "assistant", content: `Step ${i}` });
    messages.push({ role: "tool", name: "workspace_read_file", content: chunk });
  }
  return messages;
}

describe("#140 Context budget follows the engine", () => {
  beforeEach(() => {
    clearEngineContextBudgetCache();
  });

  afterEach(() => {
    clearEngineContextBudgetCache();
  });

  describe("1. Regression anchor: engine reports 131072", () => {
    it("derives the exact 100K budget, 85K compaction trigger, and 65K hybrid escalation", () => {
      const derived = deriveContextBudget(131072);
      assert.equal(derived.source, "engine");
      assert.equal(derived.contextWindowTokens, 131072);
      assert.equal(derived.budgetTokens, CHAT_CONTEXT_BUDGET_TOKENS);
      assert.equal(derived.budgetTokens, 100000);
      assert.equal(
        derived.compactionTriggerTokens,
        Math.floor(100000 * COMPACTION_THRESHOLD_RATIO)
      );
      assert.equal(derived.compactionTriggerTokens, 85000);
      assert.equal(derived.hybridEscalationTokens, Math.floor(100000 * HYBRID_ESCALATION_RATIO));
      assert.equal(derived.hybridEscalationTokens, 65000);
      assert.equal(derived.outputReserveTokens, ROUND_MAX_TOKENS);
      assert.ok(MEASURED_SYSTEM_TOOLS_FOOTPRINT_TOKENS > 0);
      assert.equal(131072 - CONTEXT_BUDGET_HEADROOM_TOKENS, 100000);
    });

    it("resolves 131072 from live /health probe and matches today's behavior", async () => {
      const mockFetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok", max_context: 131072, loaded: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      }) as typeof fetch;

      const resolved = await resolveEngineContextBudget({
        baseUrl: "http://127.0.0.1:8080",
        fetchImpl: mockFetch,
        bypassCache: true,
      });

      assert.equal(resolved.source, "engine");
      assert.equal(resolved.contextWindowTokens, 131072);
      assert.equal(resolved.budgetTokens, 100000);
      assert.equal(resolved.compactionTriggerTokens, 85000);
    });
  });

  describe("2. Larger engine context: engine reports 262144", () => {
    it("scales budget, fit trigger, compaction points, and model options up", async () => {
      const mockFetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok", max_context: 262144, loaded: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      }) as typeof fetch;

      const resolved = await resolveEngineContextBudget({
        baseUrl: "http://127.0.0.1:8080",
        fetchImpl: mockFetch,
        bypassCache: true,
      });

      const expectedBudget = 262144 - CONTEXT_BUDGET_HEADROOM_TOKENS;
      assert.equal(resolved.source, "engine");
      assert.equal(resolved.contextWindowTokens, 262144);
      assert.equal(resolved.budgetTokens, expectedBudget);
      assert.ok(resolved.budgetTokens > 200000, "256K context must yield > 200K budget");
      assert.equal(
        resolved.compactionTriggerTokens,
        Math.floor(expectedBudget * COMPACTION_THRESHOLD_RATIO)
      );
      assert.equal(
        resolved.hybridEscalationTokens,
        Math.floor(expectedBudget * HYBRID_ESCALATION_RATIO)
      );

      // A 120K conversation would trigger compaction & stop at 100K,
      // but MUST continue without compacting under a 262144 engine window.
      const midConversation = makeConversation(120000);
      const fitRes = fitConversationToBudget(midConversation, {
        budgetTokens: resolved.budgetTokens,
        contextWindowTokens: resolved.contextWindowTokens,
      });
      assert.equal(
        fitRes.compacted,
        false,
        "120K conversation must not compact under 262144 derived budget"
      );

      const cont = canContinueToolLoop({
        round: 2,
        contextTokens: 120000,
        measuredPromptTokens: 120000,
        budgetTokens: resolved.budgetTokens,
        contextWindowTokens: resolved.contextWindowTokens,
        lastRoundTools: ["workspace_read_file"],
        webResearchCalls: 0,
      });
      assert.equal(cont.canContinue, true, "120K must continue under 262144 derived budget");

      // resolveRoundModelOptions forwards the derived contextWindowTokens into num_ctx
      const opts = resolveRoundModelOptions({
        model: "qwen3.8-flash-next-gyro-gyro-s",
        contextWindowTokens: resolved.contextWindowTokens,
      });
      assert.equal(opts.num_ctx, 262144);

      // ContextSheet scales its denominator and trigger label from the derived budget
      const html = renderToString(
        React.createElement(ContextSheet, {
          open: true,
          onClose: () => {},
          usedTokens: 120000,
          budgetTokens: resolved.budgetTokens,
          triggerTokens: resolved.compactionTriggerTokens,
          segments: { toolResults: 70000, conversation: 45000, system: 5000 },
          lastRoundPromptTokens: 120000,
          compactionCount: 0,
          compaction: null,
          isStreaming: false,
          isCompacting: false,
          onCompact: () => {},
          onRestore: () => {},
        })
      );
      const expectedBudgetK = `${Math.round(resolved.budgetTokens / 1000)}K`;
      const expectedTriggerK = `${Math.round(resolved.compactionTriggerTokens / 1000)}K`;
      assert.ok(
        html.includes(expectedBudgetK),
        `ContextSheet must display scaled budget ${expectedBudgetK}`
      );
      assert.ok(
        html.includes(expectedTriggerK),
        `ContextSheet must display scaled trigger ${expectedTriggerK}`
      );
    });

    it("falls back to /slots n_ctx when /health omits max_context", async () => {
      const mockFetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok", loaded: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/slots")) {
          return new Response(JSON.stringify([{ id: 0, n_ctx: 262144 }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      }) as typeof fetch;

      const resolved = await resolveEngineContextBudget({
        baseUrl: "http://127.0.0.1:8080",
        fetchImpl: mockFetch,
        bypassCache: true,
      });

      assert.equal(resolved.source, "engine");
      assert.equal(resolved.contextWindowTokens, 262144);
      assert.equal(resolved.budgetTokens, 262144 - CONTEXT_BUDGET_HEADROOM_TOKENS);
    });
  });

  describe("3. Smaller engine context: engine reports 65536", () => {
    it("shrinks budget, fit trigger, and continuation ceiling accordingly", async () => {
      const mockFetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok", max_context: 65536, loaded: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      }) as typeof fetch;

      const resolved = await resolveEngineContextBudget({
        baseUrl: "http://127.0.0.1:8080",
        fetchImpl: mockFetch,
        bypassCache: true,
      });

      const expectedBudget = 65536 - CONTEXT_BUDGET_HEADROOM_TOKENS;
      assert.equal(resolved.source, "engine");
      assert.equal(resolved.contextWindowTokens, 65536);
      assert.equal(resolved.budgetTokens, expectedBudget);
      assert.ok(resolved.budgetTokens < 50000, "64K context must shrink budget below 50K");
      assert.equal(
        resolved.compactionTriggerTokens,
        Math.floor(expectedBudget * COMPACTION_THRESHOLD_RATIO)
      );

      // A 40K conversation is well below 100K, but MUST compact under 65536
      const conversation = makeConversation(40000);
      const fitRes = fitConversationToBudget(conversation, {
        budgetTokens: resolved.budgetTokens,
        contextWindowTokens: resolved.contextWindowTokens,
      });
      assert.equal(
        fitRes.compacted,
        true,
        "40K conversation must compact under 65536 derived budget"
      );

      // Continuation stops when tokens exceed the shrunk budget
      const cont = canContinueToolLoop({
        round: 2,
        contextTokens: expectedBudget + 2000,
        measuredPromptTokens: expectedBudget + 2000,
        budgetTokens: resolved.budgetTokens,
        contextWindowTokens: resolved.contextWindowTokens,
        lastRoundTools: ["workspace_read_file"],
        webResearchCalls: 0,
      });
      assert.equal(cont.canContinue, false);
      assert.equal(cont.stopReason, "budget");
    });
  });

  describe("4. Engine unreachable or insane response → 100K fallback with logging", () => {
    it("falls back to 100K budget / 131072 window and logs when engine is unreachable", async () => {
      const warnings: string[] = [];
      const mockFetch = (async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
      }) as typeof fetch;

      const resolved = await resolveEngineContextBudget({
        baseUrl: "http://127.0.0.1:8080",
        fetchImpl: mockFetch,
        bypassCache: true,
        logger: (msg) => warnings.push(msg),
      });

      assert.equal(resolved.source, "fallback");
      assert.equal(resolved.budgetTokens, CHAT_CONTEXT_BUDGET_TOKENS);
      assert.equal(resolved.budgetTokens, 100000);
      assert.equal(resolved.contextWindowTokens, DEFAULT_CONTEXT_WINDOW_TOKENS);
      assert.equal(resolved.compactionTriggerTokens, 85000);
      assert.equal(warnings.length, 1, "unreachable engine must log a warning");
      assert.ok(warnings[0].includes("100000"), "warning must state the 100K fallback");
    });

    it("falls back to 100K and logs when engine reports an insane max_context", () => {
      for (const bad of [0, -1024, 512, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
        const derived = deriveContextBudget(bad as number | null | undefined, "invalid");
        assert.equal(derived.source, "fallback");
        assert.equal(derived.budgetTokens, 100000);
        assert.equal(derived.contextWindowTokens, 131072);
      }
      assert.equal(parseEngineMaxContext({ max_context: "not-a-number" }), null);
    });
  });

  describe("5. /api/engine exposes derived budget fields for UI hydration", () => {
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      process.env = { ...originalEnv };
      globalThis.fetch = originalFetch;
    });

    it("returns max_context, budget_tokens, and trigger_tokens from /health fallback", async () => {
      process.env.LLM_SUPERVISOR_URL = "http://127.0.0.1:8080";
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/control/status")) {
          return new Response("Not Found", { status: 404 });
        }
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok", loaded: true, max_context: 262144 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      }) as typeof fetch;

      const res = await getEngineRoute();
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.max_context, 262144);
      assert.equal(json.budget_tokens, 262144 - CONTEXT_BUDGET_HEADROOM_TOKENS);
      assert.equal(
        json.trigger_tokens,
        Math.floor(json.budget_tokens * COMPACTION_THRESHOLD_RATIO)
      );
      assert.equal(json.budget_source, "engine");
    });
  });

  describe("6. Structural guards: no hardcoded 85K trigger or 100K literal in ChatStream / roundLoop", () => {
    const webUiRoot = path.resolve(__dirname, "..");

    it("ChatStream derives triggerTokens dynamically instead of hardcoding 85000 / 85K", () => {
      const chatStream = fs.readFileSync(
        path.join(webUiRoot, "components", "ChatStream.tsx"),
        "utf-8"
      );
      assert.ok(
        !chatStream.includes("triggerTokens={85000}"),
        "ChatStream must not hardcode triggerTokens={85000}"
      );
      assert.ok(
        !chatStream.includes('title="85K compaction trigger"'),
        'ChatStream must not hardcode title="85K compaction trigger"'
      );
    });

    it("roundLoop resolves context budget via resolveEngineContextBudget", () => {
      const roundLoop = fs.readFileSync(
        path.join(webUiRoot, "lib", "chat", "roundLoop.ts"),
        "utf-8"
      );
      assert.ok(
        roundLoop.includes("resolveEngineContextBudget"),
        "roundLoop must resolve context budget from the engine"
      );
    });

    it("Recheck 11: ContextSheet and ChatStream derive trigger tick position instead of hardcoding left-[85%]", () => {
      const chatStream = fs.readFileSync(
        path.join(webUiRoot, "components", "ChatStream.tsx"),
        "utf-8"
      );
      const contextSheet = fs.readFileSync(
        path.join(webUiRoot, "components", "ContextSheet.tsx"),
        "utf-8"
      );
      assert.ok(
        !chatStream.includes("left-[85%]"),
        "ChatStream trigger tick must not hardcode left-[85%]"
      );
      assert.ok(
        !contextSheet.includes("left-[85%]"),
        "ContextSheet trigger tick and label must not hardcode left-[85%]"
      );
    });

    it("Recheck 11: compaction digest header reflects the derived threshold tokens instead of hardcoded 85,000", async () => {
      const { compactConversationHistory } = await import("../lib/conversationCompaction");
      const conv = makeConversation(40000);
      const res = compactConversationHistory(conv, {
        maxContentTokens: 40000,
        compactionThreshold: 0.75,
        contextWindowTokens: 65536,
      });
      assert.equal(res.compacted, true);
      const digest = res.messages.find((m) => m.role === "assistant")?.content ?? "";
      assert.ok(
        !digest.includes("85,000 tokens"),
        `digest header must not hardcode 85,000 tokens when threshold is 30,000: ${digest.slice(0, 140)}`
      );
      assert.ok(
        digest.includes("75%") && digest.includes("30,000 tokens"),
        `digest header must cite derived 75% / 30,000 tokens: ${digest.slice(0, 140)}`
      );
    });
  });
});
