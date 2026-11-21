import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobQueue, submitJob, type QueuedJob } from "../lib/jobQueue";
import { createJobWorktree, removeJobWorktree } from "../lib/worktree";
import { resolveTurnStatusPhase } from "../lib/chatStatus";

describe("AC1 sequential execution", () => {
  it("second job starts only after first finishes", async () => {
    const order: string[] = [];
    const q = new JobQueue();
    const slow = (job: QueuedJob) =>
      new Promise<void>((res) => {
        order.push(`start:${job.id}`);
        setTimeout(
          () => {
            order.push(`end:${job.id}`);
            res();
          },
          job.id === "A" ? 40 : 10
        );
      });
    const { settled } = submitJob(q, { id: "A", threadId: "t1", prompt: "a" }, slow);
    submitJob(q, { id: "B", threadId: "t2", prompt: "b" }, slow);
    await settled;
    assert.deepEqual(order, ["start:A", "end:A", "start:B", "end:B"]);
  });
});

describe("AC3 queue position", () => {
  it("while the first job runs, the waiting job reports position 1", async () => {
    const q = new JobQueue();
    let releaseA: () => void = () => {};
    const exec = (job: QueuedJob) =>
      job.id === "A"
        ? new Promise<void>((res) => {
            releaseA = res;
          })
        : Promise.resolve();
    submitJob(q, { id: "A", threadId: "t1", prompt: "a" }, exec);
    submitJob(q, { id: "B", threadId: "t2", prompt: "b" }, exec);
    await new Promise((r) => setTimeout(r, 10));
    const snap = q.snapshot();
    assert.equal(snap.running?.id, "A");
    assert.equal(snap.running?.position, 0);
    assert.equal(snap.queued[0].id, "B");
    assert.equal(snap.queued[0].position, 1);
    releaseA();
    await new Promise((r) => setTimeout(r, 20));
  });
  it("queued job renders 'Queued (position N)' in the UI phase reducer", () => {
    assert.equal(
      resolveTurnStatusPhase({ isStreaming: true, queuePosition: 2 }),
      "Queued (position 2)"
    );
    assert.equal(
      resolveTurnStatusPhase({
        isStreaming: true,
        queuePosition: 0,
        activeTool: "workspace_write_file",
      }),
      "Running workspace_write_file"
    );
  });
});

describe("AC2 worktree isolation", () => {
  it("second job tree contains none of first job uncommitted changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t.io"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
    fs.writeFileSync(path.join(root, "f.txt"), "base\n");
    execFileSync("git", ["add", "f.txt"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
    const hA = createJobWorktree(root, "A");
    fs.writeFileSync(path.join(hA.path, "f.txt"), "uncommitted-A\n");
    fs.writeFileSync(path.join(hA.path, "new.txt"), "uncommitted-A\n");
    const hB = createJobWorktree(root, "B");
    assert.equal(fs.readFileSync(path.join(hB.path, "f.txt"), "utf8"), "base\n");
    assert.equal(fs.existsSync(path.join(hB.path, "new.txt")), false);
    removeJobWorktree(root, hA);
    removeJobWorktree(root, hB);
  });
});

describe("distinct executor per queued job", () => {
  it("invokes queued job B's own executor rather than reusing job A's executor", async () => {
    const q = new JobQueue();
    const seenByA: string[] = [];
    const seenByB: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });

    q.enqueue({ id: "A", threadId: "t1", prompt: "a" });
    const drainA = q.drain(async (job) => {
      seenByA.push(job.id);
      await gateA;
    });

    await new Promise((r) => setTimeout(r, 10));
    let resolveB!: () => void;
    const doneB = new Promise<void>((r) => {
      resolveB = r;
    });

    q.enqueue({ id: "B", threadId: "t2", prompt: "b" });
    const drainB = q.drain(async (job) => {
      seenByB.push(job.id);
      resolveB();
    });

    releaseA();
    await Promise.race([
      Promise.all([drainA, drainB, doneB]),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("queued job B executor did not run within 1000ms")), 1000)
      ),
    ]);

    assert.deepEqual(seenByA, ["A"]);
    assert.deepEqual(seenByB, ["B"]);
  });
});
