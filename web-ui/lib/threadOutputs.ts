import fs from "fs";
import path from "path";
import { resolveThreadsDir } from "./threads/threadStore";

export interface TurnAttachment {
  name: string;
  type: string;
  size: number;
  previewUrl: string;
}

export function inferAttachmentMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html";
    case ".svg":
      return "image/svg+xml";
    case ".drawio":
    case ".xml":
      return "application/xml";
    case ".md":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".py":
      return "text/x-python";
    case ".js":
    case ".ts":
    case ".tsx":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "application/javascript";
    case ".css":
      return "text/css";
    case ".yaml":
    case ".yml":
      return "text/yaml";
    default:
      return "application/octet-stream";
  }
}

export function getThreadOutputsWorkspaceRelPath(
  threadId: string | null | undefined,
  threadsDir: string = resolveThreadsDir(),
  workspaceRoot: string = process.env.WORKSPACE_DIR || "/workspace"
): string {
  if (!threadId || !threadId.trim()) {
    return ".agent/threads/<threadId>/files";
  }
  const cleanThreadId = threadId.trim();
  const threadFilesTarget = path.join(threadsDir, cleanThreadId, "files");
  const rel = path.relative(workspaceRoot, threadFilesTarget).replace(/\\/g, "/");
  if (!rel.startsWith("..") && !path.isAbsolute(rel) && !/^[a-zA-Z]:/.test(rel)) {
    return rel;
  }
  return `.agent/threads/${cleanThreadId}/files`;
}

export function buildFileDeliverablesDirective(
  threadId: string | null | undefined,
  threadsDir?: string,
  workspaceRoot?: string
): string {
  const targetDir = getThreadOutputsWorkspaceRelPath(threadId, threadsDir, workspaceRoot);
  return `- FILE GENERATION & DOWNLOADABLE DELIVERABLES:
  - When the user asks to generate, create, export, or download a file (single-file HTML app, game, markdown report, Python script, data file, diagram), write the complete file into '${targetDir}/<filename>' using 'workspace_write_file'.
  - After saving the file, provide a concise chat reply (1-2 sentences summarizing what was built and confirming it is ready to run or download).
  - Do NOT paste the complete code or file content into chat when the user asked for a downloadable game or file.`;
}

export function resolveTurnOutputPath(
  writtenPath: string,
  threadId: string | null | undefined,
  threadsDir: string = resolveThreadsDir(),
  workspaceRoot: string = process.env.WORKSPACE_DIR || "/workspace"
): string | null {
  if (!threadId || !threadId.trim() || !writtenPath || typeof writtenPath !== "string") {
    return null;
  }
  const cleanThreadId = threadId.trim();
  const normalized = writtenPath.replace(/\\/g, "/").trim();
  if (!normalized || normalized.includes("..")) {
    return null;
  }

  const threadOutputsDir = path.resolve(threadsDir, cleanThreadId, "files");

  // 1. Direct prefix checks on relative path
  const prefix1 = `.agent/threads/${cleanThreadId}/files/`;
  if (normalized.startsWith(prefix1)) {
    const sub = normalized.slice(prefix1.length).replace(/^[\/\\]+/, "");
    return sub || null;
  }
  const prefix2 = `${cleanThreadId}/files/`;
  if (normalized.startsWith(prefix2)) {
    const sub = normalized.slice(prefix2.length).replace(/^[\/\\]+/, "");
    return sub || null;
  }

  // 2. Candidate absolute resolution checks
  const candidateAbs = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(workspaceRoot, normalized);

  const relToOutputs = path.relative(threadOutputsDir, candidateAbs).replace(/\\/g, "/");
  if (!relToOutputs.startsWith("..") && !path.isAbsolute(relToOutputs) && !/^[a-zA-Z]:/.test(relToOutputs)) {
    return relToOutputs || null;
  }

  const wsOutputsDir = path.resolve(workspaceRoot, ".agent/threads", cleanThreadId, "files");
  const relToWsOutputs = path.relative(wsOutputsDir, candidateAbs).replace(/\\/g, "/");
  if (!relToWsOutputs.startsWith("..") && !path.isAbsolute(relToWsOutputs) && !/^[a-zA-Z]:/.test(relToWsOutputs)) {
    return relToWsOutputs || null;
  }

  const wsOldOutputsDir = path.resolve(workspaceRoot, cleanThreadId, "files");
  const relToWsOld = path.relative(wsOldOutputsDir, candidateAbs).replace(/\\/g, "/");
  if (!relToWsOld.startsWith("..") && !path.isAbsolute(relToWsOld) && !/^[a-zA-Z]:/.test(relToWsOld)) {
    return relToWsOld || null;
  }

  const candidateThreadsAbs = path.resolve(threadsDir, normalized);
  const relToThreads = path.relative(threadOutputsDir, candidateThreadsAbs).replace(/\\/g, "/");
  if (!relToThreads.startsWith("..") && !path.isAbsolute(relToThreads) && !/^[a-zA-Z]:/.test(relToThreads)) {
    return relToThreads || null;
  }

  return null;
}

