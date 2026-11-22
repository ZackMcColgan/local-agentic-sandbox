import crypto from "node:crypto";
import { BoardStore, extractThreadIdFromLink, type BoardStatus } from "./boardStore";
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
  isFlowMonitorStage2Enabled,
  monitorPrToConclusion,
  type FlowMonitorBoardItem,
  type MonitorPrResult,
  type PrChecksSnapshot,
} from "./flowMonitor";
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

  private updateItem(
    item: DispatcherBoardItem,
    patch: {
      status?: BoardStatus;
      handoff?: DispatcherHandoff | null;
      autoResumeCount?: number;
      needsAttention?: boolean;
      parkedReason?: string;
      threadLink?: string;
    }
  ): void {
    if (patch.status !== undefined) item.status = patch.status;
    if (patch.handoff === null) {
      delete item.handoff;
    } else if (patch.handoff !== undefined) {
      item.handoff = patch.handoff;
    }
    if (patch.autoResumeCount !== undefined) item.autoResumeCount = patch.autoResumeCount;
    if (patch.needsAttention !== undefined) item.needsAttention = patch.needsAttention;
    if (patch.parkedReason !== undefined) item.parkedReason = patch.parkedReason;
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
        ...(patch.needsAttention !== undefined ? { needsAttention: patch.needsAttention } : {}),
        ...(patch.parkedReason !== undefined ? { parkedReason: patch.parkedReason } : {}),
        ...(patch.threadLink !== undefined ? { threadLink: patch.threadLink } : {}),
      });
    }
  }

  private resolveFlowMonitorEnabled(): boolean {
    if (typeof this.deps.stageFlags?.flowMonitor === "boolean") {
      return this.deps.stageFlags.flowMonitor;
    }
    return isFlowMonitorStage2Enabled(undefined) || process.env.BOARD_STAGE_FLOW_MONITOR === "true";
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

  async runPrOpenShadowStages(
    item: DispatcherBoardItem,
    pr: { prNumber: number; headSha: string }
  ): Promise<PrOpenShadowResult> {
    const result: PrOpenShadowResult = {};

    if (this.deps.flowMonitor) {
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
    }

    if (this.deps.reviewerGate) {
      const stage3Enabled = this.resolveReviewerGateEnabled();
      const mechanicalInput = await this.deps.reviewerGate.getMechanicalInput(item, pr);
      const gateResult = await evaluateReviewerGate({
        itemId: item.id,
        brief: item.brief,
        mechanicalInput,
        stage3Enabled,
        ciAllGreen: result.flowMonitor?.verdict.status === "green",
        issueReviewerThread: this.deps.reviewerGate.issueReviewerThread,
        log: this.log,
      });
      result.reviewerGate = {
        ...gateResult,
        mergeAuthorized: stage3Enabled ? gateResult.mergeAuthorized : false,
      };
      result.ledger = this.getAgreementLedger().recordShadowVerdict({
        prNumber: pr.prNumber,
        headSha: pr.headSha,
        reviewerVerdict: gateResult.verdict,
      });
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

    return runSelfDeployVerified(deployInput, deployDeps, { stageEnabled });
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
      const control = getControl();
      const controlStop = getControlStopReason(control.state);
      if (controlStop) {
        stopReason = controlStop;
        break;
      }

      if (itemsProcessed >= this.maxItems) {
        stopReason = "max-items-reached";
        break;
      }

      if (this.now() - startMs >= this.maxDurationMs) {
        stopReason = "time-cap-reached";
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

      const items = this.getItems();
      const workingItems = items.filter((item) => item.status === "working");
      if (workingItems.length > 0) {
        if (!this.deps.checkWorkingItemLiveness) {
          stopReason = "job-already-running";
          break;
        }
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
              let shadowStages: ShadowStageOutcomes | undefined;
              if (
                outcomeResult.prNumber !== undefined &&
                (this.deps.flowMonitor || this.deps.reviewerGate)
              ) {
                const prShadow = await this.runPrOpenShadowStages(workingItem, {
                  prNumber: outcomeResult.prNumber,
                  headSha: outcomeResult.headSha ?? "unknown-head",
                });
                shadowStages = {
                  ...(prShadow.flowMonitor ? { flowMonitor: prShadow.flowMonitor } : {}),
                  ...(prShadow.reviewerGate ? { reviewerGate: prShadow.reviewerGate } : {}),
                };
              }
              if (outcomeResult.merged && outcomeResult.mergeSha && this.deps.selfDeploy) {
                const selfDeploy = await this.runMergedShadowStage(workingItem, {
                  mergeSha: outcomeResult.mergeSha,
                  targetTag: outcomeResult.deployTag,
                });
                shadowStages = {
                  ...(shadowStages ?? {}),
                  selfDeploy,
                };
              }
              if (shadowStages?.selfDeploy?.needsAttention) {
                this.updateItem(workingItem, {
                  status: "needs-attention",
                  needsAttention: true,
                  parkedReason: shadowStages.selfDeploy.reason ?? shadowStages.selfDeploy.evidence,
                  threadLink: `/?thread=${outcomeResult.threadId}`,
                });
                failedCount += 1;
                itemsProcessed += 1;
                outcomes.push({
                  itemId: workingItem.id,
                  key: workingItem.key,
                  title: workingItem.title,
                  outcome: "failed",
                  threadId: outcomeResult.threadId,
                  reason: shadowStages.selfDeploy.reason ?? shadowStages.selfDeploy.evidence,
                  shadowStages,
                  durationMs: Math.max(0, this.now() - recoveryStartMs),
                });
              } else {
                this.updateItem(workingItem, {
                  status: "done",
                  threadLink: `/?thread=${outcomeResult.threadId}`,
                  ...(workingItem.handoff ? { handoff: null } : {}),
                });
                completedCount += 1;
                itemsProcessed += 1;
                outcomes.push({
                  itemId: workingItem.id,
                  key: workingItem.key,
                  title: workingItem.title,
                  outcome: "completed",
                  threadId: outcomeResult.threadId,
                  reason: outcomeResult.summary,
                  ...(shadowStages ? { shadowStages } : {}),
                  durationMs: Math.max(0, this.now() - recoveryStartMs),
                });
              }
            } else if (outcomeResult.status === "chunk-complete") {
              this.updateItem(workingItem, {
                status: "queued",
                handoff: outcomeResult.handoff,
                threadLink: `/?thread=${outcomeResult.threadId}`,
              });
              requeuedCount += 1;
              itemsProcessed += 1;
              outcomes.push({
                itemId: workingItem.id,
                key: workingItem.key,
                title: workingItem.title,
                outcome: "chunk-requeued",
                threadId: outcomeResult.threadId,
                reason: outcomeResult.handoff.nextStep,
                durationMs: Math.max(0, this.now() - recoveryStartMs),
              });
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
          stopReason = "job-already-running";
          break;
        }
        if (restartLoopAfterRecovery) {
          continue;
        }
      }

      const head = selectHeadEligibleItem(items);
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
        let shadowStages: ShadowStageOutcomes | undefined;
        if (result.prNumber !== undefined && (this.deps.flowMonitor || this.deps.reviewerGate)) {
          const prShadow = await this.runPrOpenShadowStages(head, {
            prNumber: result.prNumber,
            headSha: result.headSha ?? "unknown-head",
          });
          shadowStages = {
            ...(prShadow.flowMonitor ? { flowMonitor: prShadow.flowMonitor } : {}),
            ...(prShadow.reviewerGate ? { reviewerGate: prShadow.reviewerGate } : {}),
          };
        }
        if (result.merged && result.mergeSha && this.deps.selfDeploy) {
          const selfDeploy = await this.runMergedShadowStage(head, {
            mergeSha: result.mergeSha,
            targetTag: result.deployTag,
          });
          shadowStages = {
            ...(shadowStages ?? {}),
            selfDeploy,
          };
        }

        if (shadowStages?.selfDeploy?.needsAttention) {
          this.updateItem(head, {
            status: "needs-attention",
            threadLink: `/?thread=${result.threadId}`,
          });
          itemsProcessed += 1;
          outcomes.push({
            itemId: head.id,
            key: head.key,
            title: head.title,
            outcome: "failed",
            threadId: result.threadId,
            reason: shadowStages.selfDeploy.reason ?? shadowStages.selfDeploy.evidence,
            shadowStages,
            durationMs: Math.max(0, this.now() - itemStartMs),
          });
        } else {
          this.updateItem(head, {
            status: "done",
            threadLink: `/?thread=${result.threadId}`,
            ...(head.handoff ? { handoff: null } : {}),
          });
          completedCount += 1;
          itemsProcessed += 1;
          outcomes.push({
            itemId: head.id,
            key: head.key,
            title: head.title,
            outcome: "completed",
            threadId: result.threadId,
            reason: result.summary,
            ...(shadowStages ? { shadowStages } : {}),
            durationMs: Math.max(0, this.now() - itemStartMs),
          });
        }
      } else if (result.status === "chunk-complete") {
        this.updateItem(head, {
          status: "queued",
          handoff: result.handoff,
          threadLink: `/?thread=${result.threadId}`,
        });
        requeuedCount += 1;
        itemsProcessed += 1;
        outcomes.push({
          itemId: head.id,
          key: head.key,
          title: head.title,
          outcome: "chunk-requeued",
          threadId: result.threadId,
          reason: result.handoff.nextStep,
          durationMs: Math.max(0, this.now() - itemStartMs),
        });
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
