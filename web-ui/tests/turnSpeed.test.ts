import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  computeAverageTokPerSec,
  computeLiveTokPerSec,
  sumRoundGenerationMs,
  deriveNowLineState,
} from "../lib/turnSpeed";

describe("turnSpeed — generation timing, tok/s, and header now-line", () => {
  it("computes average tok/s from output tokens and generation duration", () => {
    assert.equal(computeAverageTokPerSec(500, 10000), 50);
    assert.equal(computeAverageTokPerSec(125, 2500), 50);
    assert.equal(computeAverageTokPerSec(333, 10000), 33.3);
    assert.equal(computeAverageTokPerSec(0, 5000), null);
    assert.equal(computeAverageTokPerSec(100, 0), null);
    assert.equal(computeAverageTokPerSec(undefined, 5000), null);
  });

  it("smooths live tok/s over the current round", () => {
    const first = computeLiveTokPerSec(100, 2000, null);
    assert.equal(first, 50);
    const second = computeLiveTokPerSec(200, 2000, first);
    assert.equal(second, 67.5);
  });

  it("sums valid per-round generation durations", () => {
    assert.equal(sumRoundGenerationMs([1200, 3400, 400]), 5000);
    assert.equal(sumRoundGenerationMs(undefined), 0);
  });

  it("derives now-line state: hidden when idle, live while streaming, complete when done", () => {
    const hidden = deriveNowLineState({
      hasRunTurn: false,
      isStreaming: false,
      nowMs: 10000,
    });
    assert.equal(hidden.visible, false);

    const streaming = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: true,
      traces: [
        { tool: "workspace_run_command", args: { command: "test:gate" }, status: "running" },
      ],
      startedAtMs: 1000,
      nowMs: 6000,
      outputTokens: 250,
      liveTokPerSec: 42.5,
    });
    assert.equal(streaming.visible, true);
    assert.equal(streaming.isStreaming, true);
    assert.equal(streaming.actionLabel, "Running test:gate…");
    assert.equal(streaming.elapsedLabel, "5s");
    assert.equal(streaming.tokensLabel, "250 tok");
    assert.equal(streaming.tokPerSecLabel, "42.5 tok/s");

    const completed = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: false,
      nowMs: 12000,
      totalDurationMs: 11000,
      outputTokens: 440,
      roundGenerationMs: [5000, 6000],
    });
    assert.equal(completed.visible, true);
    assert.equal(completed.isStreaming, false);
    assert.equal(completed.elapsedLabel, "11s");
    assert.equal(completed.tokensLabel, "440 tok");
    assert.equal(completed.tokPerSecLabel, "40.0 tok/s");
  });

  it("guard: NowLineBar.tsx never uses banned zinc-500 text classes", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "web-ui/components/NowLineBar.tsx"),
      "utf8"
    );
    assert.equal(/\btext-zinc-500\b/.test(src), false);
  });
});
