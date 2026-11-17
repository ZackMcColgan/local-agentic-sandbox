import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

/**
 * PART 1B: ROUND DEADLINES + HONEST TRUNCATION + AUTO-CONTINUE.
 *
 * The platform's worst live failure mode: a runaway round (a ~70KB tool call as
 * one generation, or a silent stream) has no wall-clock leash. The per-round
 * AbortController only fires on an explicit stop; the only backstop is the
 * 1000-round counter. Live proof runs showed a 600s silent turn ending only
 * because the TEST HARNESS pressed the stop endpoint from outside — in real
 * usage there is no watchdog, so the turn holds the single engine slot looking
 * frozen until a human notices.
 *
 * Expected behavior after the fix:
 *  - Every round carries two deadlines wired to its AbortController:
 *      ROUND_INACTIVITY_DEADLINE_MS (180s without a chunk) and
 *      ROUND_TOTAL_DEADLINE_MS (15 min regardless of activity).
 *  - First aborted round follows the existing round-abort path (continue).
 *  - A SECOND CONSECUTIVE aborted round ends the turn with the honest marker
 *    "Turn ended: generation timed out." and releases all turn/slot state.
 *  - finish_reason:"length" whose tool call fails to parse is a size-limit
 *    event, never a silent retry: turn ends with
 *    "Turn ended: a tool call exceeded the per-message size limit." and logs
 *    the tool name + argument byte size.
 *  - finish_reason:"length" on a TEXT round (no tool call in flight) auto-
 *    continues ONCE with a "continue exactly where you stopped" instruction;
 *    a second consecutive length-truncation ends with the marker.
 *  - Per-round finish_reason recorded on the turn record (forensics).
 *  - Deadlines are injectable via env (test seam) so tests use short values.
 */

const TIMEOUT_MARKER = "Turn ended: generation timed out.";
const SIZE_LIMIT_MARKER = "Turn ended: a tool call exceeded the per-message size limit.";

interface ScriptStep {
  /** Chunks emitted for this completion. Each entry is one SSE delta line. */
  chunks: Array<{ content?: string; thinking?: string; toolCall?: any; finishReason?: string }>;
  /** Millisecond delay between emitted chunks (silence between chunks). */
  chunkDelayMs?: number;
  /** Millisecond delay before the first chunk (silent stall). */
  stallMs?: number;
}

/**
 * Scripted Ollama NDJSON engine (same proven harness shape as
 * synthesisRetry.test.ts). The complexity-triage call is answered with a fixed
 * JSON classification so it never consumes a scripted round step; only real
 * rounds count.
 */
