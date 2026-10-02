import { AmbiguityFlag } from "./types.js";

export interface MorningReportMilestone {
  id: string;
  title: string;
  status: string;
  commitSha?: string;
  testsPassed?: number;
  testsFailed?: number;
  diffSummary?: string;
  notes?: string;
}

export interface MorningReportInput {
  taskId: string;
  goal: string;
  branch: string;
  gitHeadSha: string;
  status: "completed" | "parked" | "cancelled" | "active";
  startedAt: string;
  completedAt?: string;
  milestones: MorningReportMilestone[];
  ambiguityFlags: AmbiguityFlag[];
  parkedItems: string[];
}

export interface MorningReport extends MorningReportInput {
  totalTestsPassed: number;
  totalTestsFailed: number;
  durationFormatted: string;
  summaryMarkdown: string;
}

/**
 * Calculates human-readable duration between two ISO timestamps.
 */
function calculateDuration(start: string, end?: string): string {
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();
  const diffSec = Math.max(0, Math.round((endTime - startTime) / 1000));

  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const seconds = diffSec % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Generates structured Morning Report data object.
 */
export function generateMorningReport(input: MorningReportInput): MorningReport {
  let totalTestsPassed = 0;
  let totalTestsFailed = 0;

  for (const m of input.milestones) {
    if (m.testsPassed) totalTestsPassed += m.testsPassed;
    if (m.testsFailed) totalTestsFailed += m.testsFailed;
  }

  const durationFormatted = calculateDuration(input.startedAt, input.completedAt);

  const report: MorningReport = {
    ...input,
    totalTestsPassed,
    totalTestsFailed,
    durationFormatted,
    summaryMarkdown: ""
  };

  report.summaryMarkdown = formatMorningReportMarkdown(report);
  return report;
}

/**
 * Formats a Morning Report as hiring-manager grade Markdown.
 */
export function formatMorningReportMarkdown(report: MorningReport): string {
  const statusBadge =
    report.status === "completed"
      ? "✅ **Status: COMPLETED**"
      : report.status === "parked"
      ? "⚠️ **Status: PARKED (Requires Zack's Review)**"
      : report.status === "cancelled"
      ? "🛑 **Status: CANCELLED**"
      : "🔄 **Status: ACTIVE**";

  const lines: string[] = [
    `# Autonomous Morning Report: ${report.taskId}`,
    "",
    `${statusBadge} | Branch: \`${report.branch}\` | Duration: ${report.durationFormatted}`,
    `Git HEAD: \`${report.gitHeadSha}\` | Started: ${report.startedAt}${report.completedAt ? ` | Finished: ${report.completedAt}` : ""}`,
    "",
    `### Goal`,
    `> ${report.goal}`,
    "",
    "---",
    "",
    "## 1. Milestones & Test Verification",
    "",
    "| Milestone | Status | Commit SHA | Tests Passed | Tests Failed | Diff Summary |",
    "| :--- | :--- | :--- | :--- | :--- | :--- |"
  ];

  for (const m of report.milestones) {
    const commitDisplay = m.commitSha ? `\`${m.commitSha.substring(0, 7)}\`` : "—";
    lines.push(
      `| **${m.id}: ${m.title}** | ${m.status} | ${commitDisplay} | ${m.testsPassed ?? 0} passed | ${m.testsFailed ?? 0} failed | ${m.diffSummary || "—"} |`
    );
  }

  lines.push("");
  lines.push(`**Total Test Suite Result**: **${report.totalTestsPassed} passed**, **${report.totalTestsFailed} failed**.`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Ambiguity Flags Section
  lines.push(`## 2. Ambiguity Flags & Judgment Calls (${report.ambiguityFlags.length})`);
  lines.push("");
  if (report.ambiguityFlags.length === 0) {
    lines.push("No ambiguities encountered. Execution adhered strictly to the specification.");
  } else {
    lines.push("Per Autonomy Policy (Oct 2, 2026), the overnight builder never blocks on ambiguity.");
    lines.push("The following judgment calls were made, committed, and flagged for morning review:");
    lines.push("");

    for (const flag of report.ambiguityFlags) {
      lines.push(`### [${flag.id}] (${flag.milestoneId}): ${flag.question}`);
      lines.push(`- **Judgment Call**: ${flag.judgmentCall}`);
      lines.push(`- **Reasoning**: ${flag.reasoning}`);
      lines.push(`- **Revert Action**: \`${flag.revertAction.type} ${flag.revertAction.target}\``);
      lines.push(`- **Reviewed**: ${flag.reviewed ? "✅ Yes" : "⏳ Pending Zack's Review"}`);
      lines.push("");
    }
  }

  // Parked Items Section
  if (report.parkedItems.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push(`## 3. Parked Items Requiring Manual Review (${report.parkedItems.length})`);
    lines.push("");
    for (const item of report.parkedItems) {
      lines.push(`- ⚠️ ${item}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
