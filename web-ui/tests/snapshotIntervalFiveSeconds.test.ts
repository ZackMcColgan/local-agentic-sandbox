import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadStore } from "../lib/threads/threadStore";
import { ThrottledStreamSnapshot, STREAM_SNAPSHOT_INTERVAL_MS } from "../lib/streamSnapshot";

/**
 * PERF-P4 (#128): the throttled mid-turn snapshot fired every 1,000 ms and each
 * write stringifies + persists the full thread JSON (1.0-1.6 MB per write, >2.2 GB
 * of writes over a long job) on the 1-vCPU event loop. The default cadence is
 * raised to 5,000 ms; round-boundary writes still bypass the throttle via
 * { force: true } (TURN-LIVENESS contract, unchanged).
 */
function makeStore(): { store: ThreadStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-p4-snap-test-"));
  return { store: new ThreadStore(dir), dir };
}

describe("PERF-P4 — snapshot interval raised to 5,000 ms", () => {
  it("default snapshot interval constant is 5000 ms", () => {
    assert.equal(STREAM_SNAPSHOT_INTERVAL_MS, 5000, "default snapshot cadence must be 5s");
  });

  it("throttle skips writes inside the 5s window and lands past it", () => {
    const { store, dir } = makeStore();
    const thread = store.createThread({ id: "t-p4-throttle", title: "p4 throttle" });
    let fakeNow = 1000;
    const snap = new ThrottledStreamSnapshot(
      store,
      thread.id,
      "msg-a",
      STREAM_SNAPSHOT_INTERVAL_MS,
      () => fakeNow
    );
    assert.equal(snap.maybeWrite("first"), true, "first write must land immediately");
    fakeNow += 4999;
    assert.equal(
      snap.maybeWrite("first second"),
      false,
      "write inside the 5s window must be skipped"
    );
    fakeNow += 1;
    assert.equal(snap.maybeWrite("first second third"), true, "write at the 5s boundary must land");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-boundary forced writes still bypass the throttle", () => {
    const { store, dir } = makeStore();
    const thread = store.createThread({ id: "t-p4-force", title: "p4 force" });
    let fakeNow = 1000;
    const snap = new ThrottledStreamSnapshot(
      store,
      thread.id,
      "msg-a",
      STREAM_SNAPSHOT_INTERVAL_MS,
      () => fakeNow
    );
    snap.maybeWrite("round one", undefined, [
      {
        tool: "workspace_read_file",
        args: { path: "lib/a.ts" },
        result: "ok",
        durationMs: 12,
        timestamp: new Date().toISOString(),
      },
    ]);
    fakeNow += 10;
    const forced = snap.maybeWrite(
      "round one, tool ran",
      undefined,
      [
        {
          tool: "workspace_read_file",
          args: { path: "lib/a.ts" },
          result: "ok",
          durationMs: 12,
          timestamp: new Date().toISOString(),
        },
        {
          tool: "workspace_run_command",
          args: { command: "npm run test:gate" },
          result: "green",
          durationMs: 4000,
          timestamp: new Date().toISOString(),
        },
      ],
      { force: true }
    );
    assert.equal(forced, true, "round-boundary snapshot must bypass the token throttle");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("server wiring: /api/chat constructs the snapshot with the shared default interval", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../app/api/chat/route.ts"), "utf8");
    assert.match(
      src,
      /new ThrottledStreamSnapshot\(\s*threadStore,\s*activeThreadId,\s*assistantMessageId\s*\)/,
      "route must construct the snapshot with the default interval (no per-route override)"
    );
  });
});
