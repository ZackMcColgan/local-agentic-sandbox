import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMcpUrl,
  parseToolCallsFromText,
  cleanResidualToolTags
} from "../lib/toolParser";

describe("Tool Parser & URL Normalization Suite", () => {
  describe("normalizeMcpUrl", () => {
    it("appends /sse to URLs missing it", () => {
      assert.equal(normalizeMcpUrl("http://mcp-runner:8080"), "http://mcp-runner:8080/sse");
      assert.equal(normalizeMcpUrl("http://browser-mcp:8081"), "http://browser-mcp:8081/sse");
      assert.equal(normalizeMcpUrl("http://localhost:8080/"), "http://localhost:8080/sse");
    });

    it("preserves URLs that already have /sse", () => {
      assert.equal(normalizeMcpUrl("http://mcp-runner:8080/sse"), "http://mcp-runner:8080/sse");
      assert.equal(normalizeMcpUrl("http://browser-mcp:8081/sse/"), "http://browser-mcp:8081/sse");
    });

    it("handles edge cases and empty URLs", () => {
      assert.equal(normalizeMcpUrl(""), "http://127.0.0.1:8080/sse");
      assert.equal(normalizeMcpUrl("   "), "http://127.0.0.1:8080/sse");
    });
  });

  describe("parseToolCallsFromText", () => {
    const allowedTools = new Set(["search_web", "workspace_run_command", "workspace_read_file"]);

    it("extracts Qwen XML syntax (<function=NAME><parameter=KEY>VAL</parameter></function>)", () => {
      const text = `I'll search for information.
<function=search_web>
<parameter=query>"bulk import jira stories"</parameter>
</function>`;

      const calls = parseToolCallsFromText(text, allowedTools);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].function.name, "search_web");
      assert.equal(calls[0].function.arguments.query, "bulk import jira stories");
    });

    it("extracts Qwen XML syntax with name attributes", () => {
      const text = `<function name="workspace_run_command">
<parameter name="command">npm test</parameter>
</function>`;

      const calls = parseToolCallsFromText(text, allowedTools);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].function.name, "workspace_run_command");
      assert.equal(calls[0].function.arguments.command, "npm test");
    });

    it("extracts <tool_call> JSON blocks", () => {
      const text = `<tool_call>
{"name": "search_web", "arguments": {"query": "weather in Spanish Fort"}}
</tool_call>`;

      const calls = parseToolCallsFromText(text, allowedTools);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].function.name, "search_web");
      assert.equal(calls[0].function.arguments.query, "weather in Spanish Fort");
    });

    it("extracts markdown ```json ... ``` tool blocks", () => {
      const text = `Let me read the file:
\`\`\`json
{
  "name": "workspace_read_file",
  "arguments": { "path": "package.json" }
}
\`\`\``;

      const calls = parseToolCallsFromText(text, allowedTools);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].function.name, "workspace_read_file");
      assert.equal(calls[0].function.arguments.path, "package.json");
    });

    it("ignores tool calls that are not in the allowed tools set", () => {
      const text = `<function=unauthorized_tool>
<parameter=cmd>rm -rf /</parameter>
</function>`;

      const calls = parseToolCallsFromText(text, allowedTools);
      assert.equal(calls.length, 0);
    });

    it("extracts raw JSON object tool calls and supports Map for tool check", () => {
      const toolMap = new Map([["search_web", { tier: "browser" }]]);
      const text = `{"name": "search_web", "arguments": {"query": "bulk import jira"}}`;
      const calls = parseToolCallsFromText(text, toolMap as any);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].function.name, "search_web");
      assert.equal(calls[0].function.arguments.query, "bulk import jira");
    });

    it("returns empty array for plain conversational text", () => {
      const text = "Sure! Here is the best way to bulk import JIRA stories using CSV import or Jira REST API.";
      const calls = parseToolCallsFromText(text, allowedTools);
      assert.equal(calls.length, 0);
    });
  });

  describe("cleanResidualToolTags", () => {
    it("strips XML and tool_call tags leaving conversational text intact", () => {
      const text = `Thinking...
<function=search_web>
<parameter=query>"test"</parameter>
</function>
Here is what I found for you.`;

      const cleaned = cleanResidualToolTags(text);
      assert.ok(!cleaned.includes("<function"));
      assert.ok(!cleaned.includes("</function>"));
      assert.ok(cleaned.includes("Here is what I found for you."));
    });

    it("handles text consisting solely of tool tags without throwing", () => {
      const text = `<tool_call>{"name": "search_web", "arguments": {}}</tool_call>`;
      const cleaned = cleanResidualToolTags(text);
      assert.equal(cleaned, "");
    });
  });
});
