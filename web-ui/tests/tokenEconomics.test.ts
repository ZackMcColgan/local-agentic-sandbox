import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildJobTokenRollup,
  computeThreadTokenEconomics,
  type JobTokenRollup
} from "../lib/tokenEconomics";
import { ThreadStore } from "../lib/threads/threadStore";
import { LlamaCppProvider } from "../lib/llm/provider";

/**
 * TOKEN ECONOMICS PART (a): PER-ROUND PROMPT-TOKEN RECORDING + PER-JOB ROLLUP.
 *
 * PR #63's provider usage plumbing already exposes per-round usage on stream
 * chunks (lib/llm/provider.ts usage extraction site). This pass reuses that
 * plumbing: the same extraction must also carry prompt_tokens, the chat route
 * records prompt tokens per round on the thread record, and a per-job rollup
 * (rounds, prompt-token integral, output tokens, compaction count) rides on
 * the thread record and is surfaced by a small read path.
 */

function mockSseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("Token Economics (a): provider usage plumbing carries prompt tokens", () => {
  it("LlamaCppProvider streamChat yields promptTokens from usage.prompt_tokens on the finish chunk", async () => {
    const provider = new LlamaCppProvider("strata");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      mockSseResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1234,"completion_tokens":56}}\n\n',
        "data: [DONE]\n\n"
      ]);
    try {
      const chunks: any[] = [];
      for await (const chunk of provider.streamChat("http://127.0.0.1:9", {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }]
      })) {
        chunks.push(chunk);
      }
      const finishChunk = chunks.find((c) => c.finish_reason === "stop");
      assert.ok(finishChunk, "a finish_reason chunk must be yielded");
      assert.equal(finishChunk.outputTokens, 56, "existing outputTokens plumbing preserved");
      assert.equal(finishChunk.promptTokens, 1234, "prompt_tokens must ride the same usage plumbing");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("LLMStreamChunk declares promptTokens alongside outputTokens", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../lib/llm/provider.ts"), "utf8");
    assert.match(src, /promptTokens\?:\s*number/, "LLMStreamChunk must declare promptTokens");
    assert.match(src, /usage\?\.prompt_tokens/, "provider must read usage.prompt_tokens at the PR #63 extraction site");
  });
});

describe("Token Economics (a): rollup shape + thread record persistence", () => {
  it("buildJobTokenRollup produces the four-field per-job rollup", () => {
    const rollup = buildJobTokenRollup({
      rounds: 4,
      promptTokens: 10000,
      outputTokens: 320,
      compactions: 2
    });
    assert.deepEqual(rollup, { rounds: 4, promptTokens: 10000, outputTokens: 320, compactions: 2 });
  });

  it("computeThreadTokenEconomics sums per-turn rollups across assistant messages", () => {
    const thread = {
      id: "t1",
      messages: [
        { role: "user", content: "q", timestamp: "x" },
        {
          role: "assistant",
          content: "a1",
          timestamp: "x",
          tokenEconomics: { rounds: 3, promptTokens: 5000, outputTokens: 100, compactions: 1 }
        },
        {
          role: "assistant",
          content: "a2",
          timestamp: "x",
          tokenEconomics: { rounds: 2, promptTokens: 4000, outputTokens: 80, compactions: 0 }
        }
      ]
    };
    const agg = computeThreadTokenEconomics(thread);
    assert.deepEqual(agg, { rounds: 5, promptTokens: 9000, outputTokens: 180, compactions: 1 });
  });

  it("computeThreadTokenEconomics returns zeros for a thread with no recorded economics", () => {
    const agg = computeThreadTokenEconomics({ id: "t0", messages: [] });
    assert.deepEqual(agg, { rounds: 0, promptTokens: 0, outputTokens: 0, compactions: 0 });
  });

  it("ThreadStore.addMessage persists the rollup on the thread record and the read path aggregates it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-econ-store-"));
    const store = new ThreadStore(dir);
    const threadId = "thread-token-econ-1";
    store.createThread({ id: threadId, title: "Token econ", hostAccess: false });

    store.addMessage(threadId, {
      id: "a-1",
      role: "assistant",
      content: "first turn",
      timestamp: new Date().toISOString(),
      roundPromptTokens: [1000, 1200],
      tokenEconomics: { rounds: 2, promptTokens: 2200, outputTokens: 50, compactions: 0 }
    });
    store.addMessage(threadId, {
      id: "a-2",
      role: "assistant",
      content: "second turn",
      timestamp: new Date().toISOString(),
      roundPromptTokens: [3000],
      tokenEconomics: { rounds: 1, promptTokens: 3000, outputTokens: 40, compactions: 1 }
    });

    const thread = await store.getThread(threadId);
    assert.ok(thread, "thread must exist");
    const asst1 = thread!.messages.find((m: any) => m.id === "a-1") as any;
    assert.deepEqual(asst1.roundPromptTokens, [1000, 1200], "per-round prompt tokens recorded on the message");
    assert.deepEqual(asst1.tokenEconomics, { rounds: 2, promptTokens: 2200, outputTokens: 50, compactions: 0 });

    // Thread-record rollup field (board item surface): the aggregate.
    const expected: JobTokenRollup = { rounds: 3, promptTokens: 5200, outputTokens: 90, compactions: 1 };
    assert.deepEqual((thread as any).tokenEconomics, expected, "thread record must carry the aggregated rollup");

    // Small read path: store-level accessor returns the same aggregate.
    assert.deepEqual(store.getTokenEconomics(threadId), expected);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Token Economics (a): chat route wiring (source assertions)", () => {
  const routeSrc = fs.readFileSync(
    path.resolve(__dirname, "../app/api/chat/route.ts"),
    "utf8"
  );

  it("route records per-round prompt tokens and persists the rollup on the final assistant message", () => {
    assert.match(routeSrc, /roundPromptTokens\.push\(/, "route must push a prompt-token record per round");
    assert.match(routeSrc, /roundPromptTokens:\s*roundPromptTokens/, "per-round array must be persisted on the assistant message");
    assert.match(routeSrc, /tokenEconomics:\s*buildJobTokenRollup/, "final assistant message must carry the job rollup");
    assert.match(routeSrc, /turnCompactionCount/, "compaction count must be tracked per turn");
  });
});
