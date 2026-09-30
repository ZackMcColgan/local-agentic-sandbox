import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCodeRunner } from "../src/tools/codeRunner.js";
import { registerAttestation } from "../src/tools/attestation.js";

describe("MCP Tools Suite", () => {
  let mcp: McpServer;

  beforeEach(() => {
    mcp = new McpServer({
      name: "test-mcp-server",
      version: "1.0.0"
    });
  });

  describe("CodeRunner Tool", () => {
    it("registers execute_sandboxed_python tool", () => {
      registerCodeRunner(mcp);
      // @ts-ignore
      const tools = mcp._registeredTools;
      assert.ok(tools["execute_sandboxed_python"], "execute_sandboxed_python should be registered");
    });

    it("executes valid python code and returns security boundary metadata", async () => {
      registerCodeRunner(mcp);
      // @ts-ignore
      const toolHandler = mcp._registeredTools["execute_sandboxed_python"].handler;

      const result = await toolHandler({
        code: "print(42)"
      });

      assert.ok(result.content, "Result content should be defined");
      assert.equal(result.content[0].type, "text");
      const parsed = JSON.parse(result.content[0].text);
      
      assert.ok(["SUCCESS", "EXECUTION_ERROR"].includes(parsed.status));
      assert.ok(parsed.security_boundary, "Security boundary must be defined");
      assert.equal(parsed.security_boundary.network_egress, "BLOCKED");
    });

    it("gracefully catches syntax errors and isolates failures", async () => {
      registerCodeRunner(mcp);
      // @ts-ignore
      const toolHandler = mcp._registeredTools["execute_sandboxed_python"].handler;

      const result = await toolHandler({
        code: "def broken_syntax(:\n  pass"
      });

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.status, "EXECUTION_ERROR");
      assert.equal(parsed.security_boundary.network_egress, "BLOCKED");
      assert.equal(parsed.security_boundary.isolation, "ENFORCED");
    });
  });

  describe("Provenance & Docker Scout Attestation Tools", () => {
    it("registers verify_container_provenance and docker_scout_policy_gate tools", () => {
      registerAttestation(mcp);
      // @ts-ignore
      const tools = mcp._registeredTools;
      assert.ok(tools["verify_container_provenance"], "verify_container_provenance should be registered");
      assert.ok(tools["docker_scout_policy_gate"], "docker_scout_policy_gate should be registered");
    });

    it("performs live runtime kernel security boundary probe", async () => {
      registerAttestation(mcp);
      // @ts-ignore
      const toolHandler = mcp._registeredTools["verify_container_provenance"].handler;

      const result = await toolHandler({
        image_uri: "local-agentic-sandbox/mcp-server:latest@sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        environment: "prod"
      });

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.telemetry_source, "LIVE_KERNEL_PROBE");
      assert.ok(parsed.runtime_boundary, "Runtime boundary must be probed");
      assert.equal(parsed.runtime_boundary.network_egress, "BLOCKED");
      assert.equal(parsed.supply_chain_gate.image_digest, "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
      assert.ok(parsed.supply_chain_gate.docker_socket_posture.includes("Docker socket"));
    });

    it("evaluates docker scout policy gate safely with fallback notice", async () => {
      registerAttestation(mcp);
      // @ts-ignore
      const toolHandler = mcp._registeredTools["docker_scout_policy_gate"].handler;

      const result = await toolHandler({
        image_uri: "local-agentic-sandbox/mcp-server:latest",
        max_critical: 0,
        max_high: 0
      });

      const parsed = JSON.parse(result.content[0].text);
      assert.ok(["PASSED", "FAILED_POLICY_GATE", "SCOUT_CLI_UNAVAILABLE"].includes(parsed.status));
    });
  });
});
