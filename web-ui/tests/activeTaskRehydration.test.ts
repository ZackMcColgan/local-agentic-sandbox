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
          criticRounds: 1,
          acceptanceCriteria: [{ id: 'ac1', assertion: 'types exist' }],
          commitSha: 'sha-m1'
        },
        {
          id: 'm2',
          title: 'Implement worker logic',
          description: 'Build logic',
          status: 'in_progress',
          builderIterations: 2,
          criticRounds: 0,
          acceptanceCriteria: [{ id: 'ac2', assertion: 'tests pass' }]
        },
        {
          id: 'm3',
          title: 'Add visual dashboard',
          description: 'UI layout',
          status: 'pending',
          builderIterations: 0,
          criticRounds: 0,
          acceptanceCriteria: [{ id: 'ac3', assertion: 'ui renders' }]
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
    assert.strictEqual(activeTask.milestones[1].status, 'in_progress');
    assert.strictEqual(activeTask.milestones[2].status, 'pending');
    assert.strictEqual(activeTask.journal.length, 2);
    assert(activeTask.journal[1].message.includes('Working on milestone m2'));
  });

  await t.test('POST /api/tasks releases activeWorkers slot when async execution settles', async () => {
    const tmpWorkspace = path.join(testCheckpointDir, 'ws-settle');
    fs.mkdirSync(tmpWorkspace, { recursive: true });
    const prevEnv = {
      AGENT_CHECKPOINT_DIR: process.env.AGENT_CHECKPOINT_DIR,
      WORKSPACE_DIR: process.env.WORKSPACE_DIR,
      FAST_GRAPH_TEST: process.env.FAST_GRAPH_TEST,
      LLM_BASE_URL: process.env.LLM_BASE_URL,
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
      LLM_ENGINE: process.env.LLM_ENGINE
    };
    process.env.AGENT_CHECKPOINT_DIR = testCheckpointDir;
    process.env.WORKSPACE_DIR = tmpWorkspace;
    process.env.FAST_GRAPH_TEST = '1';
    process.env.LLM_ENGINE = 'ollama';
    process.env.LLM_BASE_URL = 'http://127.0.0.1:1';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1';

    try {
      const tasksRoute = await import('../app/api/tasks/route');
      const { activeExecutionSet } = await import('../lib/threads/threadStore');

      const postReq = new Request('http://localhost:3000/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: 'Write a tiny hello.txt file',
          autoExecute: true
        })
      });
      const postRes = await tasksRoute.POST(postReq);
      assert.strictEqual(postRes.status, 201);
      const created = await postRes.json();
      const taskId: string = created.taskId;
      assert.ok(taskId);

      // Wait for background execution to settle (activeExecutionSet cleared)
      const deadline = Date.now() + 10000;
      while (activeExecutionSet.has(taskId) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.strictEqual(activeExecutionSet.has(taskId), false, 'Background execution should have settled');

      const getReq = new Request(`http://localhost:3000/api/tasks?taskId=${encodeURIComponent(taskId)}`);
      const getRes = await tasksRoute.GET(getReq);
      assert.strictEqual(getRes.status, 200);
      const data = await getRes.json();
      assert.strictEqual(data.activeWorkers, 0, 'Settled task must report activeWorkers: 0');
      assert.strictEqual(supervisor.getAbortController(taskId), undefined, 'Supervisor registry must also release abort controller');
    } finally {
      Object.entries(prevEnv).forEach(([k, v]) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
    }
  });
});
