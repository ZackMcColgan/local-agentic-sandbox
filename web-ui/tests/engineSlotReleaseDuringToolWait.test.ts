import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../app/api/chat/route";
import { serializeTurn } from "../lib/chatTurnGate";
import { JobQueue } from "../lib/jobQueue";
import {
  PrioritySlotScheduler,
  SlotPriority,
  SlotLease,
  getSharedSlotScheduler,
} from "../lib/slotScheduler";
import { getBridgeManifest, PROTOCOL_VERSION } from "../../host-bridge/manifest";

/**
 * Board #129 Perf P5 — single-slot engine eviction fixes.
 *
 * Problem A: mid-turn compaction must NOT dispatch a secondary summarization
 * LLM call (different system prompt) on the single engine slot; it defaults to
 * the synchronous extraction digest.
 *
 * Problem B: the turn's slot lease must be released during long tool waits
 * (lease.releaseForWait) so a queued turn can use the engine while the active
 * turn is blocked on a host/MCP tool, and re-acquired before the next round.
 */

interface SseEvent {
  type?: string;
  [key: string]: unknown;
}

async function readSseEvents(response: Response): Promise<SseEvent[]> {
  const text = await response.text();
  const events: SseEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      events.push(JSON.parse(raw) as SseEvent);
    } catch {}
  }
  return events;
}

