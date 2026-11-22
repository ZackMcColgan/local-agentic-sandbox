import fs from "node:fs";
import path from "node:path";

export interface ExplorerNode {
  name: string;
  path: string;
  type: "directory" | "file";
  children?: ExplorerNode[];
}

export interface ExplorerFileContent {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

export class ExplorerAccessError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ExplorerAccessError";
    this.status = status;
  }
}

const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "dist", ".turbo"]);
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KB

export function resolveHostCheckoutRoot(): string {
  if (process.env.EXPLORER_ROOT && process.env.EXPLORER_ROOT.trim()) {
    return path.resolve(process.env.EXPLORER_ROOT.trim());
  }
  const cwd = process.cwd();
  // When Next.js runs inside web-ui/, the repo root is one level up.
  if (path.basename(cwd) === "web-ui") {
    return path.resolve(cwd, "..");
  }
  return path.resolve(cwd);
}

export function isHostCheckoutAllowed(rootPath: string): boolean {
  try {
    // Lazy-require so unit tests without SQLite native bindings still work
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { listProjects } = require("../projects/projectStore") as {
      listProjects: () => Array<{ root_path: string; allowlisted: number }>;
    };
    const normalizedRoot = path.resolve(rootPath).toLowerCase();
    const projects = listProjects();
    for (const project of projects) {
      if (path.resolve(project.root_path).toLowerCase() === normalizedRoot) {
        return project.allowlisted === 1;
      }
    }
    return true;
  } catch {
    return true;
  }
}

export function confineExplorerPath(
  rootPath: string,
  relPath: string
): { resolved: string; normalizedRel: string } {
  const trimmed = (relPath ?? "").trim();
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new ExplorerAccessError("Access forbidden: absolute paths are not allowed", 403);
  }
  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  if (segments.some((seg) => seg === "..")) {
    throw new ExplorerAccessError("Access forbidden: path traversal detected", 403);
  }
  const resolvedRoot = path.resolve(rootPath);
  const resolved = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ExplorerAccessError("Access forbidden: path escapes root", 403);
  }
  return {
    resolved,
    normalizedRel: segments.join("/"),
  };
}

function buildTreeNode(
  rootPath: string,
  currentAbs: string,
  currentRel: string,
  depth: number,
  maxDepth: number
): ExplorerNode {
  const name = currentRel ? path.posix.basename(currentRel) : path.basename(rootPath);
  if (depth > maxDepth) {
    return { name, path: currentRel, type: "directory", children: [] };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentAbs, { withFileTypes: true });
  } catch {
    return { name, path: currentRel, type: "directory", children: [] };
  }

  const dirs: ExplorerNode[] = [];
  const files: ExplorerNode[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const childRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      const childAbs = path.join(currentAbs, entry.name);
      dirs.push(buildTreeNode(rootPath, childAbs, childRel, depth + 1, maxDepth));
    } else if (entry.isFile()) {
      const childRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      files.push({
        name: entry.name,
        path: childRel,
        type: "file",
      });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return {
    name,
    path: currentRel,
    type: "directory",
    children: [...dirs, ...files],
  };
}

export function listExplorerTree(
  rootPath: string,
  relPath = "",
  options?: { isAllowed?: () => boolean; maxDepth?: number }
): ExplorerNode {
  const allowed = options?.isAllowed ? options.isAllowed() : isHostCheckoutAllowed(rootPath);
  if (!allowed) {
    throw new ExplorerAccessError("Project access is currently revoked.", 403);
  }

  const { resolved, normalizedRel } = confineExplorerPath(rootPath, relPath);
  if (!fs.existsSync(resolved)) {
    throw new ExplorerAccessError("Directory not found", 404);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new ExplorerAccessError("Path is not a directory", 400);
  }

  return buildTreeNode(
    rootPath,
    resolved,
    normalizedRel,
    0,
    options?.maxDepth ?? DEFAULT_MAX_DEPTH
  );
}

export function readExplorerFile(
  rootPath: string,
  relPath: string,
  options?: { isAllowed?: () => boolean; maxBytes?: number }
): ExplorerFileContent {
  const allowed = options?.isAllowed ? options.isAllowed() : isHostCheckoutAllowed(rootPath);
  if (!allowed) {
    throw new ExplorerAccessError("Project access is currently revoked.", 403);
  }

  if (!relPath || !relPath.trim()) {
    throw new ExplorerAccessError("Missing required 'path' parameter", 400);
  }

  const { resolved, normalizedRel } = confineExplorerPath(rootPath, relPath);
  if (!fs.existsSync(resolved)) {
    throw new ExplorerAccessError("File not found", 404);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new ExplorerAccessError("Path is not a file", 400);
  }

  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const truncated = stat.size > maxBytes;
  const fd = fs.openSync(resolved, "r");
  try {
    const length = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, 0);
    return {
      path: normalizedRel,
      content: buf.toString("utf8"),
      size: stat.size,
      truncated,
    };
  } finally {
    fs.closeSync(fd);
  }
}
