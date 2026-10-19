import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ProjectRecord } from "./projectStore";

export interface ProjectTreeNode {
  name: string;
  path: string; // relative to project root with forward slashes
  type: "file" | "directory";
  size?: number;
}

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache"
]);

export function assertAllowedProjectPath(project: ProjectRecord, relativeOrAbsolutePath: string): string {
  if (project.allowlisted !== 1) {
    throw new Error(`Project '${project.name}' is not allowlisted (revoked). Access forbidden.`);
  }

  const rawPath = relativeOrAbsolutePath.trim();
  if (!rawPath) {
    throw new Error("Project relative path cannot be empty.");
  }

  const canonicalRoot = fs.realpathSync(project.root_path);

  // Check for obvious traversal tokens before resolving
  const normalizedInput = rawPath.replace(/\\/g, "/");
  if (normalizedInput.includes("../") || normalizedInput.includes("/..") || normalizedInput === "..") {
    // Check if it escapes
    const candidate = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(canonicalRoot, rawPath);
    if (!candidate.startsWith(canonicalRoot + path.sep) && candidate !== canonicalRoot) {
      throw new Error(`Access forbidden: traversal outside project root: ${rawPath}`);
    }
  }

  const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(canonicalRoot, rawPath);

  // If path exists, canonicalize to detect symlink escapes
  if (fs.existsSync(resolved)) {
    const canonicalTarget = fs.realpathSync(resolved);
    const rootWithSep = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;

    if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(rootWithSep)) {
      throw new Error(`Access forbidden: symlink escape: path escapes project root: ${rawPath}`);
    }
    return canonicalTarget;
  }

  // If target does not exist yet (e.g. for write operations), check closest existing ancestor
  let ancestor = path.dirname(resolved);
  while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) {
    ancestor = path.dirname(ancestor);
  }

  if (fs.existsSync(ancestor)) {
    const canonicalAncestor = fs.realpathSync(ancestor);
    const rootWithSep = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
    if (canonicalAncestor !== canonicalRoot && !canonicalAncestor.startsWith(rootWithSep)) {
      throw new Error(`Access forbidden: ancestor escapes project root: ${rawPath}`);
    }
  }

  const rootWithSep = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
  if (resolved !== canonicalRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Access forbidden: target path outside project root: ${rawPath}`);
  }

  return resolved;
}

export function getProjectTree(project: ProjectRecord, relativeSubdir: string = "."): ProjectTreeNode[] {
  const targetDir = assertAllowedProjectPath(project, relativeSubdir);
  const canonicalRoot = fs.realpathSync(project.root_path);
  const results: ProjectTreeNode[] = [];

  function walk(currentDir: string) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory() === b.isDirectory()) {
        return a.name.localeCompare(b.name);
      }
      return a.isDirectory() ? -1 : 1;
    });

    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      if (entry.name === ".DS_Store" || entry.name === "Thumbs.db") {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      let relativePath = path.relative(canonicalRoot, fullPath).replace(/\\/g, "/");

      try {
        if (entry.isDirectory()) {
          results.push({
            name: entry.name,
            path: relativePath,
            type: "directory"
          });
          walk(fullPath);
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          results.push({
            name: entry.name,
            path: relativePath,
            type: "file",
            size: stat.size
          });
        }
      } catch {
        // Skip unreadable files or broken symlinks
      }
    }
  }

  walk(targetDir);
  return results;
}

export function readProjectFile(
  project: ProjectRecord,
  relativeFilePath: string
): { content: string; size: number; path: string } {
  const targetPath = assertAllowedProjectPath(project, relativeFilePath);
  const canonicalRoot = fs.realpathSync(project.root_path);

  const stat = fs.statSync(targetPath);
  if (!stat.isFile()) {
    throw new Error(`Target is not a file: ${relativeFilePath}`);
  }

  const content = fs.readFileSync(targetPath, "utf8");
  const relPath = path.relative(canonicalRoot, targetPath).replace(/\\/g, "/");

  return {
    content,
    size: stat.size,
    path: relPath
  };
}

export function runGit(project: ProjectRecord, args: string[]): string {
  if (project.allowlisted !== 1) {
    throw new Error(`Project '${project.name}' is revoked.`);
  }

  const canonicalRoot = fs.realpathSync(project.root_path);
  return execFileSync("git", args, {
    cwd: canonicalRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  }).trim();
}
