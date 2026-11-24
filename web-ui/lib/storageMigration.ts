import fs from "fs";
import path from "path";
import os from "os";

export function getSafeHomedir(): string {
  return os.homedir() || process.env.USERPROFILE || process.env.HOME || ".";
}

export function isPathInside(candidate: string, parentDir: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parentDir);
  const normalizedCandidate =
    process.platform === "win32" ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const normalizedParent =
    process.platform === "win32" ? resolvedParent.toLowerCase() : resolvedParent;
  const rel = path.relative(normalizedParent, normalizedCandidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolves a persistent storage path:
 * 1. Explicit env var if set
 * 2. WORKSPACE_DIR/<workspaceSubpath> if WORKSPACE_DIR is set and exists on disk
 * 3. Legacy ~/.local-agentic-sandbox/<legacyFilename>
 */
export function resolvePersistentStoragePath(options: {
  envVarValue?: string;
  resolveEnvVar?: boolean;
  workspaceSubpath: string[];
  legacyFilename: string;
}): string {
  if (options.envVarValue) {
    return options.resolveEnvVar ? path.resolve(options.envVarValue) : options.envVarValue;
  }
  const workspaceDir = process.env.WORKSPACE_DIR?.trim();
  if (workspaceDir && fs.existsSync(workspaceDir)) {
    return path.join(path.resolve(workspaceDir), ...options.workspaceSubpath);
  }
  return path.join(getSafeHomedir(), ".local-agentic-sandbox", options.legacyFilename);
}

function copyFileAtomicNonDestructive(src: string, dest: string): void {
  const tmpDest = `${dest}.migrating-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.copyFileSync(src, tmpDest);
    fs.renameSync(tmpDest, dest);
  } catch (err) {
    try {
      if (fs.existsSync(tmpDest)) {
        fs.unlinkSync(tmpDest);
      }
    } catch {}
    throw err;
  }
}

/**
 * Safely copies a legacy file (and optional sidecars) to targetPath when targetPath
 * does not exist yet and legacyPath exists. Never deletes the legacy source and never
 * overwrites an existing target.
 */
export function migrateLegacyFileIfNeeded(options: {
  targetPath: string;
  legacyPath: string;
  sidecarSuffixes?: string[];
  skipTmpDirGuard?: boolean;
  logPrefix?: string;
}): boolean {
  const {
    targetPath,
    legacyPath,
    sidecarSuffixes = [],
    skipTmpDirGuard = false,
    logPrefix = "[StorageMigration]",
  } = options;

  if (!targetPath || targetPath === ":memory:" || targetPath.startsWith("file::memory:")) {
    return false;
  }

  const resolvedTarget = path.resolve(targetPath);
  const resolvedSource = path.resolve(legacyPath);

  if (
    resolvedSource === resolvedTarget ||
    (process.platform === "win32" &&
      resolvedSource.toLowerCase() === resolvedTarget.toLowerCase())
  ) {
    return false;
  }

  if (fs.existsSync(resolvedTarget) || !fs.existsSync(resolvedSource)) {
    return false;
  }

  // Keep isolated temp-dir tests from inheriting a host user's real ~/.local-agentic-sandbox files
  if (!skipTmpDirGuard) {
    const tmpRoot = os.tmpdir();
    if (isPathInside(resolvedTarget, tmpRoot) && !isPathInside(resolvedSource, tmpRoot)) {
      return false;
    }
  }

  const targetDir = path.dirname(resolvedTarget);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  try {
    // Copy sidecars first so primary target existence marks completed migration
    for (const suffix of sidecarSuffixes) {
      const sidecarSrc = `${resolvedSource}${suffix}`;
      const sidecarDest = `${resolvedTarget}${suffix}`;
      if (fs.existsSync(sidecarSrc) && !fs.existsSync(sidecarDest)) {
        copyFileAtomicNonDestructive(sidecarSrc, sidecarDest);
      }
    }
    copyFileAtomicNonDestructive(resolvedSource, resolvedTarget);
    return true;
  } catch (err) {
    console.warn(
      `${logPrefix} Warning: failed to migrate legacy file from ${resolvedSource} to ${resolvedTarget}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}