export function recordTurnOutputWrite(
  tracker: Set<string> | string[],
  writtenPath: string,
  threadId: string | null | undefined,
  threadsDir: string = resolveThreadsDir(),
  workspaceRoot: string = process.env.WORKSPACE_DIR || "/workspace"
): string | null {
  const rel = resolveTurnOutputPath(writtenPath, threadId, threadsDir, workspaceRoot);
  if (rel) {
    if (tracker instanceof Set) {
      tracker.add(rel);
    } else if (Array.isArray(tracker)) {
      if (!tracker.includes(rel)) {
        tracker.push(rel);
      }
    }
    return rel;
  }
  return null;
}

export function collectTurnAttachments(
  threadId: string | null | undefined,
  threadsDir: string = resolveThreadsDir(),
  recordedRelPaths?: Iterable<string> | string[],
  workspaceRoot: string = process.env.WORKSPACE_DIR || "/workspace"
): TurnAttachment[] {
  if (!threadId || !threadId.trim() || !recordedRelPaths) {
    return [];
  }
  const cleanThreadId = threadId.trim();
  const threadOutputsDir = path.resolve(threadsDir, cleanThreadId, "files");

  const uniquePaths: string[] = [];
  for (const p of recordedRelPaths) {
    if (p && typeof p === "string" && !uniquePaths.includes(p)) {
      uniquePaths.push(p);
    }
  }

  const attachments: TurnAttachment[] = [];
  for (const relInsideOutputs of uniquePaths) {
    let fullPath = path.resolve(threadOutputsDir, relInsideOutputs);
    let stat: fs.Stats | null = null;
    try {
      if (fs.existsSync(fullPath)) {
        const s = fs.statSync(fullPath);
        if (s.isFile()) stat = s;
      }
    } catch {}

    if (!stat) {
      const wsFullPath = path.resolve(workspaceRoot, ".agent/threads", cleanThreadId, "files", relInsideOutputs);
      try {
        if (fs.existsSync(wsFullPath)) {
          const s = fs.statSync(wsFullPath);
          if (s.isFile()) {
            stat = s;
            fullPath = wsFullPath;
          }
        }
      } catch {}
    }

    if (!stat) {
      const wsOldFullPath = path.resolve(workspaceRoot, cleanThreadId, "files", relInsideOutputs);
      try {
        if (fs.existsSync(wsOldFullPath)) {
          const s = fs.statSync(wsOldFullPath);
          if (s.isFile()) {
            stat = s;
            fullPath = wsOldFullPath;
          }
        }
      } catch {}
    }

    if (stat) {
      attachments.push({
        name: path.basename(relInsideOutputs),
        type: inferAttachmentMimeType(relInsideOutputs),
        size: stat.size,
        previewUrl: `${cleanThreadId}/files/${relInsideOutputs.replace(/\\/g, "/")}`
      });
    }
  }

  return attachments;
}

export class ThreadTurnWriteTracker {
  private recordedRelPaths: string[] = [];

  constructor(
    private threadId: string | null | undefined,
    private threadsDir: string = resolveThreadsDir(),
    private workspaceRoot: string = process.env.WORKSPACE_DIR || "/workspace"
  ) {}

  recordWrite(writtenPath: string): string | null {
    const rel = recordTurnOutputWrite(
      this.recordedRelPaths,
      writtenPath,
      this.threadId,
      this.threadsDir,
      this.workspaceRoot
    );
    return rel;
  }

  collect(): TurnAttachment[] {
    return collectTurnAttachments(
      this.threadId,
      this.threadsDir,
      this.recordedRelPaths,
      this.workspaceRoot
    );
  }
}

export * from "./chatDiffs";

