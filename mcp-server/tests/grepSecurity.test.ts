import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWorkspaceTools } from "../src/tools/workspaceTools.js";

describe("workspace_grep ReDoS & Regex Security Suite", () => {
  let mcp: McpServer;

  beforeEach(() => {
    mcp = new McpServer({
      name: "test-mcp-server",
      version: "2.0.0"
    });
    registerWorkspaceTools(mcp);
  });

  it("safely rejects catastrophic-backtracking nested quantifier patterns (ReDoS)", async () => {
    // @ts-ignore
    const grepHandler = mcp._registeredTools["workspace_grep"].handler;

    const dangerousPatterns = [
      "(a+)+$",
      "(a|aa)+$",
      "([a-zA-Z]+)*$",
      "([0-9]+)+",
      "(.*a){10}"
    ];

    for (const pattern of dangerousPatterns) {
      const res = await grepHandler({ pattern });
      const data = JSON.parse(res.content[0].text);
      assert.equal(
        data.status,
        "EXECUTION_ERROR",
        `Dangerous pattern '${pattern}' must be rejected with EXECUTION_ERROR`
      );
      assert.match(
        data.error,
        /backtracking|redos|complexity|unsafe|dangerous/i,
        `Error for '${pattern}' should indicate regex safety violation`
      );
    }
  });

  it("safely rejects excessively long regex patterns to guard against resource exhaustion", async () => {
    // @ts-ignore
    const grepHandler = mcp._registeredTools["workspace_grep"].handler;

    const hugePattern = "a".repeat(600);
    const res = await grepHandler({ pattern: hugePattern });
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.status, "EXECUTION_ERROR");
    assert.match(data.error, /length|exceeds|too long/i);
  });

  it("handles malformed/invalid regex patterns gracefully without throwing uncaught exceptions", async () => {
    // @ts-ignore
    const grepHandler = mcp._registeredTools["workspace_grep"].handler;

    const res = await grepHandler({ pattern: "[unclosed-bracket(" });
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.status, "EXECUTION_ERROR");
    assert.match(data.error, /invalid|syntax/i);
  });

  it("preserves standard safe regex and substring searches without regression", async () => {
    // @ts-ignore
    const grepHandler = mcp._registeredTools["workspace_grep"].handler;

    const validPatterns = [
      "sample_test",
      "def\\s+test_",
      "import.*node:test",
      "^const\\s+[a-zA-Z0-9_]+"
    ];

    for (const pattern of validPatterns) {
      const res = await grepHandler({ pattern });
      const data = JSON.parse(res.content[0].text);
      assert.equal(data.status, "SUCCESS", `Valid pattern '${pattern}' should execute successfully`);
      assert.equal(typeof data.match_count, "number");
    }
  });
});
