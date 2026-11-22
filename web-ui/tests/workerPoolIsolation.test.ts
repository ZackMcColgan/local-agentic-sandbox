import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { WorkerPool } from "../lib/subagents/workerPool";

describe("WorkerPool Concurrency, Worktree Isolation & Abort-Race Guard (P1.2)", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()!();
    }
  });

  it("enforces maxConcurrency=K across N parallel jobs", async () => {
    const pool = new WorkerPool({ maxConcurrency: 2 });
    let current = 0;
    let maxObserved = 0;

    const jobs = Array.from({ length: 6 }, (_, i) =>
      pool.executeJob({
        id: `conc-${i}`,
        role: "builder",
        taskFn: async () => {
          current++;
          if (current > maxObserved) maxObserved = current;
          await new Promise((r) => setTimeout(r, 80));
          current--;
          return i;
        },
      })
    );

    const results = await Promise.all(jobs);
    assert.deepStrictEqual(results, [0, 1, 2, 3, 4, 5]);
    assert.ok(maxObserved <= 2, `Expected maxObserved <= 2, got ${maxObserved}`);
    assert.strictEqual(maxObserved, 2, `Expected maxObserved === 2, got ${maxObserved}`);
  });

  it("isolates parallel jobs in separate git worktrees and cleans them up", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp-worktree-repo-"));
    cleanups.push(() => {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    execSync("git init", { cwd: repoRoot, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: repoRoot, stdio: "ignore" });
    execSync('git config user.name "Test"', { cwd: repoRoot, stdio: "ignore" });
    fs.writeFileSync(path.join(repoRoot, "base.txt"), "base\n", "utf8");
    execSync("git add base.txt && git commit -m init", { cwd: repoRoot, stdio: "ignore" });

    const pool = new WorkerPool({ maxConcurrency: 2 });
    const seenWorktrees: string[] = [];

    const job1 = pool.executeJob({
      id: "wt-1",
      role: "builder",
      worktreeRepoRoot: repoRoot,
      taskFn: async (_signal: AbortSignal, worktreePath?: string) => {
        assert.ok(worktreePath, "Expected worktreePath for job 1");
        seenWorktrees.push(worktreePath);
        fs.writeFileSync(path.join(worktreePath, "job1-dirty.txt"), "dirty1\n", "utf8");
        await new Promise((r) => setTimeout(r, 100));
        return fs.existsSync(path.join(worktreePath, "job2-dirty.txt"));
      },
    } as unknown as Parameters<typeof pool.executeJob>[0]);

    const job2 = pool.executeJob({
      id: "wt-2",
      role: "builder",
      worktreeRepoRoot: repoRoot,
      taskFn: async (_signal: AbortSignal, worktreePath?: string) => {
        assert.ok(worktreePath, "Expected worktreePath for job 2");
        seenWorktrees.push(worktreePath);
        fs.writeFileSync(path.join(worktreePath, "job2-dirty.txt"), "dirty2\n", "utf8");
        await new Promise((r) => setTimeout(r, 100));
        return fs.existsSync(path.join(worktreePath, "job1-dirty.txt"));
      },
    } as unknown as Parameters<typeof pool.executeJob>[0]);

    const [j1SawJ2, j2SawJ1] = await Promise.all([job1, job2]);
    assert.strictEqual(j1SawJ2, false, "Job 1 must not see Job 2 uncommitted changes");
    assert.strictEqual(j2SawJ1, false, "Job 2 must not see Job 1 uncommitted changes");
    assert.notStrictEqual(
      seenWorktrees[0],
      seenWorktrees[1],
      "Jobs must run in distinct worktrees"
    );
    for (const wt of seenWorktrees) {
      assert.strictEqual(fs.existsSync(wt), false, `Worktree ${wt} should be cleaned up after job`);
    }
  });

  it("abort-race guard: aborting mid-flight yields exactly one aborted terminal state and never flips to completed", async () => {
    const pool = new WorkerPool({ maxConcurrency: 1 });
    const ac = new AbortController();
    const states: string[] = [];

    const jobPromise = pool.executeJob({
      id: "abort-race-1",
      role: "builder",
      abortSignal: ac.signal,
      onTerminalState: (s: string) => states.push(s),
      taskFn: async () => {
        // Simulate a slow tool call that resolves AFTER abort
        await new Promise((r) => setTimeout(r, 200));
        return "SHOULD_NOT_COMPLETE";
      },
    } as unknown as Parameters<typeof pool.executeJob>[0]);

    setTimeout(() => ac.abort(), 30);

    await assert.rejects(jobPromise, /aborted/i);
    // Wait past the 200ms taskFn resolution to ensure no late state flip
    await new Promise((r) => setTimeout(r, 250));
    assert.deepStrictEqual(states, ["aborted"]);
  });
});
