import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  createProductionStepExecutor,
  Supervisor
} from "../lib/subagents/supervisor";
import {
  formatTestFailureForBuilder,
  extractFailingTestFromCiLog
} from "../lib/ci/workerCiFeedback";
import type { Milestone, TaskManifest } from "../lib/subagents/types";

describe("Sprint A2 — Wire Production Acceptance Test Runner & Self-Healing Retries", () => {
  const savedEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...savedEnv };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-runner-"));
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("Task 1: Default testRunner in createProductionStepExecutor", () => {
    it("executes acceptance criteria commands using sandbox tier runner when testRunner option is omitted", async () => {
      const mockMilestone: Milestone = {
        id: "M1",
        title: "Test milestone with executable acceptance criteria",
        description: "Run verification script",
        status: "in_progress",
        plannedFiles: ["output.txt"],
        acceptanceCriteria: [
          {
            id: "AC-1",
            assertion: "output.txt must exist",
            command: 'node -e "console.log(\'test-ok\')"'
          }
        ]
      };

      const mockBuilder = {
        executeMilestoneWork: async () => ({
          diff: "+ test-ok",
          gitSha: "abcd1234abcd1234abcd1234abcd1234abcd1234",
          targetFile: "output.txt",
          iterations: 1,
          synthetic: false
        })
      };

      const mockCritic = {
        evaluateMilestoneDiff: async () => ({
          approved: true,
          feedback: []
        })
      };

      const mockPool = {
        executeJob: async (job: any) => {
          if (job.role === "builder") return mockBuilder.executeMilestoneWork();
          if (job.role === "critic") return mockCritic.evaluateMilestoneDiff();
          return {};
        },
        getModelForRole: () => "swift-15-27b-mtp",
        keepAliveFor: () => -1,
        generate: async () => ({ text: "ok", model: "swift-15-27b-mtp", loadDurationMs: 0 })
      };

      // Call without options.testRunner
      const executor = createProductionStepExecutor({
        workerPool: mockPool as any,
        repoRoot: tmpDir,
        maxIterationsPerMilestone: 1
      });

      const outcome = await executor(mockMilestone, 1);

      assert.equal(outcome.status, "completed");
      assert.equal(mockMilestone.testsPassed, 1, "Default testRunner should record 1 test passed");
      assert.equal(mockMilestone.testsFailed, 0, "Default testRunner should record 0 tests failed");
    });
  });

  describe("Task 2: Feed failing test stdout/stderr into builder self-healing retries", () => {
    it("formatTestFailureForBuilder formats command, exit code, and truncates output to last 4000 chars", () => {
      const longOutput = "a".repeat(6000) + "\nAssertionError: expected false to be true";
      const formatted = formatTestFailureForBuilder("npm test", 1, longOutput);

      assert.ok(formatted.includes("Acceptance test command failed (exit code 1)"));
      assert.ok(formatted.includes("$ npm test"));
      assert.ok(formatted.includes("AssertionError: expected false to be true"));
      assert.ok(formatted.length <= 4500, "Must truncate output to last 4000 characters");
      assert.ok(!formatted.startsWith("a".repeat(3000)), "Must preserve the end of the log, not the beginning");
    });

    it("injects formatted failure into milestone.lastError when testExitCode !== 0", async () => {
      const mockMilestone: Milestone = {
        id: "M1",
        title: "Milestone that fails acceptance test",
        description: "Run failing test",
        status: "in_progress",
        plannedFiles: ["failing.ts"],
        acceptanceCriteria: [
          {
            id: "AC-FAIL",
            assertion: "Must pass strict assertion",
            command: 'node -e "process.exit(1)"'
          }
        ]
      };

      let criticReceivedFeedback: string[] = [];
      const mockPool = {
        executeJob: async (job: any) => {
          if (job.role === "builder") {
            return {
              diff: "+ const x = 0;",
              gitSha: "1111222233334444555566667777888899990000",
              targetFile: "failing.ts",
              iterations: 1,
              synthetic: false
            };
          }
          if (job.role === "critic") {
            return {
              approved: false,
              feedback: ["Tests failed"]
            };
          }
          return {};
        },
        getModelForRole: () => "swift-15-27b-mtp",
        keepAliveFor: () => -1,
        generate: async () => ({ text: "ok", model: "swift-15-27b-mtp", loadDurationMs: 0 })
      };

      const executor = createProductionStepExecutor({
        workerPool: mockPool as any,
        repoRoot: tmpDir,
        maxIterationsPerMilestone: 1
      });

      const outcome = await executor(mockMilestone, 1);

      assert.ok(mockMilestone.lastError, "milestone.lastError must be populated with test failure details");
      assert.ok(
        mockMilestone.lastError.includes("Acceptance test command failed") ||
        mockMilestone.lastError.includes("exit"),
        "milestone.lastError must contain formatted failure"
      );
    });
  });

  describe("Task 3: Deliverables attachment on task completion in threads route", () => {
    it("threads/route.ts does not contain hardcoded weather.svg fallback", () => {
      const threadsRoutePath = fs.existsSync(path.resolve(process.cwd(), "web-ui/app/api/threads/route.ts"))
        ? path.resolve(process.cwd(), "web-ui/app/api/threads/route.ts")
        : path.resolve(process.cwd(), "app/api/threads/route.ts");
      const content = fs.readFileSync(threadsRoutePath, "utf8");

      assert.ok(
        !content.includes('|| "weather.svg"'),
        "threads/route.ts must not have hardcoded 'weather.svg' fallback"
      );
      assert.ok(
        content.includes("allFiles") || content.includes("deliverables"),
        "threads/route.ts must collect deliverables across completed milestones"
      );
    });
  });

  describe("Task 4: POST /api/tasks triggers executeTaskWithRecovery", () => {
    it("tasks/route.ts triggers asynchronous executeTaskWithRecovery when autoExecute !== false", () => {
      const tasksRoutePath = fs.existsSync(path.resolve(process.cwd(), "web-ui/app/api/tasks/route.ts"))
        ? path.resolve(process.cwd(), "web-ui/app/api/tasks/route.ts")
        : path.resolve(process.cwd(), "app/api/tasks/route.ts");
      const content = fs.readFileSync(tasksRoutePath, "utf8");

      assert.ok(
        content.includes("executeTaskWithRecovery"),
        "tasks/route.ts must call executeTaskWithRecovery"
      );
      assert.ok(
        content.includes("autoExecute !== false"),
        "tasks/route.ts must support autoExecute option defaulting to true"
      );
    });
  });
});
