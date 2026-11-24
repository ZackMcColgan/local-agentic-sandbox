import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../fsAtomic";

export interface PersistedDeployRecord {
  status: "idle" | "rolling_out" | "deployed" | "rolled_back_suspended" | "failed";
  targetImage?: string;
  rollbackTarget?: string | null;
  rollbackVerified?: boolean;
  suspended: boolean;
  suspendedReason?: string;
  suspendedAt?: string;
  clearedAt?: string;
  reason?: string;
  s4Verdict?: {
    ok: boolean;
    rolloutSuccess: boolean;
    gatewayStatus: number;
    threadsStatus?: number;
    failedStep?: string;
    observed?: string;
  };
  updatedAt: string;
}

export function resolveDeployRecordPath(workspaceDir?: string): string {
  const root =
    workspaceDir || process.env.WORKSPACE_DIR || path.resolve(process.cwd(), ".agent-workspace");
  return path.join(root, ".agent", "deploy-record.json");
}

export function readDeployRecord(recordPath?: string): PersistedDeployRecord | null {
  const filePath = recordPath || resolveDeployRecordPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PersistedDeployRecord>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      status: parsed.status ?? "idle",
      targetImage: parsed.targetImage,
      rollbackTarget: parsed.rollbackTarget,
      rollbackVerified: parsed.rollbackVerified,
      suspended: Boolean(parsed.suspended),
      suspendedReason: parsed.suspendedReason,
      suspendedAt: parsed.suspendedAt,
      clearedAt: parsed.clearedAt,
      reason: parsed.reason,
      s4Verdict: parsed.s4Verdict,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeDeployRecord(
  record: PersistedDeployRecord,
  recordPath?: string
): PersistedDeployRecord {
  const filePath = recordPath || resolveDeployRecordPath();
  atomicWriteFileSync(filePath, JSON.stringify(record, null, 2) + "\n", 0o660);
  return record;
}

export function isDeploySuspended(recordPath?: string): boolean {
  const record = readDeployRecord(recordPath);
  return Boolean(record?.suspended);
}

/**
 * Explicit owner action: clears a persisted deploy-suspension flag after a rollback.
 */
export function clearDeploySuspension(recordPath?: string): PersistedDeployRecord {
  const filePath = recordPath || resolveDeployRecordPath();
  const existing = readDeployRecord(filePath);
  const nowIso = new Date().toISOString();
  const next: PersistedDeployRecord = {
    ...(existing ?? { status: "idle" }),
    suspended: false,
    clearedAt: nowIso,
    updatedAt: nowIso,
  };
  delete next.suspendedReason;
  return writeDeployRecord(next, filePath);
}

/**
 * Builds the detached host-side rollout command that survives web-ui pod replacement.
 */
export function buildDetachedRolloutCommand(params: {
  image: string;
  rollbackImage?: string;
  recordPath?: string;
  gatewayUrl?: string;
}): string {
  const parts = [
    "node",
    "scripts/rollout-deploy.js",
    "--detached",
    "--service",
    "web-ui",
    "--image",
    params.image,
  ];
  if (params.rollbackImage) {
    parts.push("--rollback-image", params.rollbackImage);
  }
  if (params.recordPath) {
    parts.push("--record-path", params.recordPath);
  }
  if (params.gatewayUrl) {
    parts.push("--gateway-url", params.gatewayUrl);
  }
  return parts.join(" ");
}
