import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
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
      COMPACTION_STRATEGY: process.env.COMPACTION_STRATEGY,
    };
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.LLM_ENGINE = "ollama";
    process.env.MCP_SERVER_URL = "http://127.0.0.1:59997/mcp/sse";
    process.env.BROWSER_MCP_URL = "http://127.0.0.1:59996/browser/sse";
    process.env.HOST_RUNNER_SHARED_SECRET = "test-secret";
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
