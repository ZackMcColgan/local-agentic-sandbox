import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRIMARY_MODEL, PRESET_MODEL_PROFILES } from "../config/models.js";
import { resolveEffectiveReasoningEffort } from "../lib/chatUtils.js";
import { createLlmGenerate } from "../lib/subagents/llmClient.js";

describe("P0.2 — LOW reasoning effort & DEFAULT_PRIMARY_MODEL", () => {
  it("defaults resolveEffectiveReasoningEffort to low for supported models", () => {
    assert.equal(resolveEffectiveReasoningEffort(DEFAULT_PRIMARY_MODEL, undefined), "low");
  });

  it("sets defaultReasoningEffort to low on preset primary models", () => {
    for (const m of PRESET_MODEL_PROFILES) {
      if (m.supportsReasoningEffort) {
        assert.equal(
          m.defaultReasoningEffort,
          "low",
          `Expected ${m.id} defaultReasoningEffort to be low`
        );
      }
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
