import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeModelOptions } from "../lib/chatUtils";
import { resolveRoundModelOptions, CHAT_CONTEXT_BUDGET_TOKENS } from "../lib/contextBudget";
import { COMPACTION_TRIGGER_TOKENS } from "../lib/threads/threadStore";
import { ROUND_MAX_TOKENS, COMPACTION_THRESHOLD_RATIO } from "../lib/modelLimits";

describe("Parameterization — Round Generation Cap: ROUND_MAX_TOKENS (16,384) on Every Round", () => {
  describe("single exported round-cap constant", () => {
    it("ROUND_MAX_TOKENS is the one source of truth and equals 16384", () => {
      assert.equal(ROUND_MAX_TOKENS, 16384);
    });
  });

  describe("computeModelOptions returns the constant for every effort tier", () => {
    it("low reasoning effort", () => {
      const opts = computeModelOptions("qwen3.8:27b-q3_k_m", "low");
      assert.equal(opts.num_predict, ROUND_MAX_TOKENS);
      assert.equal(opts.temperature, 0.2);
    });

    it("medium reasoning effort", () => {
      const opts = computeModelOptions("qwen3.8:27b-q3_k_m", "medium");
      assert.equal(opts.num_predict, ROUND_MAX_TOKENS);
      assert.equal(opts.temperature, 0.5);
    });

    it("xhigh reasoning effort", () => {
      const opts = computeModelOptions("qwen3.8:27b-q3_k_m", "xhigh");
      assert.equal(opts.num_predict, ROUND_MAX_TOKENS);
      assert.equal(opts.temperature, 0.7);
    });

    it("default/undefined reasoning effort", () => {
      const opts = computeModelOptions("qwen3.8:27b-q3_k_m");
      assert.equal(opts.num_predict, ROUND_MAX_TOKENS);
      assert.equal(opts.temperature, 0.5);
    });

    it("models without reasoning effort support (e.g. Hermes 3)", () => {
      const opts = computeModelOptions("hermes3:8b", "xhigh");
      assert.equal(opts.num_predict, ROUND_MAX_TOKENS);
      assert.equal(opts.temperature, 0.7);
    });
  });

  describe("resolveRoundModelOptions fallback uses the same constant", () => {
    it("fast-synthesis rounds (post-tool calls) on strata/llamacpp", () => {
      const originalEngine = process.env.LLM_ENGINE;
      try {
        process.env.LLM_ENGINE = "strata";
        const opts = resolveRoundModelOptions({
          model: "Swift-1.5-Qwen3.8-27B-IQ3_XS",
          requestedEffort: "medium",
          hasCompletedToolCalls: true
        });
        assert.equal(opts.num_predict, ROUND_MAX_TOKENS, "Must return ROUND_MAX_TOKENS instead of omitting num_predict on post-tool round");
        assert.equal(opts.temperature, 0.2);
        assert.equal(opts.reasoning_effort, "low");
      } finally {
        process.env.LLM_ENGINE = originalEngine;
      }
    });

    it("artifact synthesis rounds on strata/llamacpp", () => {
      const originalEngine = process.env.LLM_ENGINE;
      try {
        process.env.LLM_ENGINE = "llamacpp";
        const opts = resolveRoundModelOptions({
          model: "Swift-1.5-Qwen3.8-27B-IQ3_XS",
          isArtifactTurn: true,
          requestedEffort: "xhigh"
        });
        assert.equal(opts.num_predict, ROUND_MAX_TOKENS, "Must return ROUND_MAX_TOKENS instead of omitting num_predict on artifact turn");
        assert.equal(opts.temperature, 0.2);
      } finally {
        process.env.LLM_ENGINE = originalEngine;
      }
    });

    it("final synthesis rounds", () => {
      const opts = resolveRoundModelOptions({
        model: "Swift-1.5-Qwen3.8-27B-IQ3_XS",
        isSynthesisOrFinalRound: true
      });
      assert.equal(opts.num_predict, ROUND_MAX_TOKENS, "Must return ROUND_MAX_TOKENS for final synthesis round");
      assert.equal(opts.temperature, 0.2);
    });

    it("preserves numKeep calculation for compaction summary rounds", () => {
      const opts = resolveRoundModelOptions({
        model: "Swift-1.5-Qwen3.8-27B-IQ3_XS",
        numKeep: 1024
      });
      assert.equal(opts.num_predict, 2048 + 1024);
      assert.equal(opts.n_keep, 1024);
      assert.equal(opts.numKeep, 1024);
    });
  });

  describe("Compaction trigger derives dynamically from the context budget", () => {
    it("COMPACTION_TRIGGER_TOKENS = floor(CHAT_CONTEXT_BUDGET_TOKENS * COMPACTION_THRESHOLD_RATIO)", () => {
      assert.equal(COMPACTION_THRESHOLD_RATIO, 0.85);
      assert.equal(
        COMPACTION_TRIGGER_TOKENS,
        Math.floor(CHAT_CONTEXT_BUDGET_TOKENS * COMPACTION_THRESHOLD_RATIO),
        "A budget or ratio change must move the trigger — no hardcoded product of literals"
      );
    });
  });
});
