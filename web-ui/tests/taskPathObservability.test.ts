import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OvernightSupervisor } from "../lib/subagents/supervisor.js";
import type { TaskManifest } from "../lib/subagents/types.js";
import { runJobMode } from "../../eval/run.mjs";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeTask(overrides: Partial<TaskManifest> = {}): TaskManifest {
  const now = new Date().toISOString();
  return {
    taskId: `task-obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    goal: "Observability test goal",
    status: "active",
    toolchain: "node" as any,
    branchName: "feat/test-obs",
    checkpoints: [],
    ambiguityFlags: [],
    startedAt: now,
    milestones: [
      {
        id: "M1",
        title: "Milestone 1",
        description: "Test milestone",
        status: "pending",
        builderIterations: 0,
        criticRounds: 0,
        plannedFiles: ["artifact.txt"],
        acceptanceCriteria: [],
      },
    ],
    currentMilestoneIndex: 0,
    journal: [],
    updatedAt: now,
    ...overrides,
  };
}

describe("ITEM-1: Task-Path Observability & Lossless Failure Propagation", () => {
  it("1. WorkerGitOps.createAndSwitchBranch error populates BOTH errorSummary and parkedReason", async () => {
    const tmpDir = makeTempDir("obs-gitops-");
    const supervisor = new OvernightSupervisor();
    const task = makeTask({ enableGitOps: true });

    try {
      const result = await supervisor.executeTaskWithRecovery(task, {
        repoRoot: tmpDir,
        gitOps: {
          createAndSwitchBranch: async () => {
            throw new Error("Bootstrap failed: dirty working tree in workspace");
          },
        } as any,
        stepExecutor: async () => ({ status: "completed", summary: "should not run" }),
      });

      assert.equal(result.status, "failed");
      assert.ok(
        result.errorSummary?.includes("Bootstrap failed: dirty working tree in workspace"),
        `Expected errorSummary to include gitops error, got: ${result.errorSummary}`
      );
      assert.ok(
        result.parkedReason?.includes("Bootstrap failed: dirty working tree in workspace"),
        `Expected parkedReason to include gitops error, got: ${result.parkedReason}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("2. Empty milestones: [] fails loudly at executeTaskWithRecovery entry", async () => {
    const tmpDir = makeTempDir("obs-empty-ms-");
    const supervisor = new OvernightSupervisor();
    const task = makeTask({ milestones: [], enableGitOps: false });

    try {
      const result = await supervisor.executeTaskWithRecovery(task, {
        repoRoot: tmpDir,
        stepExecutor: async () => ({ status: "completed", summary: "should not run" }),
      });

      assert.equal(result.status, "failed");
      assert.ok(
        result.errorSummary && /milestone/i.test(result.errorSummary),
        `Expected errorSummary to mention empty milestones, got: ${result.errorSummary}`
      );
      assert.ok(
        result.parkedReason && /milestone/i.test(result.parkedReason),
        `Expected parkedReason to mention empty milestones, got: ${result.parkedReason}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("3. verifyJobCompletion failure sets errorSummary + parkedReason with specific gate reason", async () => {
    const tmpDir = makeTempDir("obs-finish-gate-");
    const supervisor = new OvernightSupervisor();
    const task = makeTask({
      enableGitOps: false,
      currentMilestoneIndex: 1,
      milestones: [
        {
          id: "M1",
          title: "Completed milestone with missing artifact",
          description: "Test",
          status: "completed",
          builderIterations: 1,
          criticRounds: 1,
          plannedFiles: ["missing-artifact.js"],
          acceptanceCriteria: [],
        },
      ],
    });

    try {
      const result = await supervisor.executeTaskWithRecovery(task, {
        repoRoot: tmpDir,
        stepExecutor: async () => ({ status: "completed", summary: "done" }),
      });

      assert.equal(result.status, "failed");
      assert.ok(
        result.errorSummary?.includes("Claimed artifact missing: missing-artifact.js"),
        `Expected errorSummary to include claimed artifact reason, got: ${result.errorSummary}`
      );
      assert.ok(
        result.parkedReason?.includes("Claimed artifact missing: missing-artifact.js"),
        `Expected parkedReason to include claimed artifact reason, got: ${result.parkedReason}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("4. threads/[id]/route.ts launchTaskExecution persists terminal failed status + reason onto thread", async () => {
    const routePath = path.resolve(process.cwd(), "app/api/threads/[id]/route.ts");
    const src = fs.readFileSync(routePath, "utf8");
    // Verify lossless failure propagation in threads/[id]/route.ts:
    // It must not collapse errorSummary into "Task did not reach completion."
    assert.ok(
      src.includes("errorSummary"),
      "threads/[id]/route.ts must propagate result.errorSummary into thread failure reason"
    );
    assert.ok(
      src.includes("currentThread.status =") &&
        src.includes("getThreadStore().saveThread(currentThread)"),
      "threads/[id]/route.ts must persist terminal status and reason onto thread"
    );
  });

  it("5. Boundary log sequence [task:<id>] phase=... emits on start / gitops / step / finish / terminal phases", async () => {
    const tmpDir = makeTempDir("obs-logs-");
    const supervisor = new OvernightSupervisor();
    fs.writeFileSync(path.join(tmpDir, "artifact.txt"), "ok\n", "utf8");
    const task = makeTask({ enableGitOps: true });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => {
      logs.push(args.map(String).join(" "));
      origLog(...args);
    };

    try {
      await supervisor.executeTaskWithRecovery(task, {
        repoRoot: tmpDir,
        gitOps: {
          createAndSwitchBranch: async () => {},
        } as any,
        stepExecutor: async () => ({
          status: "completed",
          summary: "done",
          modifiedFiles: ["artifact.txt"],
        }),
        completionClaims: {
          commits: [],
          files: ["artifact.txt"],
          gatePassed: true,
        },
        verificationAdapters: {
          checkFileExists: () => true,
          checkCommitExists: () => true,
        } as any,
      } as any);

      const prefix = `[task:${task.taskId}] phase=`;
      const phaseLogs = logs.filter((l) => l.includes(prefix));
      for (const phase of ["start", "gitops", "step", "finish", "terminal"]) {
        assert.ok(
          phaseLogs.some((l) => l.includes(`${prefix}${phase}`)),
          `Expected boundary log containing "${prefix}${phase}", got logs:\n${phaseLogs.join("\n")}`
        );
      }
    } finally {
      console.log = origLog;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("6. runJobMode in eval/run.mjs throws a clear error on task status stopped or failed", async () => {
    for (const badStatus of ["failed", "stopped"]) {
      let pollCount = 0;
      const mockFetch = async (url: string) => {
        if (url.endsWith("/api/threads")) {
          return {
            ok: true,
            json: async () => ({ thread: { id: "t-obs-1", status: "running", messages: [] } }),
          };
        }
        pollCount++;
        return {
          ok: true,
          json: async () => ({
            thread: {
              id: "t-obs-1",
              status: badStatus,
              messages: [{ role: "assistant", content: "Task failed: some error" }],
            },
          }),
        };
      };

      await assert.rejects(
        () =>
          runJobMode({
            sandboxUrl: "http://127.0.0.1:3000",
            prompt: "test",
            chunkRounds: 2,
            pollIntervalMs: 1,
            timeoutMs: 5000,
            fetchImpl: mockFetch as any,
          }),
        (err: any) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, new RegExp(badStatus, "i"));
          return true;
        },
        `Expected runJobMode to throw on status=${badStatus}`
      );
      assert.ok(pollCount >= 1);
    }
  });
});