function startMockServer(
  handler: (
    req: http.IncomingMessage,
    body: Record<string, unknown>,
    res: http.ServerResponse
  ) => void
): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        } catch {}
        handler(req, parsed, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

const TOOL_WAIT_MS = 250;

describe("engine slot release during tool waits (#129 P5-B)", () => {
  let tmpThreadsDir: string;
  let orig: Record<string, string | undefined> = {};
  let servers: http.Server[] = [];

  beforeEach(() => {
    tmpThreadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "slot-release-"));
    orig = {
      THREADS_DIR: process.env.THREADS_DIR,
      LLM_BASE_URL: process.env.LLM_BASE_URL,
      LLM_ENGINE: process.env.LLM_ENGINE,
      MCP_SERVER_URL: process.env.MCP_SERVER_URL,
      BROWSER_MCP_URL: process.env.BROWSER_MCP_URL,
      HOST_RUNNER_URL: process.env.HOST_RUNNER_URL,
      HOST_RUNNER_SHARED_SECRET: process.env.HOST_RUNNER_SHARED_SECRET,
      HOST_CHECKOUT_PATH: process.env.HOST_CHECKOUT_PATH,
      WORKSPACE_DIR: process.env.WORKSPACE_DIR,
      LLM_CONCURRENCY: process.env.LLM_CONCURRENCY,
      COMPACTION_STRATEGY: process.env.COMPACTION_STRATEGY,
    };
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.LLM_ENGINE = "ollama";
    process.env.MCP_SERVER_URL = "http://127.0.0.1:59997/mcp/sse";
    process.env.BROWSER_MCP_URL = "http://127.0.0.1:59996/browser/sse";
    process.env.HOST_RUNNER_SHARED_SECRET = "test-secret";
    delete process.env.HOST_CHECKOUT_PATH;
    delete process.env.WORKSPACE_DIR;
    delete process.env.LLM_CONCURRENCY;
    delete process.env.COMPACTION_STRATEGY;
  });

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers = [];
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  });

  it("serializeTurn hands the active slot lease to runTurn (third argument, holding)", async () => {
    const scheduler = new PrioritySlotScheduler();
    const queue = new JobQueue();
    let seenLease: SlotLease | undefined;
    const handle = serializeTurn(
      queue,
      { id: "j1", threadId: "t1", prompt: "p" },
      {
        scheduler,
        priority: SlotPriority.P0_OWNER,
        runTurn: (_job, _wt, lease) => {
          seenLease = lease;
          assert.ok(lease, "runTurn must receive the slot lease");
          assert.equal(lease.isHolding(), true, "lease must hold the slot inside the turn body");
          return Promise.resolve();
        },
      }
    );
    await handle.settled;
    assert.ok(seenLease, "lease must be threaded to runTurn");
  });

  it("queued turn acquires the engine slot while the active turn waits on a host tool", async () => {
    const events: string[] = [];

    // Mock host runner: health READY (manifest-matched), /execute slow.
    const manifest = getBridgeManifest();
    const runner = await startMockServer((req, _body, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            protocolVersion: PROTOCOL_VERSION,
            bridgeSourceSha256: manifest.bridgeSourceSha256,
          })
        );
        return;
      }
      events.push("tool_start");
      setTimeout(() => {
        events.push("tool_end");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, success: true, output: "installed", truncated: false }));
      }, TOOL_WAIT_MS);
    });
    servers.push(runner.server);
    process.env.HOST_RUNNER_URL = runner.baseUrl;

    // Mock LLM: turn A = host tool round then final; turn B = single final.
    const llm = await startMockServer((_req, body, res) => {
      const msgs = (body.messages || []) as Array<{
        role: string;
        content?: string;
        tool_calls?: unknown;
      }>;
      const user = msgs.find((m) => m.role === "user");
      const isToolRound = msgs.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (user?.content === "Run host tool" && !isToolRound) {
        events.push("llm_A_round1");
        res.write(
          `${JSON.stringify({
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "htc_1",
                  type: "function",
                  function: {
                    name: "host_run_powershell",
                    arguments: JSON.stringify({ command: "Get-Process" }),
                  },
                },
              ],
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 1000,
            eval_count: 10,
          })}\n`
        );
      } else if (user?.content === "Run host tool" && isToolRound) {
        events.push("llm_A_round2");
        res.write(
          `${JSON.stringify({ message: { role: "assistant", content: "Host tool done." }, done: true, done_reason: "stop", prompt_eval_count: 1200, eval_count: 8 })}\n`
        );
      } else {
        events.push("llm_B");
        res.write(
          `${JSON.stringify({ message: { role: "assistant", content: "Second turn done." }, done: true, done_reason: "stop", prompt_eval_count: 900, eval_count: 5 })}\n`
        );
      }
      res.end();
    });
    servers.push(llm.server);
    process.env.LLM_BASE_URL = llm.baseUrl;

    const reqA = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "thread-slot-A",
        messages: [{ role: "user", content: "Run host tool" }],
      }),
    });
    const reqB = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "thread-slot-B",
        messages: [{ role: "user", content: "Second turn" }],
      }),
    });

    const [resA, resB] = await Promise.all([POST(reqA), POST(reqB)]);
    const [evA, evB] = await Promise.all([readSseEvents(resA), readSseEvents(resB)]);
    assert.ok(
      evA.find((e) => e.type === "done"),
      "turn A must complete"
    );
    assert.ok(
      evB.find((e) => e.type === "done"),
      "turn B must complete"
    );

    const toolStartIdx = events.indexOf("tool_start");
    const toolEndIdx = events.indexOf("tool_end");
    const llmBIdx = events.indexOf("llm_B");
    assert.ok(
      toolStartIdx >= 0 && llmBIdx >= 0,
      `event log must contain tool_start and llm_B: ${JSON.stringify(events)}`
    );
    assert.ok(
      llmBIdx > toolStartIdx && llmBIdx < toolEndIdx,
      `queued turn B must dispatch its LLM round DURING turn A's tool wait (slot released), got order: ${JSON.stringify(events)}`
    );
    // Turn A must re-acquire the slot after the tool wait before its round 2.
    assert.ok(
      events.indexOf("llm_A_round2") > toolEndIdx,
      "turn A must re-acquire the slot after the tool wait"
    );

    const metrics = getSharedSlotScheduler().getMetrics();
    assert.ok(
      metrics.waitingToolMs >= TOOL_WAIT_MS,
      `waitingToolMs must accrue the released tool wait, got ${metrics.waitingToolMs}`
    );
  });
});

