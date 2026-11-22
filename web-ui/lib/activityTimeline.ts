/**
 * Pure row model for the activity timeline.
 *
 * Transforms raw tool traces into verb-first timeline rows, folds consecutive
 * completed read/search rows into expandable groups, and extracts inline error
 * summaries and write diff metadata without side effects.
 */

export type TimelineToolKind =
  | "read"
  | "search"
  | "write"
  | "shell"
  | "web"
  | "subagent"
  | "thinking"
  | "other";

export type TimelineRowStatus = "running" | "success" | "error";

export interface ThinkingSegment {
  round: number;
  text: string;
}

export interface TimelineWriteDiff {
  filePath: string;
  addedLines: number;
  removedLines: number;
  diffText?: string;
  synthesized?: boolean;
}

export interface TimelineTraceInput {
  tool: string;
  args?: Record<string, unknown>;
  result?: unknown;
  durationMs?: number;
  timestamp?: string;
  tier?: string;
  status?: "running" | "complete" | "error" | "success";
  isError?: boolean;
  round?: number;
}

export interface TimelineRow {
  id: string;
  kind: TimelineToolKind;
  status: TimelineRowStatus;
  verb: string;
  target: string;
  label: string;
  durationMs?: number;
  errorSummary?: string;
  writeDiff?: TimelineWriteDiff;
  children?: TimelineRow[];
  isGroup?: boolean;
  rawTraceIndex?: number;
  thinkingText?: string;
  round?: number;
}

const MAX_TARGET_LEN = 64;
const MAX_ERROR_LEN = 140;

