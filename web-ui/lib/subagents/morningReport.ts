import fs from "fs";
import path from "path";
import { AmbiguityFlag, TaskManifest } from "./types.js";

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

export interface TestTierSummary {
  name: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  durationSeconds: number;
  budgetSeconds?: number;
  testsPassed: number;
  testsFailed: number;
  suitesCount?: number;
  details?: string;
}

export interface MorningReportArtifact {
  name: string;
  path: string;
  previewUrl: string;
  threadUrl?: string;
  taskId?: string;
}

export interface OvernightTaskEntry {
  taskId: string;
  threadId?: string;
  goal: string;
  status: "completed" | "parked" | "failed" | "cancelled" | "stopped" | "active";
  branch: string;
  gitHeadSha: string;
  startedAt: string;
  completedAt?: string;
  durationSeconds: number;
  durationFormatted: string;
  artifacts: MorningReportArtifact[];
  parkedReason?: string;
  errorSummary?: string;
  milestones: MorningReportMilestone[];
  ambiguityFlags: AmbiguityFlag[];
  testsPassed: number;
  testsFailed: number;
}

export interface OvernightAttentionItem {
  taskId: string;
  threadId?: string;
  goal: string;
  status: "parked" | "failed";
  reason: string;
  threadUrl?: string;
}

export interface OvernightMorningReport {
  reportId: string;
  generatedAt: string;
  windowLabel: string;
  totalTasks: number;
  completedCount: number;
  parkedCount: number;
  failedCount: number;
  totalDurationSeconds: number;
  totalDurationFormatted: string;
  tasks: OvernightTaskEntry[];
  artifactsProduced: MorningReportArtifact[];
  attentionItems: OvernightAttentionItem[];
  summaryMarkdown: string;
}

export interface MorningReportInput {
  taskId: string;
  goal: string;
  branch: string;
  gitHeadSha: string;
  status: "completed" | "parked" | "failed" | "cancelled" | "active";
  startedAt: string;
  completedAt?: string;
  milestones: MorningReportMilestone[];
  ambiguityFlags: AmbiguityFlag[];
  parkedItems: string[];
  testTiers?: TestTierSummary[];
}

export interface MorningReport extends MorningReportInput {
  totalTestsPassed: number;
  totalTestsFailed: number;
  durationFormatted: string;
  summaryMarkdown: string;
  overnightSummary?: OvernightMorningReport;
}

/**
 * Calculates duration in seconds between two ISO timestamps.
 */
export function calculateDurationSeconds(start?: string, end?: string): number {
  if (!start) return 0;
  const startTime = new Date(start).getTime();
  if (Number.isNaN(startTime)) return 0;
  const endTime = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(endTime)) return 0;
  return Math.max(0, Math.round((endTime - startTime) / 1000));
}

/**
 * Formats seconds into human-readable duration string (e.g., "3m 30s").
 */
