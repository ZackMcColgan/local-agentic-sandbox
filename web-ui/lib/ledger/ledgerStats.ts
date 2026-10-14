import { RunLedgerEntry } from "./runLedger.js";

export interface LedgerSummary {
  totalRuns: number;
  completedRuns: number;
  failedOrParkedRuns: number;
  successRatePct: number;
  totalCommits: number;
  averageDurationMs: number;
}

/**
 * Aggregates statistics across run ledger records.
 */
export function summarizeLedgerRuns(runs: RunLedgerEntry[]): LedgerSummary {
  const totalRuns = runs.length;
  if (totalRuns === 0) {
    return {
      totalRuns: 0,
      completedRuns: 0,
      failedOrParkedRuns: 0,
      successRatePct: 0,
      totalCommits: 0,
      averageDurationMs: 0
    };
  }

  let completedRuns = 0;
  let failedOrParkedRuns = 0;
  const uniqueShas = new Set<string>();
  let totalDurationMs = 0;
  let durationCount = 0;

  for (const run of runs) {
    if (run.status === "completed") {
      completedRuns++;
    } else if (
      run.status === "failed" ||
      run.status === "parked" ||
      run.status === "crashed"
    ) {
      failedOrParkedRuns++;
    }

    if (Array.isArray(run.gitShas)) {
      for (const sha of run.gitShas) {
        if (sha && typeof sha === "string" && sha.trim()) {
          uniqueShas.add(sha.trim());
        }
      }
    }

    if (run.startedAt && run.completedAt) {
      const start = new Date(run.startedAt).getTime();
      const end = new Date(run.completedAt).getTime();
      if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
        totalDurationMs += end - start;
        durationCount++;
      }
    }
  }

  const rawSuccessPct = (completedRuns / totalRuns) * 100;
  const successRatePct = Math.round(rawSuccessPct * 10) / 10;
  const averageDurationMs = durationCount > 0 ? Math.round(totalDurationMs / durationCount) : 0;

  return {
    totalRuns,
    completedRuns,
    failedOrParkedRuns,
    successRatePct,
    totalCommits: uniqueShas.size,
    averageDurationMs
  };
}
