export type JobStatus = "queued" | "running" | "done" | "failed";
export interface JobRequest {
  id: string;
  threadId: string;
  prompt: string;
  /** Lower numeric value = higher priority (defaults to 0; FIFO within equal priority). */
  priority?: number;
}
export interface QueuedJob {
  id: string;
  threadId: string;
  prompt: string;
  position: number;
  status: JobStatus;
  priority?: number;
}
export interface JobQueueSnapshot {
  running: QueuedJob | null;
  queued: QueuedJob[];
}

/** Single-slot priority-aware FIFO job queue. Jobs execute strictly sequentially. */
export class JobQueue {
  private running: QueuedJob | null = null;
  private pending: QueuedJob[] = [];
  private tail: Promise<void> = Promise.resolve();
  private jobExecutors = new WeakMap<QueuedJob, (job: QueuedJob) => Promise<void>>();
  /**
   * Board #129 Perf P5-B: count of running jobs currently inside a RELEASED
   * engine-slot wait phase (lease.releaseForWait). While > 0 the active drain
   * epoch may start the next queued job concurrently: the engine slot arbiter
   * (PrioritySlotScheduler), not the queue, is what serializes LLM dispatches.
   */
  private overlapDepth = 0;
  /** Pump callback of the currently active drain epoch (single epoch at a time). */
  private activePump: (() => void) | null = null;

  /**
   * Called by the turn gate when the running turn's slot lease releases the
   * engine for a tool wait: the next queued turn starts immediately instead of
   * waiting for the whole 30-60s install/test to finish.
   */
  beginOverlap(): void {
    this.overlapDepth++;
    this.activePump?.();
  }

  /** Called when the released lease re-acquires the engine slot. */
  endOverlap(): void {
    this.overlapDepth = Math.max(0, this.overlapDepth - 1);
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
    this.pending.forEach((j, i) => {
      j.position = i + 1;
    });
    return job;
  }
  snapshot(): JobQueueSnapshot {
    return {
      running: this.running,
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
    const run = async (): Promise<void> => {
      const started: Promise<void>[] = [];
      const startJob = (job: QueuedJob): Promise<void> => {
        const jobExecutor = this.jobExecutors.get(job) ?? executor;
        job.position = 0;
        job.status = "running";
        this.running = job;
        const p = (async () => {
          try {
            await jobExecutor(job);
            job.status = "done";
          } catch {
            job.status = "failed";
          } finally {
            if (this.running === job) {
              this.running = null;
            }
          }
        })();
        started.push(p);
        return p;
      };
      return new Promise<void>((resolve) => {
        const pump = (): void => {
          if (this.pending.length === 0) {
            void Promise.all(started).then(() => {
              if (this.activePump === pump) {
                this.activePump = null;
                this.overlapDepth = 0;
              }
              resolve();
            });
            return;
          }
          const job = this.pending.shift()!;
          const p = startJob(job);
          // Strict FIFO unless the running turn has released the engine slot
          // for a tool wait (#129 P5-B): then the next queued turn may overlap,
          // and the slot arbiter still serializes actual LLM dispatches.
          if (this.overlapDepth > 0) {
            pump();
          } else {
            p.then(pump);
          }
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
