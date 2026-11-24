/**
 * Pure row model for the activity timeline.
 *
 * Transforms raw tool traces into verb-first timeline rows, folds consecutive
 * completed read/search rows into expandable groups, and extracts inline error
 * summaries and write diff metadata without side effects.
 */

export type TimelineToolKind =
  "read" | "search" | "write" | "shell" | "web" | "subagent" | "thinking" | "narration" | "other";

export type TimelineRowStatus = "running" | "success" | "error";

export interface ThinkingSegment {
  round: number;
  text: string;
}

export interface RoundNarrationSegment {
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
  subline?: string;
  workingDir?: string;
  durationMs?: number;
  errorSummary?: string;
  writeDiff?: TimelineWriteDiff;
  children?: TimelineRow[];
  isGroup?: boolean;
  rawTraceIndex?: number;
  thinkingText?: string;
  narrationText?: string;
  toolName?: string;
  traceArgs?: Record<string, unknown>;
  traceResult?: unknown;
  editCount?: number;
  round?: number;
}

const MAX_TARGET_LEN = 64;
const MAX_ERROR_LEN = 140;
const MAX_TRACE_OUTPUT_CHARS = 65536;

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
    t.includes("replace_in_file") ||
    t.includes("replace_string")
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
  if (
    kind === "write" &&
    (lower.includes("edit") || lower.includes("patch") || lower.includes("replace"))
  ) {
    return isRunning ? "Editing" : "Edited";
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
  /^\s*(?:\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:'[^']*'|"[^"]*"|[^\s;&]+)\s*;\s*|(?:Set-Location|cd)(?:\s+\/d)?\s+(?:'[^']*'|"[^"]*"|[^\s;&]+)\s*(?:;|&&|&)\s*|Write-Host\s+(?:'[^']*'|"[^"]*")\s*;\s*)/i;

const LEADING_DIR_CAPTURE_RE =
  /^\s*(?:Set-Location|cd)(?:\s+\/d)?\s+(?:'([^']*)'|"([^"]*)"|([^\s;&]+))\s*(?:;|&&|&)/i;

/**
 * Elides a single absolute Windows or Unix path to its last two segments
 * (e.g. "C:\repo\components\SettingsView.tsx" -> "...\components\SettingsView.tsx").
 */
