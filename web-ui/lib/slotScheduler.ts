import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Strict priority levels for the single-slot engine arbiter.
 * Lower numeric value = higher priority.
 */
export enum SlotPriority {
  P0_OWNER = 0,
  P1_BUILDER = 1,
  P2_ORCHESTRATOR = 2,
  P3_HOUSEKEEPING = 3,
}

export interface AcquireSlotOptions {
  priority: SlotPriority;
  label?: string;
  signal?: AbortSignal;
  onQueued?: (position: number) => void;
}

export type SlotWaitKind = "tool" | "ci";

export interface SlotUtilizationMetrics {
  generatingMs: number;
  waitingToolMs: number;
  waitingCiMs: number;
  idleGapMs: number;
  totalObservedMs: number;
  slotUtilizationPct: number;
  preemptionsCount: number;
  ownerWaitMs: {
    p50: number;
    p95: number;
    count: number;
  };
  completedJobs: number;
  jobsPerHour: number;
}

export interface SlotSchedulerOptions {
  now?: () => number;
}

export interface SlotLease {
  readonly id: string;
  readonly priority: SlotPriority;
  readonly label?: string;
  /** True while this lease currently holds the single engine slot. */
  isHolding(): boolean;
  /**
   * True when a higher-priority request is waiting in the queue.
   * Builders check this at round/chunk boundaries to yield cleanly.
   */
  shouldPreempt(): boolean;
  /**
   * If a higher-priority waiter is queued, releases the slot, waits to
   * re-acquire at this lease's priority, and resumes cleanly.
   */
  yieldIfPreempted(): Promise<void>;
  /**
   * Releases the engine slot while running a non-LLM wait phase (e.g. test:gate,
   * git/worktree commands, CI polls) so higher-or-equal priority work can use
   * the slot, then re-acquires before returning.
   */
  releaseForWait<T>(fn: () => Promise<T> | T, waitKind?: SlotWaitKind): Promise<T>;
  /** Idempotently releases the slot if currently held by this lease. */
  release(): void;
}

export interface SlotSchedulerSnapshot {
  active: { id: string; priority: SlotPriority; label?: string } | null;
  queued: Array<{ id: string; priority: SlotPriority; label?: string; position: number }>;
  preemptionPending: boolean;
}

interface Waiter {
  id: string;
  priority: SlotPriority;
  label?: string;
  seq: number;
  enqueuedAt: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  grant: () => void;
}

interface LeaseState {
  id: string;
  priority: SlotPriority;
  label?: string;
  signal?: AbortSignal;
  holding: boolean;
  acquiredAt?: number;
}

const GLOBAL_SCHEDULER_KEY = Symbol.for("local-agentic-sandbox.prioritySlotScheduler");
const leaseStorage = new AsyncLocalStorage<SlotLease>();

export class PrioritySlotScheduler {
  private activeHolder: LeaseState | null = null;
  private readonly waitQueue: Waiter[] = [];
  private seq = 0;
  private leaseSeq = 0;
  private readonly now: () => number;
  private firstObservedAt: number | null = null;
  private generatingMs = 0;
  private waitingToolMs = 0;
  private waitingCiMs = 0;
  private preemptionsCount = 0;
  private completedJobs = 0;
  private readonly ownerWaitSamplesMs: number[] = [];

  constructor(options: SlotSchedulerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Acquires the single engine slot, queuing in strict priority order
   * (`P0_OWNER > P1_BUILDER > P2_ORCHESTRATOR > P3_HOUSEKEEPING`, FIFO within
   * the same priority).
   */
  async acquire(options: AcquireSlotOptions): Promise<SlotLease> {
    const id = `slot-${++this.leaseSeq}`;
    const state: LeaseState = {
      id,
      priority: options.priority,
      label: options.label,
      signal: options.signal,
      holding: false,
    };

    await this.acquireState(state, options.onQueued);
    return this.createLease(state);
  }

  /**
   * Acquires the slot, runs `fn` with the lease bound in AsyncLocalStorage, and
   * guarantees release in `finally`.
   *
   * Uses a synchronous fast path when the slot is free and the wait queue is
   * empty so `fn` starts in the caller's tick (preserving immediate abort
   * listener registration).
   */
  runWithSlot<T>(
    options: AcquireSlotOptions,
    fn: (lease: SlotLease) => Promise<T>
  ): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(new Error("Slot acquisition aborted before acquire"));
    }

