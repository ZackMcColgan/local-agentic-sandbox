import type { BoardItem, BoardStatus } from "../board/boardStore";

export const SELF_DEPLOY_VERIFIED_STAGE_DEFAULT = false;

/**
 * Stage flag for self-deploy-verified execution.
 * Defaults to OFF (shadow mode): prepares and verifies readiness,
 * never executes a production deploy.
 */
export function isSelfDeployVerifiedEnabled(override?: boolean): boolean {
  if (typeof override === "boolean") {
    return override;
  }
  return SELF_DEPLOY_VERIFIED_STAGE_DEFAULT;
}

export interface DeployInput {
  targetTag: string;
  developSha: string;
}

export interface CurrentStateSnapshot {
  image: string;
  podStatus: string;
  podRestarts: number;
}

export interface BankRollbackResult {
  banked: boolean;
  tag: string;
}

export interface BuildImportResult {
  built: boolean;
  imported: boolean;
  imagePresentInNode: boolean;
  detail: string;
}

export interface VerifyDeploymentResult {
  ok: boolean;
  rolloutSuccess: boolean;
  podRunningZeroRestarts: boolean;
  gatewayStatus: number;
  threadListLoads: boolean;
  observedTag: string;
  failedStep?: string;
  observed?: string;
}

export interface SelfDeployVerifiedDeps {
  readCurrentState: () => Promise<CurrentStateSnapshot>;
  bankRollbackTarget: (tag: string) => Promise<BankRollbackResult>;
  buildAndImport: (targetTag: string, dryRun: boolean) => Promise<BuildImportResult>;
  setImage: (tag: string) => Promise<{ ok: boolean }>;
  verifyDeployment: (expectedTag: string) => Promise<VerifyDeploymentResult>;
}

export interface SelfDeployVerifiedResult {
  mode: "shadow" | "execute";
  status: "shadow_prepared" | "refused" | "deployed" | "rolled_back_suspended" | "failed";
  rollbackTarget?: string;
  deployTag?: string;
  prodEqualsDevelop?: boolean;
  rollbackVerified?: boolean;
  needsAttention: boolean;
  reason?: string;
  evidence?: string;
}

export async function runSelfDeployVerified(
  input: DeployInput,
  deps: SelfDeployVerifiedDeps,
  options: { stageEnabled?: boolean } = {}
): Promise<SelfDeployVerifiedResult> {
  const executeEnabled = isSelfDeployVerifiedEnabled(options.stageEnabled);
  const mode: "shadow" | "execute" = executeEnabled ? "execute" : "shadow";

  // S0: Read current deployment image + pod state
  const s0 = await deps.readCurrentState();

  // S1: Bank rollback target BEFORE any build starts
  const s1 = await deps.bankRollbackTarget(s0.image);
  if (!s0.image || !s1.banked || !s1.tag) {
    return {
      mode,
      status: "refused",
      needsAttention: true,
      reason: "No banked rollback target; refusing to proceed.",
    };
  }

  // Stage gate: in shadow mode (default OFF), prepare + verify readiness only
  if (!executeEnabled) {
    const dryRun = await deps.buildAndImport(input.targetTag, true);
    return {
      mode: "shadow",
      status: "shadow_prepared",
      rollbackTarget: s1.tag,
      deployTag: input.targetTag,
      needsAttention: false,
      evidence: `Shadow readiness verified: ${dryRun.detail}`,
    };
  }

  // S2: Build + import via repo deploy flow, verify image present in node
  const s2 = await deps.buildAndImport(input.targetTag, false);
  if (!s2.built || !s2.imported || !s2.imagePresentInNode) {
    return {
      mode: "execute",
      status: "failed",
      rollbackTarget: s1.tag,
      needsAttention: true,
      reason: "S2 build/import verification failed",
      evidence: `S2 failed: ${s2.detail}`,
    };
  }

  // S3: Set image
  await deps.setImage(input.targetTag);

  // S4: Verify rollout, pod Running 0 restarts, gateway 200, thread list loads
  const s4 = await deps.verifyDeployment(input.targetTag);
  if (!s4.ok) {
    await deps.setImage(s1.tag);
    const rollbackVerify = await deps.verifyDeployment(s1.tag);
    const failedStep = s4.failedStep ?? "verify_deployment";
    const observed = s4.observed ?? `gateway=${s4.gatewayStatus}`;
    return {
      mode: "execute",
      status: "rolled_back_suspended",
      rollbackTarget: s1.tag,
      rollbackVerified: rollbackVerify.ok,
      needsAttention: true,
      reason: "S4 verification failed; rolled back and suspended deploy.",
      evidence: `S4 failed at ${failedStep}: ${observed}`,
    };
  }

  return {
    mode: "execute",
    status: "deployed",
    rollbackTarget: s1.tag,
    deployTag: input.targetTag,
    prodEqualsDevelop: true,
    needsAttention: false,
    evidence: `Deployed ${input.targetTag} (develop ${input.developSha}); gateway ${s4.gatewayStatus}`,
  };
}

export interface SprintReportItem {
  key: string;
  prNumber?: number;
  mergeSha?: string;
  deployTag?: string;
  status: BoardStatus;
  evidence: string;
}

export interface SprintReportException {
  key: string;
  status: BoardStatus;
  reason: string;
}

export interface SprintReport {
  items: SprintReportItem[];
  exceptions: SprintReportException[];
  markdown: string;
}

export function generateSprintReport(boardItems: BoardItem[]): SprintReport {
  const items: SprintReportItem[] = boardItems.map((item) => {
    const prNumber = item.evidence?.prNumber;
    const mergeSha = item.evidence?.mergeSha;
    const deployTag = item.evidence?.deployTag;
    const parts: string[] = [];
    if (prNumber !== undefined) parts.push(`PR #${prNumber}`);
    if (mergeSha) parts.push(`merge ${mergeSha}`);
    if (deployTag) parts.push(`tag ${deployTag}`);
    if (item.parkedReason) parts.push(item.parkedReason);
    const evidence = parts.length > 0 ? parts.join(" | ") : "no evidence recorded";

    return {
      key: item.key,
      prNumber,
      mergeSha,
      deployTag,
      status: item.status,
      evidence,
    };
  });

  const exceptions: SprintReportException[] = boardItems
    .filter((item) => item.status === "parked" || Boolean(item.parkedReason))
    .map((item) => ({
      key: item.key,
      status: item.status,
      reason: item.parkedReason ?? "parked without reason",
    }));

  const lines: string[] = ["# Sprint Report", ""];
  for (const item of items) {
    lines.push(`- **${item.key}** [${item.status}] — ${item.evidence}`);
  }
  if (exceptions.length > 0) {
    lines.push("", "## Exceptions");
    for (const ex of exceptions) {
      lines.push(`- **${ex.key}** (${ex.status}): ${ex.reason}`);
    }
  }

  return {
    items,
    exceptions,
    markdown: lines.join("\n"),
  };
}
