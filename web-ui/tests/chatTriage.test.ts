import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { _triageComplexity, parseTriageComplexity } from "../lib/chat/triage";

describe("chat complexity triage", () => {
  it("parseTriageComplexity handles plain JSON, fenced JSON, and defaults", () => {
    assert.equal(
      parseTriageComplexity('{"complexity":"DEEP_SYNTHESIS","reasoning":"architecture"}'),
      "DEEP_SYNTHESIS"
    );
    assert.equal(
      parseTriageComplexity('```json\n{"complexity":"DEEP_SYNTHESIS"}\n```'),
      "DEEP_SYNTHESIS"
    );
    assert.equal(parseTriageComplexity('{"complexity":"SIMPLE_EXECUTION"}'), "SIMPLE_EXECUTION");
    assert.equal(parseTriageComplexity('{"complexity":"OTHER"}'), "SIMPLE_EXECUTION");
    assert.equal(parseTriageComplexity(undefined), "SIMPLE_EXECUTION");
  });

  it("_triageComplexity returns DEEP_SYNTHESIS when model classifies deep work", async () => {
    let seenModel: string | undefined = "";
    const result = await _triageComplexity(
      "Design a distributed consensus engine",
      "http://127.0.0.1:11434",
      "fast-model",
      {
        chat: async (_baseUrl, payload) => {
          seenModel = payload.model;
          return {
            message: {
              role: "assistant",
              content: '{"complexity":"DEEP_SYNTHESIS","reasoning":"novel architecture"}',
            },
          };
        },
        warn: () => {},
      }
    );
    assert.equal(seenModel, "fast-model");
    assert.equal(result, "DEEP_SYNTHESIS");
  });

  it("_triageComplexity defaults to SIMPLE_EXECUTION on provider or JSON error", async () => {
    const warnings: unknown[][] = [];
    const result = await _triageComplexity("run tests", "http://127.0.0.1:11434", "fast-model", {
      chat: async () => {
        throw new Error("provider unavailable");
      },
      warn: (...args) => warnings.push(args),
    });
    assert.equal(result, "SIMPLE_EXECUTION");
    assert.equal(warnings.length, 1);
  });
});
