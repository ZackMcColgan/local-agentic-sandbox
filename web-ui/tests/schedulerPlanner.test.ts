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

  it("R7: executeScheduledRun re-reads schedules.json before saving so mid-run edits are preserved", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r7-sched-rmw-"));
    try {
      const scheduler = new UnattendedScheduler({ workspaceDir: tmpDir });
      const sched = {
        id: "sched-rmw-1",
        cronExpression: "0 2 * * *",
        taskDescription: "Initial description",
        enabled: true,
        createdAt: new Date().toISOString(),
        nextRun: new Date().toISOString(),
      };
      scheduler.saveSchedules([sched]);

      await scheduler.executeScheduledRun(sched.id, {
        planGenerator: async (input: { goal: string }) => ({
          taskId: "rmw-task-1",
          goal: input.goal,
          toolchain: "node:22",
          milestones: [
            {
              id: "M1",
              title: "Step 1",
              description: "Step 1",
              acceptanceCriteria: [],
              status: "pending",
              builderIterations: 0,
              criticRounds: 0,
            },
          ],
        }),
        runner: async (m: Record<string, unknown>) => {
          // Mid-run external edit: update taskDescription of sched-rmw-1 and add sched-rmw-2
          const current = scheduler.loadSchedules();
          current[0].taskDescription = "Updated mid-run description";
          current.push({
            id: "sched-rmw-2",
            cronExpression: "0 4 * * *",
            taskDescription: "Added mid-run",
            enabled: true,
            createdAt: new Date().toISOString(),
            nextRun: new Date().toISOString(),
          });
          scheduler.saveSchedules(current);
          return { ...m, status: "completed" };
        },
      } as unknown as Parameters<typeof scheduler.executeScheduledRun>[1]);

      const after = scheduler.loadSchedules();
      assert.equal(after.length, 2, "mid-run added schedule must be preserved");
      assert.equal(after[0].taskDescription, "Updated mid-run description");
      assert.ok(after[0].lastRun, "lastRun must still be updated");
      assert.equal(after[1].id, "sched-rmw-2");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
