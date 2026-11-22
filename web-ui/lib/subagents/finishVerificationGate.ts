import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

export interface FinishVerificationInput {
  workspaceRoot: string;
  expectedArtifacts?: string[];
  gatePassed?: boolean;
  baseCommit?: string;
}

export interface FinishVerificationResult {
  ok: boolean;
  reasons: string[];
}

export function verifyJobCompletion(input: FinishVerificationInput): FinishVerificationResult {
  const reasons: string[] = [];

  if (input.gatePassed !== true) {
    reasons.push("Test gate has not passed (gatePassed !== true).");
  }

  for (const rel of input.expectedArtifacts || []) {
    const abs = path.resolve(input.workspaceRoot, rel);
    if (!fs.existsSync(abs)) {
      reasons.push(`Claimed artifact missing: ${rel}`);
    }
  }

  if (input.baseCommit) {
    try {
      const countStr = execFileSync("git", ["rev-list", "--count", `${input.baseCommit}..HEAD`], {
        cwd: input.workspaceRoot,
        encoding: "utf8",
      }).trim();
      if (Number(countStr) <= 0) {
        reasons.push(`No new commits found since baseCommit ${input.baseCommit}.`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      reasons.push(`Failed to verify git commits: ${msg}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export interface MilestoneHandoffState {
  jobId: string;
  completedMilestones: string[];
  nextMilestone: string | null;
  summary: string;
  updatedAt: string;
  // Optional chunk-handoff fields (item 18)
  chunkComplete?: boolean;
  currentState?: string;
  branch?: string;
  headSha?: string;
  nextStep?: string;
  openQuestions?: string[];
  completedSteps?: number;
}

export function writeMilestoneHandoff(handoffPath: string, state: MilestoneHandoffState): void {
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
  fs.writeFileSync(handoffPath, JSON.stringify(state, null, 2), "utf8");
}

export function readMilestoneHandoff(handoffPath: string): MilestoneHandoffState | null {
  if (!fs.existsSync(handoffPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(handoffPath, "utf8")) as MilestoneHandoffState;
  } catch {
    return null;
  }
}
