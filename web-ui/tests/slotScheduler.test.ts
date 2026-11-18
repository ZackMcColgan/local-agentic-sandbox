import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PrioritySlotScheduler,
  SlotPriority,
  getSharedSlotScheduler,
} from "../lib/slotScheduler";
import { JobQueue } from "../lib/jobQueue";
import { serializeTurn } from "../lib/chatTurnGate";
import { WorkerPool } from "../lib/subagents/workerPool";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("PrioritySlotScheduler — single-slot arbiter", () => {
  it("shares a single globalThis-backed instance via getSharedSlotScheduler()", () => {
    const a = getSharedSlotScheduler();
    const b = getSharedSlotScheduler();
    assert.strictEqual(a, b);
    assert.ok(a instanceof PrioritySlotScheduler);
  });

  it("enforces strict single-slot mutual exclusion across concurrent P0/P1/P2/P3 acquisitions (zero concurrent LLM calls)", async () => {
    const scheduler = new PrioritySlotScheduler();
    let inFlight = 0;
    let maxObserved = 0;
    const completed: string[] = [];

    const runSimulatedLlm = async (priority: SlotPriority, label: string, durationMs: number) => {
      await scheduler.runWithSlot({ priority, label }, async () => {
        inFlight++;
        if (inFlight > maxObserved) maxObserved = inFlight;
        assert.strictEqual(inFlight, 1, `Concurrent LLM call detected during ${label}`);
        await delay(durationMs);
        inFlight--;
        completed.push(label);
      });
    };

    await Promise.all([
      runSimulatedLlm(SlotPriority.P1_BUILDER, "builder-1", 25),
      runSimulatedLlm(SlotPriority.P0_OWNER, "owner-1", 15),
      runSimulatedLlm(SlotPriority.P2_ORCHESTRATOR, "orchestrator-1", 15),
      runSimulatedLlm(SlotPriority.P3_HOUSEKEEPING, "housekeeping-1", 10),
      runSimulatedLlm(SlotPriority.P0_OWNER, "owner-2", 10),
    ]);

    assert.strictEqual(maxObserved, 1, "At most 1 LLM call may be in-flight at any time");
    assert.strictEqual(completed.length, 5);
  });

  it("orders queued waiters by strict priority P0_OWNER > P1_BUILDER > P2_ORCHESTRATOR > P3_HOUSEKEEPING", async () => {
    const scheduler = new PrioritySlotScheduler();
    const order: string[] = [];

    // Hold the slot initially so all subsequent requests queue up
    const holder = await scheduler.acquire({ priority: SlotPriority.P1_BUILDER, label: "initial-holder" });

    const p3 = scheduler.runWithSlot({ priority: SlotPriority.P3_HOUSEKEEPING, label: "P3" }, async () => {
      order.push("P3");
    });
    const p2 = scheduler.runWithSlot({ priority: SlotPriority.P2_ORCHESTRATOR, label: "P2" }, async () => {
      order.push("P2");
    });
    const p1 = scheduler.runWithSlot({ priority: SlotPriority.P1_BUILDER, label: "P1" }, async () => {
      order.push("P1");
    });
    const p0a = scheduler.runWithSlot({ priority: SlotPriority.P0_OWNER, label: "P0-a" }, async () => {
      order.push("P0-a");
    });
    const p0b = scheduler.runWithSlot({ priority: SlotPriority.P0_OWNER, label: "P0-b" }, async () => {
      order.push("P0-b");
    });

    holder.release();
    await Promise.all([p3, p2, p1, p0a, p0b]);

    assert.deepStrictEqual(order, ["P0-a", "P0-b", "P1", "P2", "P3"]);
  });

  it("preempts a multi-round P1_BUILDER at the next round boundary without aborting in-flight round, then resumes without lost work", async () => {
    const scheduler = new PrioritySlotScheduler();
    const events: string[] = [];
    let round1Finished = false;
    const completedRounds: number[] = [];

    let signalRound1Started!: () => void;
    const round1Started = new Promise<void>((r) => {
      signalRound1Started = r;
    });

    const builderPromise = scheduler.runWithSlot(
      { priority: SlotPriority.P1_BUILDER, label: "multi-round-builder" },
      async (lease) => {
        for (let round = 1; round <= 3; round++) {
          events.push(`builder:round-${round}:start`);
          if (round === 1) {
            signalRound1Started();
          }
          // Simulate in-flight LLM round
          await delay(30);
          if (round === 1) {
            round1Finished = true;
          }
          completedRounds.push(round);
          events.push(`builder:round-${round}:end`);

          // Check preemption at round boundary
          if (lease.shouldPreempt()) {
            events.push(`builder:yield-after-round-${round}`);
            await lease.yieldIfPreempted();
            events.push(`builder:resumed-before-round-${round + 1}`);
          }
        }
      }
    );

    // Wait until builder is mid-flight in round 1
    await round1Started;

    // Enqueue P0_OWNER while round 1 is in-flight
    const ownerPromise = scheduler.runWithSlot(
      { priority: SlotPriority.P0_OWNER, label: "owner-turn" },
      async () => {
        assert.strictEqual(
          round1Finished,
          true,
          "In-flight builder round 1 must complete cleanly before P0_OWNER runs"
        );
        events.push("owner:run");
        await delay(10);
      }
    );

    await Promise.all([builderPromise, ownerPromise]);

    assert.deepStrictEqual(completedRounds, [1, 2, 3], "Builder must complete all rounds without lost work");
    const ownerIdx = events.indexOf("owner:run");
    const r1EndIdx = events.indexOf("builder:round-1:end");
    const r2StartIdx = events.indexOf("builder:round-2:start");
    assert.ok(r1EndIdx !== -1 && ownerIdx > r1EndIdx, "Owner must run after round 1 ends");
    assert.ok(r2StartIdx > ownerIdx, "Builder round 2 must resume after owner finishes");
  });

  it("releaseForWait(fn) allows P0 and P2 work to run during a simulated CI/test wait without waiting for builder completion", async () => {
    const scheduler = new PrioritySlotScheduler();
    const events: string[] = [];
    let waitStartedResolve!: () => void;
    const waitStarted = new Promise<void>((r) => {
      waitStartedResolve = r;
    });

    const builderPromise = scheduler.runWithSlot(
      { priority: SlotPriority.P1_BUILDER, label: "builder-with-ci-wait" },
      async (lease) => {
        events.push("builder:llm-round-1");
        await delay(10);

        const gateResult = await lease.releaseForWait(async () => {
          events.push("builder:ci-wait:start");
          waitStartedResolve();
          await delay(60);
          events.push("builder:ci-wait:end");
          return "green";
        });

        assert.strictEqual(gateResult, "green");
        events.push("builder:llm-round-2");
      }
    );

    await waitStarted;

    // During the CI wait, both P2 and P0 should be able to acquire and finish before CI wait ends
    const p2Promise = scheduler.runWithSlot(
      { priority: SlotPriority.P2_ORCHESTRATOR, label: "orchestrator-during-wait" },
      async () => {
        events.push("p2:during-wait");
        await delay(5);
      }
    );
    const p0Promise = scheduler.runWithSlot(
      { priority: SlotPriority.P0_OWNER, label: "owner-during-wait" },
      async () => {
        events.push("p0:during-wait");
        await delay(5);
      }
    );

    await Promise.all([p2Promise, p0Promise]);
    await builderPromise;

    const ciStartIdx = events.indexOf("builder:ci-wait:start");
    const ciEndIdx = events.indexOf("builder:ci-wait:end");
    const p0Idx = events.indexOf("p0:during-wait");
    const p2Idx = events.indexOf("p2:during-wait");
    const round2Idx = events.indexOf("builder:llm-round-2");

    assert.ok(p0Idx > ciStartIdx && p0Idx < ciEndIdx, "P0_OWNER must run during releaseForWait");
    assert.ok(p2Idx > ciStartIdx && p2Idx < ciEndIdx, "P2_ORCHESTRATOR must run during releaseForWait");
    assert.ok(round2Idx > ciEndIdx, "Builder round 2 must run after re-acquiring slot post-wait");
  });

  it("coordinates serializeTurn (P0_OWNER) and WorkerPool.executeJob (P1_BUILDER) on the shared scheduler", async () => {
    const queue = new JobQueue();
    const pool = new WorkerPool();
    let inFlight = 0;
    let maxObserved = 0;

    const builderJob = pool.executeJob({
      id: "wp-builder-1",
      role: "builder",
      taskFn: async () => {
        inFlight++;
        if (inFlight > maxObserved) maxObserved = inFlight;
        await delay(30);
        inFlight--;
        return "builder-done";
      },
    });

    const chatTurn = serializeTurn(
      queue,
      { id: "chat-1", threadId: "t-shared", prompt: "hello" },
      {
        runTurn: async () => {
          inFlight++;
          if (inFlight > maxObserved) maxObserved = inFlight;
          await delay(20);
          inFlight--;
        },
      }
    );

    const [builderRes] = await Promise.all([builderJob, chatTurn.settled]);
    assert.strictEqual(builderRes, "builder-done");
    assert.strictEqual(maxObserved, 1, "Chat turn and WorkerPool job must never execute concurrently");
  });
});
