import fs from "fs";
import path from "path";
import crypto from "crypto";

export const SAFE_ID_REGEX = /^[A-Za-z0-9._-]+$/;

/**
 * Validates identifiers (thread IDs, skill candidate IDs) against a strict safe allowlist
 * and rejects traversal tokens or path separators.
 */
export function isValidSafeId(id: unknown): id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) return false;
  if (id === "." || id === ".." || id.includes("..") || id.includes("/") || id.includes("\\")) {
    return false;
  }
  return SAFE_ID_REGEX.test(id);
}

/**
 * Throws if the provided identifier fails strict safe-ID validation.
 */
export function assertValidSafeId(id: unknown, label = "identifier"): string {
  if (!isValidSafeId(id)) {
    throw new Error(`Invalid ${label}: ${String(id)}`);
  }
  return id;
}

function normalizeForBoundaryCompare(targetPath: string): string {
  return process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
}

/**
 * Checks whether candidatePath resolves lexically inside rootDir (or equals rootDir),
 * guarding against sibling-prefix matches with a trailing separator check.
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

export type RealConfinementResult =
  | { ok: true; canonicalRoot: string; canonicalTarget: string }
  | { ok: false; reason: "outside_root" | "symlink_escape" | "not_found" };

/**
 * Enforces both lexical root confinement and symlink resolution via fs.realpathSync
 * so symlinks/junctions escaping rootDir are rejected.
 */
export function resolveRealConfinedPath(
  rootDir: string,
  candidatePath: string
): RealConfinementResult {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  if (!isStrictlyInsideRoot(resolvedRoot, resolvedCandidate)) {
    return { ok: false, reason: "outside_root" };
  }
  if (!fs.existsSync(resolvedRoot)) {
    return { ok: false, reason: "not_found" };
  }
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(resolvedCandidate);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  let canonicalRoot: string;
  let canonicalTarget: string;
  try {
    canonicalRoot = fs.realpathSync(resolvedRoot);
    canonicalTarget = fs.realpathSync(resolvedCandidate);
  } catch {
    return { ok: false, reason: lstat.isSymbolicLink() ? "symlink_escape" : "not_found" };
  }
  if (!isStrictlyInsideRoot(canonicalRoot, canonicalTarget)) {
    return { ok: false, reason: "symlink_escape" };
  }
  return { ok: true, canonicalRoot, canonicalTarget };
}

export function confinePathToRoot(rootDir: string, userPath: string): string {
  const rootResolved = path.resolve(rootDir);
  const targetResolved = path.resolve(rootResolved, userPath.replace(/^[/\\]+/, ""));
  if (!isStrictlyInsideRoot(rootResolved, targetResolved)) {
    throw new Error(`Security Violation: Path traversal outside root (${userPath})`);
  }
  return targetResolved;
}

export function isSafePublicUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return false;
  }
  return true;
}

export function verifyLanBridgeAuth(expectedToken: string, authHeader?: string): boolean {
  if (!expectedToken || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${expectedToken}`, "utf8");
  const actual = Buffer.from(authHeader, "utf8");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

const OCI_IMAGE_TAG_REGEX =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?\/)?[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?$/;

const HOSTNAME_OR_IPV4_REGEX =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * Validates a git branch name against a strict allowlist (no leading '-', no '..', no whitespace/shell metacharacters).
 */
export function validateGitBranchName(branchName: unknown): string {
  if (typeof branchName !== "string") {
    throw new Error("Invalid branchName: must be a non-empty string");
  }
  if (
    !branchName ||
    branchName.length > 200 ||
    branchName.startsWith("-") ||
    branchName.includes("..") ||
    branchName.includes("//") ||
    branchName.includes("@{") ||
    branchName.endsWith("/") ||
    branchName.endsWith(".") ||
    branchName.endsWith(".lock") ||
    !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(branchName)
  ) {
    throw new Error(`Invalid branchName '${branchName}'.`);
  }
  return branchName;
}

/**
 * Validates a git ref or hex SHA (allows ~N / ^N suffixes, rejects leading '-' and '..' or shell metacharacters).
 */
export function validateGitRef(ref: unknown, label = "git ref"): string {
  if (typeof ref !== "string") {
    throw new Error(`Invalid ${label}: must be a non-empty string`);
  }
  if (
    !ref ||
    ref.length > 200 ||
    ref.startsWith("-") ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock") ||
    !/^[A-Za-z0-9_][A-Za-z0-9._/-]*(?:[~^][0-9]*)*$/.test(ref)
  ) {
    throw new Error(`Invalid ${label} '${ref}'.`);
  }
  return ref;
}

/**
 * Validates an OCI image reference/tag against a strict allowlist.
 */
export function validateOciImageTag(imageTag: unknown): string {
  if (typeof imageTag !== "string") {
    throw new Error("Invalid imageTag: must be a non-empty string");
  }
  if (
    !imageTag ||
    imageTag.length > 256 ||
    imageTag.startsWith("-") ||
    imageTag.includes("..") ||
    imageTag.includes("//") ||
    !OCI_IMAGE_TAG_REGEX.test(imageTag)
  ) {
    throw new Error(`Invalid imageTag '${imageTag}'.`);
  }
  return imageTag;
}

/**
 * Validates a deploy target hostname or IPv4 address (no '@', '/', '?', '#', ':', whitespace, or scheme injection).
 */
export function validateHostAddress(hostAddress: unknown): string {
  if (typeof hostAddress !== "string") {
    throw new Error("Invalid hostAddress: must be a non-empty string");
  }
  if (!hostAddress || hostAddress.length > 253 || !HOSTNAME_OR_IPV4_REGEX.test(hostAddress)) {
    throw new Error(`Invalid hostAddress '${hostAddress}'.`);
  }
  if (/^\d+(?:\.\d+)*$/.test(hostAddress)) {
    const octets = hostAddress.split(".");
    if (octets.length !== 4 || octets.some((o) => Number(o) > 255)) {
      throw new Error(`Invalid hostAddress '${hostAddress}'.`);
    }
  }
  return hostAddress;
}
