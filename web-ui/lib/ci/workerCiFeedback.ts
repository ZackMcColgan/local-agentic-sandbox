export type CiRunState = "running" | "passed" | "failed";

export interface CiCheckRunResult {
  state: CiRunState;
  actionsUrl: string;
  failingStep?: string;
  logExcerpt?: string;
}

export type CheckRunsFetcher = (branchName: string) => Promise<CiCheckRunResult>;

export interface EvaluateCiInput {
  taskId: string;
  branchName: string;
  milestones: Array<{
    id: string;
    title: string;
    status: "pending" | "in_progress" | "completed" | "failed" | "rejected";
    commitSha?: string;
  }>;
  fixExecutor: (milestoneTitle: string, attempt: number) => Promise<{ fixed: boolean; commitSha?: string }>;
}

export interface EvaluateCiOutcome {
  taskId: string;
  ciState: CiRunState;
  finalStatus: "completed" | "parked";
  fixAttempts: number;
  milestones: Array<{
    id: string;
    title: string;
    status: "pending" | "in_progress" | "completed" | "failed" | "rejected";
    commitSha?: string;
  }>;
  parkedReason?: string;
  actionsUrl?: string;
}

export function extractFailingTestFromCiLog(log: string): string {
  if (!log) return "tests/suite.test.ts";

  // Match TAP format: not ok N - tests/foo.test.ts
  const tapMatch = log.match(/not ok \d+ - ([a-zA-Z0-9_\-./]+\.test\.ts)/);
  if (tapMatch) return tapMatch[1];

  // Match Jest/Node format: FAIL tests/foo.test.ts
  const jestMatch = log.match(/FAIL\s+([a-zA-Z0-9_\-./]+\.test\.ts)/i);
  if (jestMatch) return jestMatch[1];

  // Match general: tests/foo.test.ts
  const genMatch = log.match(/(?:tests\/[a-zA-Z0-9_\-./]+\.test\.ts)/);
  if (genMatch) return genMatch[0];

  return "unknown test step";
}

export class WorkerCiFeedbackLoop {
  private checkRunsFetcher: CheckRunsFetcher;
  private pollIntervalMs: number;
  private maxFixAttempts: number;

  constructor(options: {
    checkRunsFetcher: CheckRunsFetcher;
    pollIntervalMs?: number;
    maxFixAttempts?: number;
  }) {
    this.checkRunsFetcher = options.checkRunsFetcher;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.maxFixAttempts = options.maxFixAttempts ?? 3;
  }

  public async evaluateAndHealCi(input: EvaluateCiInput): Promise<EvaluateCiOutcome> {
    let fixAttempts = 0;
    const milestones = [...input.milestones];

    while (fixAttempts <= this.maxFixAttempts) {
      let check = await this.checkRunsFetcher(input.branchName);

      // Wait if still running
      while (check.state === "running") {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        check = await this.checkRunsFetcher(input.branchName);
      }

      if (check.state === "passed") {
        return {
          taskId: input.taskId,
          ciState: "passed",
          finalStatus: "completed",
          fixAttempts,
          milestones,
          actionsUrl: check.actionsUrl
        };
      }

      // CI failed
      if (fixAttempts >= this.maxFixAttempts) {
        return {
          taskId: input.taskId,
          ciState: "failed",
          finalStatus: "parked",
          fixAttempts,
          milestones,
          parkedReason: `CI checks failed after ${this.maxFixAttempts} fix attempts in branch ${input.branchName}`,
          actionsUrl: check.actionsUrl
        };
      }

      // Trigger a fix milestone
      fixAttempts++;
      const failingTarget = check.failingStep || extractFailingTestFromCiLog(check.logExcerpt || "");
      const fixMilestoneTitle = `Fix CI failure in ${failingTarget}`;
      const fixMilestoneId = `M-CI-FIX-${fixAttempts}`;

      const fixMilestone: EvaluateCiInput["milestones"][number] = {
        id: fixMilestoneId,
        title: fixMilestoneTitle,
        status: "in_progress"
      };
      milestones.push(fixMilestone);

      const fixResult = await input.fixExecutor(fixMilestoneTitle, fixAttempts);
      fixMilestone.status = "completed";
      if (fixResult.commitSha) {
        fixMilestone.commitSha = fixResult.commitSha;
      }
    }

    return {
      taskId: input.taskId,
      ciState: "failed",
      finalStatus: "parked",
      fixAttempts,
      milestones,
      parkedReason: `CI checks failed after ${this.maxFixAttempts} fix attempts`,
      actionsUrl: ""
    };
  }
}
