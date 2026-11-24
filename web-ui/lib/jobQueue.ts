export type JobStatus = "queued" | "running" | "done" | "failed";
export interface JobRequest {
  id: string;
  threadId: string;
  prompt: string;
  /** Lower numeric value = higher priority (defaults to 0; FIFO within equal priority). */
  priority?: number;
  /**
   * Optional workspace/checkout key (e.g. "/workspace" or HOST_CHECKOUT_PATH).
   * Pending jobs sharing the same non-empty workspaceKey as an active job will
   * not overlap concurrently.
   */
  workspaceKey?: string;
  /**
   * Marks the job as operating on an unisolated shared workspace when no explicit
   * workspaceKey is given; two sharedWorkspace jobs cannot overlap concurrently.
   */
  sharedWorkspace?: boolean;
}
export interface QueuedJob {
  id: string;
  threadId: string;
  prompt: string;
  position: number;
  status: JobStatus;
  priority?: number;
  workspaceKey?: string;
  sharedWorkspace?: boolean;
}
export interface JobQueueSnapshot {
  running: QueuedJob | null;
  queued: QueuedJob[];
}

/** Single-slot priority-aware FIFO job queue. Jobs execute strictly sequentially unless slot wait overlap allows non-conflicting overlap. */
export class JobQueue {
  private activeJobs = new Set<QueuedJob>();
  private pending: QueuedJob[] = [];
  private tail: Promise<void> = Promise.resolve();
  private jobExecutors = new WeakMap<QueuedJob, (job: QueuedJob) => Promise<void>>();
  /**
   * Board #129 Perf P5-B: count of running jobs currently inside a RELEASED
   * engine-slot wait phase (lease.releaseForWait). While > 0 the active drain
   * epoch may run at most `1 + overlapDepth` non-conflicting jobs concurrently:
   * the engine slot arbiter (PrioritySlotScheduler), not the queue, is what
   * serializes LLM dispatches.
   */
  private overlapDepth = 0;
  /** Pump callback of the currently active drain epoch (single epoch at a time). */
  private activePump: (() => void) | null = null;

  /**
   * Called by the turn gate when the running turn's slot lease releases the
   * engine for a tool wait: at most one non-conflicting queued turn starts
   * immediately instead of waiting for the whole 30-60s install/test to finish.
   */
  beginOverlap(): void {
    this.overlapDepth++;
    this.activePump?.();
  }

  /** Called when the released lease re-acquires the engine slot or aborts. */
  endOverlap(): void {
    this.overlapDepth = Math.max(0, this.overlapDepth - 1);
    this.activePump?.();
  }

  getOverlapDepth(): number {
    return this.overlapDepth;
  }

  enqueue(req: JobRequest): QueuedJob {
    const priority = req.priority ?? 0;
    const job: QueuedJob = {
      id: req.id,
      threadId: req.threadId,
      prompt: req.prompt,
      position: this.pending.length + 1,
      status: "queued",
      ...(req.priority !== undefined ? { priority: req.priority } : {}),
      ...(req.workspaceKey !== undefined ? { workspaceKey: req.workspaceKey } : {}),
      ...(req.sharedWorkspace !== undefined ? { sharedWorkspace: req.sharedWorkspace } : {}),
    };
    let insertIdx = this.pending.length;
    for (let i = 0; i < this.pending.length; i++) {
      const existingPriority = this.pending[i].priority ?? 0;
      if (priority < existingPriority) {
        insertIdx = i;
        break;
      }
    }
    this.pending.splice(insertIdx, 0, job);
    this.recomputePositions();
    return job;
  }

  private recomputePositions(): void {
    this.pending.forEach((j, i) => {
      j.position = i + 1;
    });
  }

  private resolveWorkspaceKey(
    job: Pick<QueuedJob, "workspaceKey" | "sharedWorkspace">
  ): string | null {
    if (typeof job.workspaceKey === "string" && job.workspaceKey.trim()) {
      return job.workspaceKey.trim();
    }
    if (job.sharedWorkspace) {
      return "__shared_workspace__";
    }
    return null;
  }

  private canRunConcurrentlyWithActive(job: QueuedJob): boolean {
    const jobWorkspace = this.resolveWorkspaceKey(job);
    for (const active of this.activeJobs) {
      if (active.threadId === job.threadId) {
        return false;
      }
      if (jobWorkspace !== null) {
        const activeWorkspace = this.resolveWorkspaceKey(active);
        if (activeWorkspace !== null && activeWorkspace === jobWorkspace) {
          return false;
        }
      }
    }
    return true;
  }

  private takeNextRunnableJob(): QueuedJob | null {
    for (let i = 0; i < this.pending.length; i++) {
      if (this.canRunConcurrentlyWithActive(this.pending[i])) {
        const [job] = this.pending.splice(i, 1);
        this.recomputePositions();
        return job;
      }
    }
    return null;
  }

  snapshot(): JobQueueSnapshot {
    const running = this.activeJobs.values().next().value ?? null;
    return {
      running,
      queued: this.pending.map((j, i) => ({ ...j, position: i + 1 })),
    };
  }

  drain(executor: (job: QueuedJob) => Promise<void>): Promise<void> {
    // Bind each queued job to the caller's executor so overlapping turns run their own closures.
    for (const job of this.pending) {
      if (!this.jobExecutors.has(job)) {
        this.jobExecutors.set(job, executor);
      }
    }
    if (this.activePump) {
      queueMicrotask(() => this.activePump?.());
    }
    const run = async (): Promise<void> => {
      return new Promise<void>((resolve) => {
        let settled = false;
        const maybeResolve = (): void => {
          if (settled) return;
          if (this.pending.length === 0 && this.activeJobs.size === 0) {
            settled = true;
            if (this.activePump === pump) {
              this.activePump = null;
              this.overlapDepth = 0;
            }
            resolve();
          }
        };
        const startJob = (job: QueuedJob): void => {
          const jobExecutor = this.jobExecutors.get(job) ?? executor;
          job.position = 0;
          job.status = "running";
          this.activeJobs.add(job);
          void (async () => {
            try {
              await jobExecutor(job);
              job.status = "done";
            } catch {
              job.status = "failed";
            } finally {
              this.activeJobs.delete(job);
              pump();
            }
          })();
        };
        const pump = (): void => {
          while (this.activeJobs.size < 1 + this.overlapDepth) {
            const job = this.takeNextRunnableJob();
            if (!job) break;
            startJob(job);
          }
          maybeResolve();
        };
        this.activePump = pump;
        pump();
      });
    };
    this.tail = this.tail.then(run); // serialize epochs: concurrent drains never overlap
    return this.tail;
  }
}
export function submitJob(
  queue: JobQueue,
  req: JobRequest,
  executor: (job: QueuedJob) => Promise<void>
) {
  const job = queue.enqueue(req);
  const snapshot = queue.snapshot();
  const settled = queue.drain(executor);
  return { job, snapshot, settled };
}
