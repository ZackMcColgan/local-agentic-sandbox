import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { GET as getHealth } from "../app/api/scheduler/health/route.js";
import { resetGlobalScheduler } from "../lib/subagents/scheduler.js";

describe("Phase 4 Follow-up: Scheduler Health API Test Suite", () => {
  let testWorkspace: string;

  function setup() {
    testWorkspace = path.resolve(
      process.cwd(),
      `temp-test-health-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    );
    process.env.WORKSPACE_DIR = testWorkspace;
    resetGlobalScheduler();
    if (!fs.existsSync(testWorkspace)) fs.mkdirSync(testWorkspace, { recursive: true });
  }

  function teardown() {
    resetGlobalScheduler();
    delete process.env.WORKSPACE_DIR;
    if (testWorkspace && fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  }

  it("reports 'healthy' when daemon heartbeat is active and recent (< 5 min)", async () => {
    setup();
    try {
      const daemonHbPath = path.join(testWorkspace, ".scheduler-daemon-heartbeat");
      const hb = {
        pid: 12345,
        startedAt: new Date(Date.now() - 60000).toISOString(),
        lastTick: new Date(Date.now() - 30000).toISOString(),
        active: true,
      };
      fs.writeFileSync(daemonHbPath, JSON.stringify(hb, null, 2), "utf8");

      const res = await getHealth();
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, "healthy");
      assert.ok(data.daemon);
      assert.equal(data.daemon.active, true);
      assert.equal(data.daemon.pid, 12345);
      assert.equal(data.daemon.stale, false);
      assert.equal(data.schedules.total, 0);
    } finally {
      teardown();
    }
  });

  it("reports 'degraded' when daemon heartbeat is active but stale (> 5 min)", async () => {
    setup();
    try {
      const daemonHbPath = path.join(testWorkspace, ".scheduler-daemon-heartbeat");
      const hb = {
        pid: 12345,
        startedAt: new Date(Date.now() - 600000).toISOString(),
        lastTick: new Date(Date.now() - 360000).toISOString(), // 6 minutes ago
        active: true,
      };
      fs.writeFileSync(daemonHbPath, JSON.stringify(hb, null, 2), "utf8");

      const res = await getHealth();
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, "degraded");
      assert.ok(data.daemon);
      assert.equal(data.daemon.active, true);
      assert.equal(data.daemon.stale, true);
    } finally {
      teardown();
    }
  });

  it("reports 'degraded' when daemon heartbeat has active=false", async () => {
    setup();
    try {
      const daemonHbPath = path.join(testWorkspace, ".scheduler-daemon-heartbeat");
      const hb = {
        pid: 12345,
        startedAt: new Date(Date.now() - 60000).toISOString(),
        lastTick: new Date().toISOString(),
        active: false,
      };
      fs.writeFileSync(daemonHbPath, JSON.stringify(hb, null, 2), "utf8");

      const res = await getHealth();
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, "degraded");
      assert.ok(data.daemon);
      assert.equal(data.daemon.active, false);
      assert.equal(data.daemon.stale, false);
    } finally {
      teardown();
    }
  });

  it("reports 'not-running' when heartbeat file is missing", async () => {
    setup();
    try {
      const res = await getHealth();
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, "not-running");
      assert.equal(data.daemon, null);
    } finally {
      teardown();
    }
  });

  it("reports 'not-running' when heartbeat file contains malformed JSON", async () => {
    setup();
    try {
      const daemonHbPath = path.join(testWorkspace, ".scheduler-daemon-heartbeat");
      fs.writeFileSync(daemonHbPath, "{corrupt json - not valid", "utf8");

      const res = await getHealth();
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, "not-running");
      assert.equal(data.daemon, null);
    } finally {
      teardown();
    }
  });

  it("accurately includes scheduler heartbeat and schedules summary", async () => {
    setup();
    try {
      // 1. Daemon heartbeat
      const daemonHbPath = path.join(testWorkspace, ".scheduler-daemon-heartbeat");
      fs.writeFileSync(
        daemonHbPath,
        JSON.stringify({
          pid: 54321,
          startedAt: new Date(Date.now() - 10000).toISOString(),
          lastTick: new Date().toISOString(),
          active: true,
        }),
        "utf8"
      );

      // 2. Scheduler run heartbeat
      const schedHbPath = path.join(testWorkspace, ".scheduler-heartbeat");
      fs.writeFileSync(
        schedHbPath,
        JSON.stringify({
          runId: "run-001",
          scheduleId: "sched-001",
          lastHeartbeat: new Date().toISOString(),
          attempt: 1,
          active: true,
        }),
        "utf8"
      );

      // 3. Schedules file
      const schedulesPath = path.join(testWorkspace, "schedules.json");
      const nextRunFuture = new Date(Date.now() + 3600000).toISOString();
      fs.writeFileSync(
        schedulesPath,
        JSON.stringify([
          { id: "s1", cronExpression: "0 2 * * *", enabled: true, nextRun: nextRunFuture },
          {
            id: "s2",
            cronExpression: "0 3 * * *",
            enabled: false,
            nextRun: new Date(Date.now() + 7200000).toISOString(),
          },
        ]),
        "utf8"
      );

      const res = await getHealth();
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, "healthy");
      assert.ok(data.scheduler);
      assert.equal(data.scheduler.active, true);
      assert.equal(data.scheduler.scheduleId, "sched-001");
      assert.equal(data.schedules.total, 2);
      assert.equal(data.schedules.enabled, 1);
      assert.equal(data.schedules.nextRun, nextRunFuture);
    } finally {
      teardown();
    }
  });

  it("instrumentation register() does not start daemon when SCHEDULER_DAEMON_ENABLED is unset or not 'true'", async () => {
    const { register } = await import("../instrumentation.js");
    const prevEnv = process.env.SCHEDULER_DAEMON_ENABLED;
    const g = globalThis as typeof globalThis & { __schedulerDaemonStarted?: boolean };
    const prevStarted = g.__schedulerDaemonStarted;
    try {
      delete g.__schedulerDaemonStarted;
      delete process.env.SCHEDULER_DAEMON_ENABLED;
      let calls = 0;
      const startedUnset = await register(async () => {
        calls++;
      });
      assert.equal(startedUnset, false);
      assert.equal(calls, 0);

      process.env.SCHEDULER_DAEMON_ENABLED = "false";
      const startedFalse = await register(async () => {
        calls++;
      });
      assert.equal(startedFalse, false);
      assert.equal(calls, 0);
    } finally {
      if (prevEnv === undefined) delete process.env.SCHEDULER_DAEMON_ENABLED;
      else process.env.SCHEDULER_DAEMON_ENABLED = prevEnv;
      if (prevStarted === undefined) delete g.__schedulerDaemonStarted;
      else g.__schedulerDaemonStarted = prevStarted;
    }
  });

  it("instrumentation register() starts daemon once when SCHEDULER_DAEMON_ENABLED === 'true'", async () => {
    const { register } = await import("../instrumentation.js");
    const prevEnv = process.env.SCHEDULER_DAEMON_ENABLED;
    const g = globalThis as typeof globalThis & { __schedulerDaemonStarted?: boolean };
    const prevStarted = g.__schedulerDaemonStarted;
    try {
      delete g.__schedulerDaemonStarted;
      process.env.SCHEDULER_DAEMON_ENABLED = "true";
      let calls = 0;
      const first = await register(async () => {
        calls++;
      });
      const second = await register(async () => {
        calls++;
      });
      assert.equal(first, true);
      assert.equal(second, false);
      assert.equal(calls, 1);
    } finally {
      if (prevEnv === undefined) delete process.env.SCHEDULER_DAEMON_ENABLED;
      else process.env.SCHEDULER_DAEMON_ENABLED = prevEnv;
      if (prevStarted === undefined) delete g.__schedulerDaemonStarted;
      else g.__schedulerDaemonStarted = prevStarted;
    }
  });
});