function truncate(text: string, maxLen: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function readStringArg(args: Record<string, unknown> | undefined, keys: string[]): string {
  if (!args) return "";
  for (const key of keys) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return "";
}

/**
 * Classifies a tool name into a canonical timeline kind.
 */
export function classifyToolKind(tool: string): TimelineToolKind {
  const t = (tool || "").toLowerCase();
  if (!t) return "other";

  if (
    t.includes("subagent") ||
    t.includes("delegate") ||
    t.startsWith("spawn_") ||
    t.includes("invoke_agent")
  ) {
    return "subagent";
  }

  if (
    t === "file" ||
    t.includes("read_file") ||
    t.includes("readfile") ||
    t === "read" ||
    t.includes("view_file") ||
    t.includes("cat_file")
  ) {
    return "read";
  }

  if (
    t.includes("search") ||
    t.includes("grep") ||
    t.includes("find_files") ||
    t.includes("list_dir") ||
    t.includes("glob")
  ) {
    return "search";
  }

  if (
    t.includes("write") ||
    t.includes("edit") ||
    t.includes("patch") ||
    t.includes("create_file") ||
    t.includes("delete_path") ||
    t.includes("replace_in_file")
  ) {
    return "write";
  }

  if (
    t.includes("command") ||
    t.includes("powershell") ||
    t.includes("bash") ||
    t.includes("shell") ||
    t.includes("python") ||
    t.includes("exec") ||
    t.includes("git_")
  ) {
    return "shell";
  }

  if (t.includes("fetch") || t.includes("browser") || t.includes("http") || t.includes("url")) {
    return "web";
  }

  return "other";
}

function verbForKind(kind: TimelineToolKind, tool: string, isRunning: boolean): string {
  const lower = (tool || "").toLowerCase();
  if (lower.includes("delete")) {
    return isRunning ? "Deleting" : "Deleted";
  }
  if (lower.includes("list_dir")) {
    return isRunning ? "Listing" : "Listed";
  }
  switch (kind) {
    case "read":
      return isRunning ? "Reading" : "Read";
    case "search":
      return isRunning ? "Searching" : "Searched";
    case "write":
      return isRunning ? "Writing" : "Wrote";
    case "shell":
      return isRunning ? "Running" : "Ran";
    case "web":
      return isRunning ? "Fetching" : "Fetched";
    case "subagent":
      return isRunning ? "Delegating" : "Delegated";
    default:
      return isRunning ? "Running" : "Ran";
  }
}

const LEADING_SHELL_BOILERPLATE_RE =
  /^\s*(?:\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:'[^']*'|"[^"]*")|Set-Location\s+(?:'[^']*'|"[^"]*"));\s*/i;

/**
 * Strips leading PowerShell preamble assignments and Set-Location segments
 * so shell row labels show the operative command. Falls back to the original
 * command if stripping empties it.
 */
export function stripShellBoilerplate(command: string): string {
  let remaining = command.trim();
  while (remaining.length > 0) {
    const next = remaining.replace(LEADING_SHELL_BOILERPLATE_RE, "");
    if (next === remaining) break;
    remaining = next.trim();
  }
  return remaining || command;
}

function targetForTrace(kind: TimelineToolKind, trace: TimelineTraceInput): string {
  const args = trace.args;
  if (kind === "read" || kind === "write") {
    const p = readStringArg(args, ["path", "filePath", "file_path", "target"]);
    return p ? truncate(basename(p), MAX_TARGET_LEN) : "file";
  }
  if (kind === "search") {
    const q = readStringArg(args, ["query", "pattern", "q", "path", "dir"]);
    return q ? truncate(q, MAX_TARGET_LEN) : "codebase";
  }
  if (kind === "shell") {
    const cmd = readStringArg(args, ["command", "cmd", "script"]);
    return cmd ? truncate(stripShellBoilerplate(cmd), MAX_TARGET_LEN) : trace.tool.replace(/_/g, " ");
  }
  if (kind === "web") {
    const url = readStringArg(args, ["url", "uri", "query"]);
    return url ? truncate(url, MAX_TARGET_LEN) : "web page";
  }
  if (kind === "subagent") {
    const task = readStringArg(args, ["task", "prompt", "role", "goal"]);
    return task ? truncate(task, MAX_TARGET_LEN) : "subagent";
  }
  return truncate((trace.tool || "action").replace(/_/g, " "), MAX_TARGET_LEN);
}

/**
 * Extracts a concise single-line error summary from a trace result if it indicates failure.
 */
export function extractTraceError(result: unknown, isError?: boolean): string | undefined {
  if (typeof result === "string") {
    if (isError || /^(error|failed|enoent|eacces|exit code [1-9])/i.test(result.trim())) {
      return truncate(result, MAX_ERROR_LEN);
    }
    return undefined;
  }

  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error.trim()) {
      return truncate(obj.error, MAX_ERROR_LEN);
    }
    if (obj.isError === true || obj.ok === false || obj.success === false) {
      const msg =
        (typeof obj.message === "string" && obj.message) ||
        (typeof obj.stderr === "string" && obj.stderr) ||
        (typeof obj.output === "string" && obj.output) ||
        "Tool execution failed";
      return truncate(msg, MAX_ERROR_LEN);
    }
    if (typeof obj.exitCode === "number" && obj.exitCode !== 0) {
      const detail =
        (typeof obj.stderr === "string" && obj.stderr.trim()) ||
        (typeof obj.stdout === "string" && obj.stdout.trim()) ||
        `Exit code ${obj.exitCode}`;
      return truncate(detail, MAX_ERROR_LEN);
    }
  }

  if (isError) {
    return "Action failed";
  }
  return undefined;
}

function countDiffLines(diffText: string): { addedLines: number; removedLines: number } {
  let addedLines = 0;
  let removedLines = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) addedLines++;
    else if (line.startsWith("-") && !line.startsWith("---")) removedLines++;
  }
  return { addedLines, removedLines };
}

/**
 * Extracts file path, +/− line stats, and optional unified diff text from a write trace.
 */
