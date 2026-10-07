import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OvernightSupervisor } from "../lib/subagents/supervisor";
import { TaskManifest, Milestone } from "../lib/subagents/types";

describe("Task Completion — End-to-End Autonomous Lifecycle", () => {
  it("reaches 'completed' end-to-end with completedAt set and artifacts retrievable", async () => {
    const supervisor = new OvernightSupervisor();

    const milestones: Milestone[] = [
      {
        id: "M1",
        title: "Implement core CSV parsing algorithm",
        dependencies: [],
        acceptanceCriteria: [{ id: "c1", assertion: "parseCsv function handles quoted commas" }],
        status: "pending"
      },
      {
        id: "M2",
        title: "Implement streaming buffer support for large CSVs",
        dependencies: ["M1"],
        acceptanceCriteria: [{ id: "c2", assertion: "createCsvStream processes chunks" }],
        status: "pending"
      }
    ];

    const manifest: TaskManifest = {
      taskId: `task-e2e-complete-${Date.now()}`,
      goal: "Build a robust CSV parsing and streaming utility",
      toolchain: "node:22",
      status: "active",
      currentMilestoneIndex: 0,
      milestones,
      checkpoints: [],
      ambiguityFlags: [],
      journal: []
    };

    supervisor.saveCheckpoint(manifest);

    // Mock planner/builder/critic execution: all milestones succeed
    const mockStepExecutor = async (milestone: Milestone, attempt: number) => {
      const sha = `sha-${milestone.id}-${Date.now().toString(36)}`;
      const diff = `+ export function ${milestone.id}() { return true; }`;
      return {
        status: "completed" as const,
        gitSha: sha,
        diff,
        builderIterations: 1,
        criticRounds: 1,
        builderModel: "swift-27b-mtp"
      };
    };

    const completedTask = await supervisor.executeTaskWithRecovery(manifest, { stepExecutor: mockStepExecutor });

    // 1. Assert task status transitions to completed
    assert.equal(completedTask.status, "completed", "Task status must transition to 'completed'");

    // 2. Assert completedAt timestamp is set
    assert.ok(completedTask.completedAt, "completedAt timestamp must be defined");
    assert.ok(!isNaN(Date.parse(completedTask.completedAt)), "completedAt must be a valid ISO date string");

    // 3. Assert all milestones are completed with valid commits and diffs
    assert.equal(completedTask.milestones.length, 2);
    for (const m of completedTask.milestones) {
      assert.equal(m.status, "completed");
      assert.ok(m.commitSha && m.commitSha.startsWith(`sha-${m.id}`), `Milestone ${m.id} commit SHA missing`);
      assert.ok(m.diffSummary && m.diffSummary.includes(`export function ${m.id}`), `Milestone ${m.id} diff missing`);
      assert.ok(m.completedAt, `Milestone ${m.id} completedAt missing`);
    }

    // 4. Assert final outputs/artifacts are retrievable from the supervisor checkpoint
    const reloaded = await supervisor.resumeTaskFromCheckpoint(manifest.taskId);
    assert.ok(reloaded !== null, "Persisted checkpoint must be retrievable");
    assert.equal(reloaded.status, "completed");
    assert.equal(reloaded.currentMilestoneIndex, 2);
    assert.equal(reloaded.milestones[0].commitSha, completedTask.milestones[0].commitSha);
    assert.equal(reloaded.milestones[1].commitSha, completedTask.milestones[1].commitSha);
  });
});
