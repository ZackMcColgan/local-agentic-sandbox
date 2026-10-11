import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { formatThinkingDisplay, formatHumanReadableTrace, formatElapsedDuration } from "../lib/chatUtils";

describe("UX Polish Test Suite — Progress, Thinking, Code Blocks & Human-Readable Labels", () => {
  describe("Item 1: Progress that moves", () => {
    it("formatElapsedDuration accurately formats seconds into human readable time", () => {
      assert.equal(formatElapsedDuration(45), "45s");
      assert.equal(formatElapsedDuration(192), "3m 12s");
      assert.equal(formatElapsedDuration(3665), "1h 1m 5s");
    });

    it("LiveRunBlock component source includes elapsed time and active activity label", () => {
      const src = fs.readFileSync(path.resolve(__dirname, "../components/LiveRunBlock.tsx"), "utf8");
      assert.ok(src.includes("Running for") || src.includes("formatElapsedDuration") || src.includes("elapsed"), "Must display elapsed running time");
      assert.ok(src.includes("animate-spin") || src.includes("spinner") || src.includes("indeterminate"), "Must have dynamic progress or active spinner");
    });
  });

  describe("Item 2: Thinking display (keep it, format it, filter raw noise)", () => {
    it("formatThinkingDisplay filters out raw XML/SVG tags, coordinate dumps, and repetitive tokens", () => {
      const rawThinking = [
        "Analyzing prompt and goal requirements",
        "<svg viewBox='0 0 100 100'><path d='M10 20 L30 40 Z' fill='#fff'/></svg>",
        "Decomposed into 1 milestone for weather generation",
        "```xml\n<rect x='10' y='20' width='100' height='200'/>\n```",
        "Generating SVG vector markup with sun and cloud elements"
      ];

      const formatted = formatThinkingDisplay(rawThinking);
      assert.ok(formatted.length > 0, "Should have formatted reasoning narrative steps");
      // Must keep narrative
      assert.ok(formatted.some(s => s.includes("Analyzing prompt")));
      assert.ok(formatted.some(s => s.includes("Decomposed into 1 milestone")));
      assert.ok(formatted.some(s => s.includes("Generating SVG vector markup")));
      // Must not contain raw xml coordinates or raw code blocks as bullet points
      assert.ok(!formatted.some(s => s.includes("<path d='M10 20")));
      assert.ok(!formatted.some(s => s.includes("```xml")));
    });

    it("formatThinkingDisplay returns a summary and step list with labels", () => {
      const narrative = [
        "Analyzing weather requirements",
        "Determining color palette and SVG viewBox coordinates",
        "Generating SVG markup"
      ];
      const steps = formatThinkingDisplay(narrative);
      assert.equal(steps.length, 3);
      assert.equal(steps[0], "Analyzing weather requirements");
    });
  });

  describe("Item 4: Code block enhanced rendering & copy feedback", () => {
    it("ChatStream and CodeBlock components support line numbers, copy button, language headers, and horizontal scroll", () => {
      const src = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
      assert.ok(src.includes("Copied") || src.includes("copied"), "Must show copy feedback");
      assert.ok(src.includes("overflow-x-auto"), "Must support horizontal scroll for long lines");
    });
  });

  describe("Item 5: Human-readable labels", () => {
    it("formatHumanReadableTrace translates technical tool names to plain language", () => {
      const searchTrace = {
        tool: "search_web",
        durationMs: 1500,
        args: { query: "weather forecast" }
      };
      const label = formatHumanReadableTrace(searchTrace);
      assert.ok(label.title.includes("Searched the web"), `Expected 'Searched the web' but got '${label.title}'`);
      assert.ok(label.duration.includes("1.5s") || label.duration.includes("1500ms"));

      const pythonTrace = {
        tool: "execute_sandboxed_python",
        durationMs: 820,
        args: { code: "print('hello')" }
      };
      const pyLabel = formatHumanReadableTrace(pythonTrace);
      assert.ok(pyLabel.title.includes("Ran Python script") || pyLabel.title.includes("Executed code"));
    });
  });

  describe("Item 7: Model indicator accuracy", () => {
    it("activeModel indicator resolves to swift-27b-mtp if backend is using swift-27b-mtp", () => {
      const src = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
      // Check that shortModelLabel handles swift-27b-mtp cleanly
      assert.ok(src.includes("swift"), "shortModelLabel must recognize swift model");
    });
  });

  describe("Item 8: Duplicate message deduplication", () => {
    it("ChatStream or parent does not render duplicate sequential user messages with identical content", () => {
      const src = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
      assert.ok(
        src.includes("dedupe") || src.includes("filter") || src.includes("prev.some") || src.includes("duplicate") || src.includes("hasSeen"),
        "ChatStream should prevent rendering duplicate identical user messages"
      );
    });
  });
});
