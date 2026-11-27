import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isCompactSlashCommand,
  runCompactCommand,
  formatCompactNotice,
  type CompactCommandDeps,
} from "../lib/chat/compactCommand";

function makeDeps(overrides: Partial<CompactCommandDeps> = {}): CompactCommandDeps {
  return {
    threadId: "t1",
    isStreaming: false,
    isCompacting: false,
    fetchImpl: async () =>
      new Response(JSON.stringify({ tokensBefore: 1200, tokensAfter: 400 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ...overrides,
  };
}

describe("/compact composer slash command", () => {
  it("detects exact /compact case-insensitively with surrounding whitespace", () => {
    assert.equal(isCompactSlashCommand("/compact"), true);
    assert.equal(isCompactSlashCommand("  /COMPACT  "), true);
    assert.equal(isCompactSlashCommand("/CompAct"), true);
  });

  it("does NOT intercept messages that merely contain /compact", () => {
    assert.equal(isCompactSlashCommand("/compact please"), false);
    assert.equal(isCompactSlashCommand("run /compact now"), false);
    assert.equal(isCompactSlashCommand("/compact\nplease"), false);
    assert.equal(isCompactSlashCommand("/compaction"), false);
    assert.equal(isCompactSlashCommand("hello"), false);
  });

  it("exact /compact calls the compact endpoint and never posts a chat message", async () => {
    const calls: { url: string; method: string }[] = [];
    const deps = makeDeps({
      fetchImpl: async (url: string, init?: RequestInit) => {
        calls.push({ url, method: String(init?.method ?? "GET") });
        return new Response(JSON.stringify({ tokensBefore: 1200, tokensAfter: 400 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const result = await runCompactCommand(deps);
    assert.equal(result.kind, "success");
    assert.equal(result.tokensBefore, 1200);
    assert.equal(result.tokensAfter, 400);
    assert.deepEqual(calls, [{ url: "/api/threads/t1/compact", method: "POST" }]);
  });

  it("/COMPACt also intercepts and compacts", async () => {
    const result = await runCompactCommand(
      makeDeps({
        fetchImpl: async () =>
          new Response(JSON.stringify({ tokensBefore: 900, tokensAfter: 300 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      })
    );
    assert.equal(result.kind, "success");
    assert.equal(result.tokensBefore, 900);
    assert.equal(result.tokensAfter, 300);
  });

  it("empty thread shows nothing-to-compact and creates no thread (no fetch at all)", async () => {
    const calls: string[] = [];
    const result = await runCompactCommand(
      makeDeps({
        threadId: null,
        fetchImpl: async (url: string) => {
          calls.push(url);
          return new Response("{}", { status: 200 });
        },
      })
    );
    assert.equal(result.kind, "nothing-to-compact");
    assert.deepEqual(calls, []);
  });

  it("refuses mid-turn with the same unavailable-mid-turn message the manual path uses", async () => {
    const calls: string[] = [];
    const result = await runCompactCommand(
      makeDeps({
        isStreaming: true,
        fetchImpl: async (url: string) => {
          calls.push(url);
          return new Response("{}", { status: 200 });
        },
      })
    );
    assert.equal(result.kind, "unavailable-mid-turn");
    assert.equal(result.message, "A turn is streaming — wait for it to finish.");
    assert.deepEqual(calls, []);
  });

  it("a failed compaction surfaces the error", async () => {
    const result = await runCompactCommand(
      makeDeps({
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "Compactor unavailable" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
      })
    );
    assert.equal(result.kind, "error");
    assert.match(result.message, /Compactor unavailable/);
  });

  it("a network failure surfaces as an error", async () => {
    const result = await runCompactCommand(
      makeDeps({
        fetchImpl: async () => {
          throw new Error("network down");
        },
      })
    );
    assert.equal(result.kind, "error");
    assert.match(result.message, /network down/);
  });

  it("formats success and nothing-to-compact notices", () => {
    assert.equal(
      formatCompactNotice({ kind: "success", tokensBefore: 1200, tokensAfter: 400 }),
      "Compacted 1200 → 400 tokens"
    );
    assert.equal(
      formatCompactNotice({ kind: "nothing-to-compact" }),
      "Nothing to compact yet"
    );
  });
});

describe("/compact composer wiring in ChatStream", () => {
  const src = readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");

  it("imports the compact command module", () => {
    assert.match(src, /from "\.\.\/lib\/chat\/compactCommand"/);
  });

  it("intercepts /compact in handleSend before any thread-creation or send path", () => {
    const sendIdx = src.indexOf("const handleSend = async");
    assert.ok(sendIdx > 0, "handleSend must exist");
    const interceptIdx = src.indexOf("isCompactSlashCommand(prompt)");
    assert.ok(interceptIdx > sendIdx, "interception must live inside handleSend");
    const ensureIdx = src.indexOf("onEnsureThread(prompt)");
    assert.ok(ensureIdx > interceptIdx, "interception must precede thread creation");
    const compactIdx = src.indexOf("runCompactCommand(", interceptIdx);
    assert.ok(compactIdx > interceptIdx, "interception must run the compact command");
  });

  it("renders the compact notice in place with a stable testid", () => {
    assert.match(src, /data-testid="compact-notice"/);
  });

  it("keeps composer text intact on compaction failure for retry", () => {
    const idx = src.indexOf("runCompactCommand(", src.indexOf("const handleSend = async"));
    assert.ok(idx > 0);
    const window = src.slice(idx, idx + 1200);
    assert.match(window, /setInput\(rawPrompt\)/, "failed compaction must restore composer text");
  });
});
