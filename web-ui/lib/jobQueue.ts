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
      while (this.pending.length > 0) {
        const job = this.pending.shift()!;
        const jobExecutor = this.jobExecutors.get(job) ?? executor;
        job.position = 0;
        job.status = "running";
        this.running = job;
        try {
          await jobExecutor(job);
          job.status = "done";
        } catch {
          job.status = "failed";
        } finally {
          this.running = null;
        }
      }
    };
    this.tail = this.tail.then(run); // serialize: concurrent drains never overlap
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
