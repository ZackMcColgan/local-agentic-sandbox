export type GateVerdict = "PASS" | "FAIL";

export const REVIEWER_GATE_STAGE3_DEFAULT = false;

/**
 * Stage flag for reviewer-gate merge authorization.
 * Defaults to OFF (shadow mode): verdicts are logged and authorize nothing.
 */
export function isReviewerGateStage3Enabled(override?: boolean): boolean {
  if (typeof override === "boolean") {
    return override;
  }
  return REVIEWER_GATE_STAGE3_DEFAULT;
}

export interface MechanicalFailure {
  check: "allowlist" | "hygiene" | "no-test-weakened";
  evidence: string;
}

export interface MechanicalCheckInput {
  diff: string;
  allowlist: string[];
  commitSubjects: string[];
  branchName: string;
}

export interface MechanicalCheckResult {
  verdict: GateVerdict;
  changedFiles: string[];
  failures: MechanicalFailure[];
}

const BANNED_HYGIENE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "claude", pattern: /\bclaude\b/i },
  { label: "anthropic", pattern: /\banthropic\b/i },
  { label: "openai", pattern: /\bopenai\b/i },
  { label: "codex", pattern: /\bcodex\b/i },
  { label: "chatgpt", pattern: /\bchatgpt\b/i },
  { label: "gemini", pattern: /\bgemini\b/i },
  { label: "copilot", pattern: /\bcopilot\b/i },
  { label: "cursor", pattern: /\bcursor\b/i },
  { label: "windsurf", pattern: /\bwindsurf\b/i },
  { label: "antigravity", pattern: /\bantigravity\b/i },
  { label: "zack", pattern: /\bzack\b/i },
  { label: "mccolgan", pattern: /\bmccolgan\b/i },
  { label: "hydrogen", pattern: /\bhydrogen\b/i },
  { label: "argon", pattern: /\bargon\b/i },
  { label: "sandy", pattern: /\bsandy\b/i },
];

const TEST_FILE_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const ASSERTION_PATTERN = /\b(?:assert(?:\.[a-zA-Z0-9_]+)?|expect)\s*\(/g;

interface ParsedFileDiff {
  path: string;
  deleted: boolean;
  addedLines: string[];
  removedLines: string[];
}

function parseUnifiedDiff(diff: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  let current: ParsedFileDiff | null = null;

  for (const line of diff.split(/\r?\n/)) {
    const headerMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (headerMatch) {
      current = {
        path: headerMatch[2],
        deleted: false,
        addedLines: [],
        removedLines: [],
      };
      files.push(current);
      continue;
    }
    if (!current) continue;

    if (line.startsWith("deleted file mode")) {
      current.deleted = true;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.removedLines.push(line.slice(1));
    }
  }

  return files;
}

function countAssertions(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    const matches = line.match(ASSERTION_PATTERN);
    if (matches) {
      count += matches.length;
    }
  }
  return count;
}

/**
 * Evaluates mechanical checks on a PR diff:
 * 1. Diff scope vs item brief's file allowlist
 * 2. Repo hygiene (no banned brand/model/personal names in added lines, commits, branch)
 * 3. No-test-weakened heuristics (no deleted test files, no net assertion removals)
 */
export function runMechanicalChecks(input: MechanicalCheckInput): MechanicalCheckResult {
  const failures: MechanicalFailure[] = [];
  const parsedFiles = parseUnifiedDiff(input.diff);
  const changedFiles = parsedFiles.map((f) => f.path);
  const allowSet = new Set(input.allowlist.map((p) => p.replace(/\\/g, "/")));

  for (const file of parsedFiles) {
    const normalizedPath = file.path.replace(/\\/g, "/");
    if (!allowSet.has(normalizedPath)) {
      failures.push({
        check: "allowlist",
        evidence: `File outside allowlist: ${normalizedPath}`,
      });
    }

    for (let i = 0; i < file.addedLines.length; i++) {
      const line = file.addedLines[i];
      for (const { label, pattern } of BANNED_HYGIENE_PATTERNS) {
        if (pattern.test(line)) {
          failures.push({
            check: "hygiene",
            evidence: `Banned string "${label}" in added line of ${normalizedPath}: ${line.trim()}`,
          });
        }
      }
    }

    if (TEST_FILE_PATTERN.test(normalizedPath)) {
      if (file.deleted) {
        failures.push({
          check: "no-test-weakened",
          evidence: `Test file deleted: ${normalizedPath}`,
        });
      } else {
        const removedAssertions = countAssertions(file.removedLines);
        const addedAssertions = countAssertions(file.addedLines);
        if (removedAssertions > addedAssertions) {
          failures.push({
            check: "no-test-weakened",
            evidence: `Assertions removed in ${normalizedPath}: -${removedAssertions} / +${addedAssertions}`,
          });
        }
      }
    }
  }

  for (const subject of input.commitSubjects) {
    for (const { label, pattern } of BANNED_HYGIENE_PATTERNS) {
      if (pattern.test(subject)) {
        failures.push({
          check: "hygiene",
          evidence: `Banned string "${label}" in commit subject: ${subject}`,
        });
      }
    }
  }

  for (const { label, pattern } of BANNED_HYGIENE_PATTERNS) {
    if (pattern.test(input.branchName)) {
      failures.push({
        check: "hygiene",
        evidence: `Banned string "${label}" in branch name: ${input.branchName}`,
      });
    }
  }

  return {
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    changedFiles,
    failures,
  };
}

