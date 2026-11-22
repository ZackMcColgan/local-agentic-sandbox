import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  createOvernightGraph,
  OvernightStateAnnotation,
  FileCheckpointSaver,
} from "../lib/subagents/supervisor";
import { WorkerPool } from "../lib/subagents/workerPool";
import { TelemetryTracer, getTraceSession } from "../lib/telemetry";
import type { Milestone } from "../lib/subagents/types";

describe("overnightGraph characterization", () => {
  const tempDirs: string[] = [];
  let savedFastGraphTest: string | undefined;
  let savedCwd: string;

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function makeTempGraphRepo(prefix: string): string {
    const dir = makeTempDir(prefix);
    fs.mkdirSync(path.join(dir, "deploy"), { recursive: true });
    fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "tmp-graph-repo",
        version: "1.0.0",
        scripts: { test: "node -e \"console.log('1 passing')\"" },
      }),
      "utf8"
    );
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync('git config user.name "Test Runner"', { cwd: dir, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" });
    execSync("git add package.json", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "initial commit"', { cwd: dir, stdio: "ignore" });
    return dir;
  }

  beforeEach(() => {
    savedFastGraphTest = process.env.FAST_GRAPH_TEST;
    savedCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedFastGraphTest === undefined) {
      delete process.env.FAST_GRAPH_TEST;
    } else {
      process.env.FAST_GRAPH_TEST = savedFastGraphTest;
    }
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("OvernightStateAnnotation exposes expected state channels", () => {
    const specKeys = Object.keys(OvernightStateAnnotation.spec);
    for (const key of [
      "taskId",
      "goal",
      "status",
      "toolchain",
      "scope",
      "currentMilestoneIndex",
      "milestones",
      "checkpoints",
      "ambiguityFlags",
      "journal",
      "currentDiff",
      "currentGitSha",
      "iterationCount",
      "criticApproved",
      "criticFeedback",
      "nodeHistory",
      "traceId",
      "supervisorSpanId",
      "plannerSpanId",
      "workerSpanId",
      "criticSpanId",
      "traceparent",
    ]) {
      assert.ok(specKeys.includes(key), `Missing state channel: ${key}`);
    }
  });

  it("executes pre-supplied milestones with parent-linked telemetry spans", async () => {
    process.env.FAST_GRAPH_TEST = "1";
    const repoDir = makeTempGraphRepo("overnight-graph-repo-");
    const chkDir = makeTempDir("overnight-graph-chk-");
    const checkpointer = new FileCheckpointSaver(chkDir);
    const workerPool = new WorkerPool();
    const sessionId = `graph-trace-${Date.now()}`;
    const tracer = new TelemetryTracer(sessionId);

    const presetMilestone: Milestone = {
      id: "M-PRESET",
      title: "Pre-planned artifact",
      description: "Build workspace/lib/m-preset.ts",
      status: "pending",
      plannedFiles: ["workspace/lib/m-preset.ts"],
      builderIterations: 0,
      criticRounds: 0,
      acceptanceCriteria: [{ id: "AC-1", assertion: "File created" }],
    };

    process.chdir(repoDir);
    const graph = createOvernightGraph({ checkpointer, workerPool, tracer });
    const app = graph.compile({ checkpointer });

    const executedSteps: string[] = [];
    const stream = await app.stream(
      {
        taskId: `task-preset-${Date.now()}`,
        goal: "Run pre-supplied milestone",
        toolchain: "node:22",
        status: "queued",
        currentMilestoneIndex: 0,
        milestones: [presetMilestone],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        nodeHistory: [],
      },
      { configurable: { thread_id: sessionId } }
    );

    for await (const chunk of stream) {
      executedSteps.push(Object.keys(chunk)[0]);
    }

    assert.deepEqual(executedSteps, ["planner", "explorer", "builder", "critic", "recorder"]);

    const finalState = await app.getState({ configurable: { thread_id: sessionId } });
    assert.equal(finalState.values.status, "completed");
    assert.equal(finalState.values.milestones.length, 1);
    assert.equal(finalState.values.milestones[0].status, "completed");

    const traceSession = getTraceSession(sessionId);
    assert.ok(traceSession);
    const sup = traceSession.spans.find((s) => s.name === "supervisor.task");
    const plan = traceSession.spans.find((s) => s.name === "supervisor.planner");
    const exp = traceSession.spans.find((s) => s.name === "supervisor.explorer");
    const bld = traceSession.spans.find((s) => s.name === "supervisor.builder");
    const crt = traceSession.spans.find((s) => s.name === "supervisor.critic");
    const rec = traceSession.spans.find((s) => s.name === "supervisor.recorder");
    assert.ok(sup && plan && exp && bld && crt && rec);
    assert.equal(plan.parentSpanId, sup.spanId);
    assert.equal(exp.parentSpanId, plan.spanId);
    assert.equal(bld.parentSpanId, plan.spanId);
    assert.equal(crt.parentSpanId, bld.spanId);
    assert.equal(rec.parentSpanId, crt.spanId);
  });

  it("parks task and marks milestone failed when builder node returns stuck", async () => {
    process.env.FAST_GRAPH_TEST = "1";
    const repoDir = makeTempGraphRepo("overnight-graph-stuck-");
    const chkDir = makeTempDir("overnight-graph-stuck-chk-");
    const checkpointer = new FileCheckpointSaver(chkDir);

    const stubPool = {
      getModelForRole: () => "swift-15-27b-mtp",
      executeJob: async (job: { role: string }) => {
        if (job.role === "explorer") {
          return "workspace summary";
        }
        if (job.role === "builder") {
          return {
            stuck: true,
            diff: "",
            gitSha: "abc",
            iterations: 1,
            errorSignature: "repeated-error",
          };
        }
        return {};
      },
    } as unknown as WorkerPool;

    process.chdir(repoDir);
    const graph = createOvernightGraph({ checkpointer, workerPool: stubPool });
    const app = graph.compile({ checkpointer });

    const threadId = `task-stuck-${Date.now()}`;
    const stream = await app.stream(
      {
        taskId: threadId,
        goal: "Trigger stuck builder handling",
        toolchain: "node:22",
        status: "queued",
        currentMilestoneIndex: 0,
        milestones: [
          {
            id: "M-STUCK",
            title: "Stuck milestone",
            description: "Fails with repeated error",
            status: "pending",
            builderIterations: 0,
            criticRounds: 0,
            acceptanceCriteria: [],
          },
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        nodeHistory: [],
      },
      { configurable: { thread_id: threadId } }
    );

    let builderUpdate:
      | {
          status?: string;
          criticFeedback?: string[];
          milestones?: Milestone[];
          journal?: Array<{ role: string; message: string }>;
        }
      | undefined;

    for await (const chunk of stream) {
      if ("builder" in chunk) {
        builderUpdate = chunk.builder as typeof builderUpdate;
        break;
      }
    }

    assert.ok(builderUpdate, "Expected builder node chunk");
    assert.equal(builderUpdate.status, "parked");
    assert.deepEqual(builderUpdate.criticFeedback, ["Builder stuck"]);
    assert.equal(builderUpdate.milestones?.[0]?.status, "failed");
    assert.ok(
      builderUpdate.journal?.some((j) => j.message === "Builder halted: stuck"),
      "Builder journal must record halted stuck message"
    );
  });
});
