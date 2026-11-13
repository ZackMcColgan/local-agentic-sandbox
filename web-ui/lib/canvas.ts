// uir-2 Canvas — pure logic for the artifact canvas.
//
// The canvas is an additive surface beside the chat: artifact cards and diff
// cards open it, the existing inline rendering stays as the fallback. This
// module holds everything testable without a DOM — artifact identity and
// content versions, unified-diff splitting, full-diff row building with
// old/new line numbers (never truncated), the feature-flag read, and the
// scroll capture/restore the mobile sheet uses to return to the exact chat
// scroll position.

export interface CanvasDiffFile {
  path: string;
  diff: string;
  addedLines: number;
  removedLines: number;
}

export type CanvasArtifact =
  | {
      kind: "file";
      id: string;
      filename: string;
      language?: string;
      code: string;
      /** When set and code is empty, the preview loads this URL in the sandboxed iframe. */
      sourceUrl?: string;
    }
  | {
      kind: "diff";
      id: string;
      title: string;
      files: CanvasDiffFile[];
    };

export type CanvasView = "preview" | "code" | "diff";

/**
 * Feature flag (kill switch). The canvas ships enabled; setting this
 * localStorage key to "0" / "false" / "off" removes every canvas affordance
 * and restores the exact pre-canvas inline rendering.
 */
export const CANVAS_FLAG_KEY = "las.canvas.enabled";

export function isCanvasEnabled(
  storage?: { getItem: (key: string) => string | null } | null
): boolean {
  try {
    const store =
      storage ??
      (typeof window !== "undefined" ? window.localStorage : null);
    if (!store) return true;
    const raw = store.getItem(CANVAS_FLAG_KEY);
    if (raw === null || raw === undefined) return true;
    const v = String(raw).trim().toLowerCase();
    return !(v === "0" || v === "false" || v === "off");
  } catch {
    return true;
  }
}

/** FNV-1a content hash — stable identity for "did this artifact change?" checks. */
export function artifactVersion(artifact: CanvasArtifact): string {
  const content =
    artifact.kind === "file"
      ? artifact.code
      : artifact.files.map((f) => `${f.path}\n${f.diff}`).join("\n");
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The "Updated · file changed" badge rule: show it only for an artifact the
 * user has already seen, whose content changed while the canvas was closed.
 */
export function hasUnseenUpdate(
  seenVersion: string | undefined,
  currentVersion: string,
  isCanvasOpen: boolean
): boolean {
  if (isCanvasOpen) return false;
  if (seenVersion === undefined) return false;
  return seenVersion !== currentVersion;
}

export function countDiffLines(diff: string): {
  addedLines: number;
  removedLines: number;
} {
  let addedLines = 0;
  let removedLines = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) addedLines++;
    else if (line.startsWith("-") && !line.startsWith("---")) removedLines++;
  }
  return { addedLines, removedLines };
}

function pathFromSection(sectionLines: string[]): string | null {
  for (const line of sectionLines) {
    if (line.startsWith("+++ b/")) return line.slice("+++ b/".length).trim();
    if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      return line.slice("+++ ".length).trim();
    }
  }
  const header = sectionLines[0];
  if (header?.startsWith("diff --git ")) {
    const parts = header.split(" ");
    const bPath = parts[parts.length - 1];
    if (bPath?.startsWith("b/")) return bPath.slice(2);
  }
  return null;
}

/**
 * Split a combined unified diff into per-file sections. A diff without
 * `diff --git` headers becomes a single file under the fallback path.
 * The text of each section is preserved verbatim — nothing is truncated.
 */
export function splitUnifiedDiff(
  diff: string,
  fallbackPath?: string
): CanvasDiffFile[] {
  if (!diff || !diff.trim()) return [];
  const lines = diff.split("\n");
  const starts: number[] = [];
  lines.forEach((line, idx) => {
    if (line.startsWith("diff --git ")) starts.push(idx);
  });

  if (starts.length === 0) {
    const { addedLines, removedLines } = countDiffLines(diff);
    return [
      {
        path: fallbackPath || "changes",
        diff,
        addedLines,
        removedLines,
      },
    ];
  }

  const files: CanvasDiffFile[] = [];
  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const sectionLines = lines.slice(begin, end);
    // Drop trailing blank lines that belong to the join, not the diff.
    while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1] === "") {
      sectionLines.pop();
    }
    const section = sectionLines.join("\n");
    const { addedLines, removedLines } = countDiffLines(section);
    files.push({
      path: pathFromSection(sectionLines) || fallbackPath || "changes",
      diff: section,
      addedLines,
      removedLines,
    });
  }
  return files;
}

export function diffTotals(files: CanvasDiffFile[]): {
  fileCount: number;
  addedLines: number;
  removedLines: number;
} {
  return {
    fileCount: files.length,
    addedLines: files.reduce((sum, f) => sum + f.addedLines, 0),
    removedLines: files.reduce((sum, f) => sum + f.removedLines, 0),
  };
}

export interface DiffRow {
  kind: "meta" | "hunk" | "context" | "add" | "del";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Build render rows for a FULL unified diff, tracking old/new line numbers
 * from the hunk headers. Every input line yields exactly one row — the
 * canvas never caps or truncates (the capped summary stays in trace cards).
 */
export function buildDiffRows(diff: string): DiffRow[] {
  if (!diff) return [];
  const lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const rows: DiffRow[] = [];
  let oldNo: number | null = null;
  let newNo: number | null = null;

  for (const line of lines) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldNo = parseInt(hunk[1], 10);
      newNo = parseInt(hunk[2], 10);
      rows.push({ kind: "hunk", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("rename ") ||
      line.startsWith("similarity ") ||
      line.startsWith("\\")
    ) {
      rows.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({
        kind: "add",
        text: line.slice(1),
        oldLine: null,
        newLine: newNo,
      });
      if (newNo !== null) newNo++;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({
        kind: "del",
        text: line.slice(1),
        oldLine: oldNo,
        newLine: null,
      });
      if (oldNo !== null) oldNo++;
      continue;
    }
    rows.push({
      kind: "context",
      text: line.startsWith(" ") ? line.slice(1) : line,
      oldLine: oldNo,
      newLine: newNo,
    });
    if (oldNo !== null) oldNo++;
    if (newNo !== null) newNo++;
  }
  return rows;
}

/**
 * Document identity for the preview — mirrors the inline renderer's
 * classification (an HTML page stays a page; SVG stays a graphic) so the
 * canvas preview never reclassifies what the chat already renders.
 */
export function isPreviewable(
  filename?: string,
  language?: string,
  code?: string
): boolean {
  const name = (filename || "").toLowerCase();
  const lang = (language || "").toLowerCase();
  if (name.endsWith(".html") || name.endsWith(".htm")) return true;
  if (name.endsWith(".svg")) return true;
  if (lang === "html" || lang === "svg") return true;
  const head = (code || "").trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return true;
  if (head.startsWith("<svg")) return true;
  return false;
}

export function availableViews(artifact: CanvasArtifact): CanvasView[] {
  if (artifact.kind === "diff") return ["diff"];
  return isPreviewable(artifact.filename, artifact.language, artifact.code)
    ? ["preview", "code"]
    : ["code"];
}

export interface ScrollLike {
  scrollTop: number;
}

export function captureScrollPosition(el: ScrollLike | null | undefined): number {
  if (!el) return 0;
  return typeof el.scrollTop === "number" ? el.scrollTop : 0;
}

export function restoreScrollPosition(
  el: ScrollLike | null | undefined,
  position: number
): void {
  if (!el) return;
  el.scrollTop = position;
}
