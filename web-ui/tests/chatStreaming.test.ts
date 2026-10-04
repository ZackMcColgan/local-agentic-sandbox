import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  parseThinkingAndContent,
  computeModelOptions,
  resolveEffectiveReasoningEffort
} from "../lib/chatUtils.js";
import { isReasoningEffortSupported, PRESET_MODEL_PROFILES } from "../config/models.js";

describe("Chat Streaming & Real-Time Thinking Parser Suite", () => {
  it("parses completed <think>...</think> blocks into thought and content using real implementation", () => {
    const input = "<think>\nLet's plan the architecture.\n1. Add SVG viewer.\n</think>\nHere is the diagram.";
    const parsed = parseThinkingAndContent(input);
    assert.equal(parsed.thought, "Let's plan the architecture.\n1. Add SVG viewer.");
    assert.equal(parsed.content, "Here is the diagram.");
  });

  it("parses live in-progress <think> tokens as they stream before closing tag arrives", () => {
    const streamChunk1 = "<think>I am starting to analyze the prompt";
    const parsed1 = parseThinkingAndContent(streamChunk1);
    assert.equal(parsed1.thought, "I am starting to analyze the prompt");
    assert.equal(parsed1.content, "");

    const streamChunk2 = "<think>I am starting to analyze the prompt\nNow generating vector graphic...";
    const parsed2 = parseThinkingAndContent(streamChunk2);
    assert.equal(parsed2.thought, "I am starting to analyze the prompt\nNow generating vector graphic...");
    assert.equal(parsed2.content, "");
  });

  it("transitions seamlessly from thinking stream to content stream once </think> is closed", () => {
    const fullStream = "<think>Thought complete.</think>\n```xml\n<svg viewBox='0 0 100 100'></svg>\n```";
    const parsed = parseThinkingAndContent(fullStream);
    assert.equal(parsed.thought, "Thought complete.");
    assert.ok(parsed.content.includes("<svg viewBox='0 0 100 100'>"));
  });

  it("handles conversational content without <think> tags gracefully", () => {
    const input = "Hello! How can I assist you with your project today?";
    const parsed = parseThinkingAndContent(input);
    assert.equal(parsed.thought, undefined);
    assert.equal(parsed.content, "Hello! How can I assist you with your project today?");
  });

  it("parses SSE NDJSON data events accurately", () => {
    const sseChunk = 'data: {"type":"token","content":"<think>planning"}\n\ndata: {"type":"token","content":" step 1</think>Done"}\n\n';
    const lines = sseChunk.split("\n\n");
    let accumulated = "";
    for (const line of lines) {
      if (!line.trim().startsWith("data:")) continue;
      const jsonStr = line.replace(/^data:\s*/, "");
      const event = JSON.parse(jsonStr);
      if (event.type === "token") {
        accumulated += event.content;
      }
    }

    const parsed = parseThinkingAndContent(accumulated);
    assert.equal(parsed.thought, "planning step 1");
    assert.equal(parsed.content, "Done");
  });

  it("threads reasoning effort options to supported models (Qwen 3.8 / Gemma 4)", () => {
    assert.equal(isReasoningEffortSupported("qwen3.8:27b-q3_k_m"), true);
    assert.equal(isReasoningEffortSupported("gemma4:e4b"), true);

    // High reasoning effort
    const highEffort = resolveEffectiveReasoningEffort("qwen3.8:27b-q3_k_m", "xhigh");
    assert.equal(highEffort, "xhigh");
    const highOpts = computeModelOptions("qwen3.8:27b-q3_k_m", "xhigh");
    assert.equal(highOpts.temperature, 0.7);
    assert.equal(highOpts.num_predict, 8192);

    // Low reasoning effort
    const lowEffort = resolveEffectiveReasoningEffort("qwen3.8:27b-q3_k_m", "low");
    assert.equal(lowEffort, "low");
    const lowOpts = computeModelOptions("qwen3.8:27b-q3_k_m", "low");
    assert.equal(lowOpts.temperature, 0.2);
    assert.equal(lowOpts.num_predict, 4096);
  });

  it("disables and omits reasoning effort for unsupported models (Hermes 3)", () => {
    assert.equal(isReasoningEffortSupported("hermes3:8b"), false);
    assert.equal(isReasoningEffortSupported("hermes3:70b-q3_k_m"), false);

    // Even if requested, effective effort resolves to undefined
    const unsupportedEffort = resolveEffectiveReasoningEffort("hermes3:8b", "xhigh");
    assert.equal(unsupportedEffort, undefined, "Must return undefined for unsupported models");

    const unsupportedOpts = computeModelOptions("hermes3:8b", "xhigh");
    assert.equal(unsupportedOpts.temperature, 0.7, "Must use standard unbiased defaults");
    assert.equal(unsupportedOpts.num_predict, 4096);
  });

  it("CI standing rule: no test file re-implements functions exported by implementation modules", () => {
    const testsDir = path.resolve(process.cwd(), fs.existsSync(path.join(process.cwd(), "tests")) ? "tests" : "web-ui/tests");
    const testFiles = fs.readdirSync(testsDir).filter((f) => f.endsWith(".test.ts"));

    const bannedFunctionNames = [
      "parseThinkingAndContent",
      "computeModelOptions",
      "resolveEffectiveReasoningEffort",
      "sanitizeSvg",
      "convertDrawioToSvg",
      "isSvgCode"
    ];

    for (const file of testFiles) {
      if (file === "chatStreaming.test.ts") continue; // self-exempt test definition
      const content = fs.readFileSync(path.join(testsDir, file), "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("import") || line.includes("from") || line.includes("//")) continue;
        for (const fnName of bannedFunctionNames) {
          const fnDecl = new RegExp(`\\bfunction\\s+${fnName}\\s*\\(|\\b(?:const|let|var)\\s+${fnName}\\s*=\\s*(?:\\([^)]*\\)|function|async)`);
          if (fnDecl.test(line)) {
            assert.fail(`Process violation: ${file}:${i + 1} re-implements ${fnName}. All tests must import from implementation modules.`);
          }
        }
      }
    }
  });
});
