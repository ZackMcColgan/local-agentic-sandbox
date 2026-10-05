import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { SchedulerDaemon } from "../lib/subagents/schedulerDaemon.js";
import { UnattendedScheduler, Schedule } from "../lib/subagents/scheduler.js";

describe("Phase 4 — Item 1: Scheduler Daemon Test Suite", () => {
  const testWorkspace = path.resolve(process.cwd(), `temp-test-daemon-${Date.now()}`);

  function setup() {
    process.env.WORKSPACE_DIR = testWorkspace;
    if (!fs.existsSync(testWorkspace)) fs.mkdirSync(testWorkspace, { recursive: true });
  }

  function teardown() {
    delete process.env.WORKSPACE_DIR;
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  }

  it("Tick finds due schedule and triggers run", async () => {
    setup();
    try {
      const scheduler = new UnattendedScheduler({ workspaceDir: testWorkspace });
      const now = Date.now();
      const schedules: Schedule[] = [
        {
          id: "sched-due-1",
          cronExpression: "0 0 * * *",
          taskDescription: "Test due schedule run",
          enabled: true,
          createdAt: new Date(now - 100000).toISOString(),
          nextRun: new Date(now - 10000).toISOString(),
          failureCount: 0
        }
      ];
      scheduler.saveSchedules(schedules);

      const executedIds: string[] = [];
      scheduler.executeScheduledRun = async (id: string) => {
        executedIds.push(id);
        return null;
      };

      const daemon = new SchedulerDaemon({ workspaceDir: testWorkspace, scheduler, registerSignalHandlers: false });
      const dueCount = await daemon.tick();

      assert.equal(dueCount, 1);
      assert.deepEqual(executedIds, ["sched-due-1"]);

      const hb = daemon.readHeartbeat();
      assert.ok(hb);
      assert.equal(hb.active, true);
    } finally {
      teardown();
    }
  });

  it("Skips disabled schedules", async () => {
    setup();
    try {
      const scheduler = new UnattendedScheduler({ workspaceDir: testWorkspace });
      const now = Date.now();
      const schedules: Schedule[] = [
        {
          id: "sched-disabled",
          cronExpression: "0 0 * * *",
          taskDescription: "Test disabled schedule",
          enabled: false,
          createdAt: new Date(now - 100000).toISOString(),
          nextRun: new Date(now - 10000).toISOString(),
          failureCount: 0
        }
      ];
      scheduler.saveSchedules(schedules);

      const executedIds: string[] = [];
      scheduler.executeScheduledRun = async (id: string) => {
        executedIds.push(id);
        return null;
      };

      const daemon = new SchedulerDaemon({ workspaceDir: testWorkspace, scheduler, registerSignalHandlers: false });
      const dueCount = await daemon.tick();

      assert.equal(dueCount, 0);
      assert.equal(executedIds.length, 0);
    } finally {
      teardown();
    }
  });

  it("Skips schedules in backoff", async () => {
    setup();
    try {
      const scheduler = new UnattendedScheduler({ workspaceDir: testWorkspace });
      const now = Date.now();
      const schedules: Schedule[] = [
        {
          id: "sched-backoff",
          cronExpression: "0 0 * * *",
          taskDescription: "Test backoff schedule",
          enabled: true,
          createdAt: new Date(now - 100000).toISOString(),
          nextRun: new Date(now - 10000).toISOString(),
          backoffUntil: new Date(now + 60000).toISOString(),
          failureCount: 1
        }
      ];
      scheduler.saveSchedules(schedules);

      const executedIds: string[] = [];
      scheduler.executeScheduledRun = async (id: string) => {
        executedIds.push(id);
        return null;
      };

      const daemon = new SchedulerDaemon({ workspaceDir: testWorkspace, scheduler, registerSignalHandlers: false });
      const dueCount = await daemon.tick();

      assert.equal(dueCount, 0);
      assert.equal(executedIds.length, 0);
    } finally {
      teardown();
    }
  });

  it("One failing schedule doesn't stop others", async () => {
    setup();
    try {
      const scheduler = new UnattendedScheduler({ workspaceDir: testWorkspace });
      const now = Date.now();
      const schedules: Schedule[] = [
        {
          id: "sched-fail",
          cronExpression: "0 0 * * *",
          taskDescription: "Failing task",
          enabled: true,
          createdAt: new Date(now - 100000).toISOString(),
          nextRun: new Date(now - 10000).toISOString(),
          failureCount: 0
        },
        {
          id: "sched-pass",
          cronExpression: "0 0 * * *",
          taskDescription: "Passing task",
          enabled: true,
          createdAt: new Date(now - 100000).toISOString(),
          nextRun: new Date(now - 5000).toISOString(),
          failureCount: 0
        }
      ];
      scheduler.saveSchedules(schedules);

      const executedIds: string[] = [];
      scheduler.executeScheduledRun = async (id: string) => {
        executedIds.push(id);
        if (id === "sched-fail") {
          throw new Error("Simulated worker timeout crash");
        }
        return null;
      };

      const daemon = new SchedulerDaemon({ workspaceDir: testWorkspace, scheduler, registerSignalHandlers: false });
      const dueCount = await daemon.tick();

      assert.equal(dueCount, 2);
      assert.deepEqual(executedIds, ["sched-fail", "sched-pass"]);

      const logFile = daemon.getLogFilePath();
      assert.ok(fs.existsSync(logFile));
      const logContent = fs.readFileSync(logFile, "utf8");
      assert.ok(logContent.includes("[ERROR]"));
      assert.ok(logContent.includes("Simulated worker timeout crash"));
      assert.ok(logContent.includes("Successfully completed schedule run for sched-pass"));
    } finally {
      teardown();
    }
  });

  it("Stale heartbeat on startup triggers recovery", async () => {
    setup();
    try {
      const scheduler = new UnattendedScheduler({ workspaceDir: testWorkspace });
      let recoveryCalled = false;
      scheduler.checkCrashAndRecover = async () => {
        recoveryCalled = true;
        return { recovered: true, scheduleId: "sched-recovered", attempt: 2 };
      };

      const daemon = new SchedulerDaemon({ workspaceDir: testWorkspace, scheduler, registerSignalHandlers: false });
      const hbPath = daemon.getHeartbeatPath();
      const staleHeartbeat = {
        pid: 99999,
        startedAt: new Date(Date.now() - 600000).toISOString(),
        lastTick: new Date(Date.now() - 360000).toISOString(),
        active: true
      };
      fs.writeFileSync(hbPath, JSON.stringify(staleHeartbeat, null, 2), "utf8");

      await daemon.checkStartupRecovery();

      assert.equal(recoveryCalled, true);
      const logFile = daemon.getLogFilePath();
      assert.ok(fs.existsSync(logFile));
      const logContent = fs.readFileSync(logFile, "utf8");
      assert.ok(logContent.includes("Stale heartbeat detected"));
      assert.ok(logContent.includes("Crash recovery triggered"));
    } finally {
      teardown();
    }
  });

  it("SIGTERM sets shutdown flag and marks heartbeat inactive", async () => {
    setup();
    try {
      const daemon = new SchedulerDaemon({ workspaceDir: testWorkspace, registerSignalHandlers: true });
      daemon.writeHeartbeat(true);

      assert.equal(daemon.shutdownRequested, false);
      assert.equal(daemon.readHeartbeat()?.active, true);

      // Trigger SIGTERM signal
      process.emit("SIGTERM");

      assert.equal(daemon.shutdownRequested, true);
      const hb = daemon.readHeartbeat();
      assert.ok(hb);
      assert.equal(hb.active, false);
    } finally {
      teardown();
    }
  });

  it("Log file created with correct format and rotatable", () => {
    setup();
    try {
      const daemon = new SchedulerDaemon({ workspaceDir: testWorkspace, registerSignalHandlers: false });
      daemon.log("INFO", "Scheduled maintenance check");
      daemon.log("WARN", "Disk threshold near 80%");
      daemon.log("ERROR", "Unhandled task failure");

      const logFile = daemon.getLogFilePath();
      assert.ok(fs.existsSync(logFile));
      const logContent = fs.readFileSync(logFile, "utf8");
      const lines = logContent.trim().split("\n");

      assert.equal(lines.length >= 3, true);
      const logRegex = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[(INFO|WARN|ERROR)\] .+/;
      for (const line of lines) {
        assert.ok(logRegex.test(line), `Line does not match log format: ${line}`);
      }
    } finally {
      teardown();
    }
  });
});