function makeScriptedOllamaServer(script: ScriptStep[]) {
  let completionCount = 0;
  const openResponses: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url.includes("/api/ps")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (url.includes("/sse") || url.includes("/mcp") || url.includes("/browser")) {
      res.writeHead(404);
      res.end("no mcp");
      return;
    }
    if (!url.includes("/api/chat")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    openResponses.push(res);
    // NOTE: req.destroyed is true once the request body ends (normal Node
    // behavior) — it must NOT be used to stop response writes. Track client
    // abandonment via the abort/close events instead.
    let clientGone = false;
    req.on("abort", () => {
      clientGone = true;
      try { res.destroy(); } catch {}
    });
    res.on("close", () => { clientGone = true; });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (body.includes("COMPLEXITY")) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(JSON.stringify({ message: { role: "assistant", content: '{"complexity":"SIMPLE_EXECUTION","reasoning":"tool work"}' }, done: true }) + "\n");
        res.end();
        return;
      }
      completionCount++;
      const step = script[Math.min(completionCount - 1, script.length - 1)];
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (step.stallMs) await sleep(step.stallMs);
      for (const ch of step.chunks) {
        if (step.chunkDelayMs) await sleep(step.chunkDelayMs);
        if (clientGone || res.writableEnded) return;
        const msg: any = { role: "assistant" };
        if (ch.content) msg.content = ch.content;
        if (ch.thinking) msg.thinking = ch.thinking;
        if (ch.toolCall) msg.tool_calls = [ch.toolCall];
        if (ch.finishReason) {
          res.write(JSON.stringify({ message: msg, done: true, finish_reason: ch.finishReason }) + "\n");
          res.end();
          return;
        }
        res.write(JSON.stringify({ message: msg, done: false }) + "\n");
      }
      if (!clientGone && !res.writableEnded) {
        res.write(JSON.stringify({ message: { role: "assistant", content: "" }, done: true, finish_reason: "stop" }) + "\n");
        res.end();
      }
    });
  });
  return {
    server,
    getCompletionCount: () => completionCount,
    destroyOpenResponses: () => {
      for (const r of openResponses) {
        try { r.destroy(); } catch {}
      }
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTurn(script: ScriptStep[], deadlineEnv: Record<string, string>) {
  const tmpThreadsDir = path.resolve(
    process.cwd(),
    "tmp-test-round-deadlines-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6)
  );
  fs.mkdirSync(tmpThreadsDir, { recursive: true });
  const prev: Record<string, string | undefined> = {};
  const envKeys = [
    "THREADS_DIR",
    "LLM_BASE_URL",
    "OLLAMA_BASE_URL",
    "LLAMACPP_BASE_URL",
    "MCP_SERVER_URL",
    "BROWSER_MCP_URL",
    "LLM_ENGINE",
    ...Object.keys(deadlineEnv)
  ];
  for (const k of envKeys) prev[k] = process.env[k];
  process.env.THREADS_DIR = tmpThreadsDir;
  process.env.LLM_ENGINE = "ollama";
  for (const [k, v] of Object.entries(deadlineEnv)) process.env[k] = v;

  const { server, getCompletionCount, destroyOpenResponses } = makeScriptedOllamaServer(script);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.LLAMACPP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MCP_SERVER_URL = `http://127.0.0.1:${port}/mcp`;
  process.env.BROWSER_MCP_URL = `http://127.0.0.1:${port}/browser`;

  // Harness watchdog: if the PRODUCT turn never ends, this fires and the test
  // fails honestly (a watchdog stop is a product defect, never a pass).
  const HARNESS_WATCHDOG_MS = 25_000;
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    destroyOpenResponses();
  }, HARNESS_WATCHDOG_MS);
  if (typeof watchdog.unref === "function") watchdog.unref();

  try {
    const { NextRequest } = await import("next/server");
    const chatRouteModule = await import("../app/api/chat/route");
    const { ThreadStore, activeExecutionSet, getActiveTurn } = await import("../lib/threads/threadStore");

    const store = new ThreadStore(tmpThreadsDir);
    const threadId = `thread-round-deadlines-${Date.now()}`;
    store.createThread({ id: threadId, title: "Round Deadlines Test", hostAccess: false });

    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        userMessageId: "u-1",
        assistantMessageId: "a-1",
        messages: [{ role: "user", content: "Write a long report on the repo architecture.", id: "u-1" }],
        model: "swift-15-27b-mtp",
        enableTools: true
      })
    });
    const res = await chatRouteModule.POST(req as any);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }

    const thread = await store.getThread(threadId);
    const asst = thread?.messages.find((m: any) => m.id === "a-1");
    return {
      asst,
      raw,
      completionCount: getCompletionCount(),
      slotIdle: !activeExecutionSet.has(threadId) && getActiveTurn(threadId) === null,
      watchdogFired
    };
  } finally {
    clearTimeout(watchdog);
    destroyOpenResponses();
    server.close();
    for (const k of envKeys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  }
}

test("(1) exports the pinned round deadline constants", () => {
  const mod = require("../lib/contextBudget.js");
  assert.equal(mod.ROUND_INACTIVITY_DEADLINE_MS, 180_000, "inactivity deadline must be pinned at 180s");
  assert.equal(mod.ROUND_TOTAL_DEADLINE_MS, 900_000, "total deadline must be pinned at 15 min");
});

test("(2) inactivity deadline aborts a silent stream (no chunks at all)", async () => {
  // Silent stall: server accepts the request then emits nothing. The round must
  // die at the inactivity deadline, not hang forever holding the engine slot.
  const { asst, raw, completionCount, slotIdle, watchdogFired } = await runTurn(
    [{ stallMs: 10_000, chunks: [{ content: "late" }] }],
    { ROUND_INACTIVITY_DEADLINE_MS: "300", ROUND_TOTAL_DEADLINE_MS: "60000" }
  );
  assert.equal(watchdogFired, false, "the turn must end WITHOUT the harness watchdog (product defect otherwise)");
  assert.ok(asst, "assistant message must exist");
  assert.ok(
    asst!.content.includes(TIMEOUT_MARKER),
    `silent stall must end the turn with the timeout marker, got: ${asst!.content}`
  );
  assert.ok(raw.includes(TIMEOUT_MARKER), "timeout marker must reach the SSE stream");
  assert.ok(completionCount >= 2, `two aborted rounds must run before the turn ends (got ${completionCount})`);
  assert.equal(slotIdle, true, "turn/slot state must be released after the timeout end");
});

