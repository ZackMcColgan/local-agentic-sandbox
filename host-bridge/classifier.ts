/**
 * Shared Host Classifier Module
 * Single source of truth for destructive host action classification
 * Imported by both host daemon and web-ui.
 */

/**
 * Strips single-quoted ('...') and double-quoted ("...") string literals from PowerShell code,
 * replacing them with empty quotes ("") so tokens inside string literals are never matched.
 */
export function stripQuotedStrings(cmd: string): string {
  return cmd
    .replace(/'(?:[^']|'')*'/g, '""')
    .replace(/"(?:[^"`]|`[\s\S]|"")*"/g, '""');
}

/**
 * Contract-defined destructive PowerShell patterns:
 * 1. Remove-* cmdlets
 * 2. Format-Volume, Clear-Disk, Initialize-Disk, Restart-Computer, Stop-Computer
 * 3. shutdown or shutdown.exe in command position
 * 4. del, erase, rd, rmdir, ri, rm in command position (start of string or after ;, |, &, (, or newline)
 */
export const DESTRUCTIVE_POWERSHELL_PATTERNS: RegExp[] = [
  /\bremove-[a-z0-9_]+\b/i,
  /\b(format-volume|clear-disk|initialize-disk|restart-computer|stop-computer)\b/i,
  /(?:^|[;|&(\r\n])\s*(?:&\s+)?(?:shutdown(?:\.exe)?)(?![a-zA-Z0-9_\-])/i,
  /(?:^|[;|&(\r\n])\s*(?:&\s+)?(?:del|erase|rd|rmdir|ri|rm)(?![a-zA-Z0-9_\-])/i
];

export interface DestructiveCheckResult {
  isDestructive: boolean;
  reason?: string;
}

/**
 * Evaluates whether a host tool action is destructive according to PR #44 audited behavior.
 */
export function isDestructiveHostAction(tool: string, args: any): DestructiveCheckResult {
  if (tool === "host_delete_path") {
    return {
      isDestructive: true,
      reason: `Permanent deletion of host path: ${args?.path || ""}`
    };
  }

  if (tool === "host_run_powershell") {
    const rawCmd = String(args?.command || "");
    const strippedCmd = stripQuotedStrings(rawCmd);

    for (const pattern of DESTRUCTIVE_POWERSHELL_PATTERNS) {
      if (pattern.test(strippedCmd)) {
        return {
          isDestructive: true,
          reason: `High-risk PowerShell command matched: ${pattern.source}`
        };
      }
    }
  }

  return { isDestructive: false };
}
