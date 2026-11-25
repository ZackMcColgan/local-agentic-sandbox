import crypto from "node:crypto";
import {
  BoardStore,
  extractThreadIdFromLink,
  type BoardEvidence,
  type BoardStatus,
} from "./boardStore";
import {
  composeDispatcherBrief,
  selectHeadEligibleItem,
  type DispatcherBoardItem,
  type DispatcherHandoff,
  type LiveJobState,
  type OwnerTurnState,
} from "./dispatcher";
import { getControlStopReason, readBoardControlState } from "./boardControl";
import type { BoardControlRecord } from "./boardControlStore";
import { getSharedSlotScheduler, type SlotUtilizationMetrics } from "../slotScheduler";
import {
  isFlowMonitorArmEnabled,
  isFlowMonitorObserveEnabled,
  monitorPrToConclusion,
  recordFlowMonitorObservation,
  type FlowMonitorBoardItem,
  type MonitorPrResult,
  type PrChecksSnapshot,
} from "./flowMonitor";
import {
  verifyJobCompletion,
  type FinishVerificationResult,
} from "../subagents/finishVerificationGate";
import {
  evaluateReviewerGate,
  isReviewerGateStage3Enabled,
  type EvaluateReviewerGateOptions,
  type MechanicalCheckInput,
  type ReviewerGateResult,
} from "./reviewerGate";
import { AgreementLedgerStore, type PersistentAgreementLedger } from "./agreementLedger";
import {
  isSelfDeployVerifiedEnabled,
  runSelfDeployVerified,
  type DeployInput,
  type SelfDeployVerifiedDeps,
  type SelfDeployVerifiedResult,
} from "../deploy/selfDeployVerified";

export { extractThreadIdFromLink };

export const MAX_DRAIN_ITEMS = 5;
export const MAX_DRAIN_DURATION_MS = 10 * 60 * 1000;
export const MAX_TRIAGE_ATTEMPTS = 2;
export const MAX_ORPHAN_AUTO_RESUMES = 2;
export const MAX_CHUNK_REQUEUES = 10;
export const ORPHANED_WORKING_ITEM_REASON =
  "Job thread ended without an outcome (possible restart)";

export interface OrphanedThreadEvidence {
  threadId?: string;
  hasPrOrCommitEvidence: boolean;
  evidenceSummary?: string;
  previousAttemptSummary?: string;
  branch?: string;
  headSha?: string;
}

export type WorkingItemLiveness =
  | { status: "live"; reason?: string }
  | { status: "completed"; outcome: JobExecutionOutcome; reason?: string }
  | { status: "orphaned"; reason: string; evidence?: OrphanedThreadEvidence }
  | { status: "unknown"; reason?: string };

export interface OrchestratorIssue {
  code: string;
  message: string;
  autoFixable: boolean;
  fixAction?: () => Promise<boolean> | boolean;
}

export interface TriageOutcome {
  action: "fixed" | "surfaced";
  code: string;
  message: string;
  attempts: number;
}

export interface ShadowStageOutcomes {
  flowMonitor?: MonitorPrResult;
  reviewerGate?: ReviewerGateResult;
  selfDeploy?: SelfDeployVerifiedResult;
}

export interface PrOpenShadowResult {
  flowMonitor?: MonitorPrResult;
  reviewerGate?: ReviewerGateResult;
  ledger?: PersistentAgreementLedger;
}

export interface OrchestratorStageFlags {
  flowMonitor?: boolean;
  reviewerGate?: boolean;
  selfDeploy?: boolean;
}

export type JobExecutionOutcome =
  | {
      status: "completed";
      threadId: string;
      summary?: string;
      prNumber?: number;
      headSha?: string;
      merged?: boolean;
      mergeSha?: string;
      deployTag?: string;
    }
  | { status: "chunk-complete"; threadId: string; handoff: DispatcherHandoff }
  | { status: "failed"; threadId?: string; error: string; issue?: OrchestratorIssue }
  | { status: "in-progress"; threadId: string; reason?: string };

export interface DrainItemOutcome {
  itemId: string;
  key: string;
  title: string;
  outcome: "completed" | "failed" | "in-progress" | "chunk-requeued" | "orphan-requeued";
  threadId?: string;
  reason?: string;
  triage?: TriageOutcome;
  shadowStages?: ShadowStageOutcomes;
  durationMs: number;
}

export type DrainStopReason =
  | "idle"
  | "control-paused"
  | "control-stopped"
  | "owner-preempted"
  | "job-already-running"
  | "max-items-reached"
  | "time-cap-reached";

export interface SurfacedDrainIssue {
  itemId: string;
  key: string;
  code: string;
  message: string;
}

export interface DrainReport {
  drainId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stopReason: DrainStopReason;
  completedCount: number;
  failedCount: number;
  inProgressCount: number;
  requeuedCount: number;
  surfacedCount: number;
  itemsProcessed: number;
  outcomes: DrainItemOutcome[];
  surfacedIssues: SurfacedDrainIssue[];
  slotUtilization: SlotUtilizationMetrics;
}

