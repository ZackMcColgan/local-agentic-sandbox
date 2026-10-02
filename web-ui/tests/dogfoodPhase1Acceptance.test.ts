import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";
import { generatePlanSpec } from "../lib/subagents/planner.js";
import {
  createBuilderWorker,
  createCriticWorker,
  WorkerPool
} from "../lib/subagents/workerPool.js";
import { OvernightSupervisor } from "../lib/subagents/supervisor.js";
import { generateMorningReport, formatMorningReportMarkdown } from "../lib/subagents/morningReport.js";
import { TaskManifest, Milestone } from "../lib/subagents/types.js";
import { generateArchitectureDiagram, discoverRepoState } from "../lib/diagram/architectureGenerator.js";

describe("Phase 1 Acceptance — Dogfood Task Suite", () => {
  const dogfoodGoal = "Build a draw.io architecture diagram of this repo's current state, README-ready";

  it("[1] Planner commits a SPEC.md with >= 3 milestones and explicit acceptance criteria", async () => {
    const plan = await generatePlanSpec({
      taskId: "task-dogfood-drawio",
      goal: dogfoodGoal,
      toolchain: "node:22"
    });

    assert.ok(plan.milestones.length >= 3, "Plan must contain at least 3 milestones");
    for (const m of plan.milestones) {
      assert.ok(m.acceptanceCriteria.length >= 1, `Milestone ${m.id} must have >= 1 acceptance criterion`);
      for (const ac of m.acceptanceCriteria) {
        assert.ok(ac.assertion.length > 0, "Assertion must not be empty");
      }
    }

    const markdown = plan.toMarkdown();
    assert.ok(markdown.includes(`# SPEC: ${dogfoodGoal}`));
    assert.ok(markdown.includes("Acceptance Criteria"));
    assert.ok(markdown.toLowerCase().includes("diagram"));
  });

  it("[2 & 3] Builder produces valid draw.io XML covering all containers, networks, ports, volumes, and trust boundaries", () => {
    const repoRoot = fs.existsSync(path.join(process.cwd(), "deploy")) ? process.cwd() : path.resolve(process.cwd(), "..");
    
    // Discover repo state dynamically from manifests, Dockerfiles, and compose
    const repoSnapshot = discoverRepoState(repoRoot);
    assert.ok(repoSnapshot.k8sManifests.length > 0, "Discovered Kubernetes manifests");
    assert.ok(repoSnapshot.dockerfiles.length > 0, "Discovered Dockerfiles");
    assert.ok(repoSnapshot.discoveredNetworks.includes("ai-mesh"));
    assert.ok(repoSnapshot.discoveredNetworks.includes("egress-mesh"));

    // Builder produces the superset diagram dynamically from discovered state
    const diagramResult = generateArchitectureDiagram(repoRoot);
    const drawioXml = diagramResult.xml;

    // 1. Verify XML Structure, cell count, and byte size (superset requirements)
    assert.ok(drawioXml.includes("<mxfile"));
    assert.ok(drawioXml.includes("<diagram id=\"arch-v2-5\""));
    assert.ok(drawioXml.includes("<mxGraphModel"));
    assert.ok(drawioXml.includes("background=\"#ffffff\""), "Canvas must use crisp white background per UI standards");
    assert.ok(diagramResult.cellCount >= 25, `Must have >= 25 cells (restoring prior version coverage, got ${diagramResult.cellCount})`);
    assert.ok(Buffer.byteLength(drawioXml, "utf8") >= 12000, `Byte size must be >= 12,000 bytes (got ${Buffer.byteLength(drawioXml, "utf8")})`);

    // 2. Verify Client & Ingress Layer restored
    assert.ok(drawioXml.includes("Mobile Phone / Workstation Browser"));
    assert.ok(drawioXml.includes("LAN Reverse Proxy Bridge"));
    assert.ok(drawioXml.includes("Public Internet") && drawioXml.includes("External Docs"));

    // 3. Verify K8s Layer & Containers restored
    assert.ok(drawioXml.includes("KUBERNETES CLUSTER (Namespace: local-agentic-sandbox)"));
    assert.ok(drawioXml.includes("ollama-service (K8s Service)"));
    assert.ok(drawioXml.includes("web-ui Orchestrator Pod"));
    assert.ok(drawioXml.includes("mcp-runner Tool Boundary"));
    assert.ok(drawioXml.includes("browser-mcp Scraper Pod"));
    assert.ok(drawioXml.includes("otel-collector Jaeger Tracing"));
    assert.ok(drawioXml.includes("Two-Tier Build Sandbox") || drawioXml.includes("builder-node:22"));
    assert.ok(drawioXml.includes("qdrant") || drawioXml.includes("Qdrant Vector Memory"));

    // 4. Verify Model annotations restored
    assert.ok(drawioXml.includes("qwen3.8:27b-q3_k_m"));
    assert.ok(drawioXml.includes("gemma4:e4b"));

    // 5. Verify Edges restored
    assert.ok(drawioXml.includes("Inference /api/chat"));
    assert.ok(drawioXml.includes("SSE"));

    // 6. Verify Title Block restored
    assert.ok(drawioXml.includes("local-agentic-sandbox: Autonomous Platform v2 Arch"));

    // 7. Verify networks, ports, volumes, and trust boundaries
    assert.ok(drawioXml.includes("ai-mesh"));
    assert.ok(drawioXml.includes("egress-mesh"));
    assert.ok(drawioXml.includes("11434"));
    assert.ok(drawioXml.includes("8080"));
    assert.ok(drawioXml.includes("8081"));
    assert.ok(drawioXml.includes("3000"));
    assert.ok(drawioXml.includes("16686"));
    assert.ok(drawioXml.includes("workspace-pvc"));
    assert.ok(drawioXml.includes("build-cache-pvc"));
    assert.ok(drawioXml.includes("qdrant-storage"));
    assert.ok(drawioXml.includes("Radeon RX 9070 XT 16GB VRAM ROCm"));
    assert.ok(drawioXml.includes("UID: 10001 (cap_drop: ALL)"));
    assert.ok(drawioXml.includes("read_only rootfs"));
  });

  it("[4] Critic catches >= 1 real discrepancy, rejects with notes, then approves once resolved", async () => {
    const critic = createCriticWorker();

    const sampleMilestone: Milestone = {
      id: "M1",
      title: "Verify Network Egress Isolation",
      description: "Ensure browser-mcp has egress-mesh and ai-mesh is isolated",
      status: "in_progress",
      builderIterations: 1,
      criticRounds: 0,
      acceptanceCriteria: [
        {
          id: "AC-1",
          assertion: "Diagram models browser-mcp attached to egress-mesh for web scraping"
        }
      ]
    };

    // Seed discrepancy: diff only contains ai-mesh without egress-mesh
    const flawedDiff = `
+ <mxCell id="browser-mcp" value="Container: browser-mcp" parent="ai-mesh" />
`;

    const rejection = await critic.evaluateMilestoneDiff(sampleMilestone, {
      diff: flawedDiff,
      filesChanged: ["docs/architecture.drawio"]
    });

    assert.equal(rejection.approved, false, "Critic must reject flawed diff missing egress-mesh");
    assert.ok(rejection.feedback.length >= 1, "Critic must provide feedback on discrepancy");
    assert.ok(rejection.feedback[0].includes("egress-mesh"));

    // Builder fixes discrepancy by including egress-mesh
    const fixedDiff = `
+ <mxCell id="browser-mcp" value="Container: browser-mcp" parent="egress-mesh" />
`;

    const approval = await critic.evaluateMilestoneDiff(sampleMilestone, {
      diff: fixedDiff,
      filesChanged: ["docs/architecture.drawio"]
    });

    assert.equal(approval.approved, true, "Critic must approve corrected diff");
    assert.equal(approval.feedback.length, 0);
  });

  it("[5] Cancellation mid-run immediately returns active workers to 0 and idle", async () => {
    const pool = new WorkerPool();
    const controller = new AbortController();

    let taskCancelled = false;
    const workerPromise = pool.executeJob({
      role: "builder",
      abortSignal: controller.signal,
      taskFn: async (signal) => {
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            taskCancelled = true;
            resolve({ status: "cancelled" });
          });
        });
      }
    });

    assert.equal(pool.getActiveWorkerCount(), 1);

    // Zack hits stop on mobile
    controller.abort();
    await workerPromise;

    assert.equal(taskCancelled, true);
    assert.equal(pool.getActiveWorkerCount(), 0, "Active workers must return to 0 (idle) immediately");
  });

  it("[6] Supervisor kill mid-run resumes from checkpoint and completes", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dogfood-checkpoints-"));

    try {
      const supervisor1 = new OvernightSupervisor({ checkpointDirectory: tempDir });
      const taskId = "dogfood-task-resumption";

      let task: TaskManifest = {
        taskId,
        goal: dogfoodGoal,
        branchName: "feat/v2.5-overnight",
        toolchain: "node:22",
        status: "active",
        milestones: [
          {
            id: "M1",
            title: "Topology Catalog",
            description: "Catalog services",
            acceptanceCriteria: [{ id: "AC1", assertion: "Found 5 services" }],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0
          },
          {
            id: "M2",
            title: "Draw.io Generation",
            description: "Produce diagram",
            acceptanceCriteria: [{ id: "AC2", assertion: "Valid XML" }],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0
          }
        ],
        currentMilestoneIndex: 0,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Milestone 1 finishes, checkpoint saved
      task = await supervisor1.executeSingleMilestone(task, 0, { gitSha: "sha-m1-topology" });
      assert.equal(task.currentMilestoneIndex, 1);
      assert.equal(task.milestones[0].status, "completed");

      // Supervisor process is killed simulated here
      // Fresh supervisor instance starts up
      const supervisor2 = new OvernightSupervisor({ checkpointDirectory: tempDir });
      const resumedTask = await supervisor2.resumeTaskFromCheckpoint(taskId);

      assert.ok(resumedTask !== null);
      assert.equal(resumedTask.currentMilestoneIndex, 1, "Resumed task picks up at milestone 2, not 0");
      assert.equal(resumedTask.milestones[0].status, "completed");

      // Complete milestone 2
      const completedTask = await supervisor2.executeSingleMilestone(resumedTask, 1, { gitSha: "sha-m2-drawio" });
      assert.equal(completedTask.milestones[1].status, "completed");
      assert.equal(completedTask.milestones.every((m) => m.status === "completed"), true);
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("[7] Morning report renders on mobile with commits, test results, and >= 1 flagged ambiguity", () => {
    const report = generateMorningReport({
      taskId: "task-dogfood-drawio",
      goal: dogfoodGoal,
      branch: "feat/v2.5-overnight",
      gitHeadSha: "sha-m2-drawio",
      status: "completed",
      startedAt: "2026-10-02T03:00:00Z",
      completedAt: "2026-10-02T05:30:00Z",
      milestones: [
        {
          id: "M1",
          title: "Topology Catalog",
          status: "completed",
          commitSha: "sha-m1-topol",
          testsPassed: 4,
          testsFailed: 0,
          diffSummary: "Inventoried 5 containers and 2 network bridges"
        },
        {
          id: "M2",
          title: "Draw.io Generation",
          status: "completed",
          commitSha: "sha-m2-drawi",
          testsPassed: 6,
          testsFailed: 0,
          diffSummary: "Created docs/architecture.drawio with pure white background"
        }
      ],
      ambiguityFlags: [
        {
          id: "AMB-1",
          milestoneId: "M2",
          question: "Should draw.io canvas default to pure white (#ffffff) or dark canvas?",
          judgmentCall: "Selected pure white (#ffffff) per Zack's standing UI & visual inspection rule.",
          reasoning: "Rule 2.A specifies Light Mode Purity / white background for diagrams linked to root README.",
          revertAction: {
            type: "git_revert",
            target: "sha-m2-drawi"
          },
          reviewed: false
        }
      ],
      parkedItems: []
    });

    assert.equal(report.status, "completed");
    assert.equal(report.totalTestsPassed, 10);
    assert.equal(report.totalTestsFailed, 0);
    assert.ok(report.ambiguityFlags.length >= 1, "Must contain >= 1 flagged ambiguity");

    const md = formatMorningReportMarkdown(report);
    assert.ok(md.includes("Status: COMPLETED"));
    assert.ok(md.includes("Ambiguity Flags & Judgment Calls (1)"));
    assert.ok(md.includes("AMB-1"));
    assert.ok(md.includes("pure white (#ffffff)"));
  });
});
