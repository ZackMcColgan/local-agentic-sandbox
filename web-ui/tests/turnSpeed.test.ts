import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import {
  computeAverageTokPerSec,
  computeLiveTokPerSec,
  sumRoundGenerationMs,
  deriveNowLineState,
} from "../lib/turnSpeed";
import { NowLineBar } from "../components/NowLineBar";

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

  it("shows completed-rounds average tok/s while streaming when no live EMA is present", () => {
    const state = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: true,
      traces: [
        {
          tool: "workspace_run_command",
          args: { command: "npm test" },
          status: "running",
          timestamp: "2026-11-22T10:00:00.000Z",
        },
      ],
      startedAtMs: Date.parse("2026-11-22T10:00:00.000Z"),
      nowMs: Date.parse("2026-11-22T10:00:30.000Z"),
      outputTokens: 500,
      roundGenerationMs: [4000, 6000],
      liveTokPerSec: null,
    });
    assert.equal(state.visible, true);
    assert.equal(state.elapsedLabel, "30s");
    assert.equal(state.tokensLabel, "500 tok");
    assert.equal(state.tokPerSecLabel, "50.0 tok/s");
  });

  it("derives elapsed from earliest trace timestamp on observed turns without startedAtMs", () => {
    const state = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: true,
      traces: [
        {
          tool: "workspace_read_file",
          args: { path: "a.ts" },
          timestamp: "2026-11-22T10:00:05.000Z",
        },
        {
          tool: "workspace_run_command",
          args: { command: "npm test" },
          status: "running",
          timestamp: "2026-11-22T10:00:12.000Z",
        },
      ],
      startedAtMs: null,
      nowMs: Date.parse("2026-11-22T10:00:20.000Z"),
      outputTokens: 200,
      roundGenerationMs: [4000],
    });
    assert.equal(state.elapsedLabel, "15s");
    assert.equal(state.tokensLabel, "200 tok");
    assert.equal(state.tokPerSecLabel, "50.0 tok/s");
  });

  it("omits tok/s when streaming with zero completed rounds and no live EMA", () => {
    const state = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: true,
      startedAtMs: 1000,
      nowMs: 6000,
      outputTokens: 100,
      roundGenerationMs: [],
      liveTokPerSec: null,
    });
    assert.equal(state.elapsedLabel, "5s");
    assert.equal(state.tokPerSecLabel, null);
  });

  it("Fix 1: emits rose stall segment on now-line only while streaming and stalled (>45s silent)", () => {
    const NOW = 1_700_000_000_000;
    const stalled = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: true,
      startedAtMs: NOW - 2_000_000,
      lastActivityAtMs: NOW - 1_730_000,
      nowMs: NOW,
      outputTokens: 400,
      roundGenerationMs: [8000],
    });
    assert.equal(stalled.stallLabel, "Stalled · no heartbeat 1730s");

    const stalledHtml = renderToString(
      React.createElement(NowLineBar, {
        hasRunTurn: true,
        isStreaming: true,
        startedAtMs: NOW - 2_000_000,
        lastActivityAtMs: NOW - 1_730_000,
        nowMs: NOW,
        outputTokens: 400,
        roundGenerationMs: [8000],
      })
    );
    assert.ok(stalledHtml.includes('data-testid="now-line-stalled"'));
    assert.ok(stalledHtml.includes("Stalled · no heartbeat 1730s"));
    assert.ok(stalledHtml.includes("text-rose-700"));
    assert.ok(stalledHtml.includes("dark:text-rose-400"));

    const live = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: true,
      startedAtMs: NOW - 10_000,
      lastActivityAtMs: NOW - 5_000,
      nowMs: NOW,
    });
    assert.equal(live.stallLabel, null);

    const settled = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: false,
      totalDurationMs: 2_000_000,
      lastActivityAtMs: NOW - 1_730_000,
      nowMs: NOW,
    });
    assert.equal(settled.stallLabel, null);
  });

  it("Fix 9: settled now-line omits speed when no generation data is recorded (never renders 0.0 tok/s)", () => {
    assert.equal(computeAverageTokPerSec(1, 100_000), null);

    const settledNoGen = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: false,
      nowMs: 1_700_000_000_000,
      totalDurationMs: 17_835_000,
      outputTokens: 500,
      roundGenerationMs: [],
    });
    assert.equal(settledNoGen.visible, true);
    assert.equal(settledNoGen.elapsedLabel, "4h 57m 15s");
    assert.equal(settledNoGen.tokensLabel, "500 tok");
    assert.equal(settledNoGen.tokPerSecLabel, null);

    const html = renderToString(
      React.createElement(NowLineBar, {
        hasRunTurn: true,
        isStreaming: false,
        nowMs: 1_700_000_000_000,
        totalDurationMs: 17_835_000,
        outputTokens: 500,
      })
    );
    assert.ok(!html.includes("0.0 tok/s"));
    assert.ok(!html.includes('data-testid="now-line-toks"'));
  });

  it("guard: NowLineBar.tsx never uses banned zinc-500 text classes", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../components/NowLineBar.tsx"), "utf8");
    assert.equal(/\btext-zinc-500\b/.test(src), false);
  });
});
