import crypto from "node:crypto";
import { BoardStore, type BoardStatus } from "./boardStore";
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

export const MAX_DRAIN_ITEMS = 5;
export const MAX_DRAIN_DURATION_MS = 10 * 60 * 1000;
export const MAX_TRIAGE_ATTEMPTS = 2;

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

export type JobExecutionOutcome =
  | { status: "completed"; threadId: string; summary?: string }
  | { status: "chunk-complete"; threadId: string; handoff: DispatcherHandoff }
  | { status: "failed"; threadId?: string; error: string; issue?: OrchestratorIssue }
  | { status: "in-progress"; threadId: string; reason?: string };

export interface DrainItemOutcome {
  itemId: string;
  key: string;
  title: string;
  outcome: "completed" | "failed" | "in-progress" | "chunk-requeued";
  threadId?: string;
  reason?: string;
  triage?: TriageOutcome;
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
  getSlotMetrics?: () => SlotUtilizationMetrics;
  operatorMemory?: string;
  hostCheckoutPath?: string;
  now?: () => number;
  maxItems?: number;
  maxDurationMs?: number;
  issueAndWait: (params: {
    item: DispatcherBoardItem;
    brief: string;
  }) => Promise<JobExecutionOutcome>;
  triageAutoFix?: (
    issue: OrchestratorIssue,
    item: DispatcherBoardItem
  ) => Promise<boolean> | boolean;
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
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(deps: BoardOrchestratorDeps) {
    this.deps = deps;
    const requestedItems = deps.maxItems ?? MAX_DRAIN_ITEMS;
    this.maxItems = Math.min(Math.max(1, Math.floor(requestedItems)), MAX_DRAIN_ITEMS);
    const requestedDuration = deps.maxDurationMs ?? MAX_DRAIN_DURATION_MS;
    this.maxDurationMs = Math.min(Math.max(1, requestedDuration), MAX_DRAIN_DURATION_MS);
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((msg: string) => console.info(msg));
  }

  private getItems(): DispatcherBoardItem[] {
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
      handoff?: DispatcherHandoff;
      needsAttention?: boolean;
      parkedReason?: string;
      threadLink?: string;
    }
  ): void {
    if (patch.status !== undefined) item.status = patch.status;
    if (patch.handoff !== undefined) item.handoff = patch.handoff;
    if (patch.needsAttention !== undefined) item.needsAttention = patch.needsAttention;
    if (patch.parkedReason !== undefined) item.parkedReason = patch.parkedReason;
    if (patch.threadLink !== undefined) item.threadLink = patch.threadLink;
    item.updatedAt = new Date(this.now()).toISOString();

    if (!this.deps.items) {
      const store = this.deps.boardStore ?? new BoardStore(this.deps.boardDir);
      store.update(item.id, {
        status: patch.status,
        needsAttention: patch.needsAttention,
        parkedReason: patch.parkedReason,
        threadLink: patch.threadLink,
      });
    }
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
    const getLiveJob =
      this.deps.getLiveJobState ?? (() => ({ isRunning: false }));
    const getOwner =
      this.deps.getOwnerState ?? (() => ({ isMidTurn: false }));
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
      const head = selectHeadEligibleItem(items);
      if (!head) {
        stopReason = "idle";
        break;
      }

      const itemStartMs = this.now();
      this.updateItem(head, { status: "working" });

      const brief = composeDispatcherBrief(head, {
        operatorMemory: this.deps.operatorMemory,
        hostCheckoutPath: this.deps.hostCheckoutPath,
      });

      this.log(`[orchestrator] issuing ${head.id} (${head.key} ${head.title})`);
      let result = await this.deps.issueAndWait({ item: head, brief });

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
          result = await this.deps.issueAndWait({ item: head, brief: retryBrief });
        }

        if (result.status === "failed") {
          const finalIssue = result.issue ?? issue;
          this.updateItem(head, {
            status: "needs-attention",
            needsAttention: true,
            parkedReason: finalIssue.message,
            threadLink: result.threadId ? `/threads/${result.threadId}` : undefined,
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
            triage:
              triage.action === "fixed"
                ? { ...triage, action: "surfaced" }
                : triage,
            durationMs: Math.max(0, this.now() - itemStartMs),
          });
          continue;
        }
      }

      if (result.status === "completed") {
        this.updateItem(head, {
          status: "done",
          threadLink: `/threads/${result.threadId}`,
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
          durationMs: Math.max(0, this.now() - itemStartMs),
        });
      } else if (result.status === "chunk-complete") {
        this.updateItem(head, {
          status: "queued",
          handoff: result.handoff,
          threadLink: `/threads/${result.threadId}`,
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
          threadLink: `/threads/${result.threadId}`,
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

export async function runBoardDrain(
  deps: BoardOrchestratorDeps
): Promise<DrainReport> {
  return new BoardOrchestrator(deps).drain();
}
