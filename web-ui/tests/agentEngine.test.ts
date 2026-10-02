import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousEngine, evaluateTaskCompletion } from "../lib/agentEngine";

describe("Autonomous Engine Suite", () => {
  it("initializes AutonomousEngine with normalized MCP URL and default maxIterations", () => {
    const engine = new AutonomousEngine("http://127.0.0.1:11434", "http://127.0.0.1:8080", 10);
    assert.ok(engine);
    // Verified constructor normalized mcpUrl to include /sse
    assert.equal((engine as any).mcpUrl, "http://127.0.0.1:8080/sse");
    assert.equal((engine as any).maxIterations, 10);
  });

  it("handles trailing slashes on mcpUrl gracefully in AutonomousEngine", () => {
    const engine = new AutonomousEngine("http://127.0.0.1:11434", "http://mcp-runner:8080/", 8);
    assert.equal((engine as any).mcpUrl, "http://mcp-runner:8080/sse");
  });

  it("preserves mcpUrl if /sse already present", () => {
    const engine = new AutonomousEngine("http://127.0.0.1:11434", "http://mcp-runner:8080/sse", 5);
    assert.equal((engine as any).mcpUrl, "http://mcp-runner:8080/sse");
  });

  describe("Completion Heuristic & Verification Criteria", () => {
    it("rejects trivial commands with exit code 0 (e.g. 'echo test') from completing task", () => {
      // Trivial echo command containing 'test'
      const trivialEcho = evaluateTaskCompletion({
        toolName: "workspace_run_command",
        command: "echo test",
        exitCode: 0,
        stdout: "test\n"
      });
      assert.equal(trivialEcho, false, "echo test should not complete task");

      // Trivial cat command containing 'test'
      const trivialCat = evaluateTaskCompletion({
        toolName: "workspace_run_command",
        command: "cat tests/dummy.txt",
        exitCode: 0,
        stdout: "some content\n"
      });
      assert.equal(trivialCat, false, "cat tests/dummy.txt should not complete task");

      // Trivial echo with 'passed'
      const trivialPassed = evaluateTaskCompletion({
        toolName: "workspace_run_command",
        command: "echo 'all tests passed'",
        exitCode: 0,
        stdout: "all tests passed\n"
      });
      assert.equal(trivialPassed, false, "echo 'all tests passed' should not complete task");

      // Non-test command
      const lsCmd = evaluateTaskCompletion({
        toolName: "workspace_run_command",
        command: "ls -la",
        exitCode: 0,
        stdout: "total 0\n"
      });
      assert.equal(lsCmd, false, "ls -la should not complete task");
    });

    it("requires genuine test runners with verified pass output to complete task", () => {
      // pytest with passing summary
      const pytestPass = evaluateTaskCompletion({
        toolName: "workspace_run_command",
        command: "pytest tests/",
        exitCode: 0,
        stdout: "================ 5 passed in 0.23s ================"
      });
      assert.equal(pytestPass, true, "pytest with passing summary must complete task");

      // npm test with passing summary
      const npmPass = evaluateTaskCompletion({
        toolName: "workspace_run_command",
        command: "npm test",
        exitCode: 0,
        stdout: "Tests: 12 passed, 12 total"
      });
      assert.equal(npmPass, true, "npm test with passing summary must complete task");

      // cargo test with ok result
      const cargoPass = evaluateTaskCompletion({
        toolName: "workspace_run_command",
        command: "cargo test",
        exitCode: 0,
        stdout: "test result: ok. 4 passed; 0 failed"
      });
      assert.equal(cargoPass, true, "cargo test with ok must complete task");

      // Test runner with exit code != 0 should NOT complete
      const failedTest = evaluateTaskCompletion({
        toolName: "workspace_run_command",
        command: "npm test",
        exitCode: 1,
        stdout: "Tests: 1 failed, 1 passed, 2 total"
      });
      assert.equal(failedTest, false, "failed test runner must not complete task");

      // Test runner with exit code 0 but no passing output assertions should NOT complete
      const emptyTest = evaluateTaskCompletion({
        toolName: "workspace_run_command",
        command: "pytest tests/",
        exitCode: 0,
        stdout: "no tests collected"
      });
      assert.equal(emptyTest, false, "empty test runner execution must not complete task");
    });
  });
});
