import { getAgreementLedgerStore, type AgreementLedgerEntry } from "./agreementLedger";
import type { GateVerdict, MechanicalCheckInput, ReviewerVerdict } from "./reviewerGate";
import { evaluateReviewerGate } from "./reviewerGate";
import type { DispatcherBoardItem } from "./dispatcher";
import type { HeadShaResolutionResult } from "./productionStageDeps";

/**
 * Stage 0 measurement: evaluate ANY PR (including operator-flowed PRs built
 * outside the drain) with the same reviewer pipeline the drain uses, and
 * record the shadow verdict in the agreement ledger. Grants NO merge
 * authority - Stage 3 stays OFF and isMergeAuthorized behavior is unchanged.
 */
export interface ReviewerEvaluateDeps {
  getMechanicalInput: (prNumber: number, allowlist: string[]) => Promise<MechanicalCheckInput>;
  resolveHeadSha: (prNumber: number) => Promise<string | null>;
  resolveHeadShaDetailed?: (prNumber: number) => Promise<HeadShaResolutionResult>;
  issueReviewerThread: (params: { itemId: string; brief: string }) => Promise<ReviewerVerdict>;
}

export interface ReviewerEvaluateResult {
  entry: AgreementLedgerEntry;
  verdict: GateVerdict;
  mechanicalVerdict: GateVerdict;
  reviewerVerdict: GateVerdict;
  threadId: string;
  headSha: string;
  headShaResolved: boolean;
  headShaError?: string;
  mergeAuthorized: false;
}

const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const PLACEHOLDER_HEAD_SHA = "unknown-head";

export async function evaluatePrShadowVerdict(
  deps: ReviewerEvaluateDeps,
  params: { prNumber: number; brief: string; allowlist?: string[]; log?: (message: string) => void }
): Promise<ReviewerEvaluateResult> {
  const { prNumber, brief, allowlist = [], log } = params;
  const itemId = `pr-${prNumber}`;
  const evalStartMs = Date.now();

  const mechanicalInput = await deps.getMechanicalInput(prNumber, allowlist);
  const gateResult = await evaluateReviewerGate({
    itemId,
    brief,
    mechanicalInput,
    // Stage 3 stays OFF: shadow evaluation never authorizes a merge.
    stage3Enabled: false,
    ciAllGreen: false,
    issueReviewerThread: deps.issueReviewerThread,
    log,
  });

  let headSha = PLACEHOLDER_HEAD_SHA;
  let headShaResolved = false;
  let headShaError: string | undefined;
  let reason: string | undefined;
  try {
    if (deps.resolveHeadShaDetailed) {
      const detailed = await deps.resolveHeadShaDetailed(prNumber);
      if (detailed.ok) {
        if (HEAD_SHA_PATTERN.test(detailed.headSha)) {
          headSha = detailed.headSha;
          headShaResolved = true;
        } else {
          headShaError = `Resolved head SHA '${detailed.headSha}' is not a valid 40-char hex SHA`;
        }
      } else {
        headShaError = detailed.reason;
      }
    } else {
      const resolved = await deps.resolveHeadSha(prNumber);
      if (resolved && HEAD_SHA_PATTERN.test(resolved)) {
        headSha = resolved;
        headShaResolved = true;
      } else if (resolved) {
        headShaError = `Resolved head SHA '${resolved}' is not a valid 40-char hex SHA`;
      } else {
        headShaError = "head SHA resolver returned null";
      }
    }
  } catch (err) {
    headShaError = err instanceof Error ? err.message : String(err);
    log?.(`[reviewer-audit] head sha resolution threw for PR ${prNumber}: ${headShaError}`);
  }
  if (!headShaResolved) {
    const detail = headShaError ?? "head SHA resolver returned null";
    reason = `Head sha unresolved for PR ${prNumber} (${detail}); recorded placeholder '${PLACEHOLDER_HEAD_SHA}'.`;
    log?.(
      `[reviewer-audit] head sha unresolved for PR ${prNumber}: ${detail}; recording placeholder`
    );
  }

  const engineMinutes = Math.round(((Date.now() - evalStartMs) / 60_000) * 1000) / 1000;
  const ledger = getAgreementLedgerStore().recordShadowVerdict({
    prNumber,
    headSha,
    reviewerVerdict: gateResult.verdict,
    engineMinutes,
    ...(reason ? { reason } : {}),
  });

  const entry = ledger.entries.find((e) => e.prNumber === prNumber && e.headSha === headSha);
  if (!entry) {
    throw new Error(`Shadow verdict for PR ${prNumber} was not recorded in the ledger`);
  }

  return {
    entry,
    verdict: gateResult.verdict,
    mechanicalVerdict: gateResult.mechanical.verdict,
    reviewerVerdict: gateResult.reviewer.verdict,
    threadId: gateResult.reviewer.threadId,
    headSha,
    headShaResolved,
    ...(headShaError ? { headShaError } : {}),
    mergeAuthorized: false,
  };
}

/** Production wiring: same mechanical collection and reviewer dispatch the drain uses. */
export function createProductionEvaluateDeps(
  options: { log?: (message: string) => void } = {}
): ReviewerEvaluateDeps {
  async function stageDeps() {
    const { createProductionStageDeps } = await import("./productionStageDeps");
    return createProductionStageDeps({ log: options.log });
  }

  return {
    async getMechanicalInput(prNumber, allowlist) {
      const deps = await stageDeps();
      const syntheticItem = {
        id: `pr-${prNumber}`,
        brief: "",
        allowlist,
      } as unknown as DispatcherBoardItem;
      return deps.reviewerGate.getMechanicalInput(syntheticItem, {
        prNumber,
        headSha: PLACEHOLDER_HEAD_SHA,
      });
    },
    async resolveHeadSha(prNumber) {
      const deps = await stageDeps();
      return await deps.resolveHeadSha(prNumber);
    },
    async resolveHeadShaDetailed(prNumber) {
      const deps = await stageDeps();
      return await deps.resolveHeadShaDetailed(prNumber);
    },
    async issueReviewerThread(params) {
      const deps = await stageDeps();
      return deps.reviewerGate.issueReviewerThread(params);
    },
  };
}
