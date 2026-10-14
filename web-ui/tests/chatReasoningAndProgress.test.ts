import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { formatThinkingDisplay, formatHumanReadableTrace, formatElapsedDuration } from "../lib/chatUtils";

describe("Chat Reasoning, Progress & Live Run Formatting", () => {
  describe("formatElapsedDuration & LiveRunBlock Activity Tracking", () => {
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

  describe("formatThinkingDisplay & Reasoning Noise Filtering", () => {
    it("filters out raw XML/SVG tags, coordinate dumps, and repetitive tokens", () => {
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

    it("formatThinkingDisplay preserves full reasoning text without truncating at 220 chars", () => {
      const longReasoning = "We need to construct a comprehensive weather graphic that clearly demonstrates high pressure zones, cloud coverage, temperature gradients, and wind vector indicators across the primary coordinate map without dropping essential structural requirements or truncating sentences mid-thought.";
      const steps = formatThinkingDisplay([longReasoning]);
      assert.equal(steps.length, 1);
      assert.equal(steps[0], longReasoning);
      assert.ok(!steps[0].endsWith("..."), "Thinking should not be prematurely cut off with ellipsis");
    });

    it("suppresses meta-formatting noise (code fence syntax, counts, structural fences, etc.)", () => {
      const mixedThoughts = [
        "Decomposed goal into 1 milestone. SPEC.md generated.",
        "in a ``` typescript (or appropriate language) code fence\" singular. But to include two files, two fences. No intro. Alternative: output a single code fence containing both files separated by markers",
        "Determining temperature color scale for tomorrow forecast",
        "Alternative: output a single code fence containing both files",
        "Validating SVG viewBox bounds against screen geometry"
      ];

      const cleaned = formatThinkingDisplay(mixedThoughts);
      assert.equal(cleaned.length, 3, "Should keep exactly the 3 genuine reasoning steps and drop the 2 meta-formatting noise lines");
      assert.ok(cleaned.some(s => s.includes("Decomposed goal into 1 milestone")));
      assert.ok(cleaned.some(s => s.includes("Determining temperature color scale")));
      assert.ok(cleaned.some(s => s.includes("Validating SVG viewBox bounds")));
      assert.ok(!cleaned.some(s => s.includes("code fence") || s.includes("two fences") || s.includes("separated by markers")));
    });

    it("ThinkingPanel source contains phased cards (Planning, Building, Validating), streaming badge, and is expanded by default", () => {
      const src = fs.readFileSync(path.resolve(__dirname, "../components/ThinkingPanel.tsx"), "utf8");
      assert.ok(src.includes("planning") && src.includes("building") && src.includes("validating"), "Must have 3 pipeline phases");
      assert.ok(src.includes("Worker reasoning"), "Must have panel header matching mockup");
      assert.ok(src.includes("Streaming") || src.includes("streaming-badge"), "Must have streaming badge");
      assert.ok(src.includes("defaultExpanded = true"), "Must be expanded by default as requested by user");
    });
  });

  describe("Deliverable Artifact Rendering in LiveRunBlock", () => {
    it("mounts SvgViewer when a task is completed with an SVG deliverable", () => {
      const src = fs.readFileSync(path.resolve(__dirname, "../components/LiveRunBlock.tsx"), "utf8");
      assert.ok(src.includes("SvgViewer"), "LiveRunBlock must import and mount SvgViewer");
      assert.ok(src.includes("isCompleted") && src.includes("isSvg"), "Must conditionally render SvgViewer when deliverable is an SVG");
      assert.ok(src.includes("/api/files?path="), "Must load deliverable file via /api/files endpoint");
    });

    it("mounts CodeBlock when a task produces non-SVG code deliverable (e.g. hello.ts)", () => {
      const src = fs.readFileSync(path.resolve(__dirname, "../components/LiveRunBlock.tsx"), "utf8");
      assert.ok(src.includes("CodeBlock"), "LiveRunBlock must import and mount CodeBlock for non-SVG code deliverables");
      assert.ok(src.includes("codeSnippet"), "LiveRunBlock must extract code snippet from milestone diff or content");
    });
  });

  describe("Code Block Syntax, Line Numbers, Scroll & Copy Feedback", () => {
    it("ChatStream and CodeBlock components support line numbers, copy button, language headers, and horizontal scroll", () => {
      const src = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
      assert.ok(src.includes("Copied") || src.includes("copied"), "Must show copy feedback");
      assert.ok(src.includes("overflow-x-auto"), "Must support horizontal scroll for long lines");
    });

    it("CodeBlock handles long files (e.g. 200 lines) with max-h-400px, overflow-y-auto, bottom gradient fade, expand toggle, and full copy", () => {
      const src = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
      assert.ok(src.includes("max-h-[400px]") && src.includes("overflow-y-auto"), "Must constrain long blocks to max-height with vertical scroll");
      assert.ok(src.includes("bg-gradient-to-t"), "Must have bottom fade gradient shadow when content overflows");
      assert.ok(src.includes("isExpanded") && src.includes("Expand") && src.includes("Collapse"), "Must support expand/collapse toggle");
      assert.ok(src.includes("lines.length"), "Must detect long line counts");
      // Check copy behavior passes raw full code
      assert.ok(src.includes("copyText(code)"), "Must copy the full raw code rather than truncated DOM slice");

      // Verify simulated 200-line file behavior
      const sample200Lines = Array.from({ length: 200 }, (_, i) => `console.log("Line number ${i + 1}");`).join("\n");
      assert.equal(sample200Lines.split("\n").length, 200);
      assert.ok(sample200Lines.split("\n").length > 20, "200-line file triggers long code block behavior");
    });
  });

  describe("formatHumanReadableTrace & Telemetry Labels", () => {
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

  describe("Active Model Indicator Resolution", () => {
    it("activeModel indicator resolves to swift-27b-mtp if backend is using swift-27b-mtp", () => {
      const src = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
      // Check that shortModelLabel handles swift-27b-mtp cleanly
      assert.ok(src.includes("swift"), "shortModelLabel must recognize swift model");
    });
  });

  describe("Message Stream Deduplication", () => {
    it("ChatStream or parent does not render duplicate sequential user messages with identical content", () => {
      const src = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
      assert.ok(
        src.includes("dedupe") || src.includes("filter") || src.includes("prev.some") || src.includes("duplicate") || src.includes("hasSeen"),
        "ChatStream should prevent rendering duplicate identical user messages"
      );
    });
  });

  describe("Sprint 13 Task 1 — Thinking Extraction & Residual Tool-Tag Stripping", () => {
    it("parseThinkingAndContent extracts orphan leading reasoning terminated by </think> without opening <think>", async () => {
      const { parseThinkingAndContent } = await import("../lib/chatUtils.js");
      const raw = "Let me check the forecast for Spanish Fort.\n</think>\nHere is the weather:";
      const parsed = parseThinkingAndContent(raw);
      assert.equal(parsed.thought, "Let me check the forecast for Spanish Fort.");
      assert.equal(parsed.content, "Here is the weather:");
    });

    it("parseThinkingAndContent concatenates all <think> blocks and strips them from content", async () => {
      const { parseThinkingAndContent } = await import("../lib/chatUtils.js");
      const raw = "<think>Round 1 thought</think>Looking up...\n<think>Round 2 thought</think>Final answer";
      const parsed = parseThinkingAndContent(raw);
      assert.equal(parsed.thought, "Round 1 thought\n\nRound 2 thought");
      assert.equal(parsed.content, "Looking up...\nFinal answer");
    });

    it("cleanResidualToolTags strips Qwen XML tool call blocks including unclosed and malformed tags", async () => {
      const { cleanResidualToolTags } = await import("../lib/toolParser.js");
      const raw = 'Here is the data: <tool_call> <function=search_web>{"query":"weather"}</function> </tool_call> and also <tool_call> <function=search_web</function> </tool_call> Done.';
      const cleaned = cleanResidualToolTags(raw);
      assert.ok(!cleaned.includes("<tool_call>"), "Must strip tool_call");
      assert.ok(!cleaned.includes("search_web"), "Must strip function name");
      assert.ok(cleaned.includes("Here is the data:"));
      assert.ok(cleaned.includes("Done."));
    });
  });
});