export interface BoardOrchestratorDeps {
  boardDir?: string;
  boardStore?: BoardStore;
  items?: DispatcherBoardItem[];
  getControlState?: () => BoardControlRecord;
  getLiveJobState?: () => LiveJobState;
  getOwnerState?: () => OwnerTurnState;
  checkWorkingItemLiveness?: (
    item: DispatcherBoardItem
  ) => Promise<WorkingItemLiveness> | WorkingItemLiveness;
  getSlotMetrics?: () => SlotUtilizationMetrics;
  operatorMemory?: string;
  hostCheckoutPath?: string;
  now?: () => number;
  maxItems?: number;
  maxDurationMs?: number;
  maxChunkRequeues?: number;
  dryRun?: boolean;
  issueAndWait: (params: {
    item: DispatcherBoardItem;
    brief: string;
    onThreadCreated?: (threadId: string) => void;
  }) => Promise<JobExecutionOutcome>;
  triageAutoFix?: (
    issue: OrchestratorIssue,
    item: DispatcherBoardItem
  ) => Promise<boolean> | boolean;
  stageFlags?: OrchestratorStageFlags;
  agreementLedger?: AgreementLedgerStore;
  flowMonitor?: {
    pollChecks: (item: FlowMonitorBoardItem) => Promise<PrChecksSnapshot>;
    issueThread?: (params: {
      item: FlowMonitorBoardItem;
      brief: string;
    }) => Promise<{ threadId: string }>;
  };
  reviewerGate?: {
    getMechanicalInput: (
      item: DispatcherBoardItem,
      pr: { prNumber: number; headSha: string }
    ) => Promise<MechanicalCheckInput> | MechanicalCheckInput;
    issueReviewerThread: EvaluateReviewerGateOptions["issueReviewerThread"];
  };
  /**
   * Resolve the real head SHA for a PR (gh pr view --json headRefOid). Used
   * when recording a shadow verdict so the verdict is tied to the exact head
   * that was reviewed, even when check polling fell back to a placeholder.
   */
  resolveHeadSha?: (prNumber: number) => Promise<string | null> | string | null;
  /** HO-7: Optional predicate returning true when a build turn holds the engine slot. */
  isBuildSlotBusy?: () => boolean;
  /** HO-2: Optional finish-verification hook wired into the reviewer gate input. */
  verifyFinish?: (item: DispatcherBoardItem) => FinishVerificationResult;
  selfDeploy?: {
    deps?: SelfDeployVerifiedDeps;
    getDeployInput?: (
      item: DispatcherBoardItem,
      merge: { mergeSha: string; targetTag?: string }
    ) => DeployInput;
  };
  log?: (message: string) => void;
}

const LAST_DRAIN_REPORT_KEY = Symbol.for("local-agentic-sandbox.lastDrainReport");

export function getLastDrainReport(): DrainReport | null {
  const g = globalThis as Record<symbol, DrainReport | undefined>;
  return g[LAST_DRAIN_REPORT_KEY] ?? null;
}

export function setLastDrainReport(report: DrainReport): void {
  const g = globalThis as Record<symbol, DrainReport | undefined>;
  g[LAST_DRAIN_REPORT_KEY] = report;
}

const getGlobalDrainMutexHost = (): {
  __boardDrainInFlight?: Promise<unknown> | null;
} => globalThis as typeof globalThis & { __boardDrainInFlight?: Promise<unknown> | null };

export function isBoardDrainInFlight(): boolean {
  return Boolean(getGlobalDrainMutexHost().__boardDrainInFlight);
}

/**
 * Deduplicates concurrent board drains (daemon ticks and manual POST /api/board/drain)
 * via a process-wide single-flight promise on `globalThis.__boardDrainInFlight`.
 */
export async function runBoardDrainWithMutex<T>(
  fn: () => Promise<T>
): Promise<{ result: T; deduplicated: boolean }> {
  const g = getGlobalDrainMutexHost();
  const existing = g.__boardDrainInFlight as Promise<T> | null | undefined;
  if (existing) {
    const result = await existing;
    return { result, deduplicated: true };
  }
  const runPromise = (async () => fn())();
  g.__boardDrainInFlight = runPromise;
  try {
    const result = await runPromise;
    return { result, deduplicated: false };
  } finally {
    if (g.__boardDrainInFlight === runPromise) {
      g.__boardDrainInFlight = null;
    }
  }
}

/**
 * Runs bounded triage for a failed item. Auto-fixable issues are attempted up to
 * MAX_TRIAGE_ATTEMPTS; non-auto-fixable or unfixed issues are always surfaced.
 */
export async function boundedTriage(
  issue: OrchestratorIssue,
  item: DispatcherBoardItem,
  fixFn?: (issue: OrchestratorIssue, item: DispatcherBoardItem) => Promise<boolean> | boolean
): Promise<TriageOutcome> {
  if (!issue.autoFixable) {
    return {
      action: "surfaced",
      code: issue.code,
      message: issue.message,
      attempts: 0,
    };
  }

  const handler = issue.fixAction ?? fixFn;
  if (!handler) {
    return {
      action: "surfaced",
      code: issue.code,
      message: issue.message,
      attempts: 0,
    };
  }

  for (let attempt = 1; attempt <= MAX_TRIAGE_ATTEMPTS; attempt += 1) {
    try {
      const fixed = await handler(issue, item);
      if (fixed) {
        return {
          action: "fixed",
          code: issue.code,
          message: issue.message,
          attempts: attempt,
        };
      }
    } catch {
      // Bounded: fall through to surface if attempts exhaust
    }
  }

  return {
    action: "surfaced",
    code: issue.code,
    message: issue.message,
    attempts: MAX_TRIAGE_ATTEMPTS,
  };
}

