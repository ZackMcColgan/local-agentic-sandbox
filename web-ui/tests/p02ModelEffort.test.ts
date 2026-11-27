import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRIMARY_MODEL, PRESET_MODEL_PROFILES } from "../config/models.js";
import { resolveEffectiveReasoningEffort } from "../lib/chatUtils.js";
import { createLlmGenerate } from "../lib/subagents/llmClient.js";

// Owner ruling (Nov 27, 2026): medium is the standing thinking level for the
// resident model (Flash-Next / Gyro-S), replacing the old low rule. All other
// profiles keep "low" as their default.
const RESIDENT_MODEL = "qwen3.8-flash-next-gyro-gyro-s";

describe("P0.2 — reasoning effort defaults & DEFAULT_PRIMARY_MODEL", () => {
  it("defaults resolveEffectiveReasoningEffort to medium for the resident model", () => {
    assert.equal(resolveEffectiveReasoningEffort(RESIDENT_MODEL, undefined), "medium");
    assert.equal(resolveEffectiveReasoningEffort(DEFAULT_PRIMARY_MODEL, undefined), "medium");
  });

  it("an explicitly requested effort still wins over the profile default", () => {
    assert.equal(resolveEffectiveReasoningEffort(RESIDENT_MODEL, "low"), "low");
    assert.equal(resolveEffectiveReasoningEffort(RESIDENT_MODEL, "xhigh"), "xhigh");
    assert.equal(resolveEffectiveReasoningEffort(RESIDENT_MODEL, "medium"), "medium");
  });

  it("other profiles keep low as their default when no effort is requested", () => {
    assert.equal(resolveEffectiveReasoningEffort("gemma4:e4b", undefined), "low");
    assert.equal(resolveEffectiveReasoningEffort("Swift-1.5-Qwen3.8-27B-IQ3_XS", undefined), "low");
    assert.equal(resolveEffectiveReasoningEffort("qwen3.8:27b-q3_k_m", undefined), "low");
  });

  it("sets defaultReasoningEffort to medium on the resident model and low on the rest", () => {
    for (const m of PRESET_MODEL_PROFILES) {
      if (!m.supportsReasoningEffort) continue;
      const expected = m.id === RESIDENT_MODEL ? "medium" : "low";
      assert.equal(
        m.defaultReasoningEffort,
        expected,
        `Expected ${m.id} defaultReasoningEffort to be ${expected}`
      );
    }
  });

  it("createLlmGenerate does not swallow plain response without <think> tags", async () => {
    const generate = createLlmGenerate({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ response: "Hello world without think tags.", done: true }) + "\n",
          { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
        )) as typeof fetch,
    });

    const res = await generate({
      model: DEFAULT_PRIMARY_MODEL,
      prompt: "hi",
    });
    assert.equal(res.text.trim(), "Hello world without think tags.");
  });
});
