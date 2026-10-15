import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

describe("Sprint 12 Phase 5 — Build Task Deploy Flow (deployFlow.test.ts)", () => {
  it("Build task produces a clickable link in the thread that returns HTTP 200 and creates ephemeral namespace build-<shortid>", async () => {
    const {
      DeployPipeline,
      resetAllocatedNodePortsForTesting
    } = await import("../lib/deploy/deployPipeline.js");

    resetAllocatedNodePortsForTesting();

    // Start a real ephemeral local HTTP server to verify HTTP 200 health probe
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Deployed Artifact OK</body></html>");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };

    try {
      const executedCommands: string[] = [];
      const pipeline = new DeployPipeline({
        commandRunner: async (cmd: string) => {
          executedCommands.push(cmd);
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        healthProbeUrlOverride: `http://127.0.0.1:${address.port}/`
      });

      const result = await pipeline.deployBuildTask({
        runId: "run-9f8e7d6c-1234",
        threadId: "thread-deploy-1",
        workspaceDir: "/tmp/workspace-app",
        appName: "weather-dashboard"
      });

      assert.equal(result.status, "succeeded");
      assert.equal(result.namespace, "build-9f8e7d6c", "Must create ephemeral namespace build-<shortid>");
      assert.ok(result.nodePort >= 30100 && result.nodePort <= 32767, "Must allocate valid NodePort");
      assert.ok(result.deployedUrl.includes(String(result.nodePort)), "Deployed URL must include allocated port");
      assert.equal(result.healthStatus, 200, "Health probe must return HTTP 200");
      assert.ok(
        result.threadMessageMarkdown.includes(`[${result.deployedUrl}](${result.deployedUrl})`),
        "Thread message must contain a clickable Markdown link to the deployed URL"
      );

      // Verify all pipeline stages ran in order
      assert.deepEqual(
        result.stages.map((s) => s.name),
        [
          "build_image",
          "create_namespace",
          "allocate_port",
          "apply_manifests",
          "rollout_wait",
          "health_check",
          "report_link"
        ]
      );
      assert.ok(result.stages.every((s) => s.status === "completed"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("Multiple concurrent builds allocate distinct NodePorts and never collide", async () => {
    const {
      DeployPipeline,
      resetAllocatedNodePortsForTesting
    } = await import("../lib/deploy/deployPipeline.js");

    resetAllocatedNodePortsForTesting();

    const pipeline = new DeployPipeline({
      commandRunner: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      healthChecker: async () => ({ status: 200, ok: true })
    });

    const [res1, res2, res3] = await Promise.all([
      pipeline.deployBuildTask({
        runId: "run-aaaa1111",
        threadId: "thread-1",
        workspaceDir: "/tmp/w1",
        appName: "app-1"
      }),
      pipeline.deployBuildTask({
        runId: "run-bbbb2222",
        threadId: "thread-2",
        workspaceDir: "/tmp/w2",
        appName: "app-2"
      }),
      pipeline.deployBuildTask({
        runId: "run-cccc3333",
        threadId: "thread-3",
        workspaceDir: "/tmp/w3",
        appName: "app-3"
      })
    ]);

    const ports = new Set([res1.nodePort, res2.nodePort, res3.nodePort]);
    assert.equal(ports.size, 3, "All 3 concurrent builds must receive unique NodePorts without collision");
    assert.notEqual(res1.namespace, res2.namespace);
    assert.notEqual(res2.namespace, res3.namespace);
  });

  it("Failed rollouts report the error in the thread (no silent hangs)", async () => {
    const {
      DeployPipeline,
      resetAllocatedNodePortsForTesting
    } = await import("../lib/deploy/deployPipeline.js");

    resetAllocatedNodePortsForTesting();

    const pipeline = new DeployPipeline({
      commandRunner: async (cmd: string) => {
        if (cmd.includes("rollout status")) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "error: deployment \"app-crash\" exceeded its progress deadline (CrashLoopBackOff)"
          };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      healthChecker: async () => ({ status: 503, ok: false })
    });

    const result = await pipeline.deployBuildTask({
      runId: "run-fail9999",
      threadId: "thread-fail",
      workspaceDir: "/tmp/w-fail",
      appName: "app-crash"
    });

    assert.equal(result.status, "failed", "Failed rollout must mark deploy result as failed");
    assert.ok(
      result.error?.includes("CrashLoopBackOff"),
      "Error details must capture the rollout failure reason"
    );
    assert.ok(
      result.threadMessageMarkdown.includes("CrashLoopBackOff"),
      "Thread message must report the rollout failure clearly in the thread"
    );
  });

  it("Fix 2.4 & 2.8: command sequence imports image to containerd and cleans up ephemeral namespace on completion", async () => {
    const {
      DeployPipeline,
      resetAllocatedNodePortsForTesting
    } = await import("../lib/deploy/deployPipeline.js");

    resetAllocatedNodePortsForTesting();

    const executedCommands: string[] = [];
    const pipeline = new DeployPipeline({
      commandRunner: async (cmd: string) => {
        executedCommands.push(cmd);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      healthChecker: async () => ({ status: 200, ok: true })
    });

    const result = await pipeline.deployBuildTask({
      runId: "run-import-clean-1234",
      threadId: "thread-import",
      workspaceDir: "/tmp/w-import",
      appName: "app-import"
    });

    assert.equal(result.status, "succeeded");

    const buildIdx = executedCommands.findIndex((cmd) => cmd.includes("docker build"));
    const importIdx = executedCommands.findIndex((cmd) => cmd.includes("images import") || cmd.includes("ctr"));
    assert.ok(buildIdx !== -1, "docker build must be executed");
    assert.ok(importIdx !== -1, "ctr images import command must be executed");
    assert.ok(importIdx > buildIdx, "ctr images import must run after docker build");

    const deleteNsCmd = executedCommands.find((cmd) => cmd.includes(`kubectl delete namespace ${result.namespace}`));
    assert.ok(deleteNsCmd, "Ephemeral namespace must be cleaned up");
  });

  it("Fix 2.7: queries live cluster NodePorts to prevent port collisions on pod restart", async () => {
    const {
      DeployPipeline,
      resetAllocatedNodePortsForTesting
    } = await import("../lib/deploy/deployPipeline.js");

    resetAllocatedNodePortsForTesting();

    const pipeline = new DeployPipeline({
      commandRunner: async (cmd: string) => {
        if (cmd.includes("kubectl get svc --all-namespaces")) {
          return { exitCode: 0, stdout: "30100\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      healthChecker: async () => ({ status: 200, ok: true })
    });

    const result = await pipeline.deployBuildTask({
      runId: "run-port-sync-1111",
      threadId: "thread-port-sync",
      workspaceDir: "/tmp/w-port",
      appName: "app-port"
    });

    assert.equal(result.status, "succeeded");
    assert.notEqual(result.nodePort, 30100, "Must not allocate 30100 when already in use by cluster");
  });
});