export function extractWriteDiffFromTrace(
  trace: TimelineTraceInput
): TimelineWriteDiff | undefined {
  const kind = classifyToolKind(trace.tool);
  if (kind !== "write") return undefined;

  const filePath = readStringArg(trace.args, ["path", "filePath", "file_path", "target"]);
  if (!filePath) return undefined;

  let diffText: string | undefined;
  let synthesized = false;
  let addedLines: number | undefined;
  let removedLines: number | undefined;

  if (trace.result && typeof trace.result === "object") {
    const obj = trace.result as Record<string, unknown>;
    if (typeof obj.diff === "string" && obj.diff.trim()) {
      diffText = obj.diff;
    } else if (typeof obj.unifiedDiff === "string" && obj.unifiedDiff.trim()) {
      diffText = obj.unifiedDiff;
    }
    if (typeof obj.addedLines === "number" && Number.isFinite(obj.addedLines)) {
      addedLines = obj.addedLines;
    }
    if (typeof obj.removedLines === "number" && Number.isFinite(obj.removedLines)) {
      removedLines = obj.removedLines;
    }
  }

  if (diffText && (addedLines === undefined || removedLines === undefined)) {
    const counted = countDiffLines(diffText);
    addedLines = addedLines ?? counted.addedLines;
    removedLines = removedLines ?? counted.removedLines;
  }

  const hasReplacementArg = Boolean(
    trace.args && typeof trace.args.replacement === "string" && trace.args.replacement.length > 0
  );
  const fullWrittenContent =
    trace.args && typeof trace.args.content === "string" && trace.args.content.length > 0
      ? trace.args.content
      : trace.args && typeof trace.args.newContent === "string" && trace.args.newContent.length > 0
        ? trace.args.newContent
        : undefined;

  if (!diffText && fullWrittenContent && !hasReplacementArg && (removedLines ?? 0) === 0) {
    const lines = fullWrittenContent.split("\n");
    diffText = `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
    synthesized = true;
    addedLines = addedLines ?? lines.length;
    removedLines = removedLines ?? 0;
  }

  if (addedLines === undefined && removedLines === undefined) {
    const content = readStringArg(trace.args, ["content", "newContent", "replacement"]);
    if (content) {
      addedLines = content.split("\n").length;
      removedLines = 0;
    }
  }

  return {
    filePath,
    addedLines: addedLines ?? 0,
    removedLines: removedLines ?? 0,
    ...(diffText ? { diffText } : {}),
    ...(synthesized ? { synthesized: true } : {}),
  };
}

/**
 * Maps a single trace item into a TimelineRow.
 */
export function traceToTimelineRow(
  trace: TimelineTraceInput,
  index: number,
  nowMs?: number
): TimelineRow {
  const kind = classifyToolKind(trace.tool);
  const isRunning = trace.status === "running";
  const errorSummary = isRunning ? undefined : extractTraceError(trace.result, trace.isError);
  const status: TimelineRowStatus = isRunning
    ? "running"
    : errorSummary || trace.status === "error"
      ? "error"
      : "success";

  const verb = verbForKind(kind, trace.tool, isRunning);
  const target = targetForTrace(kind, trace);
  const label = isRunning ? `${verb} ${target}…` : `${verb} ${target}`;

  let durationMs = trace.durationMs;
  if (isRunning && durationMs === undefined && trace.timestamp && nowMs !== undefined) {
    const startMs = Date.parse(trace.timestamp);
    if (Number.isFinite(startMs) && nowMs >= startMs) {
      durationMs = nowMs - startMs;
    }
  }

  const writeDiff = extractWriteDiffFromTrace(trace);

  return {
    id: `trace-${index}`,
    kind,
    status,
    verb,
    target,
    label,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(errorSummary ? { errorSummary } : {}),
    ...(writeDiff ? { writeDiff } : {}),
    rawTraceIndex: index,
  };
}

/**
 * Folds consecutive completed `read`, `search` (2+), or `shell` (3+) rows into
 * a single expandable group row.
 */
export function foldTimelineRows(rows: TimelineRow[]): TimelineRow[] {
  const result: TimelineRow[] = [];
  let i = 0;

  while (i < rows.length) {
    const current = rows[i];
    const foldable =
      current.status === "success" &&
      (current.kind === "read" || current.kind === "search" || current.kind === "shell");

    if (!foldable) {
      result.push(current);
      i++;
      continue;
    }

    let j = i + 1;
    while (j < rows.length && rows[j].status === "success" && rows[j].kind === current.kind) {
      j++;
    }

    const count = j - i;
    const minFold = current.kind === "shell" ? 3 : 2;
    if (count < minFold) {
      for (let k = i; k < j; k++) {
        result.push(rows[k]);
      }
    } else {
      const children = rows.slice(i, j);
      const totalDurationMs = children.reduce((sum, r) => sum + (r.durationMs || 0), 0);
      const verb =
        current.kind === "read" ? "Read" : current.kind === "search" ? "Searched" : "Ran";
      const target =
        current.kind === "read"
          ? `${count} files`
          : current.kind === "search"
            ? `${count} queries`
            : `${count} commands`;
      const label = `${verb} ${target}`;
      result.push({
        id: `group-${current.kind}-${i}-${j - 1}`,
        kind: current.kind,
        status: "success",
        verb,
        target,
        label,
        durationMs: totalDurationMs > 0 ? totalDurationMs : undefined,
        children,
        isGroup: true,
      });
    }
    i = j;
  }

  return result;
}

export interface BuildActivityTimelineOptions {
  thinkingSegments?: ThinkingSegment[];
  isStreaming?: boolean;
}

/**
 * End-to-end pure transform from raw traces (and optional per-round thinking
 * segments) to folded timeline rows.
 */
export function buildActivityTimeline(
  traces: TimelineTraceInput[] | undefined,
  nowMs?: number,
  options?: BuildActivityTimelineOptions
): TimelineRow[] {
  const safeTraces = Array.isArray(traces) ? traces : [];
  const validSegments = Array.isArray(options?.thinkingSegments)
    ? options.thinkingSegments.filter((s) => s && typeof s.text === "string" && s.text.trim())
    : [];

  if (validSegments.length === 0) {
    if (safeTraces.length === 0) return [];
    const rows = safeTraces.map((t, idx) => traceToTimelineRow(t, idx, nowMs));
    return foldTimelineRows(rows);
  }

  const segmentsByRound = new Map<number, ThinkingSegment[]>();
  const roundSet = new Set<number>();
  for (const seg of validSegments) {
    const r = typeof seg.round === "number" && Number.isFinite(seg.round) ? seg.round : 1;
    roundSet.add(r);
    const list = segmentsByRound.get(r) ?? [];
    list.push(seg);
    segmentsByRound.set(r, list);
  }

  const tracesByRound = new Map<number, Array<{ trace: TimelineTraceInput; index: number }>>();
  let fallbackRound = 1;
  for (let idx = 0; idx < safeTraces.length; idx++) {
    const t = safeTraces[idx];
    const r = typeof t.round === "number" && Number.isFinite(t.round) ? t.round : fallbackRound;
    fallbackRound = r;
    roundSet.add(r);
    const list = tracesByRound.get(r) ?? [];
    list.push({ trace: t, index: idx });
    tracesByRound.set(r, list);
  }

  const orderedRounds = Array.from(roundSet).sort((a, b) => a - b);
  const lastRound = orderedRounds[orderedRounds.length - 1];
  const result: TimelineRow[] = [];

  for (const r of orderedRounds) {
    const segs = segmentsByRound.get(r) ?? [];
    const roundTraces = tracesByRound.get(r) ?? [];
    for (let sIdx = 0; sIdx < segs.length; sIdx++) {
      const seg = segs[sIdx];
      const isTailStreaming =
        Boolean(options?.isStreaming) &&
        r === lastRound &&
        sIdx === segs.length - 1 &&
        roundTraces.length === 0;
      result.push({
        id: `thinking-round-${r}-${sIdx}`,
        kind: "thinking",
        status: isTailStreaming ? "running" : "success",
        verb: isTailStreaming ? "Thinking" : "Thought",
        target: "Reasoning",
        label: isTailStreaming ? "Thinking…" : "Thought",
        thinkingText: seg.text,
        round: r,
      });
    }
    if (roundTraces.length > 0) {
      const actionRows = roundTraces.map(({ trace, index }) =>
        traceToTimelineRow(trace, index, nowMs)
      );
      result.push(...foldTimelineRows(actionRows));
    }
  }

  return result;
}
