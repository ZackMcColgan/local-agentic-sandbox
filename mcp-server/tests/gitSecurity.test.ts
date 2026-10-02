import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWorkspaceTools } from "../src/tools/workspaceTools.js";

describe("Task 2 — Git Shell Injection Security Suite", () => {
  let mcp: McpServer;
  let probeFile: string;

  beforeEach(() => {
    mcp = new McpServer({
      name: "test-mcp-server-sec",
      version: "2.0.0"
    });
    registerWorkspaceTools(mcp);
    probeFile = path.join(os.tmpdir(), `pwned_probe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    if (fs.existsSync(probeFile)) {
      fs.unlinkSync(probeFile);
    }
  });

  afterEach(() => {
    if (fs.existsSync(probeFile)) {
      try {
        fs.unlinkSync(probeFile);
      } catch {}
    }
  });

  it("prevents shell injection in git_checkout_branch via semicolon and command chaining", async () => {
    // @ts-ignore
    const checkoutHandler = mcp._registeredTools["git_checkout_branch"].handler;

    // Hostile branch names containing shell metacharacters
    const touchCmd = process.platform === "win32" ? `type nul > "${probeFile}"` : `touch "${probeFile}"`;
    const hostileBranch = `main; ${touchCmd}`;

    const res = await checkoutHandler({
      branch_name: hostileBranch,
      create_new: true
    });

    // 1. Assert probe file was NOT created outside repo
    assert.equal(
      fs.existsSync(probeFile),
      false,
      "Shell injection executed! Probe file was created via branch_name injection."
    );

    // 2. Assert git treated the input as a single literal argument or rejected it safely
    const data = JSON.parse(res.content[0].text);
    if (data.status === "EXECUTION_ERROR") {
      assert.ok(
        data.error.includes("not a valid branch name") || data.error.includes("fatal:"),
        `Expected git to reject invalid branch name safely, got: ${data.error}`
      );
    }
  });

  it("prevents shell injection in git_checkout_branch via $(...) command substitution", async () => {
    // @ts-ignore
    const checkoutHandler = mcp._registeredTools["git_checkout_branch"].handler;

    const touchCmd = process.platform === "win32" ? `type nul > "${probeFile}"` : `touch "${probeFile}"`;
    const hostileBranch = `$( ${touchCmd} )`;

    await checkoutHandler({
      branch_name: hostileBranch,
      create_new: true
    });

    assert.equal(
      fs.existsSync(probeFile),
      false,
      "Shell injection executed! Probe file was created via $(...) command substitution."
    );
  });

  it("prevents shell injection in git_commit via double-quote breaking and command chaining", async () => {
    // @ts-ignore
    const writeHandler = mcp._registeredTools["workspace_write_file"].handler;
    // @ts-ignore
    const commitHandler = mcp._registeredTools["git_commit"].handler;

    // Stage a dummy file first
    await writeHandler({
      path: "sec_test_file.txt",
      content: `Security probe test ${Date.now()}`
    });

    const touchCmd = process.platform === "win32" ? `type nul > "${probeFile}"` : `touch "${probeFile}"`;
    const hostileMessage = `x"; ${touchCmd}; echo "`;

    const res = await commitHandler({
      message: hostileMessage
    });

    // 1. Assert probe file was NOT created outside repo
    assert.equal(
      fs.existsSync(probeFile),
      false,
      "Shell injection executed! Probe file was created via commit message injection."
    );

    // 2. Assert git committed the literal message or handled it safely without shell execution
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.status, "SUCCESS");
    assert.equal(data.commit_message, hostileMessage);
  });
});