export interface ReviewerVerdict {
  threadId: string;
  verdict: GateVerdict;
  evidence: string[];
}

export interface EvaluateReviewerGateOptions {
  itemId: string;
  brief: string;
  mechanicalInput: MechanicalCheckInput;
  stage3Enabled?: boolean;
  issueReviewerThread: (params: {
    itemId: string;
    brief: string;
  }) => Promise<ReviewerVerdict>;
  log?: (message: string) => void;
}

export interface ReviewerGateResult {
  verdict: GateVerdict;
  mechanical: MechanicalCheckResult;
  reviewer: ReviewerVerdict;
  shadowMode: boolean;
  mergeAuthorized: boolean;
}

/**
 * Composes a fresh-context adversarial reviewer prompt carrying the brief,
 * the diff, and the standing audit scope.
 */
export function composeReviewerPrompt(brief: string, diff: string): string {
  return [
    "You are an adversarial reviewer running in a fresh context (never the job's own thread).",
    "Evaluate the PR diff against the item brief below:",
    "1. Run behavioral acceptance criteria against the PR.",
    "2. Grep the diff for guard/banned patterns.",
    "3. Walk error paths adjacent to the change.",
    "Return PASS or FAIL with cited evidence.",
    "",
    "## Item Brief",
    brief,
    "",
    "## PR Diff",
    diff,
  ].join("\n");
}

/**
 * Runs mechanical checks + fresh adversarial reviewer thread, combines verdicts
 * (PASS only when BOTH pass), and enforces shadow mode while Stage 3 is OFF.
 */
export async function evaluateReviewerGate(
  options: EvaluateReviewerGateOptions,
): Promise<ReviewerGateResult> {
  const mechanical = runMechanicalChecks(options.mechanicalInput);
  const prompt = composeReviewerPrompt(options.brief, options.mechanicalInput.diff);
  const reviewer = await options.issueReviewerThread({
    itemId: options.itemId,
    brief: prompt,
  });

  const verdict: GateVerdict =
    mechanical.verdict === "PASS" && reviewer.verdict === "PASS" ? "PASS" : "FAIL";
  const stage3Enabled = isReviewerGateStage3Enabled(options.stage3Enabled);
  const shadowMode = !stage3Enabled;

  options.log?.(
    `[reviewer-gate] item=${options.itemId} verdict=${verdict} mechanical=${mechanical.verdict} reviewer=${reviewer.verdict} shadow=${shadowMode}`,
  );

  return {
    verdict,
    mechanical,
    reviewer,
    shadowMode,
    mergeAuthorized: false,
  };
}

export interface MergeAuthorizationInput {
  stage3Enabled?: boolean;
  ciAllGreen: boolean;
  reviewerGateVerdict: GateVerdict;
  finishVerificationClean: boolean;
}

/**
 * Stage 3 merge authorization check (machinery only; Stage 3 defaults to OFF).
 */
export function isMergeAuthorized(input: MergeAuthorizationInput): boolean {
  if (!isReviewerGateStage3Enabled(input.stage3Enabled)) {
    return false;
  }
  return (
    input.ciAllGreen &&
    input.reviewerGateVerdict === "PASS" &&
    input.finishVerificationClean
  );
}

export interface AuditComparison {
  prNumber: number;
  driverVerdict: GateVerdict;
  reviewerVerdict: GateVerdict;
  reason?: string;
  diff: string;
}

export interface EscapeRecord {
  prNumber: number;
  reason: string;
  diff: string;
}

export interface AgreementLedger {
  totalPrs: number;
  agreements: number;
  agreementRate: number;
  escapes: EscapeRecord[];
  reviewerTestCases: EscapeRecord[];
  stage3Eligible: boolean;
}

export function createAgreementLedger(): AgreementLedger {
  return {
    totalPrs: 0,
    agreements: 0,
    agreementRate: 0,
    escapes: [],
    reviewerTestCases: [],
    stage3Eligible: false,
  };
}

/**
 * Tracks agreement between driver audits and reviewer-gate verdicts.
 * Any PR the driver blocked (FAIL) that the reviewer passed (PASS) is recorded
 * as an escape and added as a reviewer test case.
 * Stage 3 entry evidence: >=95% agreement over >=10 PRs with zero escapes.
 */
export function recordAuditComparison(
  ledger: AgreementLedger,
  comparison: AuditComparison,
): AgreementLedger {
  const totalPrs = ledger.totalPrs + 1;
  const agreed = comparison.driverVerdict === comparison.reviewerVerdict;
  const agreements = ledger.agreements + (agreed ? 1 : 0);
  const agreementRate = agreements / totalPrs;

  const isEscape =
    comparison.driverVerdict === "FAIL" && comparison.reviewerVerdict === "PASS";
  const escapeRecord: EscapeRecord | null = isEscape
    ? {
        prNumber: comparison.prNumber,
        reason: comparison.reason ?? "Driver blocked PR that reviewer passed",
        diff: comparison.diff,
      }
    : null;

  const escapes = escapeRecord ? [...ledger.escapes, escapeRecord] : ledger.escapes;
  const reviewerTestCases = escapeRecord
    ? [...ledger.reviewerTestCases, escapeRecord]
    : ledger.reviewerTestCases;

  const stage3Eligible =
    totalPrs >= 10 && agreementRate >= 0.95 && escapes.length === 0;

  return {
    totalPrs,
    agreements,
    agreementRate,
    escapes,
    reviewerTestCases,
    stage3Eligible,
  };
}
