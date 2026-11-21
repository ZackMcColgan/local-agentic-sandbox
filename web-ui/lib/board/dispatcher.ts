import { BoardStore, isItemEligible, type BoardItem } from "./boardStore";
import { loadOperatorMemory } from "../memory/operatorMemory";

export const DISPATCHER_AUTO_ISSUE_DEFAULT = false;

export interface DispatcherHandoff {
  state: string;
  branch: string;
  headSha: string;
  nextStep: string;
  openQuestions?: string[];
}

export type DispatcherBoardItem = BoardItem & {
  handoff?: DispatcherHandoff;
};

export interface LiveJobState {
  isRunning: boolean;
  runningJobId?: string;
}

export interface OwnerTurnState {
  isMidTurn: boolean;
  reason?: string;
}

export interface ComposeBriefOptions {
  operatorMemory?: string;
  hostCheckoutPath?: string;
}

export interface DispatchOptions {
  items?: DispatcherBoardItem[];
  boardStore?: BoardStore;
  liveJobState: LiveJobState;
  ownerState: OwnerTurnState;
  autoIssue?: boolean;
  operatorMemory?: string;
  hostCheckoutPath?: string;
  issueThread: (params: {
    item: DispatcherBoardItem;
    brief: string;
  }) => Promise<{ threadId: string }>;
  log?: (message: string) => void;
}

export interface DispatchResult {
  action: "issued" | "shadow" | "refused" | "idle";
  reason: string;
  item?: DispatcherBoardItem;
  brief?: string;
  threadId?: string;
}

/**
 * Stage gate for auto-issuing board items. Defaults to OFF (shadow mode).
 */
export function isDispatcherAutoIssueEnabled(
  override?: boolean,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (typeof override === "boolean") {
    return override;
  }
  return env.DISPATCHER_AUTO_ISSUE === "true";
}

/**
 * Selects the head eligible queued item from the board:
 * - status must be "queued" (parked, working, pr-open, done are skipped)
 * - all dependencies must have status "done"
 */
export function selectHeadEligibleItem(items: DispatcherBoardItem[]): DispatcherBoardItem | null {
  for (const item of items) {
    if (item.status !== "queued") continue;
    if (!isItemEligible(item, items)) continue;
    return item;
  }
  return null;
}

function buildStandingJobProtocol(hostCheckoutPath?: string): string {
  const checkoutLine = hostCheckoutPath
    ? `Host mode: run against host checkout at ${hostCheckoutPath} (dedicated worktree per job).`
    : "Host mode: run against the configured host checkout (dedicated worktree per job).";

  return [
    "STANDING JOB PROTOCOL:",
    `- ${checkoutLine}`,
    "- Anti-stuck protocol: foreground commands only, nothing interactive, GIT_TERMINAL_PROMPT=0, GH_PROMPT_DISABLED=1.",
    "- Max 2 identical runs or 3 distinct strategies per subproblem; if still failing, mark BLOCKED verbatim with the exact error and stop.",
    "- Bank early / push early: commit small per-file patches and update the runlog after each step.",
    "- Verification: run `npm run test:gate` via the bridge (never full `npm run test`).",
    "- Deliverable: ONE PR into develop. NO merge and NO deploy inside the job.",
    "- Report in parts under ~3,000 tokens.",
  ].join("\n");
}

/**
 * Composes a job brief from an eligible board item, operator memory, and the
 * standing job protocol. If the item carries a chunk-complete handoff, the
 * continuation brief is built from the handoff instead of a fresh composition.
 */
export function composeDispatcherBrief(
  item: DispatcherBoardItem,
  opts: ComposeBriefOptions = {}
): string {
  const memoryText =
    opts.operatorMemory !== undefined ? opts.operatorMemory : loadOperatorMemory().text;

  const sections: string[] = [];

  if (item.handoff) {
    const h = item.handoff;
    sections.push(
      `CONTINUATION FROM HANDOFF — ${item.key} ${item.title}`,
      `State: ${h.state}`,
      `Branch: ${h.branch}`,
      `HEAD SHA: ${h.headSha}`,
      `Next step: ${h.nextStep}`
    );
    if (h.openQuestions && h.openQuestions.length > 0) {
      sections.push(`Open questions:\n- ${h.openQuestions.join("\n- ")}`);
    }
  } else {
    const deps = item.dependencies.length > 0 ? item.dependencies.join(", ") : "none";
    sections.push(
      `BOARD ITEM — ${item.key} ${item.title}`,
      `Dependencies (all done): ${deps}`,
      `Brief:\n${item.brief}`
    );
  }

  if (memoryText && memoryText.trim()) {
    sections.push(`OPERATOR MEMORY:\n${memoryText.trim()}`);
  }

  sections.push(buildStandingJobProtocol(opts.hostCheckoutPath));

  return sections.join("\n\n");
}

/**
 * Evaluates live job state, owner preemption, board eligibility, and the
 * stage gate, then either refuses, logs in shadow mode, or issues a thread.
 */
export async function dispatchNextBoardItem(opts: DispatchOptions): Promise<DispatchResult> {
  const log = opts.log ?? ((msg: string) => console.info(msg));

  if (opts.liveJobState.isRunning) {
    const reason = `Refused: a job is already running (${opts.liveJobState.runningJobId ?? "active"}).`;
    log(`[dispatcher] ${reason}`);
    return { action: "refused", reason };
  }

  if (opts.ownerState.isMidTurn) {
    const detail = opts.ownerState.reason ? ` (${opts.ownerState.reason})` : "";
    const reason = `Refused: owner is mid-turn${detail}; interactive owner turn preempts dispatcher.`;
    log(`[dispatcher] ${reason}`);
    return { action: "refused", reason };
  }

  const items = opts.items ?? (opts.boardStore ?? new BoardStore()).list();
  const item = selectHeadEligibleItem(items);
  if (!item) {
    const reason = "Idle: no eligible queued board item found.";
    log(`[dispatcher] ${reason}`);
    return { action: "idle", reason };
  }

  const brief = composeDispatcherBrief(item, {
    operatorMemory: opts.operatorMemory,
    hostCheckoutPath: opts.hostCheckoutPath,
  });

  if (!isDispatcherAutoIssueEnabled(opts.autoIssue)) {
    const reason = `Shadow mode (stage flag OFF): would issue ${item.id} (${item.key} ${item.title}).`;
    log(`[dispatcher] shadow ${item.id}: ${reason}\n${brief}`);
    return { action: "shadow", reason, item, brief };
  }

  const { threadId } = await opts.issueThread({ item, brief });
  const reason = `Issued thread ${threadId} for ${item.id} (${item.key} ${item.title}).`;
  log(`[dispatcher] ${reason}`);
  return { action: "issued", reason, item, brief, threadId };
}
