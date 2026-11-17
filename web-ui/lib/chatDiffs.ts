import fs from "fs";
import path from "path";

export interface TurnFileDiff {
  path: string;
  diff: string;
  addedLines: number;
  removedLines: number;
  truncated?: boolean;
  totalDiffLines?: number;
  omittedLines?: number;
}

export const MAX_DIFF_LINES_CAP = 120;

/**
 * Resolves rawPath safely inside workspaceRoot (checking process.env.WORKSPACE_DIR,
 * /workspace, or path.resolve(process.cwd(), "../workspace")).
 * Returns null if traversal (..) or escape outside workspace root is attempted.
 */
export function resolveWorkspaceFilePath(
  rawPath: string,
  workspaceRoot?: string
): { absPath: string; relPath: string } | null {
  if (!rawPath || typeof rawPath !== "string") return null;
  const normalized = rawPath.replace(/\\/g, "/").trim();
  if (!normalized || normalized.includes("..")) return null;

  const root =
    workspaceRoot ||
    process.env.WORKSPACE_DIR ||
    (fs.existsSync("/workspace") ? "/workspace" : path.resolve(process.cwd(), "../workspace"));

  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(resolvedRoot, normalized);

  const rel = path.relative(resolvedRoot, resolvedTarget).replace(/\\/g, "/");
  if (rel.startsWith("..") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    return null;
  }
  return {
    absPath: resolvedTarget,
    relPath: rel
  };
}

/**
 * Captures workspace file pre-image before a tool write or patch lands.
 * Only existing files are captured. Brand-new files are deliberately NOT captured.
 */
export function captureWorkspacePreImage(
  preImages: Map<string, string>,
  rawPath: string,
  workspaceRoot?: string
): void {
  const resolved = resolveWorkspaceFilePath(rawPath, workspaceRoot);
  if (!resolved) return;
  const { absPath, relPath } = resolved;
  if (!preImages.has(relPath) && fs.existsSync(absPath)) {
    try {
      const stat = fs.statSync(absPath);
      if (stat.isFile()) {
        const content = fs.readFileSync(absPath, "utf8");
        preImages.set(relPath, content);
      }
    } catch {}
  }
}

interface Edit {
  type: "keep" | "add" | "delete";
  line: string;
}