export function elidePathToTail(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return trimmed;
  if (/^[A-Za-z]:\\/.test(trimmed)) {
    const parts = trimmed.slice(3).split(/\\+/).filter(Boolean);
    if (parts.length >= 2) {
      return `...\\${parts[parts.length - 2]}\\${parts[parts.length - 1]}`;
    }
    if (parts.length === 1) {
      return `...\\${parts[0]}`;
    }
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    const parts = trimmed.split(/\/+/).filter(Boolean);
    if (parts.length >= 2) {
      return `.../${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
  }
  return trimmed;
}

/**
 * Elides any remaining absolute Windows or deep Unix paths inside a shell command
 * to their last two segments so labels stay readable.
 */
export function elideAbsolutePaths(command: string): string {
  let out = command.replace(/[A-Za-z]:\\[^\s'"]+/g, (match) => elidePathToTail(match));
  out = out.replace(/(?<![A-Za-z0-9:/])\/(?:[^\s/'"]+\/){2,}[^\s/'"]+/g, (match) =>
    elidePathToTail(match)
  );
  return out;
}

function extractWorkingDirFromCommand(
  command: string,
  args?: Record<string, unknown>
): string | undefined {
  const explicit = readStringArg(args, ["cwd", "workdir", "workingDirectory", "dir"]);
  if (explicit) return elidePathToTail(explicit);
  let remaining = command.trim();
  let foundDir: string | undefined;
  while (remaining.length > 0) {
    const dirMatch = remaining.match(LEADING_DIR_CAPTURE_RE);
    if (dirMatch) {
      foundDir = dirMatch[1] || dirMatch[2] || dirMatch[3] || foundDir;
    }
    const next = remaining.replace(LEADING_SHELL_BOILERPLATE_RE, "");
    if (next === remaining) break;
    remaining = next.trim();
  }
  return foundDir ? elidePathToTail(foundDir) : undefined;
}

/**
 * Strips leading PowerShell preamble assignments, $env: assignments,
 * Set-Location / cd chains, and Write-Host echo framing so shell row labels
 * show the operative command. Falls back to the original command if stripping
 * empties it.
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
    return cmd
      ? truncate(elideAbsolutePaths(stripShellBoilerplate(cmd)), MAX_TARGET_LEN)
      : trace.tool.replace(/_/g, " ");
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

function clampTraceOutput(text: string, maxChars = MAX_TRACE_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  const probe = `... [truncated ${text.length} earlier chars]\n`;
  if (probe.length >= maxChars) {
    return text.slice(text.length - maxChars);
  }
  const initialTail = maxChars - probe.length;
  const omitted = text.length - initialTail;
  const prefix = `... [truncated ${omitted} earlier chars]\n`;
  return prefix + text.slice(text.length - (maxChars - prefix.length));
}

function parseJsonObjectText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractObjStreams(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.output === "string" && obj.output.length > 0) {
    if (
      typeof obj.error === "string" &&
      obj.error.trim() &&
      !obj.output.includes(obj.error.trim())
    ) {
      return `${obj.output.replace(/\r?\n$/, "")}\n${obj.error}`;
    }
    return obj.output;
  }

  const parts: string[] = [];
  if (typeof obj.stdout === "string" && obj.stdout.length > 0) parts.push(obj.stdout);
  if (typeof obj.stderr === "string" && obj.stderr.length > 0) parts.push(obj.stderr);
  if (parts.length > 0) {
    return parts.length === 2 && parts[0].endsWith("\n") ? parts[0] + parts[1] : parts.join("\n");
  }

  if (typeof obj.content === "string" && obj.content.length > 0) return obj.content;
  if (typeof obj.error === "string" && obj.error.length > 0) return obj.error;
  if (typeof obj.message === "string" && obj.message.length > 0) return obj.message;
  return undefined;
}

function pickErrorDetail(obj: Record<string, unknown>, fallback: string): string {
  const candidates = [obj.error, obj.message, obj.stderr, obj.output, obj.stdout];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return fallback;
}

/**
 * Extracts a concise single-line error summary from a trace result if it indicates failure.
 * Respects explicit `isError === false` and structured success indicators first, and unwraps
 * MCP `content[0].text` JSON envelopes.
 */
export function extractTraceError(result: unknown, isError?: boolean): string | undefined {
  if (isError === false) return undefined;

  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;

    if (obj.isError === true || obj.ok === false || obj.success === false) {
      return truncate(pickErrorDetail(obj, "Tool execution failed"), MAX_ERROR_LEN);
    }
    if (typeof obj.exitCode === "number" && obj.exitCode !== 0) {
      return truncate(pickErrorDetail(obj, `Exit code ${obj.exitCode}`), MAX_ERROR_LEN);
    }
    if (typeof obj.exit_code === "number" && obj.exit_code !== 0) {
      return truncate(pickErrorDetail(obj, `Exit code ${obj.exit_code}`), MAX_ERROR_LEN);
    }
    if (obj.status === "EXECUTION_ERROR") {
      return truncate(pickErrorDetail(obj, "Tool execution failed"), MAX_ERROR_LEN);
    }

    const explicitSuccess =
      obj.isError === false ||
      obj.success === true ||
      obj.ok === true ||
      obj.exitCode === 0 ||
      obj.exit_code === 0 ||
      obj.status === "SUCCESS";
    if (explicitSuccess) {
      return undefined;
    }

    if (typeof obj.error === "string" && obj.error.trim()) {
      return truncate(obj.error, MAX_ERROR_LEN);
    }

    if (Array.isArray(obj.content)) {
      for (const item of obj.content) {
        if (!item || typeof item !== "object") continue;
        const text = (item as { text?: unknown }).text;
        if (typeof text !== "string") continue;
        const parsed = parseJsonObjectText(text);
        if (parsed) {
          const parsedFailed =
            parsed.isError === true ||
            parsed.ok === false ||
            parsed.success === false ||
            parsed.status === "EXECUTION_ERROR" ||
            (typeof parsed.exit_code === "number" && parsed.exit_code !== 0) ||
            (typeof parsed.exitCode === "number" && parsed.exitCode !== 0);
          if (parsedFailed) {
            const code =
              typeof parsed.exit_code === "number"
                ? parsed.exit_code
                : typeof parsed.exitCode === "number"
                  ? parsed.exitCode
                  : undefined;
            const fallback = code !== undefined ? `Exit code ${code}` : "Tool execution failed";
            return truncate(pickErrorDetail(parsed, fallback), MAX_ERROR_LEN);
          }
          const parsedSuccess =
            parsed.isError === false ||
            parsed.success === true ||
            parsed.ok === true ||
            parsed.exit_code === 0 ||
            parsed.exitCode === 0 ||
            parsed.status === "SUCCESS";
          if (!parsedSuccess && typeof parsed.error === "string" && parsed.error.trim()) {
            return truncate(parsed.error, MAX_ERROR_LEN);
          }
          if (parsedSuccess && !isError) {
            return undefined;
          }
        }
        if (isError === true && text.trim()) {
          return truncate(text, MAX_ERROR_LEN);
        }
      }
    }

    if (isError === true) {
      return "Action failed";
    }
    return undefined;
  }

  if (typeof result === "string") {
    if (isError === true) {
      return truncate(result, MAX_ERROR_LEN) || "Action failed";
    }
    if (
      isError === undefined &&
      /^(error|failed|enoent|eacces|exit code [1-9])/i.test(result.trim())
    ) {
      return truncate(result, MAX_ERROR_LEN);
    }
    return undefined;
  }

  if (isError === true) {
    return "Action failed";
  }
  return undefined;
}

/**
 * Extracts full multi-line tool output (`output`, `stderr`, `stdout`, or MCP `content[].text`)
 * up to 64 KB with tail preservation, separate from the concise 1-line error summary.
 */
export function extractTraceOutput(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") {
    return result.length > 0 ? clampTraceOutput(result) : undefined;
  }
  if (typeof result !== "object") return undefined;

  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.content)) {
    const chunks: string[] = [];
    for (const item of obj.content) {
      if (!item || typeof item !== "object") continue;
      const text = (item as { text?: unknown }).text;
      if (typeof text !== "string" || text.length === 0) continue;
      const parsed = parseJsonObjectText(text);
      if (parsed) {
        const inner = extractObjStreams(parsed);
        if (inner && inner.length > 0) {
          chunks.push(inner);
          continue;
        }
      }
      chunks.push(text);
    }
    if (chunks.length > 0) {
      return clampTraceOutput(chunks.join("\n"));
    }
  }

  const direct = extractObjStreams(obj);
  return direct && direct.length > 0 ? clampTraceOutput(direct) : undefined;
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

function normalizeTimelinePath(rawPath: string): string {
  const slashes = rawPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (/^[A-Za-z]:\//.test(slashes)) {
    return slashes[0].toLowerCase() + slashes.slice(1);
  }
  return slashes;
}

function buildReplacementUnifiedDiff(
  oldText: string,
  newText: string
): { diffText: string; addedLines: number; removedLines: number } {
  const oldNorm = oldText.replace(/\r\n/g, "\n");
  const newNorm = newText.replace(/\r\n/g, "\n");
  const oldLines = oldNorm.length > 0 ? oldNorm.split("\n") : [];
  const newLines = newNorm.length > 0 ? newNorm.split("\n") : [];

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= prefix && newEnd >= prefix && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const removed = oldLines.slice(prefix, oldEnd + 1);
  const added = newLines.slice(prefix, newEnd + 1);
  const hunkLines: string[] = [
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.slice(0, prefix).map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...oldLines.slice(oldEnd + 1).map((l) => ` ${l}`),
  ];

  return {
    diffText: hunkLines.join("\n"),
    addedLines: added.length,
    removedLines: removed.length,
  };
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

  // Support host_replace_string (oldString/newString) and patch-style pairs when both old and new strings are provided
  if (!diffText && trace.args) {
    const oldText =
      typeof trace.args.oldString === "string"
        ? trace.args.oldString
        : typeof trace.args.search === "string"
          ? trace.args.search
          : typeof trace.args.oldText === "string"
            ? trace.args.oldText
            : typeof trace.args.target === "string"
              ? trace.args.target
              : undefined;
    const newText =
      typeof trace.args.newString === "string"
        ? trace.args.newString
        : typeof trace.args.replace === "string"
          ? trace.args.replace
          : typeof trace.args.newText === "string"
            ? trace.args.newText
            : typeof trace.args.replacement === "string"
              ? trace.args.replacement
              : undefined;

    if (
      oldText !== undefined &&
      newText !== undefined &&
      (oldText.length > 0 || newText.length > 0)
    ) {
      const built = buildReplacementUnifiedDiff(oldText, newText);
      diffText = built.diffText;
      addedLines = addedLines ?? built.addedLines;
      removedLines = removedLines ?? built.removedLines;
    }
  }

  const hasReplacementArg = Boolean(
    trace.args &&
    ((typeof trace.args.replacement === "string" && trace.args.replacement.length > 0) ||
      typeof trace.args.oldString === "string" ||
      typeof trace.args.newString === "string")
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
    const content = readStringArg(trace.args, [
      "content",
      "newContent",
      "replacement",
      "newString",
    ]);
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
 * Coalesces repeated TimelineWriteDiff entries for the same normalized file path
 * into one entry with summed +/- and merged/latest diff text.
 */
export function coalesceTimelineWriteDiffs(diffs: TimelineWriteDiff[]): TimelineWriteDiff[] {
  if (!Array.isArray(diffs) || diffs.length === 0) return [];
  const byPath = new Map<string, TimelineWriteDiff>();
  for (const diff of diffs) {
    if (!diff || !diff.filePath) continue;
    const key = normalizeTimelinePath(diff.filePath);
    const existing = byPath.get(key);
    if (!existing) {
      byPath.set(key, { ...diff });
      continue;
    }
    const mergedDiffText =
      existing.diffText && diff.diffText && existing.diffText !== diff.diffText
        ? !existing.synthesized && !diff.synthesized
          ? `${existing.diffText}\n${diff.diffText}`
          : diff.diffText
        : diff.diffText || existing.diffText;
    byPath.set(key, {
      filePath: diff.filePath,
      addedLines: (existing.addedLines || 0) + (diff.addedLines || 0),
      removedLines: (existing.removedLines || 0) + (diff.removedLines || 0),
      ...(mergedDiffText ? { diffText: mergedDiffText } : {}),
      ...(existing.synthesized && diff.synthesized ? { synthesized: true } : {}),
    });
  }
  return Array.from(byPath.values());
}

function traceSignature(trace: TimelineTraceInput): string {
  let argsKey = "";
  if (trace.args) {
    try {
      argsKey = JSON.stringify(trace.args);
    } catch {
      argsKey = "";
    }
  }
  return `${trace.tool || ""}|${trace.timestamp || ""}|${argsKey}`;
}

/**
 * Merges settled message traces with live preview traces without duplicating any
 * tool call that appears in both.
 */
export function mergeLiveAndSettledTraces<T extends TimelineTraceInput>(
  settledTraces?: T[],
  liveTraces?: T[]
): T[] {
  const settled = Array.isArray(settledTraces) ? settledTraces : [];
  const live = Array.isArray(liveTraces) ? liveTraces : [];
  if (live.length === 0) return settled;
  if (settled.length === 0) return live;

  const seenCounts = new Map<string, number>();
  for (const t of settled) {
    const sig = traceSignature(t);
    seenCounts.set(sig, (seenCounts.get(sig) ?? 0) + 1);
  }

  const extra: T[] = [];
  const liveSeen = new Map<string, number>();
  for (const t of live) {
    const sig = traceSignature(t);
    const seenInLive = (liveSeen.get(sig) ?? 0) + 1;
    liveSeen.set(sig, seenInLive);
    const settledCount = seenCounts.get(sig) ?? 0;
    if (seenInLive > settledCount) {
      extra.push(t);
    }
  }

  return extra.length > 0 ? [...settled, ...extra] : settled;
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
  const workingDir =
    kind === "shell"
      ? extractWorkingDirFromCommand(
          readStringArg(trace.args, ["command", "cmd", "script"]),
          trace.args
        )
      : undefined;

  return {
    id: `trace-${index}`,
    kind,
    status,
    verb,
    target,
    label,
    ...(workingDir ? { workingDir } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(errorSummary ? { errorSummary } : {}),
    ...(writeDiff ? { writeDiff } : {}),
    rawTraceIndex: index,
    toolName: trace.tool,
    ...(trace.args ? { traceArgs: trace.args } : {}),
    ...(trace.result !== undefined ? { traceResult: trace.result } : {}),
    ...(typeof trace.round === "number" ? { round: trace.round } : {}),
  };
}

function formatGroupDuration(durationMs: number): string | undefined {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function deriveGroupSubline(
  kind: TimelineToolKind,
  status: TimelineRowStatus,
  children: TimelineRow[],
  totalDurationMs: number
): string | undefined {
  const durationLabel = formatGroupDuration(totalDurationMs);
  if (status === "error") {
    return durationLabel;
  }
  if (kind === "read" || kind === "search") {
    const names = children.slice(0, 2).map((c) => c.target);
    const base = names.join(", ");
    if (children.length > 2) {
      return `${base} +${children.length - 2} more`;
    }
    return base || undefined;
  }
  if (kind === "shell") {
    const dirs = Array.from(
      new Set(children.map((c) => c.workingDir).filter((d): d is string => Boolean(d)))
    );
    const sharedDir = dirs.length === 1 ? dirs[0] : undefined;
    const parts = [sharedDir, durationLabel].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }
  return durationLabel;
}

/**
 * Folds consecutive completed `read` (2+), `search` (2+), or `shell` (3+) rows,
 * as well as consecutive failed `shell` (3+) rows, into expandable group cards.
 */
export function foldTimelineRows(rows: TimelineRow[]): TimelineRow[] {
  const result: TimelineRow[] = [];
  let i = 0;

  while (i < rows.length) {
    const current = rows[i];
    const foldableSuccess =
      current.status === "success" &&
      (current.kind === "read" || current.kind === "search" || current.kind === "shell");
    const foldableShellError = current.status === "error" && current.kind === "shell";

    if (!foldableSuccess && !foldableShellError) {
      result.push(current);
      i++;
      continue;
    }

    let j = i + 1;
    while (j < rows.length && rows[j].status === current.status && rows[j].kind === current.kind) {
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
      const subline = deriveGroupSubline(current.kind, current.status, children, totalDurationMs);

      if (foldableShellError) {
        result.push({
          id: `group-shell-error-${i}-${j - 1}`,
          kind: "shell",
          status: "error",
          verb: "Failed",
          target: `${count} commands`,
          label: `${count} commands failed`,
          ...(subline ? { subline } : {}),
          durationMs: totalDurationMs > 0 ? totalDurationMs : undefined,
          children,
          isGroup: true,
        });
      } else {
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
          ...(subline ? { subline } : {}),
          durationMs: totalDurationMs > 0 ? totalDurationMs : undefined,
          children,
          isGroup: true,
        });
      }
    }
    i = j;
  }

  return result;
}

export interface BuildActivityTimelineOptions {
  thinkingSegments?: ThinkingSegment[];
  roundNarrations?: RoundNarrationSegment[];
  isStreaming?: boolean;
  roundGenerationMs?: number[];
}

/**
 * Coalesces repeated file write rows across a turn into ONE row per normalized
 * file path, summing +/- line counts and keeping the latest edit state.
 */
function coalesceWriteTimelineRows(rows: TimelineRow[]): TimelineRow[] {
  const writeIndexByPath = new Map<string, number>();
  const out: TimelineRow[] = [];

  for (const row of rows) {
    if (row.kind !== "write" || !row.writeDiff?.filePath) {
      out.push(row);
      continue;
    }
    const key = normalizeTimelinePath(row.writeDiff.filePath);
    const existingIdx = writeIndexByPath.get(key);
    if (existingIdx === undefined) {
      writeIndexByPath.set(key, out.length);
      out.push({ ...row, editCount: 1 });
      continue;
    }
    const existing = out[existingIdx];
    const [mergedDiff] = coalesceTimelineWriteDiffs([existing.writeDiff!, row.writeDiff]);
    const combinedDuration =
      (existing.durationMs ?? 0) + (row.durationMs ?? 0) > 0
        ? (existing.durationMs ?? 0) + (row.durationMs ?? 0)
        : undefined;
    out[existingIdx] = {
      ...existing,
      ...row,
      id: existing.id,
      durationMs: combinedDuration,
      writeDiff: mergedDiff,
      editCount: (existing.editCount ?? 1) + 1,
    };
  }

  return out;
}

/**
 * End-to-end pure transform from raw traces (and optional per-round thinking
 * segments and round narration commentary) to folded, write-coalesced timeline rows.
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
  const validNarrations = Array.isArray(options?.roundNarrations)
    ? options.roundNarrations.filter((n) => n && typeof n.text === "string" && n.text.trim())
    : [];

  if (validSegments.length === 0 && validNarrations.length === 0) {
    if (safeTraces.length === 0) return [];
    const rows = safeTraces.map((t, idx) => traceToTimelineRow(t, idx, nowMs));
    return coalesceWriteTimelineRows(foldTimelineRows(rows));
  }

  const segmentsByRound = new Map<number, ThinkingSegment[]>();
  const narrationsByRound = new Map<number, RoundNarrationSegment[]>();
  const roundSet = new Set<number>();
  for (const seg of validSegments) {
    const r = typeof seg.round === "number" && Number.isFinite(seg.round) ? seg.round : 1;
    roundSet.add(r);
    const list = segmentsByRound.get(r) ?? [];
    list.push(seg);
    segmentsByRound.set(r, list);
  }
  for (const nar of validNarrations) {
    const r = typeof nar.round === "number" && Number.isFinite(nar.round) ? nar.round : 1;
    roundSet.add(r);
    const list = narrationsByRound.get(r) ?? [];
    list.push(nar);
    narrationsByRound.set(r, list);
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

  const roundGenMs = Array.isArray(options?.roundGenerationMs) ? options.roundGenerationMs : [];

  for (const r of orderedRounds) {
    const segs = segmentsByRound.get(r) ?? [];
    const nars = narrationsByRound.get(r) ?? [];
    const roundTraces = tracesByRound.get(r) ?? [];
    const recordedGenMs =
      r >= 1 &&
      r - 1 < roundGenMs.length &&
      typeof roundGenMs[r - 1] === "number" &&
      Number.isFinite(roundGenMs[r - 1]) &&
      roundGenMs[r - 1] > 0
        ? roundGenMs[r - 1]
        : undefined;
    for (let sIdx = 0; sIdx < segs.length; sIdx++) {
      const seg = segs[sIdx];
      const isTailStreaming =
        Boolean(options?.isStreaming) &&
        r === lastRound &&
        sIdx === segs.length - 1 &&
        roundTraces.length === 0 &&
        nars.length === 0;
      const segDurationMs = sIdx === 0 ? recordedGenMs : undefined;
      const prevRow = result.length > 0 ? result[result.length - 1] : null;
      if (prevRow && prevRow.kind === "thinking") {
        prevRow.thinkingText = prevRow.thinkingText
          ? `${prevRow.thinkingText}\n\n${seg.text}`
          : seg.text;
        if (segDurationMs !== undefined) {
          prevRow.durationMs = (prevRow.durationMs ?? 0) + segDurationMs;
        }
        if (isTailStreaming) {
          prevRow.status = "running";
          prevRow.verb = "Thinking";
          prevRow.label = "Thinking…";
        }
      } else {
        result.push({
          id: `thinking-round-${r}-${sIdx}`,
          kind: "thinking",
          status: isTailStreaming ? "running" : "success",
          verb: isTailStreaming ? "Thinking" : "Thought",
          target: "Reasoning",
          label: isTailStreaming ? "Thinking…" : "Thought",
          ...(segDurationMs !== undefined ? { durationMs: segDurationMs } : {}),
          thinkingText: seg.text,
          round: r,
        });
      }
    }
    if (nars.length > 0) {
      const combinedNarration = nars
        .map((n) => n.text.trim())
        .filter(Boolean)
        .join("\n\n");
      if (combinedNarration) {
        result.push({
          id: `narration-round-${r}`,
          kind: "narration",
          status: "success",
          verb: "Note",
          target: `Round ${r}`,
          label: `Round ${r}`,
          narrationText: combinedNarration,
          round: r,
        });
      }
    }
    if (roundTraces.length > 0) {
      const actionRows = roundTraces.map(({ trace, index }) =>
        traceToTimelineRow(trace, index, nowMs)
      );
      result.push(...foldTimelineRows(actionRows));
    }
  }

  return coalesceWriteTimelineRows(result);
}