export class BoardOrchestrator {
  private readonly deps: BoardOrchestratorDeps;
  private readonly maxItems: number;
  private readonly maxDurationMs: number;
  private readonly maxChunkRequeues: number;
  private readonly dryRun: boolean;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private dryRunItems: DispatcherBoardItem[] | null = null;

  constructor(deps: BoardOrchestratorDeps) {
    this.deps = deps;
    const requestedItems = deps.maxItems ?? MAX_DRAIN_ITEMS;
    this.maxItems = Math.min(Math.max(1, Math.floor(requestedItems)), MAX_DRAIN_ITEMS);
    const requestedDuration = deps.maxDurationMs ?? MAX_DRAIN_DURATION_MS;
    this.maxDurationMs = Math.min(Math.max(1, requestedDuration), MAX_DRAIN_DURATION_MS);
    this.maxChunkRequeues = Math.max(1, Math.floor(deps.maxChunkRequeues ?? MAX_CHUNK_REQUEUES));
    this.dryRun = deps.dryRun === true;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((msg: string) => console.info(msg));
  }

  private getItems(): DispatcherBoardItem[] {
    if (this.dryRun) {
      if (!this.dryRunItems) {
        const source = this.deps.items
          ? this.deps.items
          : ((
              this.deps.boardStore ?? new BoardStore(this.deps.boardDir)
            ).list() as DispatcherBoardItem[]);
        this.dryRunItems = source.map((item) => ({ ...item }));
      }
      return this.dryRunItems;
    }
    if (this.deps.items) {
      return this.deps.items;
    }
    const store = this.deps.boardStore ?? new BoardStore(this.deps.boardDir);
    return store.list() as DispatcherBoardItem[];
  }

  private reloadItem(fallback: DispatcherBoardItem): DispatcherBoardItem {
    if (this.dryRun || this.deps.items) {
      return this.getItems().find((i) => i.id === fallback.id) ?? fallback;
    }
    const store = this.deps.boardStore ?? new BoardStore(this.deps.boardDir);
    return (store.get(fallback.id) as DispatcherBoardItem | undefined) ?? fallback;
  }