test("(3) total deadline aborts a CONTINUOUSLY chunking stream (the critical runaway case)", async () => {
  // A runaway generation streams forever: the inactivity timer never trips.
  // Only the total deadline can end it. This is the load-bearing case.
  const chunks = Array.from({ length: 400 }, (_, i) => ({ content: `word${i} ` }));
  const { asst, raw, completionCount, slotIdle, watchdogFired } = await runTurn(
    [{ chunks, chunkDelayMs: 12 }, { chunks, chunkDelayMs: 12 }],
    { ROUND_INACTIVITY_DEADLINE_MS: "5000", ROUND_TOTAL_DEADLINE_MS: "1200" }
  );
  assert.equal(watchdogFired, false, "the turn must end WITHOUT the harness watchdog (product defect otherwise)");
  assert.ok(asst, "assistant message must exist");
  assert.ok(
    asst!.content.includes(TIMEOUT_MARKER),
    `continuous-streaming runaway must end with the timeout marker, got: ${asst!.content}`
  );
  assert.ok(raw.includes(TIMEOUT_MARKER), "timeout marker must reach the SSE stream");
  assert.ok(completionCount >= 2, `two consecutive aborted rounds expected (got ${completionCount})`);
  assert.equal(slotIdle, true, "turn/slot state must be released");
});

test("(4) first aborted round follows the existing round-abort path (turn continues once)", async () => {
  // Round 1 stalls past the inactivity deadline; round 2 completes normally.
  // The turn must NOT end on the first abort — it continues, and the healthy
  // round's answer lands.
  const { asst, raw, completionCount } = await runTurn(
    [
      { stallMs: 10_000, chunks: [{ content: "never delivered" }] },
      { chunks: [{ content: "FINAL ANSWER after one abort." }] }
    ],
    { ROUND_INACTIVITY_DEADLINE_MS: "300", ROUND_TOTAL_DEADLINE_MS: "60000" }
  );
  assert.ok(asst, "assistant message must exist");
  assert.ok(
    !asst!.content.includes(TIMEOUT_MARKER),
    `a single aborted round must not end the turn, got: ${asst!.content}`
  );
  assert.ok(asst!.content.includes("FINAL ANSWER after one abort."), "healthy round 2 must land");
  assert.ok(!raw.includes("retrying silently"), "abort must not be a silent retry");
  assert.ok(completionCount >= 2, `round 2 must have run (got ${completionCount})`);
});

test("(5) length-truncated unparseable tool call ends with the size-limit marker, no retry", async () => {
  // finish_reason:"length" + a half-written tool call = size-limit event.
  // It must NEVER be retried as a silent round; the turn ends honestly with
  // the tool name and argument byte size logged.
  const hugeArgs = JSON.stringify({ path: "report.md", content: "x".repeat(40000) });
  const truncated = hugeArgs.slice(0, 20000); // cut mid-JSON: unparseable
  const { asst, raw, completionCount } = await runTurn(
    [
      {
        chunks: [
          { content: "Writing the report. " },
          { toolCall: { index: 0, id: "call-1", type: "function", function: { name: "workspace_write_file", arguments: truncated } }, finishReason: "length" }
        ]
      }
    ],
    { ROUND_INACTIVITY_DEADLINE_MS: "5000", ROUND_TOTAL_DEADLINE_MS: "60000" }
  );
  assert.ok(asst, "assistant message must exist");
  assert.ok(
    asst!.content.includes(SIZE_LIMIT_MARKER),
    `truncated tool call must end with the size-limit marker, got: ${asst!.content}`
  );
  assert.ok(asst!.content.includes("workspace_write_file"), "marker must name the tool");
  assert.ok(/20\d{3}|20000/.test(asst!.content), "marker must log the argument byte size");
  assert.ok(raw.includes(SIZE_LIMIT_MARKER), "size-limit marker must reach the SSE stream");
  assert.equal(completionCount, 1, `no silent retry round may run (got ${completionCount})`);
});

test("(6) truncated TEXT round auto-continues once and completes", async () => {
  // finish_reason:"length" on a text/synthesis round (no tool call in flight)
  // continues ONCE with a "continue exactly where you stopped" instruction.
  const { asst, raw, completionCount } = await runTurn(
    [
      { chunks: [{ content: "PART ONE of the report. " }, { content: "still going", finishReason: "length" }] },
      { chunks: [{ content: "PART TWO continued to the end." }] }
    ],
    { ROUND_INACTIVITY_DEADLINE_MS: "5000", ROUND_TOTAL_DEADLINE_MS: "60000" }
  );
  assert.ok(asst, "assistant message must exist");
  assert.ok(asst!.content.includes("PART ONE"), "first truncated half must be kept");
  assert.ok(asst!.content.includes("PART TWO"), "the continuation must land");
  assert.ok(!asst!.content.includes("Turn incomplete: Generation truncated"), "auto-continue must not end with the truncation marker");
  assert.equal(asst!.status, "completed");
  assert.equal(completionCount, 2, `exactly ONE auto-continue round (got ${completionCount})`);
  assert.ok(raw.includes("continue exactly where you stopped"), "continuation directive must be announced");
});

