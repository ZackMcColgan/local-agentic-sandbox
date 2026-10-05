import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  createExplorerWorker,
  createBuilderWorker,
  createCriticWorker,
  createRecorderWorker,
  WorkerPool
} from "../lib/subagents/workerPool.js";
import { Milestone } from "../lib/subagents/types.js";

describe("Phase 1 — Worker Pool & Specialized Subagents Suite", () => {
  it("enforces scoped tool access for Explorer (read-only inventory only)", () => {
    const explorer = createExplorerWorker();
    assert.equal(explorer.role, "explorer");
    const tools = explorer.getScopedToolNames();

    assert.ok(tools.includes("workspace_get_tree"), "Must have workspace_get_tree");
    assert.ok(tools.includes("workspace_grep"), "Must have workspace_grep");
    assert.ok(tools.includes("workspace_read_file"), "Must have workspace_read_file");

    // Must NOT have modification tools
    assert.equal(tools.includes("workspace_write_file"), false, "Explorer must not have write tool");
    assert.equal(tools.includes("workspace_run_command"), false, "Explorer must not have run tool");
    assert.equal(tools.includes("git_commit"), false, "Explorer must not have git commit tool");
  });

  it("enforces scoped tool access for Builder and bounds iterations to <= 5", () => {
    const builder = createBuilderWorker();
    assert.equal(builder.role, "builder");
    const tools = builder.getScopedToolNames();

    assert.ok(tools.includes("workspace_write_file"), "Builder must have write tool");
    assert.ok(tools.includes("workspace_run_command"), "Builder must have run command tool");
    assert.ok(tools.includes("git_diff"), "Builder must have git diff tool");
    assert.ok(tools.includes("git_commit"), "Builder must have git commit tool");
    assert.equal(builder.maxIterations, 5, "Builder max iterations must be capped at 5");
  });

  it("Critic independently grades builder diff and rejects discrepancies against criteria", async () => {
    const critic = createCriticWorker();
    assert.equal(critic.role, "critic");

    const milestone: Milestone = {
      id: "M1",
      title: "Diagram Container Boundary",
      description: "Ensure browser-mcp network is egress-mesh",
      acceptanceCriteria: [
        {
          id: "AC-1",
          assertion: "browser-mcp must be on egress-mesh network"
        }
      ],
      status: "in_progress",
      builderIterations: 1,
      criticRounds: 0,
      diffSummary: "+ browser-mcp: network = ai-mesh" // Intentional seeded discrepancy
    };

    const review = await critic.evaluateMilestoneDiff(milestone, {
      diff: "+ browser-mcp: network = ai-mesh",
      filesChanged: ["docker-compose.yml"]
    });

    assert.equal(review.approved, false, "Critic must reject seeded discrepancy");
    assert.ok(review.feedback.length > 0, "Critic must provide explanatory feedback notes");
    assert.ok(review.feedback.some(f => f.includes("egress-mesh") || f.includes("network")), "Feedback must point out criteria discrepancy");
  });

  it("Critic approves matching diff without self-grading homework", async () => {
    const critic = createCriticWorker();
    const milestone: Milestone = {
      id: "M2",
      title: "Valid White Background",
      description: "Ensure draw.io has background=#ffffff",
      acceptanceCriteria: [
        {
          id: "AC-2",
          assertion: "background must be #ffffff"
        }
      ],
      status: "in_progress",
      builderIterations: 1,
      criticRounds: 0,
      diffSummary: "+ background=\"#ffffff\""
    };

    const conformingDiff = `--- a/docs/architecture.drawio\n+++ b/docs/architecture.drawio\n@@ -1,3 +1,3 @@\n-<mxGraphModel background="#000000">\n+<mxGraphModel background="#ffffff">`;
    const review = await critic.evaluateMilestoneDiff(milestone, {
      diff: conformingDiff,
      filesChanged: ["docs/architecture.drawio"]
    });
    assert.equal(review.approved, true, "Critic must approve conforming diff");
  });

  it("Recorder promotion gate: extracts skill for >= 2 iterations, ignores trivial 1-iteration fixes", async () => {
    const tempSkillsDir = path.resolve(process.cwd(), "temp-test-skills");
    if (!fs.existsSync(tempSkillsDir)) fs.mkdirSync(tempSkillsDir, { recursive: true });

    try {
      const recorder = createRecorderWorker({ skillsDirectory: tempSkillsDir });

      // Case 1: Trivial 1-iteration fix without flag -> MUST NOT record
      const trivialMilestone: Milestone = {
        id: "M-triv",
        title: "Fix typo in comment",
        description: "Simple single iteration fix",
        acceptanceCriteria: [{ id: "AC-1", assertion: "Typo fixed" }],
        status: "completed",
        builderIterations: 1,
        criticRounds: 0
      };

      const result1 = await recorder.evaluateAndRecordSkill(trivialMilestone, {
        lesson: "Fixed spelling in comment",
        nonTrivialFlag: false
      });
      assert.equal(result1.promoted, false, "1-iteration trivial fix must NOT be promoted to skills");

      // Case 2: Multi-iteration (>= 2) fix -> MUST record to skills
      const nonTrivialMilestone: Milestone = {
        id: "M-deep",
        title: "Recover from SVG black polygon clipping",
        description: "Path without fill=none caused polygon artifact; solved by adding fill=none and gutter route",
        acceptanceCriteria: [{ id: "AC-2", assertion: "Diagram renders cleanly" }],
        status: "completed",
        builderIterations: 3,
        criticRounds: 1
      };

      const result2 = await recorder.evaluateAndRecordSkill(nonTrivialMilestone, {
        lesson: "Always declare fill='none' on SVG path connectors to prevent default black polygon fills",
        nonTrivialFlag: true
      });
      assert.equal(result2.promoted, true, "Multi-iteration fix must be promoted to skills");
      assert.ok(result2.skillFilePath, "Skill file path must be returned");
      assert.ok(fs.existsSync(result2.skillFilePath), "Skill file must exist on disk");

      const fileContent = fs.readFileSync(result2.skillFilePath, "utf8");
      assert.ok(fileContent.includes("fill='none'"), "Skill content must record the learned pattern");
    } finally {
      if (fs.existsSync(tempSkillsDir)) {
        fs.rmSync(tempSkillsDir, { recursive: true, force: true });
      }
    }
  });

  it("Cancellation token immediately halts worker and cleans up execution", async () => {
    const pool = new WorkerPool({
      maxConcurrency: 2,
      modelRoster: {
        planner: "swift-27b-mtp",
        builder: "swift-27b-mtp",
        critic: "swift-27b-mtp"
      }
    });

    const abortController = new AbortController();
    const workerPromise = pool.executeJob({
      role: "builder",
      taskId: "task-cancel-test",
      abortSignal: abortController.signal,
      taskFn: async (signal) => {
        // Simulate long-running inference work
        for (let i = 0; i < 50; i++) {
          if (signal.aborted) throw new Error("Worker execution aborted");
          await new Promise((r) => setTimeout(r, 50));
        }
        return "finished";
      }
    });

    // Cancel after 60ms
    setTimeout(() => {
      abortController.abort();
    }, 60);

    await assert.rejects(
      workerPromise,
      /aborted/i,
      "Worker must reject with abort error upon receiving cancellation token"
    );

    assert.equal(pool.getActiveWorkerCount(), 0, "Active worker count must return to 0 (idle) immediately");
  });
});
