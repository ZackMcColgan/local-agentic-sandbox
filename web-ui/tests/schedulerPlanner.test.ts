import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UnattendedScheduler } from "../lib/subagents/scheduler";

describe("B-8: Scheduler.executeScheduledRun uses generatePlanSpec", () => {
  it("obtains its manifest milestones from the planner instead of hand-building a single M1", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b8-sched-"));
    try {
      const scheduler = new UnattendedScheduler({ workspaceDir: tmpDir });
      const sched = {
        id: "sched-1",
        cronExpression: "0 2 * * *",
        taskDescription: "Audit and refactor auth module",
        enabled: true,
        createdAt: new Date().toISOString(),
        nextRun: new Date().toISOString(),
      };
      scheduler.saveSchedules([sched]);

      let plannerCalled = false;
      let capturedGoal = "";
      const manifest = await scheduler.executeScheduledRun(sched.id, {
        planGenerator: async (input: { goal: string }) => {
          plannerCalled = true;
          capturedGoal = input.goal;
          return {
            taskId: "planned-task-123",
            goal: input.goal,
            toolchain: "node:22",
            milestones: [
              {
                id: "M-PLAN-1",
                title: "Analyze auth",
                description: "Read auth files",
                acceptanceCriteria: [{ id: "AC-1", assertion: "Auth analyzed" }],
                status: "pending",
                builderIterations: 0,
                criticRounds: 0,
              },
              {
                id: "M-PLAN-2",
                title: "Refactor auth",
                description: "Apply refactor",
                acceptanceCriteria: [{ id: "AC-2", assertion: "Tests pass" }],
                status: "pending",
                builderIterations: 0,
                criticRounds: 0,
              },
            ],
          };
        },
        runner: async (m: Record<string, unknown>) => ({ ...m, status: "completed" }),
      } as unknown as Parameters<typeof scheduler.executeScheduledRun>[1]);

      assert.strictEqual(plannerCalled, true, "Planner must be called by executeScheduledRun");
      assert.strictEqual(capturedGoal, "Audit and refactor auth module");
      assert.ok(manifest, "Manifest must be returned");
      assert.strictEqual(manifest.milestones.length, 2);
      assert.strictEqual(manifest.milestones[0].id, "M-PLAN-1");
      assert.strictEqual(manifest.milestones[1].id, "M-PLAN-2");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
