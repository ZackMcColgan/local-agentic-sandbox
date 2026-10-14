import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import {
  OvernightSupervisor,
  createProductionStepExecutor,
  generateOvernightMorningReport
} from "../lib/subagents/supervisor.js";
import { TaskManifest, Milestone } from "../lib/subagents/types.js";
import { WorkerPool } from "../lib/subagents/workerPool.js";
import { loadPendingQueue } from "../lib/subagents/skillGate.js";

describe("Sprint 8 — Canonical Lifecycle Scenario & Real Test Execution", () => {
  it("executes 2 milestones, pauses after M1, resumes M2 with test failure then success, and records pattern", async () => {
    const tmpGit = fs.mkdtempSync(path.join(os.tmpdir(), "git-lifecycle-test-"));
    const tmpCheckpoints = fs.mkdtempSync(path.join(os.tmpdir(), "chk-lifecycle-test-"));
    const tmpSkills = fs.mkdtempSync(path.join(os.tmpdir(), "skills-lifecycle-test-"));

    const origSkillsDir = process.env.SKILLS_DIR;
    process.env.SKILLS_DIR = tmpSkills;

    try {
      // 1. Initialize isolated git repo
      execSync("git init", { cwd: tmpGit, stdio: "ignore" });
      execSync("git config user.name \"Test Runner\"", { cwd: tmpGit, stdio: "ignore" });
      execSync("git config user.email \"test@runner.local\"", { cwd: tmpGit, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpGit, "README.md"), "# Lifecycle Test Repo\n", "utf8");
      execSync("git add README.md", { cwd: tmpGit, stdio: "ignore" });
      execSync("git commit -m \"Initial commit\"", { cwd: tmpGit, stdio: "ignore" });

      const supervisor = new OvernightSupervisor({
        checkpointDirectory: tmpCheckpoints
      });

      const task: TaskManifest = {
        taskId: "task-canonical-lifecycle-1",
        goal: "Build feature with automated milestone test verification",
        toolchain: "node:22",
        branchName: "feat/lifecycle",
        status: "active",
        currentMilestoneIndex: 0,
        milestones: [
          {
            id: "M1",
            title: "Setup foundation module",
            description: "Create foundation.ts",
            status: "pending",
            builderIterations: 0,
            criticRounds: 0,
            plannedFiles: ["foundation.ts"],
            acceptanceCriteria: []
          },
          {
            id: "M2",
            title: "Implement verified logic with test",
            description: "Create logic.ts and verify via sample.test.ts",
            testFile: "sample.test.ts",
            status: "pending",
            builderIterations: 0,
            criticRounds: 0,
            plannedFiles: ["logic.ts"],
            acceptanceCriteria: []
          }
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      supervisor.saveCheckpoint(task);

      // Track testRunner iterations
      let m2TestIteration = 0;
      const testRunner = async (milestone: Milestone, targetFile: string, repoRoot: string) => {
        if (milestone.id === "M2") {
          m2TestIteration++;
          if (m2TestIteration === 1) {
            return {
              exitCode: 1,
              passed: 0,
              failed: 1,
              output: "FAIL: logic.test.ts assertion failed"
            };
          } else {
            return {
              exitCode: 0,
              passed: 4,
              failed: 0,
              output: "PASS: 4 tests passed"
            };
          }
        }
        return { exitCode: 0, passed: 1, failed: 0, output: "PASS" };
      };

      // Mock workerPool with controlled builder and critic generate responses
      const mockWorkerPool = new WorkerPool({
        scope: "PROJECT",
        generate: async (options: any) => {
          const prompt = options.prompt || "";
          if (prompt.includes("strict, adversarial code review critic") || prompt.includes("Critique:") || prompt.includes("Review the proposed changes")) {
            const body = JSON.stringify({
              approved: true,
              score: 95,
              verdict: "PASS",
              feedback: ["Looks solid"]
            });
            return {
              text: body,
              content: body
            };
          }
          // Builder generation
          const isM1 = prompt.includes("M1") || prompt.includes("foundation.ts");
          if (isM1) {
            fs.writeFileSync(path.join(tmpGit, "foundation.ts"), "export const foundation = true;\n", "utf8");
            const code = "```typescript\n// targetFile: foundation.ts\nexport const foundation = true;\n```";
            return {
              text: code,
              content: code
            };
          } else {
            fs.writeFileSync(path.join(tmpGit, "logic.ts"), `export const logic = ${m2TestIteration};\n`, "utf8");
            const code = `\`\`\`typescript\n// targetFile: logic.ts\nexport const logic = ${m2TestIteration};\n\`\`\``;
            return {
              text: code,
              content: code
            };
          }
        }
      });

      const executor = createProductionStepExecutor({
        workerPool: mockWorkerPool,
        repoRoot: tmpGit,
        testRunner
      });

      // Execute Step 1: M1
      const m1Result = await executor(task.milestones[0], 1);
      assert.equal(m1Result.status, "completed");
      task.milestones[0].status = "completed";
      task.currentMilestoneIndex = 1;
      supervisor.saveCheckpoint(task);

      // Pause task after M1
      supervisor.pauseTask(task, "Test pause after M1");
      assert.equal(task.status, "paused");
      assert.equal(task.milestones[0].status, "completed");
      assert.equal(task.milestones[1].status, "pending");

      // Resume task
      supervisor.resumeTask(task.taskId);
      task.status = "active";
      supervisor.saveCheckpoint(task);

      // Execute Step 2: M2 (which undergoes iteration 1 failing test, then iteration 2 passing test)
      const m2Result = await executor(task.milestones[1], 1);
      assert.equal(m2Result.status, "completed");
      assert.equal(m2Result.builderIterations, 2);
      assert.equal(task.milestones[1].testsPassed, 4);
      assert.equal(task.milestones[1].testsFailed, 0);

      task.milestones[1].status = "completed";
      task.currentMilestoneIndex = 2;
      task.status = "completed";
      task.completedAt = new Date().toISOString();
      supervisor.saveCheckpoint(task);

      // Verify Morning Report output
      const report = generateOvernightMorningReport([task]);
      assert.equal(report.completedCount, 1);
      assert.equal(report.tasks[0].testsPassed, 5);

      // Verify pattern recording
      const gateStore = loadPendingQueue(tmpSkills);
      assert.ok(gateStore.candidates["milestone-M2-multifix"], "Expected candidate pattern recorded for M2 multi-iteration fix");
      assert.equal(gateStore.candidates["milestone-M2-multifix"].occurrences, 1);
    } finally {
      process.env.SKILLS_DIR = origSkillsDir;
      fs.rmSync(tmpGit, { recursive: true, force: true });
      fs.rmSync(tmpCheckpoints, { recursive: true, force: true });
      fs.rmSync(tmpSkills, { recursive: true, force: true });
    }
  });
});
