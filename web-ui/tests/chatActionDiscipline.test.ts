import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  MAX_WEB_RESEARCH_CALLS,
  WEB_BUDGET_EXHAUSTED_DIRECTIVE,
  WEB_RESEARCH_TOOL_NAMES,
  isWebResearchTool,
  filterToolsForWebBudget,
  hasArtifactCreationIntent,
  buildSynthesisDirective,
  shouldRunPostToolSynthesis,
  FINAL_ROUND_SYNTHESIS_DIRECTIVE
} from "../lib/contextBudget.js";

describe("Chat Action Discipline & Artifact Synthesis Suite", () => {
  describe("Task 1: filterToolsForWebBudget & Web Research Cap", () => {
    const sampleTools = [
      { type: "function", function: { name: "search_web", description: "Search the web" } },
      { type: "function", function: { name: "fetch_webpage_markdown", description: "Fetch page" } },
      { type: "function", function: { name: "workspace_write_file", description: "Write file" } },
      { type: "function", function: { name: "workspace_read_file", description: "Read file" } },
      { type: "function", function: { name: "execute_sandboxed_python", description: "Run python" } }
    ];

    it("defines MAX_WEB_RESEARCH_CALLS = 3 and WEB_RESEARCH_TOOL_NAMES", () => {
      assert.equal(MAX_WEB_RESEARCH_CALLS, 3);
      assert.ok(WEB_RESEARCH_TOOL_NAMES.has("search_web"));
      assert.ok(WEB_RESEARCH_TOOL_NAMES.has("fetch_webpage_markdown"));
      assert.ok(!WEB_RESEARCH_TOOL_NAMES.has("workspace_write_file"));
    });

    it("identifies web research tools by name and browser tier", () => {
      assert.equal(isWebResearchTool("search_web"), true);
      assert.equal(isWebResearchTool("fetch_webpage_markdown"), true);
      assert.equal(isWebResearchTool("custom_scraper", "browser"), true);
      assert.equal(isWebResearchTool("workspace_write_file", "workspace"), false);
      assert.equal(isWebResearchTool("execute_sandboxed_python"), false);
    });

    it("returns all tools when webResearchCalls < 3", () => {
      for (const calls of [0, 1, 2]) {
        const filtered = filterToolsForWebBudget(sampleTools, calls);
        assert.equal(filtered.length, 5, `Expected 5 tools for ${calls} calls used`);
        const names = filtered.map((t) => t.function?.name || t.name);
        assert.ok(names.includes("search_web"));
        assert.ok(names.includes("fetch_webpage_markdown"));
        assert.ok(names.includes("workspace_write_file"));
        assert.ok(names.includes("workspace_read_file"));
        assert.ok(names.includes("execute_sandboxed_python"));
      }
    });

    it("withholds web research tools when webResearchCalls >= 3 while preserving sandbox/workspace tools", () => {
      for (const calls of [3, 4, 10]) {
        const filtered = filterToolsForWebBudget(sampleTools, calls);
        assert.equal(filtered.length, 3, `Expected 3 tools for ${calls} calls used`);
        const names = filtered.map((t) => t.function?.name || t.name);
        assert.ok(!names.includes("search_web"), "search_web must be withheld");
        assert.ok(!names.includes("fetch_webpage_markdown"), "fetch_webpage_markdown must be withheld");
        assert.ok(names.includes("workspace_write_file"), "workspace_write_file must be preserved");
        assert.ok(names.includes("workspace_read_file"), "workspace_read_file must be preserved");
        assert.ok(names.includes("execute_sandboxed_python"), "execute_sandboxed_python must be preserved");
      }
    });
  });

  describe("Task 2: hasArtifactCreationIntent & buildSynthesisDirective", () => {
    it("accurately detects SVG creation intent", () => {
      const svgPrompts = [
        "create an SVG of the weather in Spanish Fort AL",
        "draw an architecture diagram of the cluster",
        "design a flowchart for user login",
        "make an infographic showing quarterly revenue",
        "render a vector graphic of the system topology"
      ];

      for (const prompt of svgPrompts) {
        const result = hasArtifactCreationIntent(prompt);
        assert.equal(result.wantsSvg, true, `Prompt should want SVG: "${prompt}"`);
        assert.equal(result.isArtifactRequest, true, `Prompt should be artifact request: "${prompt}"`);
      }
    });

    it("distinguishes non-artifact informational queries", () => {
      const infoPrompts = [
        "what is the weather in Spanish Fort AL?",
        "how does the supervisor manage tasks?",
        "explain zero-trust architecture",
        "summarize the README file"
      ];

      for (const prompt of infoPrompts) {
        const result = hasArtifactCreationIntent(prompt);
        assert.equal(result.wantsSvg, false, `Prompt should not want SVG: "${prompt}"`);
        assert.equal(result.isArtifactRequest, false, `Prompt should not be artifact request: "${prompt}"`);
      }
    });

    it("builds SVG-specific directive when wantsSvg is true", () => {
      const directive = buildSynthesisDirective("create an SVG of the weather in Spanish Fort AL");
      assert.ok(directive.includes("<svg"), "Must require <svg deliverable");
      assert.ok(directive.includes("```svg"), "Must require ```svg code block");
      assert.ok(directive.includes("Do not invoke any more tools"), "Must prohibit more tools");
      assert.ok(directive.includes("do not reply with a text-only summary"), "Must instruct not to reply with text-only summary");
    });

    it("builds standard Markdown directive when wantsSvg is false", () => {
      const directive = buildSynthesisDirective("what is the weather in Spanish Fort AL?");
      assert.ok(directive.includes("synthesize all the tool results"), "Should be standard Markdown synthesis");
      assert.ok(!directive.includes("```svg"), "Should not mention ```svg block");

      const finalRoundDirective = buildSynthesisDirective("what is the weather in Spanish Fort AL?", true);
      assert.equal(finalRoundDirective, FINAL_ROUND_SYNTHESIS_DIRECTIVE);
    });
  });

  describe("Task 3: shouldRunPostToolSynthesis", () => {
    it("returns true when SVG was requested and tools ran, but no SVG or diagram was produced", () => {
      const shouldRun = shouldRunPostToolSynthesis({
        userPrompt: "create an SVG of the weather in Spanish Fort AL",
        assistantContent: "The weather in Spanish Fort is 75F and sunny with mild humidity.",
        lingeringToolCallsCount: 0,
        traces: [{ tool: "search_web", args: { query: "weather spanish fort" }, result: {} }]
      });
      assert.equal(shouldRun, true, "Must trigger post-tool synthesis when SVG is missing from response");
    });

    it("returns false when assistant content already contains an SVG block", () => {
      const shouldRun = shouldRunPostToolSynthesis({
        userPrompt: "create an SVG of the weather in Spanish Fort AL",
        assistantContent: "Here is your vector graphic:\n\n```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"gold\"/></svg>\n```",
        lingeringToolCallsCount: 0,
        traces: [{ tool: "search_web", args: {}, result: {} }]
      });
      assert.equal(shouldRun, false, "Should not trigger synthesis if SVG is already present");
    });

    it("returns false when traces already wrote an SVG file", () => {
      const shouldRun = shouldRunPostToolSynthesis({
        userPrompt: "create an SVG of the weather in Spanish Fort AL",
        assistantContent: "I have written the SVG graphic to weather.svg in the workspace.",
        lingeringToolCallsCount: 0,
        traces: [
          {
            tool: "workspace_write_file",
            args: { path: "weather.svg", content: "<svg viewBox=\"0 0 100 100\"></svg>" },
            result: { status: "SUCCESS" }
          }
        ]
      });
      assert.equal(shouldRun, false, "Should not trigger synthesis if SVG was written to workspace");
    });

    it("returns true when assistant content is empty or has lingering tool calls", () => {
      const emptyContentRun = shouldRunPostToolSynthesis({
        userPrompt: "what is the weather?",
        assistantContent: "",
        lingeringToolCallsCount: 0,
        traces: [{ tool: "search_web", args: {}, result: {} }]
      });
      assert.equal(emptyContentRun, true, "Must trigger synthesis when assistant content is empty");

      const lingeringRun = shouldRunPostToolSynthesis({
        userPrompt: "what is the weather?",
        assistantContent: "I found this info.",
        lingeringToolCallsCount: 1,
        traces: [{ tool: "search_web", args: {}, result: {} }]
      });
      assert.equal(lingeringRun, true, "Must trigger synthesis when lingering tool calls exist");
    });
  });

  describe("Task 4: System Prompt & Chat Route Integration", () => {
    it("route.ts enforces MAX_WEB_RESEARCH_CALLS, calls filterToolsForWebBudget, buildSynthesisDirective, and shouldRunPostToolSynthesis", () => {
      const routePath = path.resolve(__dirname, "../app/api/chat/route.ts");
      assert.ok(fs.existsSync(routePath), "route.ts must exist");
      const routeSource = fs.readFileSync(routePath, "utf8");

      assert.ok(
        routeSource.includes("MAX_WEB_RESEARCH_CALLS"),
        "route.ts must reference MAX_WEB_RESEARCH_CALLS"
      );
      assert.ok(
        routeSource.includes("filterToolsForWebBudget"),
        "route.ts must invoke filterToolsForWebBudget"
      );
      assert.ok(
        routeSource.includes("buildSynthesisDirective"),
        "route.ts must invoke buildSynthesisDirective"
      );
      assert.ok(
        routeSource.includes("shouldRunPostToolSynthesis"),
        "route.ts must invoke shouldRunPostToolSynthesis"
      );
      assert.ok(
        routeSource.includes("WEB RESEARCH & ACTION DISCIPLINE"),
        "SYSTEM_PROMPT in route.ts must contain the WEB RESEARCH & ACTION DISCIPLINE rule"
      );
    });
  });
});