export function formatDurationSeconds(diffSec: number): string {
  const safeSec = Math.max(0, Math.round(diffSec));
  const hours = Math.floor(safeSec / 3600);
  const minutes = Math.floor((safeSec % 3600) / 60);
  const seconds = safeSec % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Calculates human-readable duration between two ISO timestamps.
 */
function calculateDuration(start: string, end?: string): string {
  return formatDurationSeconds(calculateDurationSeconds(start, end));
}

/**
 * Checks if a given ISO timestamp falls within the overnight window (default 10pm / 22:00 to 7am / 07:00 UTC or local).
 */
export function isWithinOvernightWindow(
  timestampIso: string,
  windowStartHour: number = 22,
  windowEndHour: number = 7
): boolean {
  const date = new Date(timestampIso);
  if (Number.isNaN(date.getTime())) return false;
  const utcHour = date.getUTCHours();
  const localHour = date.getHours();

  const inRange = (h: number) =>
    windowStartHour > windowEndHour
      ? h >= windowStartHour || h < windowEndHour
      : h >= windowStartHour && h < windowEndHour;

  return inRange(utcHour) || inRange(localHour);
}

/**
 * Extracts produced file artifacts and builds working preview URLs for a task.
 */
export function extractTaskArtifacts(task: TaskManifest): MorningReportArtifact[] {
  const seenPaths = new Set<string>();
  const artifacts: MorningReportArtifact[] = [];

  const addFile = (rawPath?: string) => {
    if (!rawPath) return;
    const cleaned = rawPath.trim().replace(/^['"`]+|['"`]+$/g, "");
    if (!cleaned || seenPaths.has(cleaned)) return;
    seenPaths.add(cleaned);
    const basename = path.posix.basename(cleaned.replace(/\\/g, "/"));
    artifacts.push({
      name: basename || cleaned,
      path: cleaned,
      previewUrl: `/api/files?path=${encodeURIComponent(cleaned)}`,
      threadUrl: task.threadId ? `/?thread=${encodeURIComponent(task.threadId)}` : undefined,
      taskId: task.taskId
    });
  };

  for (const m of task.milestones || []) {
    if (Array.isArray(m.plannedFiles)) {
      for (const pf of m.plannedFiles) {
        addFile(pf);
      }
    }
    if (m.testFile) {
      addFile(m.testFile);
    }
    if (m.diffSummary) {
      const fileMatch = m.diffSummary.match(/File:\s*([^\r\n]+)/i);
      if (fileMatch && fileMatch[1]) {
        addFile(fileMatch[1]);
      }
    }
  }

  for (const entry of task.journal || []) {
    const genMatch = entry.message?.match(/Generated deliverable\s+([^\s(]+)/i);
    if (genMatch && genMatch[1]) {
      addFile(genMatch[1]);
    }
  }

  return artifacts;
}

/**
 * Normalizes a task manifest's outcome into completed / parked / failed / active
 * and extracts parkedReason or errorSummary.
 */
function resolveTaskOutcome(task: TaskManifest): {
  status: OvernightTaskEntry["status"];
  parkedReason?: string;
  errorSummary?: string;
} {
  if (task.status === "completed") {
    return { status: "completed" };
  }

  if (task.status === "parked") {
    const reason =
      task.parkedReason ||
      task.ambiguityFlags?.[0]?.question ||
      "Task parked awaiting manual review.";
    return { status: "parked", parkedReason: reason };
  }

  const hasFailedMilestone = (task.milestones || []).some((m) => m.status === "failed" || m.status === "rejected");
  if (task.status === "failed" || task.status === "crashed" || hasFailedMilestone) {
    const failedM = (task.milestones || []).find((m) => m.status === "failed" || m.status === "rejected");
    const journalErr = [...(task.journal || [])]
      .reverse()
      .find((j) => /crash|error|fail/i.test(j.message))?.message;
    const errorSummary =
      task.errorSummary ||
      failedM?.criticCritique ||
      failedM?.criticNotes?.[0] ||
      journalErr ||
      task.parkedReason ||
      "Execution failed during milestone verification.";
    return { status: "failed", errorSummary };
  }

  if (task.status === "stopped" || task.status === "cancelled") {
    return {
      status: task.status,
      parkedReason: task.parkedReason || "Task stopped before completion."
    };
  }

  return { status: "active" };
}

/**
 * Generates an aggregated Overnight Morning Report across a list of tasks (completed, parked, failed).
 * Covers the overnight window (10pm–7am) and persists to disk.
 */
export function generateOvernightMorningReport(
  tasks: TaskManifest[],
  options?: {
    filterOvernightWindow?: boolean;
    windowStartHour?: number;
    windowEndHour?: number;
  }
): OvernightMorningReport {
  const startHour = options?.windowStartHour ?? 22;
  const endHour = options?.windowEndHour ?? 7;

  let candidateTasks = Array.isArray(tasks) ? [...tasks] : [];
  if (options?.filterOvernightWindow) {
    const windowFiltered = candidateTasks.filter((t) =>
      isWithinOvernightWindow(t.startedAt || t.updatedAt || new Date().toISOString(), startHour, endHour)
    );
    // Fallback to all candidate tasks if none strictly matched the clock hours so the report is never blank after a run
    if (windowFiltered.length > 0) {
      candidateTasks = windowFiltered;
    }
  }

  // Deduplicate candidate tasks by taskId so each task appears exactly once
  const seenTaskIds = new Set<string>();
  candidateTasks = candidateTasks.filter((task) => {
    if (!task.taskId) return true;
    if (seenTaskIds.has(task.taskId)) return false;
    seenTaskIds.add(task.taskId);
    return true;
  });

  // Sort newest first
  candidateTasks.sort((a, b) => {
    const tA = new Date(a.updatedAt || a.completedAt || a.startedAt || 0).getTime();
    const tB = new Date(b.updatedAt || b.completedAt || b.startedAt || 0).getTime();
    return tB - tA;
  });

  let completedCount = 0;
  let parkedCount = 0;
  let failedCount = 0;
  let totalDurationSeconds = 0;

  const entries: OvernightTaskEntry[] = [];
  const allArtifacts: MorningReportArtifact[] = [];
  const attentionItems: OvernightAttentionItem[] = [];

  const seenGlobalArtifactPaths = new Set<string>();

  for (const task of candidateTasks) {
    const outcome = resolveTaskOutcome(task);
    if (outcome.status === "completed") completedCount++;
    else if (outcome.status === "parked") parkedCount++;
    else if (outcome.status === "failed") failedCount++;

    const endTimestamp = task.completedAt || task.updatedAt || task.startedAt;
    const durationSeconds = calculateDurationSeconds(task.startedAt, endTimestamp);
    const durationFormatted = formatDurationSeconds(durationSeconds);
    totalDurationSeconds += durationSeconds;

    const artifacts = extractTaskArtifacts(task);
    for (const art of artifacts) {
      const norm = art.path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
      if (!seenGlobalArtifactPaths.has(norm)) {
        seenGlobalArtifactPaths.add(norm);
        allArtifacts.push({
          ...art,
          path: norm
        });
      }
    }

    let testsPassed = 0;
    let testsFailed = 0;
    const milestones: MorningReportMilestone[] = (task.milestones || []).map((m) => {
      if (m.testsPassed) testsPassed += m.testsPassed;
      if (m.testsFailed) testsFailed += m.testsFailed;
      return {
        id: m.id,
        title: m.title,
        status: m.status,
        commitSha: m.commitSha,
        testsPassed: m.testsPassed ?? 0,
        testsFailed: m.testsFailed ?? 0,
        diffSummary: m.diffSummary,
        notes: m.criticCritique
      };
    });

    const lastCheckpoint =
      task.checkpoints && task.checkpoints.length > 0
        ? task.checkpoints[task.checkpoints.length - 1]
        : undefined;

    const entry: OvernightTaskEntry = {
      taskId: task.taskId,
      threadId: task.threadId,
      goal: task.goal,
      status: outcome.status,
      branch: task.branch || task.branchName || "feat/overnight",
      gitHeadSha: lastCheckpoint?.gitHeadSha || "HEAD",
      startedAt: task.startedAt || new Date().toISOString(),
      completedAt: task.completedAt || task.updatedAt,
      durationSeconds,
      durationFormatted,
      artifacts,
      parkedReason: outcome.parkedReason,
      errorSummary: outcome.errorSummary,
      milestones,
      ambiguityFlags: task.ambiguityFlags || [],
      testsPassed,
      testsFailed
    };

    entries.push(entry);

    if (outcome.status === "parked") {
      attentionItems.push({
        taskId: task.taskId,
        threadId: task.threadId,
        goal: task.goal,
        status: "parked",
        reason: outcome.parkedReason || "Parked awaiting manual review.",
        threadUrl: task.threadId ? `/?thread=${encodeURIComponent(task.threadId)}` : undefined
      });
    } else if (outcome.status === "failed") {
      attentionItems.push({
        taskId: task.taskId,
        threadId: task.threadId,
        goal: task.goal,
        status: "failed",
        reason: outcome.errorSummary || "Task failed verification.",
        threadUrl: task.threadId ? `/?thread=${encodeURIComponent(task.threadId)}` : undefined
      });
    }
  }

  const report: OvernightMorningReport = {
    reportId: `morning-report-${new Date().toISOString().slice(0, 10)}`,
    generatedAt: new Date().toISOString(),
    windowLabel: "Overnight Window (10:00 PM – 7:00 AM)",
    totalTasks: entries.length,
    completedCount,
    parkedCount,
    failedCount,
    totalDurationSeconds,
    totalDurationFormatted: formatDurationSeconds(totalDurationSeconds),
    tasks: entries,
    artifactsProduced: allArtifacts,
    attentionItems,
    summaryMarkdown: ""
  };

  report.summaryMarkdown = formatOvernightMorningReportMarkdown(report);
  return report;
}

/**
 * Formats the multi-task Overnight Morning Report as clean Markdown.
 */
export function formatOvernightMorningReportMarkdown(report: OvernightMorningReport): string {
  const lines: string[] = [
    `# Overnight Morning Report (${report.windowLabel})`,
    "",
    `**Total Tasks**: ${report.totalTasks} | ✅ **Completed**: ${report.completedCount} | ⚠️ **Parked**: ${report.parkedCount} | ❌ **Failed**: ${report.failedCount} | ⏱️ **Total Time**: ${report.totalDurationFormatted}`,
    "",
    "---",
    "",
    "## 1. What Ran",
    "",
    "| Task ID | Goal | Status | Duration | Artifacts |",
    "| :--- | :--- | :--- | :--- | :--- |"
  ];

  for (const t of report.tasks) {
    const statusBadge =
      t.status === "completed"
        ? "✅ Completed"
        : t.status === "parked"
        ? "⚠️ Parked"
        : t.status === "failed"
        ? "❌ Failed"
        : `🔄 ${t.status}`;
    const artLinks =
      t.artifacts.length > 0
        ? t.artifacts.map((a) => `[${a.name}](${a.previewUrl})`).join(", ")
        : "—";
    lines.push(`| \`${t.taskId}\` | ${t.goal} | ${statusBadge} | ${t.durationFormatted} | ${artLinks} |`);
  }

  lines.push("");
  lines.push("## 2. What Was Produced");
  lines.push("");
  if (report.artifactsProduced.length === 0) {
    lines.push("No file artifacts were produced during this window.");
  } else {
    for (const art of report.artifactsProduced) {
      lines.push(`- **[${art.name}](${art.previewUrl})** (\`${art.path}\`) — Task \`${art.taskId}\``);
    }
  }

  lines.push("");
  lines.push("## 3. What Needs Attention");
  lines.push("");
  if (report.attentionItems.length === 0) {
    lines.push("Nothing requires immediate intervention. All overnight tasks completed cleanly.");
  } else {
    for (const item of report.attentionItems) {
      const icon = item.status === "parked" ? "⚠️ **PARKED**" : "❌ **FAILED**";
      lines.push(`- ${icon} (\`${item.taskId}\` — *${item.goal}*): ${item.reason}`);
    }
  }

  return lines.join("\n");
}

export const MORNING_REPORT_CHECKPOINT_DIR: string = (() => {
  if (process.env.MORNING_REPORT_DIR) return process.env.MORNING_REPORT_DIR;
  if (process.env.AGENT_CHECKPOINT_DIR) return process.env.AGENT_CHECKPOINT_DIR;

  const candidates = [
    fs.existsSync(path.resolve(process.cwd(), "../workspace"))
      ? path.resolve(process.cwd(), "../workspace/.agent/checkpoints")
      : null,
    path.resolve(process.cwd(), ".agent/checkpoints"),
    path.resolve(process.cwd(), ".checkpoints"),
    path.resolve("/tmp/.agent/checkpoints")
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // try next candidate
    }
  }
  return path.resolve(process.cwd(), ".checkpoints");
})();

/**
 * Persists the Overnight Morning Report to disk so it is readable at 7am without digging through logs.
 */
export function persistOvernightMorningReport(
  report: OvernightMorningReport,
  checkpointDir?: string
): string {
  const dir = checkpointDir || MORNING_REPORT_CHECKPOINT_DIR;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, "overnight-morning-report.json");
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), "utf8");
  return filePath;
}

