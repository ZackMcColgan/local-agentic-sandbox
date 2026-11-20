import type { BoardItem } from "./boardStore";

export const FLOW_MONITOR_STAGE2_DEFAULT = false;

export const REQUIRED_PR_CHECKS = [
  "Typecheck (full error report)",
  "Unit Tests & Static Analysis",
  "Code Coverage Report",
  "Container Build & Docker Scout Scan",
  "Playwright UI (Shard 1/3)",
  "Playwright UI (Shard 2/3)",
  "Playwright UI (Shard 3/3)",
] as const;

export interface PrCheckResult {
  name: string;
  status: string;
  conclusion: string | null;
  failingStep?: string;
  error?: string;
}

export interface PrChecksSnapshot {
  headSha: string;
  checks: PrCheckResult[];
}

export interface PreviousFailure {
  job: string;
  error: string;
  attemptedFix?: string;
}

export type FlowMonitorBoardItem = BoardItem & {
  prNumber?: number;
  branch?: string;
  worktreePath?: string;
  previousFailure?: PreviousFailure;
};

export interface PrCheckVerdict {
  status: "green" | "red" | "running";
  headSha: string;
  failingJob?: string;
  failingStep?: string;
  error?: string;
}

export interface EscalationEvidence {
  failingJob: string;
  error: string;
  alreadyTried: string;
  strategy: string;
}

export interface MonitorPrOptions {
  item: FlowMonitorBoardItem;
  stage2Enabled?: boolean;
  pollChecks: (item: FlowMonitorBoardItem) => Promise<PrChecksSnapshot>;
  issueThread: (params: {
    item: FlowMonitorBoardItem;
    brief: string;
  }) => Promise<{ threadId: string }>;
  log?: (message: string) => void;
}

export interface MonitorPrResult {
  action: "green" | "running" | "fix-cycle-issued" | "needs-attention" | "shadow";
  verdict: PrCheckVerdict;
  reason: string;
  brief?: string;
  threadId?: string;
  escalation?: EscalationEvidence;
}

/**
 * Stage 2 gate for flow-monitor. Defaults to OFF (shadow mode).
 */
export function isFlowMonitorStage2Enabled(
  override?: boolean,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (typeof override === "boolean") {
    return override;
  }
  return env.FLOW_MONITOR_STAGE2 === "true";
}

function isCheckRunning(check: PrCheckResult): boolean {
  const status = check.status.toUpperCase();
  if (status !== "COMPLETED") return true;
  if (!check.conclusion) return true;
  const conclusion = check.conclusion.toUpperCase();
  return conclusion === "PENDING" || conclusion === "IN_PROGRESS" || conclusion === "QUEUED";
}

function isCheckFailed(check: PrCheckResult): boolean {
  if (!check.conclusion) return false;
  const conclusion = check.conclusion.toUpperCase();
  return (
    conclusion === "FAILURE" ||
    conclusion === "TIMED_OUT" ||
    conclusion === "CANCELLED" ||
    conclusion === "ACTION_REQUIRED"
  );
}

/**
 * Evaluates PR check conclusions against the required 5-check bar on the PR head SHA.
 * Returns "running" if any required check is missing or still in progress.
 */
export function evaluatePrChecks(
  headSha: string,
  checks: PrCheckResult[]
): PrCheckVerdict {
  for (const check of checks) {
    if (isCheckFailed(check)) {
      return {
        status: "red",
        headSha,
        failingJob: check.name,
        failingStep: check.failingStep ?? "unknown step",
        error: check.error ?? `Check ${check.name} concluded with ${check.conclusion}`,
      };
    }
  }

  for (const requiredName of REQUIRED_PR_CHECKS) {
    const match = checks.find((c) => c.name === requiredName);
    if (!match || isCheckRunning(match)) {
      return { status: "running", headSha };
    }
    if ((match.conclusion ?? "").toUpperCase() !== "SUCCESS") {
      return {
        status: "red",
        headSha,
        failingJob: match.name,
        failingStep: match.failingStep ?? "unknown step",
        error: match.error ?? `Check ${match.name} concluded with ${match.conclusion}`,
      };
    }
  }

  return { status: "green", headSha };
}

/**
 * A green verdict is only valid for the head SHA it was evaluated against.
 * Any head change voids the verdict.
 */
export function isVerdictValidForHead(
  verdict: PrCheckVerdict,
  currentHeadSha: string
): boolean {
  return verdict.status === "green" && verdict.headSha === currentHeadSha;
}

