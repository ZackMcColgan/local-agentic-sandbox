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
  return cmd.replace(/'(?:[^']|'')*'/g, '""').replace(/"(?:[^"`]|`[\s\S]|"")*"/g, '""');
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
  /(?:^|[;|&(\r\n])\s*(?:&\s+)?(?:del|erase|rd|rmdir|ri|rm)(?![a-zA-Z0-9_\-])/i,
];

export interface DestructiveCheckResult {
  isDestructive: boolean;
  reason?: string;
}

const ENCODED_COMMAND_SWITCH_PATTERN =
  /(?:^|[;|&(\r\n\s])(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^\r\n;|&]*?\s-(?:e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?=\s|$|[;|&)])/i;

const ENCODED_COMMAND_ARG_PATTERN =
  /(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^\r\n;|&]*?\s-(?:e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)\s+['"]?([A-Za-z0-9+/=]{4,})['"]?/i;

const DOTNET_DELETE_PATTERN =
  /\[\s*(?:system\s*\.\s*)?io\s*\.\s*(?:file|directory)\s*\]\s*::\s*delete\s*\(/i;

const CMD_INDIRECTION_PATTERN =
  /(?:^|[;|&(\r\n])\s*(?:&\s+)?cmd(?:\.exe)?\s+\/[ck]\s+([\s\S]+)$/i;

function unquoteOuter(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function matchDestructivePatterns(strippedCmd: string): RegExp | undefined {
  return DESTRUCTIVE_POWERSHELL_PATTERNS.find((pattern) => pattern.test(strippedCmd));
}

function evaluatePowerShellCommand(rawCmd: string, depth = 0): DestructiveCheckResult {
  const strippedCmd = stripQuotedStrings(rawCmd);

  if (ENCODED_COMMAND_SWITCH_PATTERN.test(strippedCmd)) {
    const argMatch = ENCODED_COMMAND_ARG_PATTERN.exec(rawCmd);
    if (argMatch?.[1]) {
      const decoded = Buffer.from(argMatch[1], "base64").toString("utf16le");
      const decodedMatch = matchDestructivePatterns(stripQuotedStrings(decoded));
      if (decodedMatch) {
        return {
          isDestructive: true,
          reason: `Encoded PowerShell command decoded match: ${decodedMatch.source}`,
        };
      }
    }
    return {
      isDestructive: true,
      reason: "Opaque encoded PowerShell command (-EncodedCommand)",
    };
  }

  if (DOTNET_DELETE_PATTERN.test(strippedCmd)) {
    return {
      isDestructive: true,
      reason: "High-risk .NET static Delete call",
    };
  }

  if (depth < 4) {
    const cmdMatch = CMD_INDIRECTION_PATTERN.exec(rawCmd);
    if (cmdMatch?.[1]) {
      const innerCmd = unquoteOuter(cmdMatch[1]);
      const innerResult = evaluatePowerShellCommand(innerCmd, depth + 1);
      if (innerResult.isDestructive) {
        return innerResult;
      }
    }
  }

  const matchedPattern = matchDestructivePatterns(strippedCmd);
  if (matchedPattern) {
    return {
      isDestructive: true,
      reason: `High-risk PowerShell command matched: ${matchedPattern.source}`,
    };
  }

  return { isDestructive: false };
}

/**
 * Evaluates whether a host tool action is destructive according to PR #44 audited behavior.
 */
export function isDestructiveHostAction(
  tool: string,
  args: Record<string, unknown> | undefined | null
): DestructiveCheckResult {
  if (tool === "host_delete_path") {
    return {
      isDestructive: true,
      reason: `Permanent deletion of host path: ${args?.path || ""}`,
    };
  }

  if (tool === "host_run_powershell") {
    return evaluatePowerShellCommand(String(args?.command || ""));
  }

  return { isDestructive: false };
}