function computeEdits(bLines: string[], aLines: string[]): Edit[] {
  const n = bLines.length;
  const m = aLines.length;
  if (n === 0 && m === 0) return [];

  // Prefix matching
  let start = 0;
  while (start < n && start < m && bLines[start] === aLines[start]) {
    start++;
  }

  // Suffix matching
  let bEnd = n - 1;
  let aEnd = m - 1;
  while (bEnd >= start && aEnd >= start && bLines[bEnd] === aLines[aEnd]) {
    bEnd--;
    aEnd--;
  }

  const prefixEdits: Edit[] = bLines.slice(0, start).map((line) => ({ type: "keep", line }));
  const suffixEdits: Edit[] = bLines.slice(bEnd + 1).map((line) => ({ type: "keep", line }));

  const midB = bLines.slice(start, bEnd + 1);
  const midA = aLines.slice(start, aEnd + 1);

  if (midB.length === 0) {
    const midEdits: Edit[] = midA.map((line) => ({ type: "add", line }));
    return [...prefixEdits, ...midEdits, ...suffixEdits];
  }
  if (midA.length === 0) {
    const midEdits: Edit[] = midB.map((line) => ({ type: "delete", line }));
    return [...prefixEdits, ...midEdits, ...suffixEdits];
  }

  const N = midB.length;
  const M = midA.length;

  if (N * M > 2000000) {
    const delEdits: Edit[] = midB.map((line) => ({ type: "delete", line }));
    const addEdits: Edit[] = midA.map((line) => ({ type: "add", line }));
    return [...prefixEdits, ...delEdits, ...addEdits, ...suffixEdits];
  }

  const dp: Int32Array[] = Array.from({ length: N + 1 }, () => new Int32Array(M + 1));
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      if (midB[i - 1] === midA[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const midEditsRev: Edit[] = [];
  let i = N;
  let j = M;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && midB[i - 1] === midA[j - 1]) {
      midEditsRev.push({ type: "keep", line: midB[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      midEditsRev.push({ type: "add", line: midA[j - 1] });
      j--;
    } else if (i > 0) {
      midEditsRev.push({ type: "delete", line: midB[i - 1] });
      i--;
    }
  }
  midEditsRev.reverse();
  return [...prefixEdits, ...midEditsRev, ...suffixEdits];
}

/**
 * Computes unified diff for a modified workspace file against its pre-image.
 * Returns null if beforeContent === afterContent.
 */
export function computeUnifiedFileDiff(
  relPath: string,
  beforeContent: string,
  afterContent: string,
  maxLines = MAX_DIFF_LINES_CAP
): TurnFileDiff | null {
  const normBefore = beforeContent.replace(/\r\n/g, "\n");
  const normAfter = afterContent.replace(/\r\n/g, "\n");

  if (normBefore === normAfter) {
    return null;
  }

  const bLines = normBefore.length > 0 ? normBefore.split("\n") : [];
  const aLines = normAfter.length > 0 ? normAfter.split("\n") : [];

  const edits = computeEdits(bLines, aLines);

  let addedLines = 0;
  let removedLines = 0;
  for (const edit of edits) {
    if (edit.type === "add") addedLines++;
    else if (edit.type === "delete") removedLines++;
  }

  if (addedLines === 0 && removedLines === 0) {
    return null;
  }

  const CONTEXT = 3;
  const changeIndices: number[] = [];
  for (let idx = 0; idx < edits.length; idx++) {
    if (edits[idx].type !== "keep") {
      changeIndices.push(idx);
    }
  }

  const hunkRanges: Array<[number, number]> = [];
  let currentHunk: [number, number] | null = null;

  for (const idx of changeIndices) {
    const rangeStart = Math.max(0, idx - CONTEXT);
    const rangeEnd = Math.min(edits.length - 1, idx + CONTEXT);

    if (!currentHunk) {
      currentHunk = [rangeStart, rangeEnd];
    } else if (rangeStart <= currentHunk[1] + 1) {
      currentHunk[1] = Math.max(currentHunk[1], rangeEnd);
    } else {
      hunkRanges.push(currentHunk);
      currentHunk = [rangeStart, rangeEnd];
    }
  }
  if (currentHunk) {
    hunkRanges.push(currentHunk);
  }

  const beforeLineAtEdit: number[] = new Array(edits.length);
  const afterLineAtEdit: number[] = new Array(edits.length);
  let bCounter = 1;
  let aCounter = 1;
  for (let idx = 0; idx < edits.length; idx++) {
    beforeLineAtEdit[idx] = bCounter;
    afterLineAtEdit[idx] = aCounter;
    if (edits[idx].type === "delete" || edits[idx].type === "keep") bCounter++;
    if (edits[idx].type === "add" || edits[idx].type === "keep") aCounter++;
  }

  const cleanPath = relPath.replace(/\\/g, "/");
  const diffLines: string[] = [
    `--- a/${cleanPath}`,
    `+++ b/${cleanPath}`
  ];

  for (const [startIdx, endIdx] of hunkRanges) {
    let beforeCount = 0;
    let afterCount = 0;
    for (let idx = startIdx; idx <= endIdx; idx++) {
      if (edits[idx].type === "delete" || edits[idx].type === "keep") beforeCount++;
      if (edits[idx].type === "add" || edits[idx].type === "keep") afterCount++;
    }

    const beforeStart = beforeLineAtEdit[startIdx];
    const afterStart = afterLineAtEdit[startIdx];

    diffLines.push(`@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`);
    for (let idx = startIdx; idx <= endIdx; idx++) {
      const edit = edits[idx];
      if (edit.type === "keep") {
        diffLines.push(` ${edit.line}`);
      } else if (edit.type === "delete") {
        diffLines.push(`-${edit.line}`);
      } else if (edit.type === "add") {
        diffLines.push(`+${edit.line}`);
      }
    }
  }

  const totalDiffLines = diffLines.length;
  if (totalDiffLines > maxLines) {
    const omittedLines = totalDiffLines - maxLines;
    const truncatedLines = diffLines.slice(0, maxLines);
    truncatedLines.push(`# ... truncated (${omittedLines} of ${totalDiffLines} diff lines omitted)`);
    return {
      path: cleanPath,
      diff: truncatedLines.join("\n"),
      addedLines,
      removedLines,
      truncated: true,
      totalDiffLines,
      omittedLines
    };
  }

  return {
    path: cleanPath,
    diff: diffLines.join("\n"),
    addedLines,
    removedLines
  };
}

/**
 * Collects modified file diffs for a turn by reading post-turn content and
 * diffing against the pre-images. Brand-new files are not in preImages and therefore skipped.
 */
export function collectTurnModifiedFileDiffs(
  preImages: Map<string, string>,
  workspaceRoot?: string,
  maxLines = MAX_DIFF_LINES_CAP
): TurnFileDiff[] {
  if (!preImages || preImages.size === 0) return [];
  const diffs: TurnFileDiff[] = [];

  for (const [relPath, beforeContent] of preImages.entries()) {
    const resolved = resolveWorkspaceFilePath(relPath, workspaceRoot);
    if (!resolved) continue;
    const { absPath } = resolved;
    if (!fs.existsSync(absPath)) continue;
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) continue;
      const afterContent = fs.readFileSync(absPath, "utf8");
      if (afterContent === beforeContent) continue;
      const fileDiff = computeUnifiedFileDiff(relPath, beforeContent, afterContent, maxLines);
      if (fileDiff) {
        diffs.push(fileDiff);
      }
    } catch {}
  }

  return diffs;
}