test("(7) two consecutive truncated TEXT rounds end with the truncation marker", async () => {
  const { asst, raw, completionCount } = await runTurn(
    [
      { chunks: [{ content: "PART ONE. ", finishReason: "length" }] },
      { chunks: [{ content: "PART TWO. ", finishReason: "length" }] }
    ],
    { ROUND_INACTIVITY_DEADLINE_MS: "5000", ROUND_TOTAL_DEADLINE_MS: "60000" }
  );
  assert.ok(asst, "assistant message must exist");
  assert.ok(asst!.content.includes("PART ONE"), "first half kept");
  assert.ok(asst!.content.includes("PART TWO"), "second half kept");
  assert.ok(
    asst!.content.includes("Turn ended: generation truncated at the per-message size limit."),
    `second consecutive truncation must end with the marker, got: ${asst!.content}`
  );
  assert.equal(asst!.status, "incomplete");
  assert.equal(completionCount, 2, `auto-continue fires exactly once (got ${completionCount})`);
  assert.ok(raw.includes("Turn ended: generation truncated at the per-message size limit."), "marker must reach the SSE stream");
});

test("(8) truncated TOOL CALL is NOT auto-continued", async () => {
  // A half-written call cannot be safely resumed: even a text-looking prefix
  // with a tool call in flight ends with the size-limit marker, zero extra rounds.
  const badArgs = '{"path":"a.md","content":"aaaa';
  const { asst, completionCount } = await runTurn(
    [
      { chunks: [{ content: "Writing. " }, { toolCall: { index: 0, id: "c1", type: "function", function: { name: "workspace_write_file", arguments: badArgs } }, finishReason: "length" }] },
      { chunks: [{ content: "SHOULD NEVER RUN" }] }
    ],
    { ROUND_INACTIVITY_DEADLINE_MS: "5000", ROUND_TOTAL_DEADLINE_MS: "60000" }
  );
  assert.ok(asst!.content.includes(SIZE_LIMIT_MARKER), `tool-call truncation must use the size-limit marker, got: ${asst!.content}`);
  assert.ok(!asst!.content.includes("SHOULD NEVER RUN"), "no continuation round for a truncated tool call");
  assert.equal(completionCount, 1, `no continuation round (got ${completionCount})`);
});

test("(9) per-round finish_reason recorded on the turn record (forensics)", async () => {
  const { asst } = await runTurn(
    [{ chunks: [{ content: "done", finishReason: "stop" }] }],
    { ROUND_INACTIVITY_DEADLINE_MS: "5000", ROUND_TOTAL_DEADLINE_MS: "60000" }
  );
  assert.ok(asst, "assistant message must exist");
  assert.ok(Array.isArray((asst as any).roundFinishReasons), "turn record must carry per-round finish_reasons");
  assert.ok((asst as any).roundFinishReasons.includes("stop"), "round finish reasons must include the round's finish_reason");
});

test("(10) a healthy continuous stream completes UNTOUCHED (calibration guard)", async () => {
  // Calibration: a legitimate max round (~7 min of continuous chunks under the
  // pinned 15-min total / 180s inactivity) must complete with no abort, no
  // marker, status completed. Short injected deadlines scaled to the same
  // ratio (total well above the stream duration) prove the wrapper does not
  // touch healthy rounds.
  const chunks = Array.from({ length: 200 }, (_, i) => ({ content: `tok${i} ` }));
  const { asst, raw, completionCount, slotIdle } = await runTurn(
    [{ chunks, chunkDelayMs: 10 }],
    { ROUND_INACTIVITY_DEADLINE_MS: "2000", ROUND_TOTAL_DEADLINE_MS: "5000" }
  );
  assert.ok(asst!.content.includes("tok0"), "healthy stream content must land");
  assert.ok(!asst!.content.includes(TIMEOUT_MARKER), "healthy round must never trip the timeout marker");
  assert.ok(!asst!.content.includes("Turn ended"), "healthy round must never carry an end marker");
  assert.equal(asst!.status, "completed");
  assert.equal(completionCount, 1);
  assert.equal(slotIdle, true, "slot released normally");
});
