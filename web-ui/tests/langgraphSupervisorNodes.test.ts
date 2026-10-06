import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  createOvernightGraph,
  FileCheckpointSaver,
  getRealGitSha
} from '../lib/subagents/supervisor';
import { WorkerPool } from '../lib/subagents/workerPool';
import { Milestone } from '../lib/subagents/types';
import {
  checkOllama,
  enableOllamaMock,
  disableOllamaMock,
  logServiceMode
} from './helpers/serviceMocks.js';

process.env.FAST_GRAPH_TEST = "1";

test('Fix 1 — LangGraph Real Nodes & File-Backed Checkpointing Suite', async (t) => {
  const useRealOllama = await checkOllama();
  logServiceMode('ollama', useRealOllama);
  if (!useRealOllama) enableOllamaMock();

  const testCheckpointDir = path.resolve(process.cwd(), '.tmp-lg-nodes-test');
  if (!fs.existsSync(testCheckpointDir)) {
    fs.mkdirSync(testCheckpointDir, { recursive: true });
  }

  t.after(() => {
    if (!useRealOllama) disableOllamaMock();
    try {
      fs.rmSync(testCheckpointDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test('executes multi-milestone graph to completion and asserts all commit SHAs resolve via git log', async () => {
    const checkpointer = new FileCheckpointSaver(testCheckpointDir);
    const workerPool = new WorkerPool();
    const taskId = `lg-task-multi-${Date.now()}`;

    const graph = createOvernightGraph({
      checkpointer,
      workerPool
    });
    const app = graph.compile({ checkpointer });

    const executedSteps: string[] = [];
    const stream = await app.stream(
      {
        taskId,
        goal: 'Build synthetic microservices topology with 3 milestones',
        toolchain: 'node:22',
        status: 'queued',
        currentMilestoneIndex: 0,
        milestones: [],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        nodeHistory: []
      },
      { configurable: { thread_id: taskId } }
    );

    for await (const chunk of stream) {
      const stepName = Object.keys(chunk)[0];
      executedSteps.push(stepName);
    }

    // 1. Assert multi-milestone execution ran through planner, explorer, and multiple builder/critic/recorder cycles
    assert.ok(executedSteps.includes('planner'));
    assert.ok(executedSteps.includes('explorer'));
    assert.ok(executedSteps.filter((s) => s === 'builder').length >= 3, 'Builder must run for each milestone');
    assert.ok(executedSteps.filter((s) => s === 'critic').length >= 3, 'Critic must evaluate each milestone');
    assert.ok(executedSteps.filter((s) => s === 'recorder').length >= 3, 'Recorder must process each milestone');

    // 2. Assert final state has all milestones completed
    const finalState = await app.getState({ configurable: { thread_id: taskId } });
    assert.strictEqual(finalState.values.status, 'completed');
    assert.ok(finalState.values.milestones.length >= 3, 'Task must contain >= 3 milestones');
    for (const m of finalState.values.milestones) {
      assert.strictEqual(m.status, 'completed', `Milestone ${m.id} must be completed`);
      assert.ok(m.commitSha, `Milestone ${m.id} must have a commit SHA`);

      // 3. Assert every SHA appearing in checkpoints resolves via git log (no synthesized SHAs)
      const resolvedSha = execSync(`git rev-parse --verify ${m.commitSha}`, {
        encoding: 'utf8'
      }).trim();
      assert.strictEqual(resolvedSha, m.commitSha, 'Commit SHA must resolve via git rev-parse');

      const logOutput = execSync(`git log -n 1 --format=%H ${m.commitSha}`, {
        encoding: 'utf8'
      }).trim();
      assert.strictEqual(logOutput, m.commitSha, 'Commit SHA must be found in git log history');
    }

    // 4. Assert disk checkpoint was written by LangGraph checkpointer
    const checkpointFile = checkpointer.getFilePath(taskId);
    assert(fs.existsSync(checkpointFile), `Expected ${checkpointFile} on disk`);
  });

  await t.test('critic rejects a genuinely flawed diff, builder retries, and retry is observable in state', async () => {
    const checkpointer = new FileCheckpointSaver(testCheckpointDir);
    const workerPool = new WorkerPool();
    const taskId = `lg-task-critic-retry-${Date.now()}`;

    // Define a single-milestone task with a strict criterion requiring egress-mesh
    const strictMilestone: Milestone = {
      id: 'M1',
      title: 'Network Egress Isolation',
      description: 'Ensure scraper is strictly bound to egress-mesh',
      status: 'pending',
      builderIterations: 0,
      criticRounds: 0,
      forcedFlaw: true,
      acceptanceCriteria: [
        {
          id: 'AC-NET-1',
          assertion: 'Diagram models browser-mcp attached to egress-mesh for web scraping'
        }
      ]
    };

    const graph = createOvernightGraph({
      checkpointer,
      workerPool
    });
    const app = graph.compile({ checkpointer });

    const stepTrail: string[] = [];
    const stream = await app.stream(
      {
        taskId,
        goal: 'Verify Network Egress Isolation',
        toolchain: 'node:22',
        status: 'queued',
        currentMilestoneIndex: 0,
        milestones: [strictMilestone],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        nodeHistory: []
      },
      { configurable: { thread_id: taskId } }
    );

    for await (const chunk of stream) {
      const step = Object.keys(chunk)[0];
      stepTrail.push(step);
    }

    // 1. Assert genuine critic rejection and subsequent builder retry occurred in the LangGraph graph
    const builderRuns = stepTrail.filter((s) => s === 'builder').length;
    const criticRuns = stepTrail.filter((s) => s === 'critic').length;
    assert.strictEqual(builderRuns, 2, 'Builder must run twice: initial flawed pass and retry pass');
    assert.strictEqual(criticRuns, 2, 'Critic must run twice: first rejecting, then approving');
    assert.deepStrictEqual(stepTrail, ['planner', 'explorer', 'builder', 'critic', 'builder', 'critic', 'recorder']);

    // 2. Assert retry counts in final state
    const finalState = await app.getState({ configurable: { thread_id: taskId } });
    assert.strictEqual(finalState.values.status, 'completed');
    const m1 = finalState.values.milestones[0];
    assert.strictEqual(m1.status, 'completed');
    assert.strictEqual(m1.builderIterations, 2, 'Milestone must record 2 builder iterations');
    assert.strictEqual(m1.criticRounds, 2, 'Milestone must record 2 critic rounds');
    assert.ok(m1.diffSummary?.includes('egress-mesh'), 'Final diff must contain egress-mesh fix applied by builder');

    // 3. Verify git SHA resolution
    const verifiedSha = execSync(`git rev-parse --verify ${m1.commitSha}`, {
      encoding: 'utf8'
    }).trim();
    assert.strictEqual(verifiedSha, m1.commitSha);
  });

  await t.test('kills graph mid-run and resumes through LangGraph checkpointer to completion', async () => {
    const checkpointer1 = new FileCheckpointSaver(testCheckpointDir);
    const workerPool1 = new WorkerPool();
    const taskId = `lg-crash-task-${Date.now()}`;

    const graph1 = createOvernightGraph({
      checkpointer: checkpointer1,
      workerPool: workerPool1
    });
    const app1 = graph1.compile({ checkpointer: checkpointer1 });

    const stepTrail1: string[] = [];
    const stream1 = await app1.stream(
      {
        taskId,
        goal: 'Build synthetic microservice endpoint',
        toolchain: 'node:22',
        status: 'queued',
        currentMilestoneIndex: 0,
        milestones: [],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        nodeHistory: []
      },
      { configurable: { thread_id: taskId } }
    );

    // Simulate worker crash after explorer node completes
    for await (const chunk of stream1) {
      const step = Object.keys(chunk)[0];
      stepTrail1.push(step);
      if (step === 'explorer') {
        break;
      }
    }

    assert.deepStrictEqual(stepTrail1, ['planner', 'explorer']);

    // Assert checkpoint file was persisted mid-run
    const checkpointFile = checkpointer1.getFilePath(taskId);
    assert(fs.existsSync(checkpointFile), 'Checkpoint file must be written mid-run before crash');

    // Simulate new supervisor process starting up with a fresh checkpointer and graph instance
    const checkpointer2 = new FileCheckpointSaver(testCheckpointDir);
    const workerPool2 = new WorkerPool();
    const graph2 = createOvernightGraph({
      checkpointer: checkpointer2,
      workerPool: workerPool2
    });
    const app2 = graph2.compile({ checkpointer: checkpointer2 });

    // Verify next scheduled node from saved checkpoint is builder
    const stateBeforeResume = await app2.getState({ configurable: { thread_id: taskId } });
    assert.deepStrictEqual(stateBeforeResume.next, ['builder']);

    // Resume execution from checkpoint to completion
    const stepTrail2: string[] = [];
    const stream2 = await app2.stream(null, { configurable: { thread_id: taskId } });
    for await (const chunk of stream2) {
      const step = Object.keys(chunk)[0];
      stepTrail2.push(step);
    }

    assert.ok(stepTrail2.includes('builder'));
    assert.ok(stepTrail2.includes('critic'));
    assert.ok(stepTrail2.includes('recorder'));

    const finalResumedState = await app2.getState({ configurable: { thread_id: taskId } });
    assert.strictEqual(finalResumedState.values.status, 'completed');
  });
});
