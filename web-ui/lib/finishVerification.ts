export type CompletionStamp = "completed" | "completed-unverified";

export interface VerificationGap {
  kind: "commit" | "branch" | "file" | "pr" | "gate" | "fallback_file";
  claim: string;
  checked: string;
  found: string;
}

export interface CompletionClaims {
  commits?: string[];
  branches?: string[];
  files?: string[];
  prs?: Array<{ number: number; expectedState?: string }>;
  gatePassed?: boolean;
  fallbackFiles?: string[];
}

export interface VerificationAdapters {
  resolveCommit: (sha: string) => Promise<boolean>;
  checkPr: (prNumber: number) => Promise<{ exists: boolean; state: string | null }>;
  branchExists?: (branch: string) => Promise<boolean>;
  fileExists?: (filePath: string) => Promise<boolean>;
}

export interface VerificationResult {
  status: CompletionStamp;
  gaps: VerificationGap[];
}

/**
 * Verifies completion claims against ground truth (git state, PR state,
 * persisted gate results) rather than turn narration text.
 */
export async function verifyCompletionClaims(
  claims: CompletionClaims,
  adapters: VerificationAdapters
): Promise<VerificationResult> {
  const gaps: VerificationGap[] = [];

  for (const sha of claims.commits || []) {
    const ok = await adapters.resolveCommit(sha);
    if (!ok) {
      gaps.push({
        kind: "commit",
        claim: sha,
        checked: "git rev-parse --verify",
        found: "commit SHA does not resolve",
      });
    }
  }

  for (const branch of claims.branches || []) {
    const ok = adapters.branchExists ? await adapters.branchExists(branch) : false;
    if (!ok) {
      gaps.push({
        kind: "branch",
        claim: branch,
        checked: "git branch / ref check",
        found: "branch does not exist",
      });
    }
  }

  for (const filePath of claims.files || []) {
    const ok = adapters.fileExists ? await adapters.fileExists(filePath) : false;
    if (!ok) {
      gaps.push({
        kind: "file",
        claim: filePath,
        checked: "filesystem check",
        found: "file does not exist",
      });
    }
  }

  for (const pr of claims.prs || []) {
    const res = await adapters.checkPr(pr.number);
    if (!res.exists) {
      gaps.push({
        kind: "pr",
        claim: `PR #${pr.number}`,
        checked: "gh pr view",
        found: "PR does not exist",
      });
    } else if (pr.expectedState && res.state !== pr.expectedState) {
      gaps.push({
        kind: "pr",
        claim: `PR #${pr.number} (${pr.expectedState})`,
        checked: "gh pr view",
        found: `state is ${res.state ?? "unknown"}`,
      });
    }
  }

  if (claims.gatePassed === false) {
    gaps.push({
      kind: "gate",
      claim: "test:gate",
      checked: "persisted gate result",
      found: "gate did not pass",
    });
  }

  for (const fallbackFile of claims.fallbackFiles || []) {
    if (claims.gatePassed !== true) {
      gaps.push({
        kind: "fallback_file",
        claim: fallbackFile,
        checked: "covering gate/tests for surgical-fallback write",
        found: "covering gate/tests absent or failing",
      });
    }
  }

  return {
    status: gaps.length === 0 ? "completed" : "completed-unverified",
    gaps,
  };
}

export function stampCompletion<T extends Record<string, any>>(
  record: T,
  verification: VerificationResult
): T & { completionStamp: CompletionStamp; verificationGaps: VerificationGap[] } {
  return {
    ...record,
    completionStamp: verification.status,
    verificationGaps: verification.gaps,
  };
}
