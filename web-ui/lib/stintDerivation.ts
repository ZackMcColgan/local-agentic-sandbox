/**
 * Pure stint-card derivation from a completed assistant turn's record and traces.
 * Every metric is derived from recorded data; anything not derivable is omitted.
 */

import { extractWriteDiffFromTrace, type TimelineTraceInput } from "./activityTimeline";
import { computeAverageTokPerSec, sumRoundGenerationMs } from "./turnSpeed";

export interface StintRecordInput {
  durationMs?: number;
  outputTokens?: number;
  roundPromptTokens?: number[];
  roundGenerationMs?: number[];
  traces?: TimelineTraceInput[];
  prUrl?: string;
}

export interface StintFilesSummary {
  count: number;
  addedLines: number;
  removedLines: number;
}

export interface StintTestsSummary {
  passed: number;
  failed: number;
}

export interface StintPrLink {
  number: number;
  url: string;
}

export interface StintMetrics {
  rounds?: number;
  durationMs?: number;
  outputTokens?: number;
  avgTokPerSec?: number;
  files?: StintFilesSummary;
  tests?: StintTestsSummary;
  pr?: StintPrLink;
}

function stringifyTraceResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    const parts = [obj.stdout, obj.stderr, obj.output, obj.message, obj.text].filter(
      (v): v is string => typeof v === "string"
    );
    if (parts.length > 0) return parts.join("\n");
    try {
      return JSON.stringify(result);
    } catch {
      return "";
    }
  }
  return "";
}

function extractTestSummary(traces: TimelineTraceInput[]): StintTestsSummary | undefined {
  let latest: StintTestsSummary | undefined;
  for (const trace of traces) {
    const text = stringifyTraceResult(trace.result);
    if (!text) continue;

    // Match test:gate format: "14 tests passed, 0 failed"
    const gateMatch = text.match(/(\d+)\s+tests?\s+passed,\s+(\d+)\s+failed/i);
    if (gateMatch) {
      latest = { passed: parseInt(gateMatch[1], 10), failed: parseInt(gateMatch[2], 10) };
      continue;
    }

    // Match node:test TAP summary: "# pass N" and "# fail M"
    const tapPass = text.match(/^#\s*pass\s+(\d+)/im);
    const tapFail = text.match(/^#\s*fail\s+(\d+)/im);
    if (tapPass) {
      latest = {
        passed: parseInt(tapPass[1], 10),
        failed: tapFail ? parseInt(tapFail[1], 10) : 0,
      };
    }
  }
  return latest;
}

function extractPrLink(
  traces: TimelineTraceInput[],
  explicitUrl?: string
): StintPrLink | undefined {
  const candidates: string[] = [];
  if (explicitUrl) candidates.push(explicitUrl);
  for (const trace of traces) {
    const text = stringifyTraceResult(trace.result);
    if (text) candidates.push(text);
  }
  for (const text of candidates) {
    const match = text.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i);
    if (match) {
      return { number: parseInt(match[1], 10), url: match[0] };
    }
  }
  return undefined;
}

/**
 * Derives stint card metrics purely from a completed turn's record and traces.
 * Returns null if no metrics can be derived.
 */
export function deriveStintMetrics(input: StintRecordInput): StintMetrics | null {
  const traces = Array.isArray(input.traces) ? input.traces : [];

  const rounds =
    Array.isArray(input.roundPromptTokens) && input.roundPromptTokens.length > 0
      ? input.roundPromptTokens.length
      : undefined;

  const durationMs =
    typeof input.durationMs === "number" &&
    Number.isFinite(input.durationMs) &&
    input.durationMs > 0
      ? input.durationMs
      : undefined;

  const outputTokens =
    typeof input.outputTokens === "number" &&
    Number.isFinite(input.outputTokens) &&
    input.outputTokens > 0
      ? input.outputTokens
      : undefined;

  const genMs = sumRoundGenerationMs(input.roundGenerationMs);
  const avgTokPerSec =
    computeAverageTokPerSec(outputTokens, genMs > 0 ? genMs : durationMs) ?? undefined;

  // Files summary from write traces
  const fileSet = new Set<string>();
  let addedLines = 0;
  let removedLines = 0;
  for (const trace of traces) {
    const diff = extractWriteDiffFromTrace(trace);
    if (!diff) continue;
    fileSet.add(diff.filePath);
    addedLines += diff.addedLines;
    removedLines += diff.removedLines;
  }
  const files: StintFilesSummary | undefined =
    fileSet.size > 0 ? { count: fileSet.size, addedLines, removedLines } : undefined;

  const tests = extractTestSummary(traces);
  const pr = extractPrLink(traces, input.prUrl);

  if (
    rounds === undefined &&
    durationMs === undefined &&
    outputTokens === undefined &&
    avgTokPerSec === undefined &&
    files === undefined &&
    tests === undefined &&
    pr === undefined
  ) {
    return null;
  }

  return {
    ...(rounds !== undefined ? { rounds } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(avgTokPerSec !== undefined ? { avgTokPerSec } : {}),
    ...(files ? { files } : {}),
    ...(tests ? { tests } : {}),
    ...(pr ? { pr } : {}),
  };
}
