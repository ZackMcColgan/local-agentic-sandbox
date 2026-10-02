import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWorkspaceTools } from "../src/tools/workspaceTools.js";

describe("Workspace & Git Tools Suite", () => {
  let mcp: McpServer;

  beforeEach(() => {
    mcp = new McpServer({
      name: "test-mcp-server",
      version: "2.0.0"
    });
    registerWorkspaceTools(mcp);
  });

  it("registers all 8 autonomous workspace & git tools", () => {
    // @ts-ignore
    const tools = mcp._registeredTools;
    const requiredTools = [
      "workspace_get_tree",
      "workspace_grep",
      "workspace_read_file",
      "workspace_write_file",
      "workspace_run_command",
      "git_status",
      "git_checkout_branch",
      "git_commit"
    ];

    for (const toolName of requiredTools) {
      assert.ok(tools[toolName], `${toolName} should be registered in MCP server`);
    }
  });

  it("writes and reads files within workspace, supporting code and .drawio.svg diagrams", async () => {
    // @ts-ignore
    const writeHandler = mcp._registeredTools["workspace_write_file"].handler;
    // @ts-ignore
    const readHandler = mcp._registeredTools["workspace_read_file"].handler;

    // 1. Write Python test file
    const writeResult = await writeHandler({
      path: "tests/sample_test.py",
      content: "def test_answer():\n    assert 1 + 1 == 2\n"
    });
    const writeData = JSON.parse(writeResult.content[0].text);
    assert.equal(writeData.status, "SUCCESS");

    // 2. Read Python test file
    const readResult = await readHandler({
      path: "tests/sample_test.py"
    });
    const readData = JSON.parse(readResult.content[0].text);
    assert.equal(readData.status, "SUCCESS");
    assert.ok(readData.content.includes("test_answer"));

    // 3. Write .drawio.svg architecture diagram
    const svgResult = await writeHandler({
      path: "docs/architecture.drawio.svg",
      content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="50" /></svg>'
    });
    const svgData = JSON.parse(svgResult.content[0].text);
    assert.equal(svgData.status, "SUCCESS");
    assert.equal(svgData.is_diagram, true);
  });

  it("strictly rejects path traversal attempts outside workspace", async () => {
    // @ts-ignore
    const readHandler = mcp._registeredTools["workspace_read_file"].handler;

    const res = await readHandler({
      path: "../../../etc/shadow"
    });
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.status, "EXECUTION_ERROR");
    assert.ok(data.error.includes("Security Violation") || data.error.includes("traversal"));
  });

  it("executes workspace_get_tree and workspace_grep", async () => {
    // @ts-ignore
    const treeHandler = mcp._registeredTools["workspace_get_tree"].handler;
    // @ts-ignore
    const grepHandler = mcp._registeredTools["workspace_grep"].handler;

    const treeRes = await treeHandler({ max_depth: 3 });
    const treeData = JSON.parse(treeRes.content[0].text);
    assert.equal(treeData.status, "SUCCESS");
    assert.ok(typeof treeData.tree === "string");

    const grepRes = await grepHandler({ pattern: "test_answer" });
    const grepData = JSON.parse(grepRes.content[0].text);
    assert.equal(grepData.status, "SUCCESS");
    assert.ok(grepData.match_count >= 1);
  });

  it("executes commands and checks exit codes with workspace_run_command", async () => {
    // @ts-ignore
    const cmdHandler = mcp._registeredTools["workspace_run_command"].handler;

    const res = await cmdHandler({
      command: "node -e \"console.log('hello autonomous sandbox')\""
    });
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.status, "SUCCESS");
    assert.equal(data.exit_code, 0);
    assert.equal(data.stdout, "hello autonomous sandbox");
  });

  it("performs git operations (status, checkout_branch, commit)", async () => {
    // @ts-ignore
    const statusHandler = mcp._registeredTools["git_status"].handler;
    // @ts-ignore
    const checkoutHandler = mcp._registeredTools["git_checkout_branch"].handler;
    // @ts-ignore
    const commitHandler = mcp._registeredTools["git_commit"].handler;

    // Checkout a new autonomous branch
    const branchName = `agent/test-suite-${Date.now()}`;
    const checkoutRes = await checkoutHandler({
      branch_name: branchName,
      create_new: true
    });
    const checkoutData = JSON.parse(checkoutRes.content[0].text);
    assert.equal(checkoutData.status, "SUCCESS");
    assert.equal(checkoutData.current_branch, branchName);

    // Write file to commit
    // @ts-ignore
    const writeHandler = mcp._registeredTools["workspace_write_file"].handler;
    await writeHandler({
      path: "commit_test.txt",
      content: `Autonomous commit test ${Date.now()}`
    });

    // Commit changes
    const commitRes = await commitHandler({
      message: "feat(tests): add automated autonomous test assertions"
    });
    const commitData = JSON.parse(commitRes.content[0].text);
    assert.equal(commitData.status, "SUCCESS");

    // Inspect git status
    const statusRes = await statusHandler({});
    const statusData = JSON.parse(statusRes.content[0].text);
    assert.equal(statusData.status, "SUCCESS");
    assert.equal(statusData.branch, branchName);
  });
});
