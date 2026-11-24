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
          failureCount: 0,
        },
      ];
      scheduler.saveSchedules(schedules);

      const executedIds: string[] = [];
      scheduler.executeScheduledRun = async (id: string) => {
        executedIds.push(id);
        return null;
      };

      const daemon = new SchedulerDaemon({
        workspaceDir: testWorkspace,
        scheduler,
        registerSignalHandlers: false,
      });
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
          failureCount: 0,
        },
      ];
      scheduler.saveSchedules(schedules);

      const executedIds: string[] = [];
      scheduler.executeScheduledRun = async (id: string) => {
        executedIds.push(id);
        return null;
      };

      const daemon = new SchedulerDaemon({
        workspaceDir: testWorkspace,
        scheduler,
        registerSignalHandlers: false,
      });
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
          failureCount: 1,
        },
      ];
      scheduler.saveSchedules(schedules);

      const executedIds: string[] = [];
      scheduler.executeScheduledRun = async (id: string) => {
        executedIds.push(id);
        return null;
      };

      const daemon = new SchedulerDaemon({
        workspaceDir: testWorkspace,
        scheduler,
        registerSignalHandlers: false,
      });
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
          failureCount: 0,
        },
        {
          id: "sched-pass",
          cronExpression: "0 0 * * *",
          taskDescription: "Passing task",
          enabled: true,
          createdAt: new Date(now - 100000).toISOString(),
          nextRun: new Date(now - 5000).toISOString(),
          failureCount: 0,
        },
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

      const daemon = new SchedulerDaemon({
        workspaceDir: testWorkspace,
        scheduler,
        registerSignalHandlers: false,
      });
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

      const daemon = new SchedulerDaemon({
        workspaceDir: testWorkspace,
        scheduler,
        registerSignalHandlers: false,
      });
      const hbPath = daemon.getHeartbeatPath();
      const staleHeartbeat = {
        pid: 99999,
        startedAt: new Date(Date.now() - 600000).toISOString(),
        lastTick: new Date(Date.now() - 360000).toISOString(),
        active: true,
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
      const daemon = new SchedulerDaemon({
        workspaceDir: testWorkspace,
        registerSignalHandlers: true,
      });
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
      const daemon = new SchedulerDaemon({
        workspaceDir: testWorkspace,
        registerSignalHandlers: false,
      });
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

  it("Board drain duty: invokes drain once when control is running", async () => {
    setup();
    try {
      const scheduler = new UnattendedScheduler({ workspaceDir: testWorkspace });
      let drainCalls = 0;
      const daemon = new SchedulerDaemon({
        workspaceDir: testWorkspace,
        scheduler,
        registerSignalHandlers: false,
        boardDrain: {
          isRunning: () => true,
          drain: async () => {
            drainCalls += 1;
          },
        },
      });

      await daemon.tick();
      assert.equal(drainCalls, 1);
    } finally {
      teardown();
    }
  });

  it("Board drain duty: does not invoke drain when control is stopped", async () => {
    setup();
    try {
      const scheduler = new UnattendedScheduler({ workspaceDir: testWorkspace });
      let drainCalls = 0;
      const daemon = new SchedulerDaemon({
        workspaceDir: testWorkspace,
        scheduler,
        registerSignalHandlers: false,
        boardDrain: {
          isRunning: () => false,
          drain: async () => {
            drainCalls += 1;
          },
        },
      });

      await daemon.tick();
      assert.equal(drainCalls, 0);
    } finally {
      teardown();
    }
  });

  it("Board drain duty: skips second tick while first drain is still in flight", async () => {
    setup();
    try {
      const scheduler = new UnattendedScheduler({ workspaceDir: testWorkspace });
      let drainCalls = 0;
      let releaseFirstDrain!: () => void;
      const firstDrainBlocker = new Promise<void>((resolve) => {
        releaseFirstDrain = resolve;
      });

      const daemon = new SchedulerDaemon({
        workspaceDir: testWorkspace,
        scheduler,
        registerSignalHandlers: false,
        boardDrain: {
          isRunning: () => true,
          drain: async () => {
            drainCalls += 1;
            await firstDrainBlocker;
          },
        },
      });

      const firstTick = daemon.tick();
      // Yield so firstTick enters drain() and sets the in-flight guard
      await new Promise((resolve) => setTimeout(resolve, 10));
      const secondTick = daemon.tick();

      await secondTick;
      assert.equal(
        drainCalls,
        1,
        "Second tick must not start a second drain while first is in flight"
      );

      releaseFirstDrain();
      await firstTick;
      assert.equal(drainCalls, 1);
    } finally {
      teardown();
    }
  });

  it("15s restart gap with active .scheduler-heartbeat invokes checkCrashAndRecover and marks orphaned cron manifest crashed", async () => {
    setup();
    try {
      const scheduler = new UnattendedScheduler({ workspaceDir: testWorkspace });
      const schedId = await scheduler.scheduleTask("0 2 * * *", "Restart recovery cron job");

      // Create an orphaned "active" cron manifest in .agent/checkpoints
      const checkpointDir = path.join(testWorkspace, ".agent", "checkpoints");
      fs.mkdirSync(checkpointDir, { recursive: true });
      const runId = "run-15s-crash";
      const manifestPath = path.join(checkpointDir, `${runId}-checkpoint.json`);
      const nowIso = new Date().toISOString();
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            taskId: runId,
            goal: "Restart recovery cron job",
            toolchain: "node:22",
            branchName: `feat/sched-${schedId.replace(/^sched-?/, "")}`,
            status: "active",
            milestones: [],
            currentMilestoneIndex: 0,
            checkpoints: [],
            ambiguityFlags: [],
            journal: [],
            startedAt: nowIso,
            updatedAt: nowIso,
          },
          null,
          2
        ),
        "utf8"
      );

      // Write active .scheduler-heartbeat 15 seconds ago (< 5m threshold)
      const schedHbPath = scheduler.getHeartbeatPath();
      fs.writeFileSync(
        schedHbPath,
        JSON.stringify(
          {
            runId,
            scheduleId: schedId,
            lastHeartbeat: new Date(Date.now() - 15_000).toISOString(),
            attempt: 1,
            active: true,
          },
          null,
          2
        ),
        "utf8"
      );

      const daemon = new SchedulerDaemon({
        workspaceDir: testWorkspace,
        scheduler,
        registerSignalHandlers: false,
      });

      // Also write .scheduler-daemon-heartbeat only 15 seconds old (< 5m)
      fs.writeFileSync(
        daemon.getHeartbeatPath(),
        JSON.stringify(
          {
            pid: 99998,
            startedAt: new Date(Date.now() - 30_000).toISOString(),
            lastTick: new Date(Date.now() - 15_000).toISOString(),
            active: true,
          },
          null,
          2
        ),
        "utf8"
      );

      await daemon.checkStartupRecovery();

      const updatedSchedHb = JSON.parse(fs.readFileSync(schedHbPath, "utf8")) as {
        active: boolean;
      };
      assert.equal(
        updatedSchedHb.active,
        false,
        "checkCrashAndRecover must mark .scheduler-heartbeat inactive on 15s restart gap"
      );

      const updatedSchedules = await scheduler.listSchedules();
      const updatedSched = updatedSchedules.find((s) => s.id === schedId);
      assert.equal(updatedSched?.failureCount, 1);
      assert.ok(updatedSched?.backoffUntil);

      const updatedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        status: string;
      };
      assert.equal(
        updatedManifest.status,
        "crashed",
        "orphaned active cron manifest must be marked crashed"
      );
    } finally {
      teardown();
    }
  });

  it("R8: Board drain duty invokes reconcile (without drain) when control is paused/stopped", async () => {
    setup();
    try {
      const scheduler = new UnattendedScheduler({ workspaceDir: testWorkspace });
      let drainCalls = 0;
      let reconcileCalls = 0;
      const daemon = new SchedulerDaemon({
        workspaceDir: testWorkspace,
        scheduler,
        registerSignalHandlers: false,
        boardDrain: {
          isRunning: () => false,
          drain: async () => {
            drainCalls += 1;
          },
          reconcile: async () => {
            reconcileCalls += 1;
          },
        },
      });

      await daemon.tick();
      assert.equal(drainCalls, 0);
      assert.equal(reconcileCalls, 1);
    } finally {
      teardown();
    }
  });
});
