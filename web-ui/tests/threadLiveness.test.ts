import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TURN_STALL_WINDOW_MS,
  ZOMBIE_TURN_AGE_CAP_MS,
  isRecordStaleBeyond,
  isZombiePresence,
  computeTurnLiveness,
} from "../lib/threads/liveness";
import type { Thread } from "../lib/threads/types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  const baseTime = new Date("2026-11-21T12:00:00.000Z").toISOString();
  return {
    id: "thread-liveness-test",
    title: "Test thread",
    status: "active",
    createdAt: baseTime,
    updatedAt: baseTime,
    model: "test-model",
    reasoningEffort: "medium",
    messages: [],
    ...overrides,
  };
}

describe("thread liveness and zombie computation", () => {
  const baseMs = Date.parse("2026-11-21T12:00:00.000Z");

  it("computeTurnLiveness returns 'settled' for non-live statuses", () => {
    for (const status of ["completed", "stopped", "failed", "paused", "needs_input"] as const) {
      assert.equal(computeTurnLiveness(makeThread({ status }), baseMs), "settled");
    }
  });

  it("computeTurnLiveness returns 'alive' within TURN_STALL_WINDOW_MS and 'stalled' past it", () => {
    const thread = makeThread({ status: "running" });
    assert.equal(computeTurnLiveness(thread, baseMs + TURN_STALL_WINDOW_MS), "alive");
    assert.equal(computeTurnLiveness(thread, baseMs + TURN_STALL_WINDOW_MS + 1), "stalled");
  });

  it("computeTurnLiveness returns 'stalled' when timestamps are invalid", () => {
    const thread = makeThread({ status: "active", updatedAt: "not-a-date", createdAt: "" });
    assert.equal(computeTurnLiveness(thread, baseMs), "stalled");
  });

  it("isRecordStaleBeyond checks updatedAt against windowMs", () => {
    const thread = makeThread();
    assert.equal(isRecordStaleBeyond(thread, baseMs + 1000, 1000), false);
    assert.equal(isRecordStaleBeyond(thread, baseMs + 1001, 1000), true);
  });

  it("isZombiePresence requires BOTH presence age > ZOMBIE_TURN_AGE_CAP_MS and stale record", () => {
    const presence = { startedAt: new Date(baseMs).toISOString() };
    const freshThread = makeThread({
      updatedAt: new Date(baseMs + ZOMBIE_TURN_AGE_CAP_MS).toISOString(),
    });
    // Ancient presence, fresh record -> NOT zombie
    assert.equal(
      isZombiePresence(presence, freshThread, baseMs + ZOMBIE_TURN_AGE_CAP_MS + 1000),
      false
    );

    // Young presence, stale record -> NOT zombie
    const staleThread = makeThread({ updatedAt: new Date(baseMs).toISOString() });
    assert.equal(isZombiePresence(presence, staleThread, baseMs + ZOMBIE_TURN_AGE_CAP_MS), false);

    // Ancient presence AND stale record -> zombie
    assert.equal(
      isZombiePresence(presence, staleThread, baseMs + ZOMBIE_TURN_AGE_CAP_MS + 1),
      true
    );
  });
});
