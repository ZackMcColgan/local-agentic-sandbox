import fs from "node:fs";
import path from "node:path";
import type { BoardItem, BoardStatus } from "../board/boardStore";

export const SELF_DEPLOY_VERIFIED_STAGE_DEFAULT = false;

/**
 * Stage flag for self-deploy-verified execution.
 * Defaults to OFF (shadow mode): prepares and verifies readiness,
 * never executes a production deploy.
 */
export function isSelfDeployVerifiedEnabled(
  override?: boolean,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (typeof override === "boolean") {
    return override;
  }
  return env.BOARD_STAGE_SELF_DEPLOY === "true";
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
  builtTag?: string;
  detail: string;
}

export interface VerifyDeploymentResult {
  ok: boolean;
  rolloutSuccess: boolean;
  podRunningZeroRestarts: boolean;
  gatewayStatus: number;
  threadListLoads: boolean;
  observedTag: string;
  observedSha?: string | null;
  failedStep?: string;
  observed?: string;
}

export interface SelfDeployVerifiedDeps {
  readCurrentState: () => Promise<CurrentStateSnapshot>;
  bankRollbackTarget: (tag: string) => Promise<BankRollbackResult>;
  buildAndImport: (targetTag: string, dryRun: boolean) => Promise<BuildImportResult>;
  setImage: (tag: string) => Promise<{ ok: boolean; detail?: string }>;
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

  const deployTag = s2.builtTag ?? input.targetTag;

  // S3: Set image
  const s3 = await deps.setImage(deployTag);
  if (!s3.ok) {
    return {
      mode: "execute",
      status: "failed",
      rollbackTarget: s1.tag,
      needsAttention: true,
      reason: "S3 set-image failed",
      evidence: `S3 failed: ${s3.detail ?? "setImage returned ok=false"}`,
    };
  }

  // S4: Verify rollout, pod Running 0 restarts, gateway 200, thread list loads
  const s4 = await deps.verifyDeployment(deployTag);
  if (!s4.ok) {
    const rollbackSet = await deps.setImage(s1.tag);
    if (!rollbackSet.ok) {
      const failedStep = s4.failedStep ?? "verify_deployment";
      const observed = s4.observed ?? `gateway=${s4.gatewayStatus}`;
      return {
        mode: "execute",
        status: "rolled_back_suspended",
        rollbackTarget: s1.tag,
        rollbackVerified: false,
        needsAttention: true,
        reason: "S4 verification failed; rollback set-image also failed.",
        evidence: `S4 failed at ${failedStep}: ${observed}; rollback setImage failed: ${rollbackSet.detail ?? "setImage returned ok=false"}`,
      };
    }
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
    deployTag,
    prodEqualsDevelop: computeProdEqualsDevelop(
      input.developSha,
      s4.observedTag ?? deployTag,
      s4.observedSha ?? resolveDeployedCommitSha()
    ),
    needsAttention: false,
    evidence: `Deployed ${deployTag} (develop ${input.developSha}); gateway ${s4.gatewayStatus}`,
  };
}

/**
 * HO-4: Resolves the deployed commit SHA from build-time env vars or an optional
 * baked `build-info.json` file. Returns null when unavailable.
 */
export function resolveDeployedCommitSha(
  env: Record<string, string | undefined> = process.env,
  buildInfoPath?: string
): string | null {
  const fromEnv =
    env.DEPLOYED_COMMIT_SHA?.trim() || env.BUILD_COMMIT_SHA?.trim() || env.GIT_SHA?.trim() || "";
  if (/^[0-9a-f]{7,40}$/i.test(fromEnv)) {
    return fromEnv.toLowerCase();
  }
  const candidatePath = buildInfoPath ?? path.resolve(process.cwd(), "build-info.json");
  try {
    if (fs.existsSync(candidatePath)) {
      const parsed = JSON.parse(fs.readFileSync(candidatePath, "utf8")) as {
        commitSha?: unknown;
        sha?: unknown;
      };
      const raw =
        typeof parsed?.commitSha === "string"
          ? parsed.commitSha.trim()
          : typeof parsed?.sha === "string"
            ? parsed.sha.trim()
            : "";
      if (/^[0-9a-f]{7,40}$/i.test(raw)) {
        return raw.toLowerCase();
      }
    }
  } catch {
    // Ignore unreadable build-info.json
  }
  return null;
}

/**
 * HO-4: Computes whether the deployed image/commit matches `developSha` by
 * comparing hex SHA prefixes (>= 7 chars) rather than hardcoding `true`.
 */
export function computeProdEqualsDevelop(
  developSha: string,
  observedTag?: string,
  deployedCommitSha?: string | null
): boolean {
  const target = (developSha || "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(target)) return false;

  // Prefer explicit SHA extracted from observedTag when present; fall back to deployedCommitSha.
  let candidate: string | null = null;
  if (typeof observedTag === "string" && observedTag.trim()) {
    const tagPart = observedTag.trim().split(":").pop() ?? "";
    const shaMatch = /(?:^|[-_])([0-9a-f]{7,40})$/i.exec(tagPart);
    if (shaMatch) candidate = shaMatch[1].toLowerCase();
  }
  if (
    !candidate &&
    typeof deployedCommitSha === "string" &&
    /^[0-9a-f]{7,40}$/i.test(deployedCommitSha.trim())
  ) {
    candidate = deployedCommitSha.trim().toLowerCase();
  }
  if (!candidate) return false;

  const minLen = Math.min(candidate.length, target.length);
  return minLen >= 7 && target.slice(0, minLen) === candidate.slice(0, minLen);
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
