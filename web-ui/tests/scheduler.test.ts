import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  UnattendedScheduler,
  calculateNextRun,
  scheduleTask,
  cancelSchedule,
  listSchedules,
  triggerMorningReport
} from "../lib/subagents/scheduler.js";
import { TaskManifest } from "../lib/subagents/types.js";

describe("Phase 2 — Item 1: Unattended Overnight Scheduler Suite", () => {
  const testWorkspace = path.resolve(process.cwd(), "temp-test-scheduler-workspace");

  it("Cron parser correctly calculates next run for '0 2 * * *' (2am daily)", () => {
    const baseDate = new Date("2026-10-05T01:00:00Z");
    const nextRun = calculateNextRun("0 2 * * *", baseDate);

    assert.equal(nextRun.getUTCHours(), 2);
    assert.equal(nextRun.getUTCMinutes(), 0);
    assert.equal(nextRun.getUTCDate(), 5);

    const after2am = new Date("2026-10-05T03:00:00Z");
    const nextDayRun = calculateNextRun("0 2 * * *", after2am);
    assert.equal(nextDayRun.getUTCHours(), 2);
    assert.equal(nextDayRun.getUTCMinutes(), 0);
    assert.equal(nextDayRun.getUTCDate(), 6);
  });

  it("Schedule persists to disk and reloads after simulated restart", async () => {
    if (!fs.existsSync(testWorkspace)) fs.mkdirSync(testWorkspace, { recursive: true });
    const storageFile = path.join(testWorkspace, "schedules.json");

    try {
      const scheduler1 = new UnattendedScheduler({ storageFile, workspaceDir: testWorkspace });
      const schedId = await scheduler1.scheduleTask("0 2 * * *", "Run nightly test and build suite");
      assert.ok(schedId);

      const list1 = await scheduler1.listSchedules();
      assert.equal(list1.length, 1);
      assert.equal(list1[0].id, schedId);
      assert.equal(list1[0].enabled, true);

      assert.ok(fs.existsSync(storageFile));

      const scheduler2 = new UnattendedScheduler({ storageFile, workspaceDir: testWorkspace });
      const list2 = await scheduler2.listSchedules();
      assert.equal(list2.length, 1);
      assert.equal(list2[0].id, schedId);
      assert.equal(list2[0].taskDescription, "Run nightly test and build suite");
      assert.equal(list2[0].cronExpression, "0 2 * * *");
    } finally {
      if (fs.existsSync(testWorkspace)) fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it("Crash during run triggers backoff restart (mocked crash)", async () => {
    if (!fs.existsSync(testWorkspace)) fs.mkdirSync(testWorkspace, { recursive: true });
    const storageFile = path.join(testWorkspace, "schedules.json");

    try {
      const scheduler = new UnattendedScheduler({ storageFile, workspaceDir: testWorkspace });
      const schedId = await scheduler.scheduleTask("0 2 * * *", "Crash resilience task");

      scheduler.writeHeartbeat("mock-run-123", schedId, 1, true);
      assert.ok(fs.existsSync(scheduler.getHeartbeatPath()));

      const recovery1 = await scheduler.checkCrashAndRecover();
      assert.equal(recovery1.recovered, true);
      assert.equal(recovery1.scheduleId, schedId);
      assert.equal(recovery1.attempt, 2);

      const schedules = await scheduler.listSchedules();
      const updated = schedules.find((s) => s.id === schedId);
      assert.equal(updated?.failureCount, 1);
      assert.ok(updated?.backoffUntil);

      const backoffDiff = new Date(updated!.backoffUntil!).getTime() - Date.now();
      assert.ok(backoffDiff > 50000 && backoffDiff <= 61000);
    } finally {
      if (fs.existsSync(testWorkspace)) fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it("Completed run generates morning report with correct sections", async () => {
    if (!fs.existsSync(testWorkspace)) fs.mkdirSync(testWorkspace, { recursive: true });

    try {
      const scheduler = new UnattendedScheduler({ workspaceDir: testWorkspace });
      const mockManifest: TaskManifest = {
        taskId: "task-morning-report-test",
        goal: "Nightly autonomous verification",
        toolchain: "node:22",
        branchName: "sched/nightly",
        status: "completed",
        milestones: [
          {
            id: "M1",
            title: "Setup core infrastructure",
            description: "Deploy base containers",
            acceptanceCriteria: [{ id: "AC-1", assertion: "Containers running" }],
            status: "completed",
            builderIterations: 1,
            criticRounds: 1,
            commitSha: "sha-m1-abc1234",
            testsPassed: 14,
            testsFailed: 0
          }
        ],
        currentMilestoneIndex: 1,
        checkpoints: [],
        ambiguityFlags: [
          {
            id: "amb-1",
            milestoneId: "M1",
            question: "Should port 80 be routed to LAN?",
            judgmentCall: "Bound to 0.0.0.0 per lan-bridge config",
            reasoning: "Local test environment requires multi-device access",
            revertAction: { type: "re_plan", target: "M1" },
            reviewed: false
          }
        ],
        journal: [],
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      };

      const reportContent = await scheduler.triggerMorningReport("run-report-1", mockManifest);
      assert.ok(reportContent.includes("# Autonomous Overnight Morning Report"));
      assert.ok(reportContent.includes("## Overview"));
      assert.ok(reportContent.includes("## Milestones Completed"));
      assert.ok(reportContent.includes("Setup core infrastructure"));
      assert.ok(reportContent.includes("## Commits Made"));
      assert.ok(reportContent.includes("sha-m1-abc1234"));
      assert.ok(reportContent.includes("## Test Results"));
      assert.ok(reportContent.includes("Passed**: 14"));
      assert.ok(reportContent.includes("## Ambiguities Flagged & Parking Status"));
      assert.ok(reportContent.includes("Should port 80 be routed to LAN?"));

      const dateStr = new Date().toISOString().slice(0, 10);
      const expectedReportPath = path.join(testWorkspace, "reports", `morning-${dateStr}.md`);
      assert.ok(fs.existsSync(expectedReportPath));
    } finally {
      if (fs.existsSync(testWorkspace)) fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it("Disabled schedule does not trigger", async () => {
    if (!fs.existsSync(testWorkspace)) fs.mkdirSync(testWorkspace, { recursive: true });
    const storageFile = path.join(testWorkspace, "schedules.json");

    try {
      const scheduler = new UnattendedScheduler({ storageFile, workspaceDir: testWorkspace });
      const schedId = await scheduler.scheduleTask("0 2 * * *", "Disabled task");

      const schedules = await scheduler.listSchedules();
      schedules[0].enabled = false;
      scheduler.saveSchedules(schedules);

      const res = await scheduler.executeScheduledRun(schedId);
      assert.equal(res, null, "Disabled schedule must not execute");
    } finally {
      if (fs.existsSync(testWorkspace)) fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });
});
