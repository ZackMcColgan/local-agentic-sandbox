import { describe, it, expect } from "vitest";
import {
  TURN_STALL_WINDOW_MS,
  ZOMBIE_TURN_AGE_CAP_MS,
  isRecordStaleBeyond,
  isZombiePresence,
  computeTurnLiveness,
  type Thread,
} from "../lib/threads/threadStore";

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
      expect(computeTurnLiveness(makeThread({ status }), baseMs)).toBe("settled");
    }
  });

  it("computeTurnLiveness returns 'alive' within TURN_STALL_WINDOW_MS and 'stalled' past it", () => {
    const thread = makeThread({ status: "running" });
    expect(computeTurnLiveness(thread, baseMs + TURN_STALL_WINDOW_MS)).toBe("alive");
    expect(computeTurnLiveness(thread, baseMs + TURN_STALL_WINDOW_MS + 1)).toBe("stalled");
  });

  it("computeTurnLiveness returns 'stalled' when timestamps are invalid", () => {
    const thread = makeThread({ status: "active", updatedAt: "not-a-date", createdAt: "" });
    expect(computeTurnLiveness(thread, baseMs)).toBe("stalled");
  });

  it("isRecordStaleBeyond checks updatedAt against windowMs", () => {
    const thread = makeThread();
    expect(isRecordStaleBeyond(thread, baseMs + 1000, 1000)).toBe(false);
    expect(isRecordStaleBeyond(thread, baseMs + 1001, 1000)).toBe(true);
  });

  it("isZombiePresence requires BOTH presence age > ZOMBIE_TURN_AGE_CAP_MS and stale record", () => {
    const presence = { startedAt: new Date(baseMs).toISOString() };
    const freshThread = makeThread({
      updatedAt: new Date(baseMs + ZOMBIE_TURN_AGE_CAP_MS).toISOString(),
    });
    // Ancient presence, fresh record -> NOT zombie
    expect(isZombiePresence(presence, freshThread, baseMs + ZOMBIE_TURN_AGE_CAP_MS + 1000)).toBe(
      false
    );

    // Young presence, stale record -> NOT zombie
    const staleThread = makeThread({ updatedAt: new Date(baseMs).toISOString() });
    expect(isZombiePresence(presence, staleThread, baseMs + ZOMBIE_TURN_AGE_CAP_MS)).toBe(false);

    // Ancient presence AND stale record -> zombie
    expect(isZombiePresence(presence, staleThread, baseMs + ZOMBIE_TURN_AGE_CAP_MS + 1)).toBe(true);
  });
});
