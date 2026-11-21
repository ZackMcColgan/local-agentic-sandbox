import {
  verifyCompletionClaims,
  type CompletionStamp,
  type VerificationAdapters,
  type VerificationGap,
} from "./finishVerification";

export interface ExtractedCitations {
  commits: string[];
  prs: number[];
  gateLines: string[];
}

export interface EvidenceSummaryResult {
  flagged: boolean;
  completionStamp?: CompletionStamp;
  gaps: VerificationGap[];
}

const COMPLETION_TRIGGER_RE = /\b(done|complete|completed|finished|merged|deployed|shipped)\b/i;

const COMMIT_SHA_RE = /\b([0-9a-f]{7,40})\b/gi;
const PR_NUMBER_RE = /(?:^|[\s(])#(\d+)\b/g;
const GATE_PASS_WITH_RUN_RE =
  /test:gate[^\n]*\b(?:pass(?:ed)?|green)\b[^\n]*(?:\b(?:head|run|commit)\b\s+[0-9a-f]{7,40}|#[0-9]+|\b[0-9a-f]{7,40}\b)/i;

/**
 * Extracts inline evidence citations (commit SHAs, PR numbers, and
 * run/head-qualified test:gate pass lines) from a job's final summary text.
 */
export function extractCitations(text: string): ExtractedCitations {
  const commits = new Set<string>();
  const prs = new Set<number>();
  const gateLines: string[] = [];

  for (const match of text.matchAll(COMMIT_SHA_RE)) {
    if (match[1]) commits.add(match[1].toLowerCase());
  }

  for (const match of text.matchAll(PR_NUMBER_RE)) {
    if (match[1]) {
      const num = Number.parseInt(match[1], 10);
      if (Number.isFinite(num) && num > 0) prs.add(num);
    }
  }

  for (const line of text.split(/\r?\n/)) {
    if (GATE_PASS_WITH_RUN_RE.test(line)) {
      gateLines.push(line.trim());
    }
  }

  return {
    commits: Array.from(commits),
    prs: Array.from(prs),
    gateLines,
  };
}

/**
 * Returns true when the summary text contains completion-claim language.
 */
export function hasCompletionLanguage(text: string): boolean {
  return COMPLETION_TRIGGER_RE.test(text);
}

export interface VerifyEvidenceOptions {
  /**
   * When false, evidence verification is skipped and a neutral result is
   * returned without invoking any adapters. Defaults to true for job-summary
   * compatibility.
   */
  isJobSummary?: boolean;
}

/**
 * Verifies that any summary claiming completion includes inline citations
 * that resolve against git/PR ground truth.
 */
export async function verifyEvidenceLinkedSummary(
  text: string,
  adapters: VerificationAdapters,
  options?: VerifyEvidenceOptions
): Promise<EvidenceSummaryResult> {
  if (options?.isJobSummary === false) {
    return { flagged: false, completionStamp: undefined, gaps: [] };
  }

  if (!hasCompletionLanguage(text)) {
    return { flagged: false, completionStamp: undefined, gaps: [] };
  }

  const citations = extractCitations(text);
  const totalCitations =
    citations.commits.length + citations.prs.length + citations.gateLines.length;

  if (totalCitations === 0) {
    return {
      flagged: true,
      completionStamp: "completed-unverified",
      gaps: [
        {
          kind: "gate",
          claim: "completion summary",
          checked: "inline evidence citations (commit SHA, PR #N, or test:gate run/head)",
          found: "no verifiable citations found",
        },
      ],
    };
  }

  const verification = await verifyCompletionClaims(
    {
      commits: citations.commits,
      prs: citations.prs.map((number) => ({ number })),
    },
    adapters
  );

  return {
    flagged: true,
    completionStamp: verification.status,
    gaps: verification.gaps,
  };
}