describe("mid-turn compaction uses extraction digest (#129 P5-A)", () => {
  let tmpThreadsDir: string;
  let orig: Record<string, string | undefined> = {};
  let server: http.Server | null = null;

  beforeEach(() => {
    tmpThreadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "midturn-digest-"));
    orig = {
      THREADS_DIR: process.env.THREADS_DIR,
      LLM_BASE_URL: process.env.LLM_BASE_URL,
      LLM_ENGINE: process.env.LLM_ENGINE,
      MCP_SERVER_URL: process.env.MCP_SERVER_URL,
      BROWSER_MCP_URL: process.env.BROWSER_MCP_URL,
      COMPACTION_STRATEGY: process.env.COMPACTION_STRATEGY,
      MID_TURN_HYBRID_COMPACTION: process.env.MID_TURN_HYBRID_COMPACTION,
    };
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.LLM_ENGINE = "ollama";
    process.env.MCP_SERVER_URL = "http://127.0.0.1:59997/mcp/sse";
    process.env.BROWSER_MCP_URL = "http://127.0.0.1:59996/browser/sse";
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  });

  it("COMPACTION_STRATEGY=hybrid mid-turn compaction dispatches ZERO summarization calls and carries the extraction digest", async () => {
    process.env.COMPACTION_STRATEGY = "hybrid";
    const brief =
      "MIDTURN_DIGEST_BRIEF: inspect web-ui/lib/contextBudget.ts commit 86c8901c6433617cb9abe5db97123a0f52f58c89 https://github.com/test/repo and report results.";
    let mainDispatches = 0;
    let summarizationDispatches = 0;
    const capturedMainRequests: Array<
      Array<{ role: string; content?: string; tool_calls?: unknown[] }>
    > = [];

    const mock = await startMockServer((_req, body, res) => {
      const msgs = (body.messages || []) as Array<{
        role: string;
        content?: string;
        tool_calls?: unknown[];
      }>;
      const isSummarizationCall =
        msgs[0]?.role === "system" &&
        typeof msgs[0]?.content === "string" &&
        msgs[0].content.includes("You are compacting the working memory");
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (isSummarizationCall) {
        summarizationDispatches++;
        res.write(
          `${JSON.stringify({ message: { role: "assistant", content: "[CONVERSATION COMPACTED (MODEL DIGEST)]: nope" }, done: true, done_reason: "stop", prompt_eval_count: 500, eval_count: 100 })}\n`
        );
        res.end();
        return;
      }
      mainDispatches++;
      capturedMainRequests.push(JSON.parse(JSON.stringify(msgs)));
      res.write(
        `${JSON.stringify({
          message: {
            role: "assistant",
            content:
              `Round ${mainDispatches}: ` + (mainDispatches === 3 ? "R".repeat(20_000) : "short"),
            tool_calls: [
              {
                id: `htc_${mainDispatches}`,
                type: "function",
                function: {
                  name: "workspace_get_tree",
                  arguments: JSON.stringify({ path: `d${mainDispatches}` }),
                },
              },
            ],
          },
          done: true,
          done_reason: "stop",
          prompt_eval_count: mainDispatches === 3 ? 93_000 : 10_000,
          eval_count: 100,
        })}\n`
      );
      res.end();
    });
    server = mock.server;
    process.env.LLM_BASE_URL = mock.baseUrl;

    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "thread-midturn-digest",
        messages: [{ role: "user", content: brief }],
      }),
    });
    const res = await POST(req);
    const events = await readSseEvents(res);
    const compactionEvt = events.find((e) => e.type === "compaction");
    assert.ok(compactionEvt, "Compaction event must fire mid-turn");
    assert.equal(
      summarizationDispatches,
      0,
      "Mid-turn compaction must NEVER dispatch a summarization LLM call on the single engine slot"
    );
    assert.ok(
      Array.isArray(compactionEvt.actions) &&
        (compactionEvt.actions as string[]).includes("compaction"),
      `Expected extraction compaction action, got ${JSON.stringify(compactionEvt.actions)}`
    );
    assert.ok(
      !Array.isArray(compactionEvt.actions) ||
        !(compactionEvt.actions as string[]).includes("hybrid_model_digest"),
      "Mid-turn actions must not report a model digest"
    );
    const round0User = capturedMainRequests[0].find((m) => m.role === "user");
    const postCompact = capturedMainRequests.find(
      (r, i) =>
        i > 0 &&
        r.some(
          (m) => typeof m.content === "string" && m.content.startsWith("[CONVERSATION COMPACTED")
        )
    );
    assert.ok(postCompact, "Post-compaction round must carry the extraction digest boundary");
    const postUser = postCompact.find((m) => m.role === "user");
    assert.equal(
      postUser?.content,
      round0User?.content,
      "Leading user message must stay byte-identical across mid-turn compaction"
    );
  });
});

