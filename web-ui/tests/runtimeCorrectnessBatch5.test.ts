import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnWrappedPowerShell } from "../../host-bridge/powershellRunner";
import { LlamaCppProvider, OllamaProvider } from "../lib/llm/provider";
import { ThrottledStreamSnapshot } from "../lib/streamSnapshot";
import { BoardStore } from "../lib/board/boardStore";
import { BoardControlStore } from "../lib/board/boardControlStore";
import { JobQueue, submitJob } from "../lib/jobQueue";
import { ThreadStore } from "../lib/threads/threadStore";
import { POST as threadByIdPost } from "../app/api/threads/[id]/route";

function runWrappedPs(
  command: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawnWrappedPowerShell(command, process.cwd());
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    proc.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("Batch 5 — Runtime Correctness Cluster", () => {
  it(
    "N-R4: PowerShell wrapper reflects NativeCommandError failure under $ErrorActionPreference='Stop' without exiting 0",
    { skip: process.platform !== "win32" },
    async () => {
      // 1. Failing native command under $ErrorActionPreference='Stop' must exit non-zero and surface stderr
      const failRes = await runWrappedPs(
        `$ErrorActionPreference = 'Stop'; cmd /c "echo native-boom 1>&2 && exit 1"; Write-Output "SHOULD_NOT_RUN"`
      );
      assert.notEqual(failRes.code, 0, "Failed native command under Stop must not exit 0");
      assert.ok(
        failRes.stderr.includes("native-boom"),
        `Expected stderr to include native-boom, got: ${failRes.stderr}`
      );

      // 2. Native stderr with exit 0 under Stop aborts scriptblock -> must NOT silently exit 0 as if trailing ran
      const abortedRes = await runWrappedPs(
        `$ErrorActionPreference = 'Stop'; cmd /c "echo native-warn 1>&2 && exit 0"; Write-Output "TRAILING_RAN"`
      );
      if (!abortedRes.stdout.includes("TRAILING_RAN")) {
        assert.notEqual(
          abortedRes.code,
          0,
          "If NativeCommandError aborted trailing commands, wrapper must not report exit 0"
        );
      }

      // 3. Normal native stderr with exit 0 (default Continue) stays clean and runs trailing commands
      const okRes = await runWrappedPs(
        `cmd /c "echo progress-info 1>&2 && exit 0"; Write-Output "TRAILING_OK"`
      );
      assert.equal(okRes.code, 0);
      assert.ok(okRes.stdout.includes("TRAILING_OK"));
    }
  );

  it("N-R3: LLM stream readers attach at most one abort listener per stream and cancel reader on break", async () => {
    const origFetch = globalThis.fetch;
    let cancelCalled = false;
    let addListenerCount = 0;
    let removeListenerCount = 0;

    const ac = new AbortController();
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      if (args[0] === "abort") addListenerCount++;
      return origAdd(...args);
    }) as AbortSignal["addEventListener"];
    ac.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      if (args[0] === "abort") removeListenerCount++;
      return origRemove(...args);
    }) as AbortSignal["removeEventListener"];

    const encoder = new TextEncoder();
    let chunkIdx = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIdx < 10) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: `tok${chunkIdx} ` } }] })}\n\n`
            )
          );
          chunkIdx++;
        } else {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
      cancel() {
        cancelCalled = true;
      },
    });

    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    try {
      const provider = new LlamaCppProvider();
      let seen = 0;
      for await (const chunk of provider.streamChat("http://127.0.0.1:11434", {
        model: "test",
        messages: [{ role: "user", content: "hi" }],
        signal: ac.signal,
      })) {
        if (chunk.message?.content) seen++;
        if (seen === 3) break;
      }
      assert.equal(addListenerCount, 1, `Expected 1 abort listener, got ${addListenerCount}`);
      assert.equal(
        removeListenerCount,
        1,
        `Expected abort listener cleaned up, got ${removeListenerCount}`
      );
      assert.equal(cancelCalled, true, "Expected reader.cancel() to be called on early break");
    } finally {
      globalThis.fetch = origFetch;
    }

    // Also verify OllamaProvider attaches 1 listener across multiple chunks
    let ollamaAdds = 0;
    let ollamaRemoves = 0;
    const ac2 = new AbortController();
    const oAdd = ac2.signal.addEventListener.bind(ac2.signal);
    const oRem = ac2.signal.removeEventListener.bind(ac2.signal);
    ac2.signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      if (args[0] === "abort") ollamaAdds++;
      return oAdd(...args);
    }) as AbortSignal["addEventListener"];
    ac2.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      if (args[0] === "abort") ollamaRemoves++;
      return oRem(...args);
    }) as AbortSignal["removeEventListener"];

    let oIdx = 0;
    const oStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (oIdx < 5) {
          controller.enqueue(
            encoder.encode(`${JSON.stringify({ message: { content: `o${oIdx}` }, done: false })}\n`)
          );
          oIdx++;
        } else {
          controller.enqueue(
            encoder.encode(`${JSON.stringify({ message: { content: "" }, done: true })}\n`)
          );
          controller.close();
        }
      },
    });
    globalThis.fetch = (async () => new Response(oStream, { status: 200 })) as typeof fetch;
    try {
      const provider = new OllamaProvider();
      for await (const _chunk of provider.streamChat("http://127.0.0.1:11434", {
        model: "test",
        messages: [{ role: "user", content: "hi" }],
        signal: ac2.signal,
      })) {
        // consume all
      }
      assert.equal(ollamaAdds, 1, `Expected 1 abort listener in OllamaProvider, got ${ollamaAdds}`);
      assert.equal(
        ollamaRemoves,
        1,
        `Expected 1 abort listener removal in OllamaProvider, got ${ollamaRemoves}`
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("N-R3: LlamaCppProvider.generate() strips inline <think>...</think> tags from returned text", async () => {
    const origFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<think>secret reasoning" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: " more thought</think>Final JSON answer" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    let idx = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (idx < chunks.length) {
          controller.enqueue(encoder.encode(chunks[idx++]));
        } else {
          controller.close();
        }
      },
    });

    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    try {
      const provider = new LlamaCppProvider();
      let capturedThinking = "";
      const res = await provider.generate(
        {
          model: "test",
          prompt: "hi",
          onThinkingChunk: (_d, cum) => {
            capturedThinking = cum;
          },
        },
        "http://127.0.0.1:11434"
      );
      assert.equal(res.text, "Final JSON answer");
      assert.ok(!res.text.includes("<think>"));
      assert.ok(capturedThinking.includes("secret reasoning"));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("N-R6: ThrottledStreamSnapshot.maybeWrite('') preserves previously streamed prose", () => {
    const written: Array<{ content: string }> = [];
    let now = 0;
    const snapshot = new ThrottledStreamSnapshot(
      {
        addMessage(_id, msg) {
          written.push({ content: msg.content });
        },
      },
      "thr-1",
      "msg-1",
      5000,
      () => now
    );

    snapshot.maybeWrite("Streamed prose so far", "thinking", undefined, { force: true });
    now += 6000;
    // Round boundary passes empty string "" with updated traces
    snapshot.maybeWrite(
      "",
      "thinking",
      [{ id: "t1", type: "tool", label: "read", status: "done" } as never],
      {
        force: true,
      }
    );

    assert.equal(written.length, 2);
    assert.equal(written[1].content, "Streamed prose so far");
  });

  it("N-R8: POST /api/threads/[id] setModel re-reads fresh thread instead of overwriting concurrent updates", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nr8-threads-"));
    const prevThreadsDir = process.env.THREADS_DIR;
    process.env.THREADS_DIR = tmpDir;
    try {
      const store = new ThreadStore(tmpDir);
      const created = store.createThread({ title: "Initial", model: "model-a" });

      // Simulate concurrent save of a message while setModel is processed
      const origGetThread = ThreadStore.prototype.getThread;
      let calls = 0;
      ThreadStore.prototype.getThread = async function (threadId: string) {
        calls++;
        const t = await origGetThread.call(this, threadId);
        if (calls === 1 && t) {
          // After initial read in handler, simulate concurrent writer adding a message on disk
          const updated = structuredClone(t);
          updated.messages.push({
            id: "concurrent-msg",
            role: "assistant",
            content: "Concurrent reply",
            timestamp: new Date().toISOString(),
          });
          store.saveThread(updated);
        }
        return t;
      };

      try {
        const req = new Request(`http://localhost:3000/api/threads/${created.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "setModel", model: "model-b" }),
        });
        const res = await threadByIdPost(req, { params: Promise.resolve({ id: created.id }) });
        assert.equal(res.status, 200);
        const reloaded = await origGetThread.call(store, created.id);
        assert.equal(reloaded?.model, "model-b");
        assert.ok(
          reloaded?.messages.some((m) => m.id === "concurrent-msg"),
          "setModel must not clobber concurrently saved messages"
        );
      } finally {
        ThreadStore.prototype.getThread = origGetThread;
      }
    } finally {
      if (prevThreadsDir === undefined) delete process.env.THREADS_DIR;
      else process.env.THREADS_DIR = prevThreadsDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("HO-6: BoardControlStore Stop/Pause transitions working items out of working so reconciliation does not auto-requeue; Start re-queues them", async () => {
    const tmpBoardDir = fs.mkdtempSync(path.join(os.tmpdir(), "ho6-board-"));
    try {
      const boardStore = new BoardStore(tmpBoardDir);
      const item = boardStore.create({
        title: "Active job",
        brief: "Do work",
        author: "Owner",
        source: "manual",
      });
      boardStore.update(item.id, { status: "working" });

      const controlStore = new BoardControlStore(tmpBoardDir, {
        abortTurn: () => true,
        clearTurn: () => {},
        cancelTaskFn: () => true,
        unloadModels: async () => [],
      });

      await controlStore.applyAction("stop");
      const afterStop = boardStore.get(item.id);
      assert.equal(afterStop?.status, "parked", "Stop must transition working item to parked");
      assert.equal(afterStop?.parkedReason, "Stopped by owner");

      // Explicit owner start re-queues the owner-stopped item
      await controlStore.applyAction("start");
      const afterStart = boardStore.get(item.id);
      assert.equal(afterStart?.status, "queued", "Start must re-queue owner-stopped item");
    } finally {
      fs.rmSync(tmpBoardDir, { recursive: true, force: true });
    }
  });

  it("N-R2/UI-H3: JobQueue waitForJob resolves when Job A completes even while Job B is still running", async () => {
    const queue = new JobQueue();
    let releaseJobB!: () => void;
    const jobBGate = new Promise<void>((r) => {
      releaseJobB = r;
    });

    const subA = submitJob(queue, { id: "job-a", threadId: "thr-a", prompt: "a" }, async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const subB = submitJob(queue, { id: "job-b", threadId: "thr-b", prompt: "b" }, async () => {
      await jobBGate;
    });

    // The per-job waitForJob promise resolves as soon as Job A finishes,
    // WITHOUT waiting for Job B. (submitJob's `settled` keeps its original
    // whole-queue drain meaning, pinned by AC1 in jobQueueIsolation.test.ts.)
    let jobASettled = false;
    void queue.waitForJob("job-a").then(() => {
      jobASettled = true;
    });

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(jobASettled, true, "waitForJob('job-a') must resolve without waiting for Job B");

    releaseJobB();
    await subB.settled;
    await subA.settled;
  });
});
