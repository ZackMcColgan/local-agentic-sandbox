/**
 * Board #132 - Optional host file-folder restriction.
 *
 * OPT-IN ONLY: enforcement happens solely when the owner turns the Settings
 * toggle ON. Default is OFF; the owner can bypass or disable at any time.
 * When ON, host FILE tools (and the cwd of host_run_powershell) may only
 * operate on paths inside the owner-entered allowed folders.
 */

import path from "path";

export interface FileRestrictionSettings {
  fileRestrictionEnabled: boolean;
  allowedHostPaths: string[];
}

/** Normalize a path for containment comparison: unified separators, lowercase, no trailing slash. */
function normalizeForCompare(p: string): string {
  const unified = p.replace(/[\\/]+$/g, "").replace(/[\\/]+/g, path.sep);
  return unified.toLowerCase();
}

/**
 * True when `candidate` is the allowed folder itself or lives inside it.
 * Directory-scoped containment (path.relative), NOT a naive string prefix,
 * so a sibling folder sharing a name prefix ("repos" vs "reposX") never matches.
 */
export function isPathWithinAllowedFolders(candidate: string, allowedFolders: string[]): boolean {
  const normCandidate = normalizeForCompare(candidate);
  if (!normCandidate) return false;
  for (const folder of allowedFolders) {
    const normFolder = normalizeForCompare(folder);
    if (!normFolder) continue;
    if (normCandidate === normFolder) return true;
    const rel = path.relative(normFolder, normCandidate);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  return false;
}

/** Path-bearing arguments per host tool. Unattended git tools carry none. */
export function collectPathArguments(tool: string, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof args?.path === "string" && args.path) out.push(args.path);
  if (Array.isArray(args?.paths)) {
    for (const p of args.paths) {
      if (typeof p === "string" && p) out.push(p);
    }
  }
  if (tool === "host_run_powershell" && typeof args?.cwd === "string" && args.cwd) {
    out.push(args.cwd);
  }
  return out;
}

export interface FileRestrictionVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Evaluate the opt-in restriction for one host tool call. Toggle OFF (or no
 * path-bearing args) allows everything; toggle ON blocks any path outside the
 * owner's allowed folders.
 */
export function evaluateFileRestriction(
  settings: FileRestrictionSettings,
  tool: string,
  args: Record<string, unknown>
): FileRestrictionVerdict {
  if (!settings.fileRestrictionEnabled) return { allowed: true };
  const paths = collectPathArguments(tool, args);
  if (paths.length === 0) return { allowed: true };
  const blocked = paths.filter((p) => !isPathWithinAllowedFolders(p, settings.allowedHostPaths));
  if (blocked.length === 0) return { allowed: true };
  return {
    allowed: false,
    reason:
      `Host file restriction is enabled in Settings (opt-in). Path(s) outside the allowed folders: ` +
      `${blocked.join(", ")}. Allowed folders: ${settings.allowedHostPaths.join(", ") || "(none)"}. ` +
      `The owner can edit the allowed folders or turn the restriction off in Settings at any time.`,
  };
}
