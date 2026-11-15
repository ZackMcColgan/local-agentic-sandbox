import { JobQueue, QueuedJob } from "./jobQueue";
import { createJobWorktree, removeJobWorktree, WorktreeHandle } from "./worktree";

export interface TurnGateRequest {
  id: string;
  threadId: string;
  prompt: string;
}

export interface TurnGateOptions {
  /** Host checkout root. When provided, the turn runs against its OWN git worktree. */
  repoRoot?: string;
  /** The turn body: the orchestrator pipeline for this job. */
  runTurn: (job: QueuedJob, worktree: WorktreeHandle | null) => Promise<void>;
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
  const job = queue.enqueue(req);

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
    const worktree = opts.repoRoot ? createJobWorktree(opts.repoRoot, j.id) : null;
    try {
      await opts.runTurn(j, worktree);
    } finally {
      if (worktree && opts.repoRoot) removeJobWorktree(opts.repoRoot, worktree);
    }
  });

  settled.then(() => opts.onSettled?.(job.status === "failed" ? "failed" : "done"));
  return { job, queuePosition, settled };
}
