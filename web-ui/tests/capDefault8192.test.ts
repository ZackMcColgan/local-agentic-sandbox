import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeModelOptions } from "../lib/chatUtils";
import { resolveRoundModelOptions } from "../lib/contextBudget";

describe("Part 0 — Cap Default: 8,192 on Every Round", () => {
  describe("computeModelOptions", () => {
    it("returns num_predict: 8192 for low reasoning effort", () => {
      const opts = computeModelOptions("qwen3.8:27b-q3_k_m", "low");
      assert.equal(opts.num_predict, 8192);
      assert.equal(opts.temperature, 0.2);
    });

    it("returns num_predict: 8192 for medium reasoning effort", () => {
      const opts = computeModelOptions("qwen3.8:27b-q3_k_m", "medium");
      assert.equal(opts.num_predict, 8192);
      assert.equal(opts.temperature, 0.5);
    });

    it("returns num_predict: 8192 for xhigh reasoning effort", () => {
      const opts = computeModelOptions("qwen3.8:27b-q3_k_m", "xhigh");
      assert.equal(opts.num_predict, 8192);
      assert.equal(opts.temperature, 0.7);
    });

    it("returns num_predict: 8192 for default/undefined reasoning effort", () => {
      const opts = computeModelOptions("qwen3.8:27b-q3_k_m");
      assert.equal(opts.num_predict, 8192);
      assert.equal(opts.temperature, 0.5);
    });

    it("returns num_predict: 8192 for models without reasoning effort support (e.g. Hermes 3)", () => {
      const opts = computeModelOptions("hermes3:8b", "xhigh");
      assert.equal(opts.num_predict, 8192);
      assert.equal(opts.temperature, 0.7);
    });
  });

  describe("resolveRoundModelOptions", () => {
    it("returns num_predict: 8192 for fast-synthesis rounds (post-tool calls) on strata/llamacpp", () => {
      const originalEngine = process.env.LLM_ENGINE;
      try {
        process.env.LLM_ENGINE = "strata";
        const opts = resolveRoundModelOptions({
          model: "Swift-1.5-Qwen3.8-27B-IQ3_XS",
          requestedEffort: "medium",
          hasCompletedToolCalls: true
        });
        assert.equal(opts.num_predict, 8192, "Must return 8192 instead of omitting num_predict on post-tool round");
        assert.equal(opts.temperature, 0.2);
        assert.equal(opts.reasoning_effort, "low");
      } finally {
        process.env.LLM_ENGINE = originalEngine;
      }
    });

    it("returns num_predict: 8192 for artifact synthesis rounds on strata/llamacpp", () => {
      const originalEngine = process.env.LLM_ENGINE;
      try {
        process.env.LLM_ENGINE = "llamacpp";
        const opts = resolveRoundModelOptions({
          model: "Swift-1.5-Qwen3.8-27B-IQ3_XS",
          isArtifactTurn: true,
          requestedEffort: "xhigh"
        });
        assert.equal(opts.num_predict, 8192, "Must return 8192 instead of omitting num_predict on artifact turn");
        assert.equal(opts.temperature, 0.2);
      } finally {
        process.env.LLM_ENGINE = originalEngine;
      }
    });

    it("returns num_predict: 8192 for final synthesis rounds", () => {
      const opts = resolveRoundModelOptions({
        model: "Swift-1.5-Qwen3.8-27B-IQ3_XS",
        isSynthesisOrFinalRound: true
      });
      assert.equal(opts.num_predict, 8192, "Must return 8192 for final synthesis round");
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
});
