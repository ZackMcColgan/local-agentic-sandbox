import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { OvernightSupervisor } from '../lib/subagents/supervisor';
import { TaskManifest } from '../lib/subagents/types';

test('Fix 4 — Active Task Rehydration & Refresh Durability Suite', async (t) => {
  const testCheckpointDir = path.resolve(process.cwd(), '.tmp-rehydration-test');
  if (!fs.existsSync(testCheckpointDir)) {
    fs.mkdirSync(testCheckpointDir, { recursive: true });
  }

  const supervisor = new OvernightSupervisor({ checkpointDirectory: testCheckpointDir });

  t.after(() => {
    try {
      fs.rmSync(testCheckpointDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test('returns null when no active run exists in checkpoint directory', async () => {
    const tasks = await supervisor.listAllTasks();
    const active = tasks.find((t) => t.status === 'active') || null;
    assert.strictEqual(active, null);
  });

  await t.test('reconstructs active task, milestone progress, and journal entries across supervisor instances', async () => {
    const taskId = `task-rehydrate-${Date.now()}`;
    const manifest: TaskManifest = {
      taskId,
      goal: 'Autonomous build session mid-run',
      branchName: 'feat/v2.5-overnight',
      branch: 'feat/v2.5-overnight',
      toolchain: 'node:22',
      status: 'active',
      milestones: [
        {
          id: 'm1',
          title: 'Setup initial schemas',
          description: 'Define models',
          status: 'completed',
          builderIterations: 1,
          acceptanceCriteria: [{ id: 'ac1', description: 'types exist', assertion: 'types' }],
          commitSha: 'sha-m1'
        },
        {
          id: 'm2',
          title: 'Implement worker logic',
          description: 'Build logic',
          status: 'active',
          builderIterations: 2,
          acceptanceCriteria: [{ id: 'ac2', description: 'tests pass', assertion: 'pass' }]
        },
        {
          id: 'm3',
          title: 'Add visual dashboard',
          description: 'UI layout',
          status: 'pending',
          builderIterations: 0,
          acceptanceCriteria: [{ id: 'ac3', description: 'ui renders', assertion: 'render' }]
        }
      ],
      currentMilestoneIndex: 1,
      checkpoints: [],
      ambiguityFlags: [],
      journal: [
        {
          timestamp: new Date().toISOString(),
          role: 'planner',
          message: 'Decomposed 3 milestones'
        },
        {
          timestamp: new Date().toISOString(),
          role: 'builder',
          message: 'Working on milestone m2'
        }
      ],
      startedAt: new Date(Date.now() - 60000).toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Save checkpoint to disk
    supervisor.saveCheckpoint(manifest);

    // Simulate page refresh / server restart: instantiate brand new supervisor and rehydrate
    const freshSupervisor = new OvernightSupervisor({ checkpointDirectory: testCheckpointDir });
    const allTasks = await freshSupervisor.listAllTasks();

    assert.strictEqual(allTasks.length, 1);
    const activeTask = allTasks.find((t) => t.status === 'active');
    assert(activeTask !== undefined);
    assert.strictEqual(activeTask.taskId, taskId);
    assert.strictEqual(activeTask.currentMilestoneIndex, 1);
    assert.strictEqual(activeTask.milestones[0].status, 'completed');
    assert.strictEqual(activeTask.milestones[1].status, 'active');
    assert.strictEqual(activeTask.milestones[2].status, 'pending');
    assert.strictEqual(activeTask.journal.length, 2);
    assert(activeTask.journal[1].message.includes('Working on milestone m2'));
  });
});
