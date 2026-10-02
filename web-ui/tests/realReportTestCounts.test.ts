import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { generateMorningReport, formatMorningReportMarkdown } from "../lib/subagents/morningReport.js";
import { OvernightSupervisor, getRealGitSha } from "../lib/subagents/supervisor.js";
import { TaskManifest } from "../lib/subagents/types.js";

describe("Fix 2 — Real Test Counts Through Report Path Suite", () => {
  it("grep check: report generation path contains zero hardcoded test counts", () => {
    const tasksRoutePath = path.resolve(process.cwd(), "app/api/tasks/route.ts");
    const routeContent = fs.readFileSync(tasksRoutePath, "utf8");

    // Must not contain hardcoded "m.status === 'completed' ? 2 : 0"
    assert.ok(
      !routeContent.includes('testsPassed: m.status === "completed" ? 2 : 0'),
      "tasks/route.ts must not hardcode testsPassed"
    );
    assert.ok(
      !routeContent.includes("testsPassed: 2"),
      "tasks/route.ts must not hardcode testsPassed = 2"
    );
  });

  it("plumbs honest test outcomes including failing tests into morning report", async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "report-counts-test-"));
    const realSha = getRealGitSha();

    try {
      const supervisor = new OvernightSupervisor({ checkpointDirectory: tempDir });
      const taskId = "task-honest-test-counts";

      let task: TaskManifest = {
        taskId,
        goal: "Refactor API error handling and assert regression tests",
        branchName: "feat/v2.5-overnight",
        toolchain: "node:22",
        status: "active",
        milestones: [
          {
            id: "M1",
            title: "Database Migration Suite",
            description: "Run schema migration assertions",
            status: "pending",
            builderIterations: 1,
            criticRounds: 1,
            acceptanceCriteria: [{ id: "AC1", assertion: "All 8 migrations pass" }]
          },
          {
            id: "M2",
            title: "Endpoint Validation Suite with Known Failure",
            description: "Execute regression suite catching intentional bad payload bug",
            status: "pending",
            builderIterations: 2,
            criticRounds: 1,
            acceptanceCriteria: [{ id: "AC2", assertion: "Catches bad payload validation bug" }]
          }
        ],
        currentMilestoneIndex: 0,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: "2026-10-02T10:00:00Z",
        updatedAt: "2026-10-02T10:00:00Z"
      };

      // Milestone 1 passes all 8 tests
      task = await supervisor.executeSingleMilestone(task, 0, {
        gitSha: realSha,
        diff: "Updated database migration schema",
        testsPassed: 8,
        testsFailed: 0,
        testFile: "tests/migrations.test.ts"
      });

      assert.equal(task.milestones[0].testsPassed, 8);
      assert.equal(task.milestones[0].testsFailed, 0);

      // Milestone 2 runs with a known failing test (honest failure reporting)
      task = await supervisor.executeSingleMilestone(task, 1, {
        gitSha: realSha,
        diff: "Updated endpoint validation schema",
        testsPassed: 5,
        testsFailed: 2,
        testFile: "tests/endpointValidation.test.ts"
      });

      assert.equal(task.milestones[1].testsPassed, 5);
      assert.equal(task.milestones[1].testsFailed, 2);

      // Generate morning report reading directly from milestone test counts
      const report = generateMorningReport({
        taskId: task.taskId,
        goal: task.goal,
        branch: "feat/v2.5-overnight",
        gitHeadSha: realSha,
        status: "completed",
        startedAt: task.startedAt,
        completedAt: new Date().toISOString(),
        milestones: task.milestones.map((m) => ({
          id: m.id,
          title: m.title,
          status: m.status,
          commitSha: m.commitSha,
          testsPassed: m.testsPassed ?? 0,
          testsFailed: m.testsFailed ?? 0,
          diffSummary: m.diffSummary
        })),
        ambiguityFlags: [],
        parkedItems: []
      });

      // Assert report honest totals
      assert.equal(report.totalTestsPassed, 13, "8 + 5 = 13 tests passed");
      assert.equal(report.totalTestsFailed, 2, "Report must honestly record 2 failed tests");

      const md = formatMorningReportMarkdown(report);
      assert.ok(md.includes("8 passed | 0 failed"), "M1 test counts in table");
      assert.ok(md.includes("5 passed | 2 failed"), "M2 failing test counts in table");
      assert.ok(md.includes("**13 passed**, **2 failed**"), "Overall totals show honest failure");
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
