import { describe, it } from "node:test";
import assert from "node:assert";
import React from "react";
import ReactDOMServer from "react-dom/server";
import {
  LiveRunBlock,
  deriveRunCardStatus,
  computeRunElapsedSeconds,
  formatRunTimerLabel
} from "../components/LiveRunBlock";
import { TaskManifest } from "../lib/subagents/types";

describe("LiveRunBlock — Honest Status & Frozen Settled Timers", () => {
  const baseTask: TaskManifest = {
    taskId: "task-status-1",
    goal: "Build feature",
    status: "active",
    toolchain: "node:22",
    branchName: "feat/test",
    milestones: [],
    currentMilestoneIndex: 0,
    checkpoints: [],
    ambiguityFlags: [],
    journal: [],
    startedAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:12:30.000Z"
  };

  it("1. Missing status does NOT default to active/running", () => {
    const missingStatus = deriveRunCardStatus({ status: undefined as any });
    assert.strictEqual(missingStatus.isRunning, false);
    assert.notStrictEqual(missingStatus.headerLabel, "Live run");
  });

  it("2. Parked status and paused-with-parkedReason are classified as parked, not running or failed", () => {
    const explicitParked = deriveRunCardStatus({ status: "parked", parkedReason: "Chunk budget reached" });
    assert.strictEqual(explicitParked.isRunning, false);
    assert.strictEqual(explicitParked.isParked, true);
    assert.strictEqual(explicitParked.isFailed, false);
    assert.strictEqual(explicitParked.headerLabel, "Run parked");

    const supervisorParked = deriveRunCardStatus({ status: "paused", parkedReason: "Chunk boundary" });
    assert.strictEqual(supervisorParked.isRunning, false);
    assert.strictEqual(supervisorParked.isParked, true);
    assert.strictEqual(supervisorParked.isFailed, false);
    assert.strictEqual(supervisorParked.headerLabel, "Run parked");
  });

  it("3. Settled/parked runs compute FROZEN duration (settle time minus start), never Date.now()", () => {
    const sevenHoursLater = new Date("2026-11-20T07:12:32.000Z").getTime();

    const parkedTask: TaskManifest = {
      ...baseTask,
      status: "parked",
      parkedReason: "Max iterations"
    };
    const elapsed = computeRunElapsedSeconds(parkedTask, sevenHoursLater);
    assert.strictEqual(elapsed, 750, "Parked duration must freeze at updatedAt - startedAt (12m 30s = 750s)");

    const parkedWithoutEnd: TaskManifest = {
      ...baseTask,
      status: "parked",
      updatedAt: ""
    };
    assert.strictEqual(
      computeRunElapsedSeconds(parkedWithoutEnd, sevenHoursLater),
      0,
      "Settled task without settle timestamp must not count wall-clock time"
    );

    const activeElapsed = computeRunElapsedSeconds(baseTask, sevenHoursLater);
    assert.strictEqual(activeElapsed, 7 * 3600 + 12 * 60 + 32, "Active task counts up to now");
  });

  it("4. Timer label never says 'Running for' for parked, failed, paused, stopped, or completed runs", () => {
    for (const status of ["parked", "failed", "paused", "stopped", "cancelled", "completed", "crashed"] as const) {
      const info = deriveRunCardStatus({ status: status as any });
      const label = formatRunTimerLabel(info, 750);
      assert.ok(!label.startsWith("Running for"), `Status '${status}' must not render 'Running for', got: ${label}`);
    }
    const runningInfo = deriveRunCardStatus({ status: "active" });
    assert.ok(formatRunTimerLabel(runningInfo, 750).startsWith("Running for"));
  });

  it("5. SSR render of parked run card shows 'Run parked', frozen duration, and no RUNNING pill", () => {
    const parkedTask: TaskManifest = {
      ...baseTask,
      status: "parked",
      parkedReason: "Waiting on user input"
    };
    const html = ReactDOMServer.renderToString(React.createElement(LiveRunBlock, { task: parkedTask }));
    assert.ok(html.includes("Run parked"), "Header must say 'Run parked'");
    assert.ok(!html.includes('data-testid="running-pill"'), "Parked card must not render RUNNING pill");
    assert.ok(!html.includes("Running for"), "Parked card must not render 'Running for'");
    assert.ok(html.includes("Parked after 12m 30s"), "Parked card must render frozen duration");
  });
});