describe("slot scheduler overlap cap and workspace isolation (R1 + R5)", () => {
  let tmpThreadsDir: string;
  let orig: Record<string, string | undefined> = {};
  let servers: http.Server[] = [];

  beforeEach(() => {
    tmpThreadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "slot-r1-r5-"));
    orig = {
      THREADS_DIR: process.env.THREADS_DIR,
      LLM_BASE_URL: process.env.LLM_BASE_URL,
      LLM_ENGINE: process.env.LLM_ENGINE,
      MCP_SERVER_URL: process.env.MCP_SERVER_URL,
      BROWSER_MCP_URL: process.env.BROWSER_MCP_URL,
      HOST_RUNNER_URL: process.env.HOST_RUNNER_URL,
      HOST_RUNNER_SHARED_SECRET: process.env.HOST_RUNNER_SHARED_SECRET,
      HOST_CHECKOUT_PATH: process.env.HOST_CHECKOUT_PATH,
      WORKSPACE_DIR: process.env.WORKSPACE_DIR,
      LLM_CONCURRENCY: process.env.LLM_CONCURRENCY,
      COMPACTION_STRATEGY: process.env.COMPACTION_STRATEGY,
    };
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.LLM_ENGINE = "ollama";
    process.env.MCP_SERVER_URL = "http://127.0.0.1:59997/mcp/sse";
    process.env.BROWSER_MCP_URL = "http://127.0.0.1:59996/browser/sse";
    process.env.HOST_RUNNER_SHARED_SECRET = "test-secret";
    delete process.env.HOST_CHECKOUT_PATH;
    delete process.env.WORKSPACE_DIR;
    delete process.env.LLM_CONCURRENCY;
    delete process.env.COMPACTION_STRATEGY;
  });

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers = [];
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  });

  it("caps overlap to 1 per waiter across 4 queued turns, supports mid-wait arrival, and balances overlapDepth on abort-during-wait (R1)", async () => {
    const scheduler = new PrioritySlotScheduler();
    const queue = new JobQueue();
    const readOverlapDepth = () => (queue as unknown as { overlapDepth: number }).overlapDepth;

    let activeTurns = 0;
    let maxActiveTurns = 0;
    const events: string[] = [];
    const overlapDepthSamplesDuringWait: number[] = [];

    let signalWaitEntered!: () => void;
    const waitEntered = new Promise<void>((r) => {
      signalWaitEntered = r;
    });
    let releaseWait!: () => void;
    const waitGate = new Promise<void>((r) => {
      releaseWait = r;
    });

    let signalT2Started!: () => void;
    const t2Started = new Promise<void>((r) => {
      signalT2Started = r;
    });
    let releaseT2!: () => void;
    const t2Gate = new Promise<void>((r) => {
      releaseT2 = r;
    });

    const t1 = serializeTurn(
      queue,
      { id: "j1", threadId: "th-1", prompt: "p1" },
      {
        scheduler,
        runTurn: async (_job, _wt, lease) => {
          activeTurns++;
          maxActiveTurns = Math.max(maxActiveTurns, activeTurns);
          events.push("start:j1");
          await lease!.releaseForWait(async () => {
            events.push("wait_start:j1");
            overlapDepthSamplesDuringWait.push(readOverlapDepth());
            signalWaitEntered();
            await waitGate;
            overlapDepthSamplesDuringWait.push(readOverlapDepth());
            events.push("wait_end:j1");
          });
          events.push("reacquired:j1");
          assert.equal(
            readOverlapDepth(),
            0,
            "overlapDepth must return to 0 immediately after reacquire"
          );
          activeTurns--;
          events.push("end:j1");
        },
      }
    );

    const makeWorkerTurn = (
      id: string,
      threadId: string,
      gate?: Promise<void>,
      onStart?: () => void
    ) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });
      const handle = serializeTurn(
        queue,
        { id, threadId, prompt: id },
        {
          scheduler,
          runTurn: async () => {
            activeTurns++;
            maxActiveTurns = Math.max(maxActiveTurns, activeTurns);
            events.push(`start:${id}`);
            onStart?.();
            if (gate) {
              await gate;
            } else {
              await new Promise((r) => setTimeout(r, 10));
            }
            activeTurns--;
            events.push(`end:${id}`);
            resolveDone();
          },
        }
      );
      return { handle, done };
    };

    const t2 = makeWorkerTurn("j2", "th-2", t2Gate, signalT2Started);
    const t3 = makeWorkerTurn("j3", "th-3");
    const t4 = makeWorkerTurn("j4", "th-4");

    await waitEntered;
    await t2Started;

    // While j1 is waiting and j2 is the single overlapping turn, j3 and j4 must still be queued.
    assert.equal(readOverlapDepth(), 1, "overlapDepth must stay 1 during releaseForWait");
    assert.equal(activeTurns, 2, "only 1 overlapping turn (j2) may run concurrently with j1");
    assert.equal(events.includes("start:j3"), false, "j3 must not start while j2 overlaps j1");
    assert.equal(events.includes("start:j4"), false, "j4 must not start while j2 overlaps j1");

    // Let j2 finish while j1 is still waiting; j3 may now take the overlap slot.
    releaseT2();
    await t2.done;
    await t3.done;

    // Mid-wait arrival (j5) arriving while j1 is still waiting should run during the wait.
    const t5 = makeWorkerTurn("j5", "th-5");
    await t4.done;
    await t5.done;
    assert.equal(readOverlapDepth(), 1, "overlapDepth must still be 1 until j1 reacquires");

    releaseWait();
    await Promise.all([
      t1.settled,
      t2.handle.settled,
      t3.handle.settled,
      t4.handle.settled,
      t5.handle.settled,
    ]);

    assert.equal(readOverlapDepth(), 0, "overlapDepth must be 0 after all turns settle");
    assert.equal(maxActiveTurns, 2, "at most 2 turns may run concurrently");
    assert.ok(
      overlapDepthSamplesDuringWait.every((d) => d === 1),
      `overlapDepth must remain 1 throughout wait, saw ${JSON.stringify(overlapDepthSamplesDuringWait)}`
    );
    assert.ok(
      events.indexOf("start:j5") < events.indexOf("wait_end:j1"),
      `mid-wait arrival j5 must execute during j1 wait: ${JSON.stringify(events)}`
    );

    // Abort-during-wait case: aborting while waiting to reacquire must still balance endOverlap()
    // and rethrow any error caught from fn().
    const abortQueue = new JobQueue();
    const readAbortOverlap = () => (abortQueue as unknown as { overlapDepth: number }).overlapDepth;
    const acA = new AbortController();
    let signalBHolding!: () => void;
    const bHolding = new Promise<void>((r) => {
      signalBHolding = r;
    });
    let releaseB!: () => void;
    const bGate = new Promise<void>((r) => {
      releaseB = r;
    });
    let resolveADone!: () => void;
    const aDone = new Promise<void>((r) => {
      resolveADone = r;
    });
    let caughtInA: unknown;

    const turnA = serializeTurn(
      abortQueue,
      { id: "abort-A", threadId: "th-abort-A", prompt: "a" },
      {
        scheduler,
        signal: acA.signal,
        runTurn: async (_job, _wt, lease) => {
          try {
            await lease!.releaseForWait(async () => {
              await bHolding;
              throw new Error("tool-wait-error");
            });
          } catch (err) {
            caughtInA = err;
            throw err;
          } finally {
            resolveADone();
          }
        },
      }
    );

    const turnB = serializeTurn(
      abortQueue,
      { id: "abort-B", threadId: "th-abort-B", prompt: "b" },
      {
        scheduler,
        runTurn: async () => {
          signalBHolding();
          await bGate;
        },
      }
    );

    await bHolding;
    // Allow turnA's fn() to throw and enter acquireState() while turnB holds the slot.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(readAbortOverlap(), 1, "overlapDepth must be 1 before abort during reacquire");

    acA.abort();
    await aDone;
    assert.equal(readAbortOverlap(), 0, "overlapDepth must reset to 0 when reacquire aborts");
    assert.match(
      caughtInA instanceof Error ? caughtInA.message : String(caughtInA),
      /tool-wait-error/,
      "releaseForWait must rethrow original fn() error instead of abort error"
    );

    releaseB();
    await Promise.all([turnA.settled, turnB.settled]);
    assert.equal(readAbortOverlap(), 0);
  });

  it("strictly serializes same-threadId turns and keeps snapshot().running populated until all active turns finish (R5)", async () => {
    const scheduler = new PrioritySlotScheduler();
    const queue = new JobQueue();
    const events: string[] = [];

    let signalA1Waiting!: () => void;
    const a1Waiting = new Promise<void>((r) => {
      signalA1Waiting = r;
    });
    let releaseA1Wait!: () => void;
    const a1WaitGate = new Promise<void>((r) => {
      releaseA1Wait = r;
    });
    let releaseA1End!: () => void;
    const a1EndGate = new Promise<void>((r) => {
      releaseA1End = r;
    });

    const a1 = serializeTurn(
      queue,
      { id: "A1", threadId: "same-thread", prompt: "a1" },
      {
        scheduler,
        runTurn: async (_job, _wt, lease) => {
          events.push("start:A1");
          await lease!.releaseForWait(async () => {
            events.push("wait_start:A1");
            signalA1Waiting();
            await a1WaitGate;
            events.push("wait_end:A1");
          });
          await a1EndGate;
          events.push("end:A1");
        },
      }
    );

    // Same-threadId follow-up A2 must NOT overlap A1.
    const a2 = serializeTurn(
      queue,
      { id: "A2", threadId: "same-thread", prompt: "a2" },
      {
        scheduler,
        runTurn: async () => {
          events.push("start:A2");
          events.push("end:A2");
        },
      }
    );

    // Different-threadId turn B1 CAN overlap A1's wait and finish before A1 finishes.
    let resolveB1Done!: () => void;
    const b1Done = new Promise<void>((r) => {
      resolveB1Done = r;
    });
    const b1 = serializeTurn(
      queue,
      { id: "B1", threadId: "other-thread", prompt: "b1" },
      {
        scheduler,
        runTurn: async () => {
          events.push("start:B1");
          await new Promise((r) => setTimeout(r, 15));
          events.push("end:B1");
          resolveB1Done();
        },
      }
    );

    await a1Waiting;
    await b1Done;
    // Allow B1's job wrapper finally block to run before inspecting snapshot().running.
    await new Promise((r) => setTimeout(r, 10));

    // B1 finished while A1 is still active: snapshot().running must stay populated!
    assert.ok(
      queue.snapshot().running !== null,
      "snapshot().running must remain non-null while A1 is still active after B1 finishes"
    );
    assert.equal(
      events.includes("start:A2"),
      false,
      "same-threadId turn A2 must not overlap A1 during releaseForWait"
    );

    releaseA1Wait();
    releaseA1End();
    await Promise.all([a1.settled, a2.settled, b1.settled]);

    assert.equal(
      queue.snapshot().running,
      null,
      "snapshot().running must be null after all finish"
    );
    assert.ok(
      events.indexOf("start:B1") < events.indexOf("wait_end:A1"),
      `other-thread B1 should overlap A1 wait: ${JSON.stringify(events)}`
    );
    assert.ok(
      events.indexOf("start:A2") > events.indexOf("end:A1"),
      `same-thread A2 must run strictly after A1 finishes: ${JSON.stringify(events)}`
    );
  });

  it("prevents overlapping turns on shared unisolated workspace/host checkout while allowing isolated worktrees (R5)", async () => {
    const scheduler = new PrioritySlotScheduler();
    const queue = new JobQueue();
    const events: string[] = [];

    let signalW1Waiting!: () => void;
    const w1Waiting = new Promise<void>((r) => {
      signalW1Waiting = r;
    });
    let releaseW1!: () => void;
    const w1Gate = new Promise<void>((r) => {
      releaseW1 = r;
    });

    const w1 = serializeTurn(
      queue,
      { id: "W1", threadId: "th-w1", prompt: "w1" },
      {
        scheduler,
        workspaceKey: "/workspace",
        runTurn: async (_job, _wt, lease) => {
          events.push("start:W1");
          await lease!.releaseForWait(async () => {
            signalW1Waiting();
            await w1Gate;
          });
          events.push("end:W1");
        },
      }
    );

    const w2 = serializeTurn(
      queue,
      { id: "W2", threadId: "th-w2", prompt: "w2" },
      {
        scheduler,
        workspaceKey: "/workspace",
        runTurn: async () => {
          events.push("start:W2");
          events.push("end:W2");
        },
      }
    );

    await w1Waiting;
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(
      events.includes("start:W2"),
      false,
      "shared unisolated workspace turn W2 must not overlap W1"
    );
    releaseW1();
    await Promise.all([w1.settled, w2.settled]);
    assert.ok(events.indexOf("start:W2") > events.indexOf("end:W1"));

    // Contrast: isolated git worktrees (repoRoot) CAN overlap during releaseForWait.
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wt-overlap-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoRoot });
      execFileSync("git", ["config", "user.email", "t@t.io"], { cwd: repoRoot });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repoRoot });
      fs.writeFileSync(path.join(repoRoot, "f.txt"), "base\n");
      execFileSync("git", ["add", "f.txt"], { cwd: repoRoot });
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repoRoot });

      const wtQueue = new JobQueue();
      const wtEvents: string[] = [];
      let releaseWt1!: () => void;
      const wt1Gate = new Promise<void>((r) => {
        releaseWt1 = r;
      });
      let signalWt2Done!: () => void;
      const wt2Done = new Promise<void>((r) => {
        signalWt2Done = r;
      });

      const wt1 = serializeTurn(
        wtQueue,
        { id: "WT1", threadId: "th-wt1", prompt: "wt1" },
        {
          scheduler,
          repoRoot,
          runTurn: async (_job, wt, lease) => {
            assert.ok(wt, "WT1 must have isolated worktree");
            wtEvents.push("start:WT1");
            await lease!.releaseForWait(async () => {
              wtEvents.push("wait_start:WT1");
              await wt2Done;
              await wt1Gate;
              wtEvents.push("wait_end:WT1");
            });
            wtEvents.push("end:WT1");
          },
        }
      );

      const wt2 = serializeTurn(
        wtQueue,
        { id: "WT2", threadId: "th-wt2", prompt: "wt2" },
        {
          scheduler,
          repoRoot,
          runTurn: async (_job, wt) => {
            assert.ok(wt, "WT2 must have isolated worktree");
            wtEvents.push("start:WT2");
            wtEvents.push("end:WT2");
            signalWt2Done();
          },
        }
      );

      await wt2Done;
      releaseWt1();
      await Promise.all([wt1.settled, wt2.settled]);
      assert.ok(
        wtEvents.indexOf("start:WT2") < wtEvents.indexOf("wait_end:WT1"),
        `isolated worktree turns should overlap during wait: ${JSON.stringify(wtEvents)}`
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }

    // Also verify POST /api/chat wires HOST_CHECKOUT_PATH shared workspace protection.
    process.env.HOST_CHECKOUT_PATH = os.tmpdir();
    const routeEvents: string[] = [];
    const manifest = getBridgeManifest();
    const runner = await startMockServer((req, _body, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            protocolVersion: PROTOCOL_VERSION,
            bridgeSourceSha256: manifest.bridgeSourceSha256,
          })
        );
        return;
      }
      routeEvents.push("tool_start");
      setTimeout(() => {
        routeEvents.push("tool_end");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, success: true, output: "ok", truncated: false }));
      }, 150);
    });
    servers.push(runner.server);
    process.env.HOST_RUNNER_URL = runner.baseUrl;

    const llm = await startMockServer((_req, body, res) => {
      const msgs = (body.messages || []) as Array<{
        role: string;
        content?: string;
        tool_calls?: unknown;
      }>;
      const user = msgs.find((m) => m.role === "user");
      const isToolRound = msgs.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (user?.content === "Host checkout job" && !isToolRound) {
        routeEvents.push("llm_A_round1");
        res.write(
          `${JSON.stringify({
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "hc_1",
                  type: "function",
                  function: {
                    name: "host_run_powershell",
                    arguments: JSON.stringify({ command: "git status" }),
                  },
                },
              ],
            },
            done: true,
            done_reason: "stop",
          })}\n`
        );
      } else if (user?.content === "Host checkout job" && isToolRound) {
        routeEvents.push("llm_A_round2");
        res.write(
          `${JSON.stringify({ message: { role: "assistant", content: "Done A." }, done: true, done_reason: "stop" })}\n`
        );
      } else {
        routeEvents.push("llm_B");
        res.write(
          `${JSON.stringify({ message: { role: "assistant", content: "Done B." }, done: true, done_reason: "stop" })}\n`
        );
      }
      res.end();
    });
    servers.push(llm.server);
    process.env.LLM_BASE_URL = llm.baseUrl;

    const [resA, resB] = await Promise.all([
      POST(
        new NextRequest("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: "host-checkout-A",
            messages: [{ role: "user", content: "Host checkout job" }],
          }),
        })
      ),
      POST(
        new NextRequest("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: "host-checkout-B",
            messages: [{ role: "user", content: "Second host job" }],
          }),
        })
      ),
    ]);
    await Promise.all([readSseEvents(resA), readSseEvents(resB)]);
    assert.ok(
      routeEvents.includes("llm_A_round2") && routeEvents.includes("llm_B"),
      `both HOST_CHECKOUT_PATH turns must complete: ${JSON.stringify(routeEvents)}`
    );
    assert.ok(
      routeEvents.indexOf("llm_B") > routeEvents.indexOf("llm_A_round2"),
      `shared HOST_CHECKOUT_PATH turns must not overlap: ${JSON.stringify(routeEvents)}`
    );
  });

  it("keeps single-slot (LLM_CONCURRENCY=1) engine lease held on short read-only batches, while multi-slot releases (R5)", async () => {
    const runReadBatchScenario = async (concurrency: string): Promise<string[]> => {
      process.env.LLM_CONCURRENCY = concurrency;
      const events: string[] = [];
      const manifest = getBridgeManifest();
      const runner = await startMockServer((req, _body, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              protocolVersion: PROTOCOL_VERSION,
              bridgeSourceSha256: manifest.bridgeSourceSha256,
            })
          );
          return;
        }
        events.push("read_start");
        setTimeout(() => {
          events.push("read_end");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, success: true, content: "file-body" }));
        }, 150);
      });
      servers.push(runner.server);
      process.env.HOST_RUNNER_URL = runner.baseUrl;

      const llm = await startMockServer((_req, body, res) => {
        const msgs = (body.messages || []) as Array<{
          role: string;
          content?: string;
          tool_calls?: unknown;
        }>;
        const user = msgs.find((m) => m.role === "user");
        const isFirstTurn =
          typeof user?.content === "string" && user.content.startsWith("Read a file");
        const isToolRound = msgs.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (isFirstTurn && !isToolRound) {
          events.push("llm_A_round1");
          res.write(
            `${JSON.stringify({
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "ro_1",
                    type: "function",
                    function: {
                      name: "host_read_file",
                      arguments: JSON.stringify({ path: "README.md" }),
                    },
                  },
                ],
              },
              done: true,
              done_reason: "stop",
            })}\n`
          );
        } else if (isFirstTurn && isToolRound) {
          events.push("llm_A_round2");
          res.write(
            `${JSON.stringify({ message: { role: "assistant", content: "Read complete." }, done: true, done_reason: "stop" })}\n`
          );
        } else {
          events.push("llm_B");
          res.write(
            `${JSON.stringify({ message: { role: "assistant", content: "Second done." }, done: true, done_reason: "stop" })}\n`
          );
        }
        res.end();
      });
      servers.push(llm.server);
      process.env.LLM_BASE_URL = llm.baseUrl;

      const suffix = concurrency;
      const [resA, resB] = await Promise.all([
        POST(
          new NextRequest("http://localhost/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threadId: `ro-A-${suffix}`,
              messages: [{ role: "user", content: "Read a file" }],
            }),
          })
        ),
        POST(
          new NextRequest("http://localhost/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threadId: `ro-B-${suffix}`,
              messages: [{ role: "user", content: "Second turn" }],
            }),
          })
        ),
      ]);
      await Promise.all([readSseEvents(resA), readSseEvents(resB)]);
      return events;
    };

    const singleSlotEvents = await runReadBatchScenario("1");
    assert.ok(
      singleSlotEvents.includes("read_end") && singleSlotEvents.includes("llm_A_round2"),
      `single-slot read turn must complete both rounds: ${JSON.stringify(singleSlotEvents)}`
    );
    assert.ok(
      singleSlotEvents.indexOf("llm_B") > singleSlotEvents.indexOf("llm_A_round2"),
      `LLM_CONCURRENCY=1 must NOT release slot lease on read-only batch: ${JSON.stringify(singleSlotEvents)}`
    );

    const multiSlotEvents = await runReadBatchScenario("2");
    assert.ok(
      multiSlotEvents.includes("read_end") && multiSlotEvents.includes("llm_A_round2"),
      `multi-slot read turn must complete both rounds: ${JSON.stringify(multiSlotEvents)}`
    );
    assert.ok(
      multiSlotEvents.indexOf("llm_B") > multiSlotEvents.indexOf("read_start") &&
        multiSlotEvents.indexOf("llm_B") < multiSlotEvents.indexOf("read_end"),
      `LLM_CONCURRENCY=2 may release slot lease on read-only batch: ${JSON.stringify(multiSlotEvents)}`
    );
  });
});
