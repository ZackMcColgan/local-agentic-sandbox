import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCompactCommand,
  runCompactCommand,
  COMPACT_NOTHING_TO_COMPACT,
  COMPACT_MID_TURN_MESSAGE,
} from "../lib/chat/compactCommand";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parseCompactCommand", () => {
  it("matches exact /compact (trimmed, case-insensitive)", () => {
    assert.equal(parseCompactCommand("/compact"), true);
    assert.equal(parseCompactCommand("  /compact  "), true);
    assert.equal(parseCompactCommand("/COMPACt"), true);
    assert.equal(parseCompactCommand("/CoMpAcT"), true);
  });

  it("does not match /compact embedded in longer text", () => {
    assert.equal(parseCompactCommand("/compact please"), false);
    assert.equal(parseCompactCommand("run /compact now"), false);
    assert.equal(parseCompactCommand("/compactx"), false);
    assert.equal(parseCompactCommand("/compact/"), false);
    assert.equal(parseCompactCommand("hello"), false);
    assert.equal(parseCompactCommand(""), false);
  });
});

describe("runCompactCommand", () => {
  it("POSTs the compact endpoint and reports tokens before -> after on success", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const result = await runCompactCommand("thread-42", {
      isStreaming: false,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: String((init as RequestInit)?.method || "GET") });
        return jsonResponse(200, {
          thread: { id: "thread-42", compaction: { compactedAt: "2026-11-25T00:00:00Z" } },
          tokensBefore: 120000,
          tokensAfter: 45000,
        });
      },
    });
    assert.equal(result.kind, "success");
    assert.equal(result.tokensBefore, 120000);
    assert.equal(result.tokensAfter, 45000);
    assert.equal(result.message, "History compacted: 120000 → 45000 tokens");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.ok(calls[0].url.includes("/api/threads/thread-42/compact"));
  });

  it("refuses mid-turn with the unavailable-mid-turn message and makes no request", async () => {
    const calls: string[] = [];
    const result = await runCompactCommand("thread-42", {
      isStreaming: true,
      fetchImpl: async (url) => {
        calls.push(String(url));
        return jsonResponse(200, {});
      },
    });
    assert.equal(result.kind, "refused");
    assert.equal(result.message, COMPACT_MID_TURN_MESSAGE);
    assert.equal(calls.length, 0);
  });

  it("empty new thread: nothing-to-compact notice, no request, no thread created", async () => {
    const calls: string[] = [];
    const result = await runCompactCommand(undefined, {
      isStreaming: false,
      fetchImpl: async (url) => {
        calls.push(String(url));
        return jsonResponse(200, {});
      },
    });
    assert.equal(result.kind, "no-thread");
    assert.equal(result.message, COMPACT_NOTHING_TO_COMPACT);
    assert.equal(calls.length, 0);
  });

  it("failed compaction surfaces the error message", async () => {
    const result = await runCompactCommand("thread-42", {
      isStreaming: false,
      fetchImpl: async () => jsonResponse(500, { error: "Compaction failed: LLM unreachable" }),
    });
    assert.equal(result.kind, "error");
    assert.equal(result.message, "Compaction failed: LLM unreachable");
  });

  it("failed compaction with non-JSON body still surfaces a usable error", async () => {
    const result = await runCompactCommand("thread-42", {
      isStreaming: false,
      fetchImpl: async () => new Response("boom", { status: 502 }),
    });
    assert.equal(result.kind, "error");
    assert.ok(result.message.includes("502"));
  });
});