    if (!this.activeHolder && this.waitQueue.length === 0) {
      const id = `slot-${++this.leaseSeq}`;
      const ts = this.now();
      if (this.firstObservedAt === null) {
        this.firstObservedAt = ts;
      }
      const state: LeaseState = {
        id,
        priority: options.priority,
        label: options.label,
        signal: options.signal,
        holding: true,
        acquiredAt: ts,
      };
      this.activeHolder = state;
      const lease = this.createLease(state);
      try {
        return Promise.resolve(leaseStorage.run(lease, () => fn(lease))).finally(() => {
          this.completedJobs++;
          lease.release();
        });
      } catch (err) {
        lease.release();
        return Promise.reject(err);
      }
    }

    return this.acquire(options).then(async (lease) => {
      try {
        return await leaseStorage.run(lease, () => fn(lease));
      } finally {
        this.completedJobs++;
        lease.release();
      }
    });
  }

  /**
   * Returns true if a higher-priority request is waiting ahead of the current
   * holder (or ahead of `leaseId` if specified).
   */
  shouldPreempt(leaseId?: string): boolean {
    if (!this.activeHolder) return false;
    if (leaseId && this.activeHolder.id !== leaseId) return false;
    if (this.waitQueue.length === 0) return false;
    return this.waitQueue[0].priority < this.activeHolder.priority;
  }

  getSnapshot(): SlotSchedulerSnapshot {
    return {
      active: this.activeHolder
        ? {
            id: this.activeHolder.id,
            priority: this.activeHolder.priority,
            label: this.activeHolder.label,
          }
        : null,
      queued: this.waitQueue.map((w, idx) => ({
        id: w.id,
        priority: w.priority,
        label: w.label,
        position: idx + 1,
      })),
      preemptionPending: this.shouldPreempt(),
    };
  }

  getMetrics(): SlotUtilizationMetrics {
    const currentNow = this.now();
    const activeGeneratingMs =
      this.activeHolder && this.activeHolder.acquiredAt !== undefined
        ? Math.max(0, currentNow - this.activeHolder.acquiredAt)
        : 0;
    const generatingMs = this.generatingMs + activeGeneratingMs;
    const totalObservedMs =
      this.firstObservedAt !== null ? Math.max(0, currentNow - this.firstObservedAt) : 0;
    const idleGapMs = Math.max(
      0,
      totalObservedMs - generatingMs - this.waitingToolMs - this.waitingCiMs
    );
    const slotUtilizationPct =
      totalObservedMs > 0 ? Math.round((generatingMs / totalObservedMs) * 10000) / 100 : 0;
    const jobsPerHour =
      totalObservedMs > 0
        ? Math.round((this.completedJobs / (totalObservedMs / 3_600_000)) * 100) / 100
        : 0;

    const sorted = [...this.ownerWaitSamplesMs].sort((a, b) => a - b);
    const p50 = sorted.length > 0 ? sorted[Math.ceil(0.5 * sorted.length) - 1] : 0;
    const p95 = sorted.length > 0 ? sorted[Math.ceil(0.95 * sorted.length) - 1] : 0;

    return {
      generatingMs,
      waitingToolMs: this.waitingToolMs,
      waitingCiMs: this.waitingCiMs,
      idleGapMs,
      totalObservedMs,
      slotUtilizationPct,
      preemptionsCount: this.preemptionsCount,
      ownerWaitMs: {
        p50,
        p95,
        count: sorted.length,
      },
      completedJobs: this.completedJobs,
      jobsPerHour,
    };
  }

  private createLease(state: LeaseState): SlotLease {
    const lease: SlotLease = {
      id: state.id,
      priority: state.priority,
      label: state.label,
      isHolding: () => state.holding && this.activeHolder === state,
      shouldPreempt: () =>
        state.holding &&
        this.activeHolder === state &&
        this.waitQueue.length > 0 &&
        this.waitQueue[0].priority < state.priority,
      yieldIfPreempted: async () => {
        if (!lease.shouldPreempt()) return;
        this.preemptionsCount++;
        this.releaseState(state);
        await this.acquireState(state);
      },
      releaseForWait: async <T>(
        fn: () => Promise<T> | T,
        waitKind: SlotWaitKind = "tool"
      ): Promise<T> => {
        if (!lease.isHolding()) {
          return await fn();
        }
        this.releaseState(state);
        const waitStart = this.now();
        let result!: T;
        let caught: unknown;
        let hasError = false;
        try {
          result = await fn();
        } catch (err) {
          caught = err;
          hasError = true;
        }
        const waitElapsed = Math.max(0, this.now() - waitStart);
        if (waitKind === "ci") {
          this.waitingCiMs += waitElapsed;
        } else {
          this.waitingToolMs += waitElapsed;
        }
        await this.acquireState(state);
        if (hasError) {
          throw caught;
        }
        return result;
      },
      release: () => {
        this.releaseState(state);
      },
    };
    return lease;
  }

  private acquireState(
    state: LeaseState,
    onQueued?: (position: number) => void
  ): Promise<void> {
    if (state.signal?.aborted) {
      return Promise.reject(new Error("Slot acquisition aborted before acquire"));
    }

    const ts = this.now();
    if (this.firstObservedAt === null) {
      this.firstObservedAt = ts;
    }

    if (this.activeHolder === null) {
      state.holding = true;
      state.acquiredAt = ts;
      this.activeHolder = state;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        id: state.id,
        priority: state.priority,
        label: state.label,
        seq: ++this.seq,
        enqueuedAt: ts,
        signal: state.signal,
        grant: () => {
          if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
          }
          const grantTs = this.now();
          if (waiter.priority === SlotPriority.P0_OWNER) {
            this.ownerWaitSamplesMs.push(Math.max(0, grantTs - waiter.enqueuedAt));
          }
          state.holding = true;
          state.acquiredAt = grantTs;
          this.activeHolder = state;
          resolve();
        },
      };

      if (state.signal) {
        const onAbort = () => {
          const idx = this.waitQueue.indexOf(waiter);
          if (idx !== -1) {
            this.waitQueue.splice(idx, 1);
          }
          reject(new Error("Slot acquisition aborted while waiting"));
        };
        waiter.onAbort = onAbort;
        state.signal.addEventListener("abort", onAbort, { once: true });
      }

      const insertIdx = this.insertWaiterSorted(waiter);
      onQueued?.(insertIdx + 1);
    });
  }

  private insertWaiterSorted(waiter: Waiter): number {
    let idx = this.waitQueue.length;
    for (let i = 0; i < this.waitQueue.length; i++) {
      const cur = this.waitQueue[i];
      if (
        waiter.priority < cur.priority ||
        (waiter.priority === cur.priority && waiter.seq < cur.seq)
      ) {
        idx = i;
        break;
      }
    }
    this.waitQueue.splice(idx, 0, waiter);
    return idx;
  }

  private releaseState(state: LeaseState): void {
    if (!state.holding || this.activeHolder !== state) {
      return;
    }
    if (state.acquiredAt !== undefined) {
      this.generatingMs += Math.max(0, this.now() - state.acquiredAt);
      state.acquiredAt = undefined;
    }
    state.holding = false;
    this.activeHolder = null;

    const next = this.waitQueue.shift();
    if (next) {
      next.grant();
    }
  }
}

/**
 * Returns the process-wide `globalThis`-backed single-slot arbiter so all
 * routes, workers, and orchestrators share one engine slot.
 */
export function getSharedSlotScheduler(): PrioritySlotScheduler {
  const g = globalThis as Record<PropertyKey, unknown>;
  let instance = g[GLOBAL_SCHEDULER_KEY] as PrioritySlotScheduler | undefined;
  if (!instance) {
    instance = new PrioritySlotScheduler();
    g[GLOBAL_SCHEDULER_KEY] = instance;
  }
  return instance;
}

/**
 * Returns the active `SlotLease` for the current async execution context, if any.
 */
export function getCurrentSlotLease(): SlotLease | undefined {
  return leaseStorage.getStore();
}

/**
 * Releases the current async context's engine slot during a non-LLM wait phase
 * (if a slot lease is currently held), and re-acquires it before returning.
 */
export async function releaseCurrentSlotForWait<T>(fn: () => Promise<T> | T): Promise<T> {
  const lease = getCurrentSlotLease();
  if (lease && lease.isHolding()) {
    return await lease.releaseForWait(fn);
  }
  return await fn();
}
