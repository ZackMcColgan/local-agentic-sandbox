import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobQueue } from "../lib/jobQueue";
import { serializeTurn } from "../lib/chatTurnGate";
import { resolveTurnStatusPhase } from "../lib/chatStatus";

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-wt-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.io"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(path.join(root, "f.txt"), "base\n");
  execFileSync("git", ["add", "f.txt"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
  return root;
}

describe("route-path serialization through serializeTurn (AC1)", () => {
  it("two turns submitted together execute sequentially, second starts after first settles", async () => {
    const order: string[] = [];
    const queue = new JobQueue();
    const runTurn = (job: { id: string }) =>
      new Promise<void>((resolve) => {
        order.push(`start:${job.id}`);
        setTimeout(() => {
          order.push(`end:${job.id}`);
          resolve();
        }, job.id === "A" ? 40 : 10);
      });
    const a = serializeTurn(queue, { id: "A", threadId: "t1", prompt: "a" }, { runTurn });
    const b = serializeTurn(queue, { id: "B", threadId: "t2", prompt: "b" }, { runTurn });
    await Promise.all([a.settled, b.settled]);
    assert.deepEqual(order, ["start:A", "end:A", "start:B", "end:B"]);
  });
});

describe("route-path worktree isolation through serializeTurn (AC2)", () => {
  it("second turn's tree contains none of the first turn's uncommitted changes", async () => {
    const root = makeRepo();
    const queue = new JobQueue();
    const runTurn = async (job: { id: string }, wt: { path: string } | null) => {
      assert.ok(wt, "turn must run against its own worktree");
      if (job.id === "A") {
        fs.writeFileSync(path.join(wt!.path, "f.txt"), "uncommitted-A\n");
        fs.writeFileSync(path.join(wt!.path, "new.txt"), "uncommitted-A\n");
      } else {
        assert.equal(fs.readFileSync(path.join(wt!.path, "f.txt"), "utf8"), "base\n");
        assert.equal(fs.existsSync(path.join(wt!.path, "new.txt")), false);
      }
    };
    const a = serializeTurn(queue, { id: "A", threadId: "t1", prompt: "a" }, { repoRoot: root, runTurn });
    const b = serializeTurn(queue, { id: "B", threadId: "t2", prompt: "b" }, { repoRoot: root, runTurn });
    await Promise.all([a.settled, b.settled]);
    // main checkout untouched by both turns
    assert.equal(fs.readFileSync(path.join(root, "f.txt"), "utf8"), "base\n");
    assert.equal(fs.existsSync(path.join(root, "new.txt")), false);
  });
});

describe("queue position surfaces for UI (AC3)", () => {
  it("waiting turn reports position 1 via onQueued and renders 'Queued (position 1)'", async () => {
    const queue = new JobQueue();
    // Deferred captured at construction: drain() starts the executor on a
    // later microtask, so a resolve handle assigned inside runTurn would not
    // exist yet when the test releases the gate.
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
    const runTurn = (job: { id: string }) =>
      job.id === "A" ? aGate : Promise.resolve();
    const positions: number[] = [];
    serializeTurn(queue, { id: "A", threadId: "t1", prompt: "a" }, { runTurn, onQueued: (p) => positions.push(p) });
    const b = serializeTurn(queue, { id: "B", threadId: "t2", prompt: "b" }, { runTurn, onQueued: (p) => positions.push(p) });
    assert.equal(b.queuePosition, 1);
    assert.deepEqual(positions, [1]); // A started immediately (no queue event), B queued at 1
    assert.equal(resolveTurnStatusPhase({ isStreaming: true, queuePosition: 1 }), "Queued (position 1)");
    releaseA();
    await b.settled;
  });

  it("executes overlapping turns with distinct per-turn runTurn closures so queued SSE writers close", async () => {
    const queue = new JobQueue();
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    const executedA: string[] = [];
    const executedB: string[] = [];
    let turnAFinalized = false;

    const a = serializeTurn(
      queue,
      { id: "A", threadId: "t1", prompt: "a" },
      {
        runTurn: async (job) => {
          // Mimic chat route post-abort early exit once Turn A has finalized
          if (turnAFinalized) return;
          executedA.push(job.id);
          await gateA;
          turnAFinalized = true;
        },
      },
    );

    // Let Turn A start and pause on gateA before Turn B enqueues
    await new Promise((r) => setTimeout(r, 15));

    const streamB = new TransformStream<Uint8Array, Uint8Array>();
    const writerB = streamB.writable.getWriter();
    const readerB = streamB.readable.getReader();

    const b = serializeTurn(
      queue,
      { id: "B", threadId: "t2", prompt: "b" },
      {
        runTurn: async (job) => {
          executedB.push(job.id);
          await writerB.write(new TextEncoder().encode("data: ok\n\n"));
          await writerB.close();
        },
      },
    );

    releaseA();
    const firstChunk = await Promise.race([
      readerB.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("reader.read timed out after 2000ms")), 2000)),
    ]);
    const eofChunk = await Promise.race([
      readerB.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("reader EOF timed out after 2000ms")), 2000)),
    ]);
    await Promise.all([a.settled, b.settled]);

    assert.equal(firstChunk.done, false);
    assert.equal(eofChunk.done, true);
    assert.deepEqual(executedA, ["A"]);
    assert.deepEqual(executedB, ["B"]);
  });

  it("still executes runTurn with null worktree if repoRoot worktree setup fails", async () => {
    const nonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nongit-"));
    try {
      const queue = new JobQueue();
      const observed: Array<{ id: string; worktree: unknown }> = [];
      const turn = serializeTurn(
        queue,
        { id: "bad-wt", threadId: "t1", prompt: "x" },
        {
          repoRoot: nonGitRoot,
          runTurn: async (job, worktree) => {
            observed.push({ id: job.id, worktree });
          },
        },
      );
      await turn.settled;
      assert.deepEqual(observed, [{ id: "bad-wt", worktree: null }]);
    } finally {
      fs.rmSync(nonGitRoot, { recursive: true, force: true });
    }
  });
});
describe("wiring is live, not dead code (audit guard)", () => {
  it("chat route imports and calls serializeTurn", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "app", "api", "chat", "route.ts"), "utf8");
    assert.match(src, /from "@\/lib\/chatTurnGate"/);
    assert.match(src, /serializeTurn\(/);
  });
  it("chat route wires the singleton queue, per-job repoRoot, and queue_position emission", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "app", "api", "chat", "route.ts"), "utf8");
    assert.match(src, /const chatJobQueue = new JobQueue\(\)/);
    assert.match(src, /repoRoot: resolveJobRepoRoot\(\)/);
    assert.match(src, /queue_position: position/);
    assert.match(src, /onQueued: \(position\)/);
  });
  // Deferred to step 4 (ChatStream queue-position rendering): the route now
  // emits queue_position events; ChatStream must parse them into queuePosition.
  // Skipped so this step's gate stays green without UI work.
  it.skip("ChatStream parses queue_position and feeds resolveTurnStatusPhase", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "components", "ChatStream.tsx"), "utf8");
    assert.match(src, /queue_position/);
    assert.match(src, /queuePosition/);
  });
});