  private updateItem(
    item: DispatcherBoardItem,
    patch: {
      status?: BoardStatus;
      handoff?: DispatcherHandoff | null;
      autoResumeCount?: number | null;
      chunkRequeueCount?: number | null;
      needsAttention?: boolean | null;
      parkedReason?: string | null;
      evidence?: BoardEvidence | null;
      threadLink?: string;
    }
  ): void {
    const isTransitionToClear =
      patch.status === "working" || patch.status === "done" || patch.status === "queued";

    if (patch.status !== undefined) item.status = patch.status;
    if (patch.handoff === null) {
      delete item.handoff;
    } else if (patch.handoff !== undefined) {
      item.handoff = patch.handoff;
    }
    if (patch.autoResumeCount === null) {
      delete item.autoResumeCount;
    } else if (patch.autoResumeCount !== undefined) {
      item.autoResumeCount = patch.autoResumeCount;
    }
    if (patch.chunkRequeueCount === null) {
      delete item.chunkRequeueCount;
    } else if (patch.chunkRequeueCount !== undefined) {
      item.chunkRequeueCount = patch.chunkRequeueCount;
    }
    if (
      patch.needsAttention === null ||
      (isTransitionToClear && patch.needsAttention === undefined)
    ) {
      delete item.needsAttention;
    } else if (patch.needsAttention !== undefined) {
      item.needsAttention = patch.needsAttention;
    }
    if (patch.parkedReason === null || (isTransitionToClear && patch.parkedReason === undefined)) {
      delete item.parkedReason;
    } else if (patch.parkedReason !== undefined) {
      item.parkedReason = patch.parkedReason;
    }
    if (patch.evidence === null) {
      delete item.evidence;
    } else if (patch.evidence !== undefined) {
      const mergedEvidence = Object.fromEntries(
        Object.entries({ ...(item.evidence ?? {}), ...patch.evidence }).filter(
          ([, v]) => v !== undefined
        )
      ) as BoardEvidence;
      if (Object.keys(mergedEvidence).length > 0) {
        item.evidence = mergedEvidence;
      } else {
        delete item.evidence;
      }
    }
    if (patch.threadLink !== undefined) item.threadLink = patch.threadLink;
    item.updatedAt = new Date(this.now()).toISOString();

    if (this.dryRun) {
      return;
    }

    if (!this.deps.items) {
      const store = this.deps.boardStore ?? new BoardStore(this.deps.boardDir);
      store.update(item.id, {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.handoff !== undefined ? { handoff: patch.handoff } : {}),
        ...(patch.autoResumeCount !== undefined ? { autoResumeCount: patch.autoResumeCount } : {}),
        ...(patch.chunkRequeueCount !== undefined
          ? { chunkRequeueCount: patch.chunkRequeueCount }
          : {}),
        ...(patch.needsAttention !== undefined ? { needsAttention: patch.needsAttention } : {}),
        ...(patch.parkedReason !== undefined ? { parkedReason: patch.parkedReason } : {}),
        ...(patch.evidence !== undefined ? { evidence: patch.evidence } : {}),
        ...(patch.threadLink !== undefined ? { threadLink: patch.threadLink } : {}),
      });
    }
  }

  private resolveFlowMonitorEnabled(): boolean {
    if (typeof this.deps.stageFlags?.flowMonitor === "boolean") {
      return this.deps.stageFlags.flowMonitor;
    }
    return isFlowMonitorArmEnabled(undefined);
  }

  private resolveReviewerGateEnabled(): boolean {
    return isReviewerGateStage3Enabled(this.deps.stageFlags?.reviewerGate);
  }

  private resolveSelfDeployEnabled(): boolean {
    return isSelfDeployVerifiedEnabled(this.deps.stageFlags?.selfDeploy);
  }

  private getAgreementLedger(): AgreementLedgerStore {
    return this.deps.agreementLedger ?? new AgreementLedgerStore(this.deps.boardDir);
  }

  /**
   * Resolve the head SHA to persist with a shadow verdict. A real 40-char SHA
   * is used as-is; otherwise the resolver (gh pr view --json headRefOid) is
   * consulted. If resolution fails, the placeholder is kept and the failure is
   * logged - never recorded silently.
   */
  private async resolveRecordedHeadSha(
    pr: { prNumber: number; headSha: string },
    itemKey: string
  ): Promise<string> {
    if (/^[0-9a-f]{40}$/i.test(pr.headSha)) {
      return pr.headSha;
    }
    const resolver = this.deps.resolveHeadSha;
    if (resolver) {
      try {
        const resolved = await resolver(pr.prNumber);
        if (resolved && /^[0-9a-f]{40}$/i.test(resolved)) {
          return resolved;
        }
      } catch (err) {
        this.log(
          `[orchestrator] head sha resolution threw for PR ${pr.prNumber} (${itemKey}): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    this.log(
      `[orchestrator] head sha unresolved for PR ${pr.prNumber} (${itemKey}); recording placeholder '${pr.headSha}'`
    );
    return pr.headSha;
  }

  async runPrOpenShadowStages(
    item: DispatcherBoardItem,
    pr: { prNumber: number; headSha: string }
  ): Promise<PrOpenShadowResult> {
    const result: PrOpenShadowResult = {};

    if (this.deps.flowMonitor) {
      try {
        const flowItem: FlowMonitorBoardItem = {
          ...item,
          prNumber: pr.prNumber,
        };
        const stage2Enabled = this.resolveFlowMonitorEnabled();
        result.flowMonitor = await monitorPrToConclusion({
          item: flowItem,
          stage2Enabled,
          pollChecks: this.deps.flowMonitor.pollChecks,
          issueThread:
            this.deps.flowMonitor.issueThread ?? (async () => ({ threadId: "shadow-noop" })),
          log: this.log,
        });
        if (isFlowMonitorObserveEnabled()) {
          recordFlowMonitorObservation({
            itemKey: item.key,
            prNumber: pr.prNumber,
            action: result.flowMonitor.action,
            verdictStatus: result.flowMonitor.verdict.status,
            reason: result.flowMonitor.reason,
          });
        }
      } catch (err) {
        this.log(
          `[orchestrator] shadow flowMonitor failed for ${item.id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    if (this.deps.reviewerGate) {
      const slotBusy = this.deps.isBuildSlotBusy
        ? this.deps.isBuildSlotBusy()
        : Boolean(getSharedSlotScheduler().getSnapshot().active);
      if (slotBusy) {
        this.log(
          `[orchestrator] shedding shadow reviewer for ${item.id} (PR #${pr.prNumber}) while build turn holds engine slot`
        );
      } else {
        try {
          const revStartMs = this.now();
          const stage3Enabled = this.resolveReviewerGateEnabled();
          const mechanicalInput = await this.deps.reviewerGate.getMechanicalInput(item, pr);
          const finishResult = this.deps.verifyFinish
            ? this.deps.verifyFinish(item)
            : verifyJobCompletion({
                workspaceRoot: this.deps.hostCheckoutPath || process.cwd(),
                gatePassed: result.flowMonitor?.verdict.status === "green",
              });
          const gateResult = await evaluateReviewerGate({
            itemId: item.id,
            brief: item.brief,
            mechanicalInput,
            stage3Enabled,
            ciAllGreen: result.flowMonitor?.verdict.status === "green",
            finishVerificationClean: finishResult.ok,
            issueReviewerThread: this.deps.reviewerGate.issueReviewerThread,
            log: this.log,
          });
          result.reviewerGate = {
            ...gateResult,
            mergeAuthorized: stage3Enabled ? gateResult.mergeAuthorized : false,
          };
          const recordedHeadSha = await this.resolveRecordedHeadSha(pr, item.key);
          const engineMinutes = Math.round(((this.now() - revStartMs) / 60_000) * 1000) / 1000;
          result.ledger = this.getAgreementLedger().recordShadowVerdict({
            prNumber: pr.prNumber,
            headSha: recordedHeadSha,
            reviewerVerdict: gateResult.verdict,
            engineMinutes,
          });
        } catch (err) {
          this.log(
            `[orchestrator] shadow reviewerGate failed for ${item.id}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }

    return result;
  }

  async runMergedShadowStage(
    item: DispatcherBoardItem,
    merge: { mergeSha: string; targetTag?: string }
  ): Promise<SelfDeployVerifiedResult> {
    const stageEnabled = this.resolveSelfDeployEnabled();
    const deployInput: DeployInput = this.deps.selfDeploy?.getDeployInput
      ? this.deps.selfDeploy.getDeployInput(item, merge)
      : {
          targetTag:
            merge.targetTag ?? `local-agentic-sandbox-web-ui:${merge.mergeSha.slice(0, 7)}`,
          developSha: merge.mergeSha,
        };

    const deployDeps: SelfDeployVerifiedDeps = this.deps.selfDeploy?.deps ?? {
      readCurrentState: async () => ({
        image: "local-agentic-sandbox:shadow-current",
        podStatus: "Running",
        podRestarts: 0,
      }),
      bankRollbackTarget: async (tag: string) => ({ banked: true, tag }),
      buildAndImport: async (targetTag: string, dryRun: boolean) => ({
        built: !dryRun,
        imported: !dryRun,
        imagePresentInNode: !dryRun,
        detail: dryRun
          ? `shadow preparation bookkeeping only for ${targetTag}`
          : `built ${targetTag}`,
      }),
      setImage: async () => ({ ok: false }),
      verifyDeployment: async (expectedTag: string) => ({
        ok: false,
        rolloutSuccess: false,
        podRunningZeroRestarts: false,
        gatewayStatus: 0,
        threadListLoads: false,
        observedTag: expectedTag,
      }),
    };

    try {
      return await runSelfDeployVerified(deployInput, deployDeps, { stageEnabled });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`[orchestrator] shadow selfDeploy failed for ${item.id}: ${reason}`);
      return {
        mode: stageEnabled ? "execute" : "shadow",
        status: "failed",
        deployTag: deployInput.targetTag,
        needsAttention: stageEnabled,
        reason,
      };
    }
  }

  private async settleCompletedOutcome(
    item: DispatcherBoardItem,
    outcome: Extract<JobExecutionOutcome, { status: "completed" }>,
    startedMs: number
  ): Promise<{
    completedDelta: number;
    failedDelta: number;
    outcomeRecord: DrainItemOutcome;
  }> {
    let shadowStages: ShadowStageOutcomes | undefined;
    if (outcome.prNumber !== undefined && (this.deps.flowMonitor || this.deps.reviewerGate)) {
      try {
        const prShadow = await this.runPrOpenShadowStages(item, {
          prNumber: outcome.prNumber,
          headSha: outcome.headSha ?? "unknown-head",
        });
        shadowStages = {
          ...(prShadow.flowMonitor ? { flowMonitor: prShadow.flowMonitor } : {}),
          ...(prShadow.reviewerGate ? { reviewerGate: prShadow.reviewerGate } : {}),
        };
      } catch (err) {
        this.log(
          `[orchestrator] pr-open shadow stages failed for ${item.id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    if (outcome.merged && outcome.mergeSha && this.deps.selfDeploy) {
      try {
        const selfDeploy = await this.runMergedShadowStage(item, {
          mergeSha: outcome.mergeSha,
          targetTag: outcome.deployTag,
        });
        shadowStages = {
          ...(shadowStages ?? {}),
          selfDeploy,
        };
      } catch (err) {
        this.log(
          `[orchestrator] merged shadow stage failed for ${item.id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    const deployTag = outcome.deployTag ?? shadowStages?.selfDeploy?.deployTag;
    const evidence: BoardEvidence = {
      ...(outcome.prNumber !== undefined ? { prNumber: outcome.prNumber } : {}),
      ...(outcome.mergeSha ? { mergeSha: outcome.mergeSha } : {}),
      ...(deployTag ? { deployTag } : {}),
    };
    const hasEvidence = Object.keys(evidence).length > 0;

    if (shadowStages?.selfDeploy?.needsAttention) {
      const reason = shadowStages.selfDeploy.reason ?? shadowStages.selfDeploy.evidence;
      this.updateItem(item, {
        status: "needs-attention",
        needsAttention: true,
        parkedReason: reason,
        ...(hasEvidence ? { evidence } : {}),
        threadLink: `/?thread=${outcome.threadId}`,
      });
      return {
        completedDelta: 0,
        failedDelta: 1,
        outcomeRecord: {
          itemId: item.id,
          key: item.key,
          title: item.title,
          outcome: "failed",
          threadId: outcome.threadId,
          reason,
          shadowStages,
          durationMs: Math.max(0, this.now() - startedMs),
        },
      };
    }

    this.updateItem(item, {
      status: "done",
      ...(hasEvidence ? { evidence } : {}),
      threadLink: `/?thread=${outcome.threadId}`,
      ...(item.handoff ? { handoff: null } : {}),
    });
    return {
      completedDelta: 1,
      failedDelta: 0,
      outcomeRecord: {
        itemId: item.id,
        key: item.key,
        title: item.title,
        outcome: "completed",
        threadId: outcome.threadId,
        reason: outcome.summary,
        ...(shadowStages ? { shadowStages } : {}),
        durationMs: Math.max(0, this.now() - startedMs),
      },
    };
  }

  private recordChunkCompleteOutcome(
    item: DispatcherBoardItem,
    outcome: Extract<JobExecutionOutcome, { status: "chunk-complete" }>,
    startedMs: number
  ): {
    requeuedDelta: number;
    failedDelta: number;
    surfacedIssue?: SurfacedDrainIssue;
    outcomeRecord: DrainItemOutcome;
  } {
    const currentChunkCount = item.chunkRequeueCount ?? 0;
    if (currentChunkCount >= this.maxChunkRequeues) {
      const reason = `Chunk requeue budget exhausted (${currentChunkCount}/${this.maxChunkRequeues}) without completion.`;
      this.log(`[orchestrator] parking item ${item.id} (${item.key}): ${reason}`);
      this.updateItem(item, {
        status: "needs-attention",
        needsAttention: true,
        parkedReason: reason,
        handoff: outcome.handoff,
        threadLink: `/?thread=${outcome.threadId}`,
      });
      return {
        requeuedDelta: 0,
        failedDelta: 1,
        surfacedIssue: {
          itemId: item.id,
          key: item.key,
          code: "chunk-requeue-limit",
          message: reason,
        },
        outcomeRecord: {
          itemId: item.id,
          key: item.key,
          title: item.title,
          outcome: "failed",
          threadId: outcome.threadId,
          reason,
          durationMs: Math.max(0, this.now() - startedMs),
        },
      };
    }

    const nextChunkCount = currentChunkCount + 1;
    this.updateItem(item, {
      status: "queued",
      handoff: outcome.handoff,
      chunkRequeueCount: nextChunkCount,
      threadLink: `/?thread=${outcome.threadId}`,
    });
    return {
      requeuedDelta: 1,
      failedDelta: 0,
      outcomeRecord: {
        itemId: item.id,
        key: item.key,
        title: item.title,
        outcome: "chunk-requeued",
        threadId: outcome.threadId,
        reason: outcome.handoff.nextStep,
        durationMs: Math.max(0, this.now() - startedMs),
      },
    };
  }

  async drain(): Promise<DrainReport> {
    const startMs = this.now();
    const startedAt = new Date(startMs).toISOString();
    const drainId = `drain-${crypto.randomBytes(4).toString("hex")}`;

    const outcomes: DrainItemOutcome[] = [];
    const surfacedIssues: SurfacedDrainIssue[] = [];
    let completedCount = 0;
    let failedCount = 0;
    let inProgressCount = 0;
    let requeuedCount = 0;
    let itemsProcessed = 0;
    let stopReason: DrainStopReason = "idle";

    const getControl =
      this.deps.getControlState ?? (() => readBoardControlState(this.deps.boardDir));
    const getLiveJob = this.deps.getLiveJobState ?? (() => ({ isRunning: false }));
    const getOwner = this.deps.getOwnerState ?? (() => ({ isMidTurn: false }));
    const getSlotMetrics =
      this.deps.getSlotMetrics ?? (() => getSharedSlotScheduler().getMetrics());

    while (true) {
      // control.drainBudget (persisted by /api/board/control) is the effective
      // per-drain cap when set; the request/constructor maxItems only narrows
      // it further. A null budget leaves the constructor cap untouched.
      const budgetControl = getControl();
      const effectiveMaxItems =
        typeof budgetControl.drainBudget === "number" &&
        Number.isFinite(budgetControl.drainBudget)
          ? Math.min(this.maxItems, Math.max(1, Math.floor(budgetControl.drainBudget)))
          : this.maxItems;

      if (itemsProcessed >= effectiveMaxItems) {
        stopReason = "max-items-reached";
        break;
      }

      if (this.now() - startMs >= this.maxDurationMs) {
        stopReason = "time-cap-reached";
        break;
      }

      const control = getControl();
      const controlStop = getControlStopReason(control.state);

      // Reconcile dead "working" items even when boardControl is "paused" or "stopped"
      // so stale/settled cards never remain stuck in "working". Never issue new queued jobs
      // when controlStop is active.
      const items = this.getItems();
      const workingItems = items.filter((item) => item.status === "working");
      if (workingItems.length > 0 && this.deps.checkWorkingItemLiveness) {
        let hasLiveWorkingItem = false;
        let restartLoopAfterRecovery = false;
        for (const workingItem of workingItems) {
          let liveness: WorkingItemLiveness;
          try {
            liveness = await this.deps.checkWorkingItemLiveness(workingItem);
          } catch (err) {
            this.log(
              `[orchestrator] liveness check failed for ${workingItem.id}; treating as live: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
            hasLiveWorkingItem = true;
            break;
          }
          if (liveness.status === "completed") {
            const recoveryStartMs = this.now();
            this.log(
              `[orchestrator] reconciling settled working item ${workingItem.id} (${workingItem.key}): ${
                liveness.reason || liveness.outcome.status
              }`
            );
            const outcomeResult = liveness.outcome;
            if (outcomeResult.status === "completed") {
              const settled = await this.settleCompletedOutcome(
                workingItem,
                outcomeResult,
                recoveryStartMs
              );
              completedCount += settled.completedDelta;
              failedCount += settled.failedDelta;
              itemsProcessed += 1;
              outcomes.push(settled.outcomeRecord);
            } else if (outcomeResult.status === "chunk-complete") {
              const chunked = this.recordChunkCompleteOutcome(
                workingItem,
                outcomeResult,
                recoveryStartMs
              );
              requeuedCount += chunked.requeuedDelta;
              failedCount += chunked.failedDelta;
              itemsProcessed += 1;
              if (chunked.surfacedIssue) surfacedIssues.push(chunked.surfacedIssue);
              outcomes.push(chunked.outcomeRecord);
            } else if (outcomeResult.status === "failed") {
              const issue = outcomeResult.issue ?? {
                code: "execution-failed",
                message: outcomeResult.error,
                autoFixable: false,
              };
              this.updateItem(workingItem, {
                status: "needs-attention",
                needsAttention: true,
                parkedReason: issue.message,
                threadLink: outcomeResult.threadId
                  ? `/?thread=${outcomeResult.threadId}`
                  : undefined,
              });
              surfacedIssues.push({
                itemId: workingItem.id,
                key: workingItem.key,
                code: issue.code,
                message: issue.message,
              });
              failedCount += 1;
              itemsProcessed += 1;
              outcomes.push({
                itemId: workingItem.id,
                key: workingItem.key,
                title: workingItem.title,
                outcome: "failed",
                threadId: outcomeResult.threadId,
                reason: issue.message,
                durationMs: Math.max(0, this.now() - recoveryStartMs),
              });
            } else {
              hasLiveWorkingItem = true;
              break;
            }
            restartLoopAfterRecovery = true;
            break;
          } else if (liveness.status === "orphaned") {
            const recoveryStartMs = this.now();
            const currentCount = workingItem.autoResumeCount ?? 0;
            const evidence = liveness.evidence;
            const baseReason = liveness.reason || ORPHANED_WORKING_ITEM_REASON;

            if (evidence?.hasPrOrCommitEvidence) {
              const reason = evidence.evidenceSummary
                ? `Interrupted thread already has PR/commit evidence (${evidence.evidenceSummary}); manual review required.`
                : "Interrupted thread already has PR/commit evidence; manual review required.";
              this.log(
                `[orchestrator] parking orphaned working item ${workingItem.id} (${workingItem.key}) due to PR/commit evidence: ${reason}`
              );
              this.updateItem(workingItem, {
                status: "needs-attention",
                needsAttention: true,
                parkedReason: reason,
              });
              surfacedIssues.push({
                itemId: workingItem.id,
                key: workingItem.key,
                code: "orphaned-working-item",
                message: reason,
              });
              failedCount += 1;
            } else if (currentCount < MAX_ORPHAN_AUTO_RESUMES) {
              const nextCount = currentCount + 1;
              const prevThreadRef = evidence?.threadId
                ? `thread ${evidence.threadId}`
                : "previous attempt";
              const prevSummary = evidence?.previousAttemptSummary
                ? `Previous attempt: ${evidence.previousAttemptSummary}`
                : `Previous attempt interrupted (${baseReason}).`;
              const handoff: DispatcherHandoff = {
                state: `Auto-resume attempt ${nextCount}/${MAX_ORPHAN_AUTO_RESUMES} after interrupted ${prevThreadRef}. ${prevSummary}`,
                branch: evidence?.branch || "unknown (check git rev-parse --abbrev-ref HEAD)",
                headSha: evidence?.headSha || "unknown (check git log -n 5 --oneline)",
                nextStep:
                  "Inspect banked state (git status, git log, existing worktree/runlog) and continue from where the previous attempt left off. Continue, do not restart from scratch.",
                openQuestions: [`Original brief: ${workingItem.brief.slice(0, 600)}`],
              };
              this.log(
                `[orchestrator] requeuing orphaned working item ${workingItem.id} (${workingItem.key}) for auto-resume ${nextCount}/${MAX_ORPHAN_AUTO_RESUMES}`
              );
              this.updateItem(workingItem, {
                status: "queued",
                autoResumeCount: nextCount,
                handoff,
                needsAttention: false,
              });
              requeuedCount += 1;
              itemsProcessed += 1;
              outcomes.push({
                itemId: workingItem.id,
                key: workingItem.key,
                title: workingItem.title,
                outcome: "orphan-requeued",
                threadId: evidence?.threadId,
                reason: handoff.state,
                durationMs: Math.max(0, this.now() - recoveryStartMs),
              });
              restartLoopAfterRecovery = true;
              break;
            } else {
              const reason = `Auto-resume budget exhausted (${currentCount}/${MAX_ORPHAN_AUTO_RESUMES}): ${baseReason}`;
              this.log(
                `[orchestrator] parking orphaned working item ${workingItem.id} (${workingItem.key}): ${reason}`
              );
              this.updateItem(workingItem, {
                status: "needs-attention",
                needsAttention: true,
                parkedReason: reason,
              });
              surfacedIssues.push({
                itemId: workingItem.id,
                key: workingItem.key,
                code: "orphaned-working-item",
                message: reason,
              });
              failedCount += 1;
            }
          } else {
            hasLiveWorkingItem = true;
            break;
          }
        }
        if (hasLiveWorkingItem) {
          stopReason = controlStop ?? "job-already-running";
          break;
        }
        if (restartLoopAfterRecovery) {
          continue;
        }
      }

      if (controlStop) {
        stopReason = controlStop;
        break;
      }

      const liveJob = getLiveJob();
      if (liveJob.isRunning) {
        stopReason = "job-already-running";
        break;
      }

      const ownerState = getOwner();
      if (ownerState.isMidTurn) {
        stopReason = "owner-preempted";
        break;
      }

      if (workingItems.length > 0 && !this.deps.checkWorkingItemLiveness) {
        stopReason = "job-already-running";
        break;
      }

      let head = selectHeadEligibleItem(items);
      if (!head) {
        stopReason = "idle";
        break;
      }

      const itemStartMs = this.now();

      const brief = composeDispatcherBrief(head, {
        operatorMemory: this.deps.operatorMemory,
        hostCheckoutPath: this.deps.hostCheckoutPath,
      });

      const onThreadCreated = (threadId: string) => {
        if (!head) return;
        this.updateItem(head, {
          status: "working",
          threadLink: `/?thread=${threadId}`,
        });
      };

      this.log(`[orchestrator] issuing ${head.id} (${head.key} ${head.title})`);
      let result = await this.deps.issueAndWait({ item: head, brief, onThreadCreated });

      if (result.status === "failed") {
        const issue: OrchestratorIssue = result.issue ?? {
          code: "execution-failed",
          message: result.error,
          autoFixable: false,
        };
        const triage = await boundedTriage(issue, head, this.deps.triageAutoFix);

        if (triage.action === "fixed") {
          head = this.reloadItem(head);
          const retryBrief = composeDispatcherBrief(head, {
            operatorMemory: this.deps.operatorMemory,
            hostCheckoutPath: this.deps.hostCheckoutPath,
          });
          result = await this.deps.issueAndWait({
            item: head,
            brief: retryBrief,
            onThreadCreated,
          });
        }

        if (result.status === "failed") {
          const finalIssue = result.issue ?? issue;
          this.updateItem(head, {
            status: "needs-attention",
            needsAttention: true,
            parkedReason: finalIssue.message,
            threadLink: result.threadId ? `/?thread=${result.threadId}` : undefined,
          });
          surfacedIssues.push({
            itemId: head.id,
            key: head.key,
            code: finalIssue.code,
            message: finalIssue.message,
          });
          failedCount += 1;
          itemsProcessed += 1;
          outcomes.push({
            itemId: head.id,
            key: head.key,
            title: head.title,
            outcome: "failed",
            threadId: result.threadId,
            reason: finalIssue.message,
            triage: triage.action === "fixed" ? { ...triage, action: "surfaced" } : triage,
            durationMs: Math.max(0, this.now() - itemStartMs),
          });
          continue;
        }
      }

      if (result.status === "completed") {
        const settled = await this.settleCompletedOutcome(head, result, itemStartMs);
        completedCount += settled.completedDelta;
        failedCount += settled.failedDelta;
        itemsProcessed += 1;
        outcomes.push(settled.outcomeRecord);
      } else if (result.status === "chunk-complete") {
        const chunked = this.recordChunkCompleteOutcome(head, result, itemStartMs);
        requeuedCount += chunked.requeuedDelta;
        failedCount += chunked.failedDelta;
        itemsProcessed += 1;
        if (chunked.surfacedIssue) surfacedIssues.push(chunked.surfacedIssue);
        outcomes.push(chunked.outcomeRecord);
      } else if (result.status === "in-progress") {
        this.updateItem(head, {
          status: "working",
          threadLink: `/?thread=${result.threadId}`,
        });
        inProgressCount += 1;
        itemsProcessed += 1;
        outcomes.push({
          itemId: head.id,
          key: head.key,
          title: head.title,
          outcome: "in-progress",
          threadId: result.threadId,
          reason: result.reason,
          durationMs: Math.max(0, this.now() - itemStartMs),
        });
        stopReason = "job-already-running";
        break;
      }
    }

    const endMs = this.now();
    const report: DrainReport = {
      drainId,
      startedAt,
      completedAt: new Date(endMs).toISOString(),
      durationMs: Math.max(0, endMs - startMs),
      stopReason,
      completedCount,
      failedCount,
      inProgressCount,
      requeuedCount,
      surfacedCount: surfacedIssues.length,
      itemsProcessed,
      outcomes,
      surfacedIssues,
      slotUtilization: getSlotMetrics(),
    };

    setLastDrainReport(report);
    return report;
  }
}

export interface ExtractedJobMetadata {
  prNumber?: number;
  headSha?: string;
  merged?: boolean;
  mergeSha?: string;
  deployTag?: string;
}

/**
 * Extracts PR / merge / deploy metadata from a completed job turn's output
 * so the orchestrator can feed the wired shadow stages (flow monitor,
 * reviewer gate, self-deploy).
 */
export function extractJobOutcomeMetadata(
  ...texts: Array<string | undefined>
): ExtractedJobMetadata {
  const combined = texts
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join("\n");
  if (!combined) return {};

  const result: ExtractedJobMetadata = {};

  const prMatch = /\/pull\/(\d+)\b/i.exec(combined) ?? /\bPR\s*#(\d+)\b/i.exec(combined);
  if (prMatch) {
    const parsed = Number.parseInt(prMatch[1], 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      result.prNumber = parsed;
    }
  }

  const headShaMatch = /\bhead(?:_?sha|\s+sha)\s*[:=]\s*([0-9a-f]{7,40})\b/i.exec(combined);
  if (headShaMatch) {
    result.headSha = headShaMatch[1];
  }

  const mergeShaMatch =
    /\bmerge(?:_?sha|\s+(?:sha|commit))\s*[:=]\s*([0-9a-f]{7,40})\b/i.exec(combined) ??
    /\bmerged\s+(?:commit|sha)\s+([0-9a-f]{7,40})\b/i.exec(combined);
  if (mergeShaMatch) {
    result.merged = true;
    result.mergeSha = mergeShaMatch[1];
  }

  const deployTagMatch = /\bdeploy(?:_?tag|\s+tag)\s*[:=]\s*([^\s,;]+)/i.exec(combined);
  if (deployTagMatch) {
    result.deployTag = deployTagMatch[1];
  }

  return result;
}

export async function runBoardDrain(deps: BoardOrchestratorDeps): Promise<DrainReport> {
  return new BoardOrchestrator(deps).drain();
}
