import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRIMARY_MODEL, DEFAULT_SUBAGENT_MODEL, PRESET_MODEL_PROFILES } from "../config/models.js";

describe("Web UI Model Configuration Suite", () => {
  it("defaults to qwen3.8:27b-q3_k_m for orchestrator to fit within 16GB VRAM limit", () => {
    assert.equal(DEFAULT_PRIMARY_MODEL, "qwen3.8:27b-q3_k_m");
  });

  it("defaults to gemma4:e4b for fast multimodal sub-agent execution", () => {
    assert.equal(DEFAULT_SUBAGENT_MODEL, "gemma4:e4b");
  });

  it("contains complete profiles for orchestrator and sub-agents", () => {
    assert.ok(PRESET_MODEL_PROFILES.length >= 3);

    const orchestrator = PRESET_MODEL_PROFILES.find((p) => p.id === "qwen3.8:27b-q3_k_m");
    assert.ok(orchestrator, "qwen3.8:27b-q3_k_m profile must exist");
    assert.equal(orchestrator?.role, "orchestrator");
    assert.equal(orchestrator?.supportsReasoningEffort, true);
    assert.equal(orchestrator?.defaultReasoningEffort, "medium");
    assert.ok(orchestrator?.recommendedVRAM.includes("13.8 GB"));

    const subagent = PRESET_MODEL_PROFILES.find((p) => p.id === "gemma4:e4b");
    assert.ok(subagent, "gemma4:e4b profile must exist");
    assert.equal(subagent?.role, "sub-agent");
    assert.equal(subagent?.supportsReasoningEffort, true);
  });
});
