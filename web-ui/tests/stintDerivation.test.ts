import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { deriveStintMetrics, formatStintDuration } from "../lib/stintDerivation";
import { StintCard } from "../components/StintCard";

describe("stintDerivation — pure thread-record metrics", () => {
  it("derives rounds, time, tokens, avg tok/s, files, tests, and PR from a fixture record", () => {
    const metrics = deriveStintMetrics({
      durationMs: 18000,
      outputTokens: 600,
      roundPromptTokens: [4200, 5100, 6300],
      roundGenerationMs: [4000, 4000, 4000],
      traces: [
        {
          tool: "workspace_write_file",
          args: { path: "web-ui/lib/a.ts" },
          result: { addedLines: 12, removedLines: 3 },
          durationMs: 40,
        },
        {
          tool: "workspace_write_file",
          args: { path: "web-ui/lib/b.ts" },
          result: { addedLines: 8, removedLines: 1 },
          durationMs: 35,
        },
        {
          tool: "workspace_run_command",
          args: { command: "npm run test:gate" },
          result: { stdout: "✅ [test:gate] PASSED: 14 tests passed, 0 failed in 4.2s." },
          durationMs: 4200,
        },
        {
          tool: "workspace_run_command",
          args: { command: "gh pr create" },
          result: { stdout: "https://github.com/org/repo/pull/247" },
          durationMs: 800,
        },
      ],
    });

    assert.ok(metrics);
    assert.equal(metrics.rounds, 3);
    assert.equal(metrics.durationMs, 18000);
    assert.equal(metrics.outputTokens, 600);
    assert.equal(metrics.avgTokPerSec, 50); // 600 / (12000 / 1000)
    assert.deepEqual(metrics.files, { count: 2, addedLines: 20, removedLines: 4 });
    assert.deepEqual(metrics.tests, { passed: 14, failed: 0 });
    assert.deepEqual(metrics.pr, { number: 247, url: "https://github.com/org/repo/pull/247" });
  });

  it("omits tests and PR when absent from traces and handles trace-less turns", () => {
    const metrics = deriveStintMetrics({
      durationMs: 5000,
      outputTokens: 200,
      roundPromptTokens: [1800],
      roundGenerationMs: [4000],
      traces: [],
    });

    assert.ok(metrics);
    assert.equal(metrics.rounds, 1);
    assert.equal(metrics.durationMs, 5000);
    assert.equal(metrics.outputTokens, 200);
    assert.equal(metrics.avgTokPerSec, 50);
    assert.equal(metrics.files, undefined);
    assert.equal(metrics.tests, undefined);
    assert.equal(metrics.pr, undefined);
  });

  it("returns null when no metrics can be derived", () => {
    assert.equal(deriveStintMetrics({}), null);
  });

  it("Fix 8: formats TIME metric like the mock ('4m 03s') and derives duration from traces when durationMs is absent", () => {
    assert.equal(formatStintDuration(243_000), "4m 03s");
    assert.equal(formatStintDuration(45_000), "45s");
    assert.equal(formatStintDuration(3_665_000), "1h 01m 05s");

    const derived = deriveStintMetrics({
      traces: [
        {
          tool: "workspace_read_file",
          args: { path: "a.ts" },
          timestamp: "2026-11-22T10:00:00.000Z",
          durationMs: 100,
        },
        {
          tool: "workspace_run_command",
          args: { command: "npm test" },
          timestamp: "2026-11-22T10:04:00.000Z",
          durationMs: 3000,
        },
      ],
    });
    assert.ok(derived);
    assert.equal(derived.durationMs, 243_000);

    const html = renderToString(
      React.createElement(StintCard, {
        durationMs: 243_000,
        outputTokens: 600,
        roundPromptTokens: [4000, 5000],
        roundGenerationMs: [6000, 6000],
      })
    );
    assert.ok(html.includes('data-testid="stint-time"'));
    assert.ok(html.includes("4m 03s"));
  });

  it("Fix 9: omits avg speed in stint card when no generation data is recorded (never renders 0.0 tok/s)", () => {
    const metrics = deriveStintMetrics({
      durationMs: 17_835_000,
      outputTokens: 500,
      roundPromptTokens: [4000],
      roundGenerationMs: [],
    });
    assert.ok(metrics);
    assert.equal(metrics.avgTokPerSec, undefined);

    const html = renderToString(
      React.createElement(StintCard, {
        durationMs: 17_835_000,
        outputTokens: 500,
        roundPromptTokens: [4000],
      })
    );
    assert.ok(!html.includes("0.0 tok/s"));
    assert.ok(!html.includes('data-testid="stint-avg-speed"'));
  });

  it("guard: StintCard.tsx never uses banned zinc-500 text classes", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../components/StintCard.tsx"), "utf8");
    assert.equal(/\btext-zinc-500\b/.test(src), false);
  });
});
