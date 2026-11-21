import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { appendNarrationChunk } from "../lib/liveActivity";

describe("UI-010: narration chunk separators", () => {
  it("inserts a newline between separate status chunks that end with punctuation and start with uppercase", () => {
    let acc = "";
    acc = appendNarrationChunk(acc, "Updated runlog.");
    acc = appendNarrationChunk(acc, "Both runs green.");
    acc = appendNarrationChunk(acc, "Banking commit.");
    assert.equal(acc, "Updated runlog.\nBoth runs green.\nBanking commit.");
  });

  it("leaves single-chunk messages unchanged", () => {
    assert.equal(appendNarrationChunk("", "Single chunk."), "Single chunk.");
  });

  it("does not split mid-word BPE tokens or normal spaced tokens", () => {
    let acc = "";
    acc = appendNarrationChunk(acc, "hel");
    acc = appendNarrationChunk(acc, "lo");
    acc = appendNarrationChunk(acc, " world");
    assert.equal(acc, "hello world");
  });

  it("does not double-insert newlines when chunk or existing already has one", () => {
    assert.equal(appendNarrationChunk("Line 1.\n", "Line 2."), "Line 1.\nLine 2.");
    assert.equal(appendNarrationChunk("Line 1.", "\nLine 2."), "Line 1.\nLine 2.");
  });

  it("chat/route.ts uses appendNarrationChunk for streamed token assembly", () => {
    const routeSrc = fs.readFileSync(path.join(process.cwd(), "app/api/chat/route.ts"), "utf8");
    assert.match(routeSrc, /appendNarrationChunk\s*\(/);
  });
});