/**
 * Loads the persisted Overnight Morning Report from disk if available.
 */
export function loadPersistedOvernightMorningReport(
  checkpointDir?: string
): OvernightMorningReport | null {
  const dir = checkpointDir || MORNING_REPORT_CHECKPOINT_DIR;
  const filePath = path.join(dir, "overnight-morning-report.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as OvernightMorningReport;
  } catch {
    return null;
  }
}

/**
 * Generates structured single-task Morning Report data object (backward compatible).
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
      : report.status === "failed"
      ? "❌ **Status: FAILED**"
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

  let sectionNumber = 2;

  // Test Verification Tiers Section (Phase C: Tier 1 Gate + Tier 2 Full Suite)
  if (report.testTiers && report.testTiers.length > 0) {
    lines.push(`## ${sectionNumber}. Test Verification Tiers (Phase C)`);
    lines.push("");
    lines.push("| Tier | Command | Status | Duration | Budget | Tests Passed | Tests Failed | Details |");
    lines.push("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |");
    for (const tier of report.testTiers) {
      const statusIcon = tier.status === "passed" ? "✅ Passed" : tier.status === "failed" ? "❌ Failed" : "⏸️ Skipped";
      const budgetStr = tier.budgetSeconds ? `<${tier.budgetSeconds}s` : "—";
      lines.push(
        `| **${tier.name}** | \`${tier.command}\` | ${statusIcon} | ${tier.durationSeconds}s | ${budgetStr} | ${tier.testsPassed} | ${tier.testsFailed} | ${tier.details || "—"} |`
      );
    }
    lines.push("");
    lines.push("---");
    lines.push("");
    sectionNumber++;
  }

  // Ambiguity Flags Section
  lines.push(`## ${sectionNumber}. Ambiguity Flags & Judgment Calls (${report.ambiguityFlags.length})`);
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
