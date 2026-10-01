import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousEngine } from "../lib/agentEngine";

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
});
