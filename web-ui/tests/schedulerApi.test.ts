import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { GET as getSchedules, POST as postSchedule, DELETE as deleteSchedule } from "../app/api/schedules/route.js";
import { DELETE as deleteScheduleById } from "../app/api/schedules/[id]/route.js";
import { POST as triggerSchedule } from "../app/api/schedules/[id]/trigger/route.js";
import { resetGlobalScheduler } from "../lib/subagents/scheduler.js";

describe("Phase 3 — Item 2: Scheduler API Routes Suite", () => {
  let testWorkspace: string;
  let savedWorkspace: string | undefined;

  function setup() {
    testWorkspace = path.resolve(process.cwd(), `temp-test-sched-api-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    savedWorkspace = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = testWorkspace;
    resetGlobalScheduler();
    if (!fs.existsSync(testWorkspace)) fs.mkdirSync(testWorkspace, { recursive: true });
  }

  function teardown() {
    resetGlobalScheduler();
    if (savedWorkspace !== undefined) {
      process.env.WORKSPACE_DIR = savedWorkspace;
    } else {
      delete process.env.WORKSPACE_DIR;
    }
    if (testWorkspace && fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  }

  it("POST /api/schedules with valid cron returns 200, id, and nextRun", async () => {
    setup();
    try {
      const req = new Request("http://localhost:3000/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cronExpression: "0 2 * * *",
          taskDescription: "Run overnight verification"
        })
      });

      const res = await postSchedule(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.id);
      assert.ok(data.nextRun);
      assert.ok(typeof data.id === "string");
    } finally {
      teardown();
    }
  });

  it("POST /api/schedules with invalid cron (4 parts) returns 400", async () => {
    setup();
    try {
      const req = new Request("http://localhost:3000/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cronExpression: "0 2 * *",
          taskDescription: "Incomplete cron format"
        })
      });

      const res = await postSchedule(req);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error);
      assert.ok(data.error.includes("5 fields"));
    } finally {
      teardown();
    }
  });

  it("POST /api/schedules with empty taskDescription returns 400", async () => {
    setup();
    try {
      const req = new Request("http://localhost:3000/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cronExpression: "0 2 * * *",
          taskDescription: "   "
        })
      });

      const res = await postSchedule(req);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error);
      assert.ok(data.error.includes("taskDescription"));
    } finally {
      teardown();
    }
  });

  it("GET /api/schedules returns array of schedules", async () => {
    setup();
    try {
      const postReq = new Request("http://localhost:3000/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cronExpression: "0 * * * *",
          taskDescription: "Hourly check"
        })
      });
      await postSchedule(postReq);

      const getReq = new Request("http://localhost:3000/api/schedules", { method: "GET" });
      const res = await getSchedules();
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.schedules));
      assert.equal(data.schedules.length, 1);
      assert.equal(data.schedules[0].taskDescription, "Hourly check");
    } finally {
      teardown();
    }
  });

  it("DELETE /api/schedules?id=<id> removes schedule, GET confirms gone", async () => {
    setup();
    try {
      const postReq = new Request("http://localhost:3000/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cronExpression: "0 3 * * *",
          taskDescription: "Schedule to cancel"
        })
      });
      const postRes = await postSchedule(postReq);
      const { id } = await postRes.json();

      const deleteReq = new Request(`http://localhost:3000/api/schedules?id=${id}`, { method: "DELETE" });
      const delRes = await deleteSchedule(deleteReq);
      assert.equal(delRes.status, 200);
      const delData = await delRes.json();
      assert.equal(delData.success, true);

      const getReq = new Request("http://localhost:3000/api/schedules", { method: "GET" });
      const getRes = await getSchedules();
      const getData = await getRes.json();
      assert.equal(getData.schedules.some((s: any) => s.id === id), false);
    } finally {
      teardown();
    }
  });

  it("DELETE /api/schedules/[id] removes schedule by path parameter", async () => {
    setup();
    try {
      const postReq = new Request("http://localhost:3000/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cronExpression: "0 3 * * *",
          taskDescription: "Path delete schedule"
        })
      });
      const postRes = await postSchedule(postReq);
      const { id } = await postRes.json();

      const deleteReq = new Request(`http://localhost:3000/api/schedules/${id}`, { method: "DELETE" });
      const delRes = await deleteScheduleById(deleteReq, { params: Promise.resolve({ id }) });
      assert.equal(delRes.status, 200);
      const delData = await delRes.json();
      assert.equal(delData.success, true);

      const getReq = new Request("http://localhost:3000/api/schedules", { method: "GET" });
      const getRes = await getSchedules();
      const getData = await getRes.json();
      assert.equal(getData.schedules.some((s: any) => s.id === id), false);
    } finally {
      teardown();
    }
  });

  it("POST /api/schedules/[id]/trigger starts run and returns runId, or 404 if not found", async () => {
    setup();
    try {
      // 1. Non-existent schedule returns 404
      const notFoundReq = new Request("http://localhost:3000/api/schedules/sched-nonexistent/trigger", { method: "POST" });
      const notFoundRes = await triggerSchedule(notFoundReq, { params: Promise.resolve({ id: "sched-nonexistent" }) });
      assert.equal(notFoundRes.status, 404);

      // 2. Create a schedule and trigger it
      const postReq = new Request("http://localhost:3000/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cronExpression: "0 4 * * *",
          taskDescription: "Triggerable run"
        })
      });
      const postRes = await postSchedule(postReq);
      const { id } = await postRes.json();

      const trigReq = new Request(`http://localhost:3000/api/schedules/${id}/trigger`, { method: "POST" });
      const trigRes = await triggerSchedule(trigReq, { params: Promise.resolve({ id }) });
      assert.equal(trigRes.status, 200);
      const trigData = await trigRes.json();
      assert.ok(trigData.runId);
      assert.ok(trigData.status);
    } finally {
      teardown();
    }
  });
});