/**
 * Composes one bounded fix-cycle brief for the SAME PR (same branch, same worktree).
 */
export function composeFixCycleBrief(
  item: FlowMonitorBoardItem,
  failure: {
    headSha: string;
    failingJob: string;
    failingStep?: string;
    error: string;
  }
): string {
  const prLabel = item.prNumber ? `PR #${item.prNumber}` : "the open PR";
  const branchLabel = item.branch ?? "current PR branch";
  const worktreeLabel = item.worktreePath ?? "existing item worktree";

  return [
    `BOUNDED FIX-CYCLE BRIEF — ${item.key} ${item.title}`,
    `Target: ${prLabel} on branch ${branchLabel} (worktree: ${worktreeLabel})`,
    `Head SHA: ${failure.headSha}`,
    `Failing job: ${failure.failingJob}`,
    `Failing test/step: ${failure.failingStep ?? "unknown step"}`,
    `Exact error: ${failure.error}`,
    "Scope: Fix this gap ONLY. Land the fix on the same PR, same branch, same worktree — never open a new PR.",
  ].join("\n");
}

function isSameRootCause(
  prev: PreviousFailure | undefined,
  verdict: PrCheckVerdict
): boolean {
  if (!prev || verdict.status !== "red") return false;
  const sameJob = prev.job.trim().toLowerCase() === (verdict.failingJob ?? "").trim().toLowerCase();
  const sameError = prev.error.trim().toLowerCase() === (verdict.error ?? "").trim().toLowerCase();
  return sameJob && sameError;
}

/**
 * Polls PR checks, evaluates against head SHA, and either reports running/green,
 * composes one bounded fix-cycle brief, or escalates to needs-attention on a
 * second red with the same root cause (never parks).
 *
 * Stage 2 gate defaults to OFF (shadow mode): logs the decision and issues nothing.
 */
export async function monitorPrToConclusion(
  opts: MonitorPrOptions
): Promise<MonitorPrResult> {
  const log = opts.log ?? ((msg: string) => console.info(msg));
  const snapshot = await opts.pollChecks(opts.item);
  const verdict = evaluatePrChecks(snapshot.headSha, snapshot.checks);

  if (verdict.status === "running") {
    const reason = `Checks still running on ${verdict.headSha}.`;
    log(`[flow-monitor] ${opts.item.id}: ${reason}`);
    return { action: "running", verdict, reason };
  }

  const stage2 = isFlowMonitorStage2Enabled(opts.stage2Enabled);

  if (verdict.status === "green") {
    const reason = `All 5 checks green on head SHA ${verdict.headSha}.`;
    if (!stage2) {
      log(`[flow-monitor] shadow ${opts.item.id}: ${reason}`);
      return { action: "shadow", verdict, reason };
    }
    log(`[flow-monitor] ${opts.item.id}: ${reason}`);
    return { action: "green", verdict, reason };
  }

  // Red verdict
  if (isSameRootCause(opts.item.previousFailure, verdict)) {
    const escalation: EscalationEvidence = {
      failingJob: verdict.failingJob ?? "unknown job",
      error: verdict.error ?? "unknown error",
      alreadyTried: opts.item.previousFailure?.attemptedFix ?? "prior bounded fix cycle",
      strategy: "Shrink the fix into micro-steps on the same item; never park or skip.",
    };
    const reason = `Second red on same root cause (${escalation.failingJob}); surfacing needs-attention.`;
    log(`[flow-monitor] ${opts.item.id}: ${reason}`);
    return { action: "needs-attention", verdict, reason, escalation };
  }

  const brief = composeFixCycleBrief(opts.item, {
    headSha: verdict.headSha,
    failingJob: verdict.failingJob ?? "unknown job",
    failingStep: verdict.failingStep,
    error: verdict.error ?? "unknown error",
  });

  if (!stage2) {
    const reason = `Shadow mode (stage 2 OFF): would issue fix-cycle brief for ${opts.item.id}.`;
    log(`[flow-monitor] shadow ${opts.item.id}: ${reason}\n${brief}`);
    return { action: "shadow", verdict, reason, brief };
  }

  const { threadId } = await opts.issueThread({ item: opts.item, brief });
  const reason = `Issued fix-cycle brief (${threadId}) for ${opts.item.id} on ${verdict.failingJob}.`;
  log(`[flow-monitor] ${opts.item.id}: ${reason}`);
  return { action: "fix-cycle-issued", verdict, reason, brief, threadId };
}
