import { JobQueue, QueuedJob } from "./jobQueue";
import { createJobWorktree, removeJobWorktree, WorktreeHandle } from "./worktree";
import {
  getSharedSlotScheduler,
  PrioritySlotScheduler,
  SlotLease,
  SlotPriority,
} from "./slotScheduler";

export interface TurnGateRequest {
  id: string;
  threadId: string;
  prompt: string;
}

export interface TurnGateOptions {
  /** Host checkout root. When provided, the turn runs against its OWN git worktree. */
  repoRoot?: string;
  /** The turn body: the orchestrator pipeline for this job. */
  runTurn: (job: QueuedJob, worktree: WorktreeHandle | null, lease?: SlotLease) => Promise<void>;
  /** Priority for the shared single-slot arbiter (defaults to P0_OWNER). */
  priority?: SlotPriority;
  /** Optional scheduler override (defaults to globalThis-backed shared scheduler). */
  scheduler?: PrioritySlotScheduler;
  /** Optional abort signal for slot acquisition. */
  signal?: AbortSignal;
  /** Fired once when this turn is queued behind another running turn (1-based queue position). */
  onQueued?: (position: number) => void;
  /** Fired when the turn settles ("done" | "failed"). */
  onSettled?: (status: "done" | "failed") => void;
}

export interface TurnGateHandle {
  job: QueuedJob;
  /** 0 = starts immediately; >=1 = waiting in queue at this position. */
  queuePosition: number;
  settled: Promise<void>;
}

/**
 * job-queue-isolation seam: serialize chat job turns through a single JobQueue
 * (one turn executes at a time, FIFO) and give each turn its own git worktree
 * of the host checkout so queued turns can never sweep each other's
 * uncommitted work into the wrong branch.
 */
export function serializeTurn(
  queue: JobQueue,
  req: TurnGateRequest,
  opts: TurnGateOptions
): TurnGateHandle {
  const job = queue.enqueue({
    ...req,
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
  });

  // Decide queue position BEFORE draining: a turn is "queued" only when
  // something is ahead of it (a running turn, or another pending turn).
  const snap = queue.snapshot();
  const idx = snap.queued.findIndex((q) => q.id === req.id);
  // Position = number of turns ahead of this one. drain() starts asynchronously,
  // so a turn enqueued before any drain began is still in pending: the jobs
  // ahead of it are its pending index. Once a turn is running, pending jobs
  // are 1-based behind that running turn.
  const queued = snap.running !== null || idx > 0;
  const queuePosition = queued ? (snap.running !== null ? idx + 1 : idx) : 0;
  if (queuePosition > 0) opts.onQueued?.(queuePosition);

  const settled = queue.drain(async (j) => {
    let worktree: WorktreeHandle | null = null;
    if (opts.repoRoot) {
      try {
        worktree = createJobWorktree(opts.repoRoot, j.id);
      } catch {
        worktree = null;
      }
    }
    try {
      const scheduler = opts.scheduler ?? getSharedSlotScheduler();
      const priority = opts.priority ?? SlotPriority.P0_OWNER;
      await scheduler.runWithSlot(
        {
          priority,
          label: `chat:${j.threadId}`,
          signal: opts.signal,
        },
        async (lease) => {
          await opts.runTurn(j, worktree, lease);
        }
      );
    } finally {
      if (worktree && opts.repoRoot) {
        try {
          removeJobWorktree(opts.repoRoot, worktree);
        } catch {}
      }
    }
  });

  settled.then(() => opts.onSettled?.(job.status === "failed" ? "failed" : "done"));
  return { job, queuePosition, settled };
}
