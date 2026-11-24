import fs from "fs";
import path from "path";

function normalizeForBoundaryCompare(targetPath: string): string {
  return process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
}

/**
 * Checks whether candidatePath is inside rootDir (or equals rootDir),
 * using a trailing path separator to block sibling-prefix bypasses.
 */
export function isStrictlyInsideRoot(rootDir: string, candidatePath: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const normRoot = normalizeForBoundaryCompare(resolvedRoot);
  const normCandidate = normalizeForBoundaryCompare(resolvedCandidate);
  const rootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
  if (normCandidate !== normRoot && !normCandidate.startsWith(rootWithSep)) {
    return false;
  }
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return (
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !rel.startsWith("../") &&
    !path.isAbsolute(rel) &&
    !/^[a-zA-Z]:/.test(rel)
  );
}

/**
 * Resolves userPath inside rootDir with both lexical and realpath-based
 * symlink confinement. For non-existent leaf targets (e.g. file writes),
 * resolves the nearest existing ancestor directory and verifies it stays
 * strictly inside the canonical workspace root.
 */
export function resolveRealConfinedPath(
  rootDir: string,
  userPath: string,
  options: { stripWorkspacePrefix?: boolean } = {}
): string {
  if (userPath.includes("..")) {
    throw new Error(
      `Security Violation: Path traversal outside /workspace is forbidden (${userPath})`
    );
  }
  const normalized = path.normalize(userPath).replace(/^(\/|\\)+/, "");
  const relative = options.stripWorkspacePrefix
    ? normalized.replace(/^workspace(?:[/\\]+|$)/i, "")
    : normalized;
  const rootResolved = path.resolve(rootDir);
  const resolved = path.resolve(rootResolved, relative);

  if (!isStrictlyInsideRoot(rootResolved, resolved)) {
    throw new Error(
      `Security Violation: Path traversal outside /workspace is forbidden (${userPath})`
    );
  }

  if (!fs.existsSync(rootResolved)) {
    return resolved;
  }

  const canonicalRoot = fs.realpathSync(rootResolved);

  // Check if target exists (including broken symlinks via lstatSync)
  let lstat: fs.Stats | null = null;
  try {
    lstat = fs.lstatSync(resolved);
  } catch {
    lstat = null;
  }

  if (lstat) {
    let canonicalTarget: string;
    try {
      canonicalTarget = fs.realpathSync(resolved);
    } catch {
      throw new Error(
        `Security Violation: Symlink escape outside /workspace is forbidden (${userPath})`
      );
    }
    if (!isStrictlyInsideRoot(canonicalRoot, canonicalTarget)) {
      throw new Error(
        `Security Violation: Symlink escape outside /workspace is forbidden (${userPath})`
      );
    }
    return canonicalTarget;
  }

  // Target does not exist yet: walk up to nearest existing ancestor and verify its realpath
  const missingSegments: string[] = [];
  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    missingSegments.unshift(path.basename(probe));
    probe = parent;
  }

  let canonicalAncestor: string;
  try {
    canonicalAncestor = fs.realpathSync(probe);
  } catch {
    throw new Error(
      `Security Violation: Symlink escape outside /workspace is forbidden (${userPath})`
    );
  }

  if (!isStrictlyInsideRoot(canonicalRoot, canonicalAncestor)) {
    throw new Error(
      `Security Violation: Symlink escape outside /workspace is forbidden (${userPath})`
    );
  }

  const finalPath = path.resolve(canonicalAncestor, ...missingSegments);
  if (!isStrictlyInsideRoot(canonicalRoot, finalPath)) {
    throw new Error(
      `Security Violation: Path traversal outside /workspace is forbidden (${userPath})`
    );
  }
  return finalPath;
}
