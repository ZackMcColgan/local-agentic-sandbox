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
 * Normalizes PowerShell backtick escapes outside single-quoted string literals.
 * Line-continuation backticks become spaces; backticks before identifier/path characters are removed
 * so obfuscated tokens like `` `Rem`ove-Item `` or `` `d`el `` resolve to their executed form.
 */
function normalizeBackticks(cmd: string): string {
  let out = "";
  let inSingle = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inSingle) {
      out += ch;
      if (ch === "'") {
        if (cmd[i + 1] === "'") {
          out += "'";
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === "`") {
      const next = cmd[i + 1];
      if (next === "\r" && cmd[i + 2] === "\n") {
        out += " ";
        i += 2;
        continue;
      }
      if (next === "\n") {
        out += " ";
        i += 1;
        continue;
      }
      if (next && /[A-Za-z0-9_\-./\\]/.test(next)) {
        out += next;
        i += 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Unquotes command names explicitly invoked via the PowerShell call operator (&) or dot-sourcing (.),
 * including optional parenthesized wrappers like `& ("Remove-Item")` or simple concatenation `& ("Re" + "move-Item")`.
 * Quoted string arguments to ordinary commands (e.g. `Write-Output "Remove-Item"`) are left untouched.
 */
function unquoteInvokedCommands(cmd: string): string {
  // Collapse simple string concatenation inside call-operator parens: & ("Re" + "move-Item") -> & ("Remove-Item")
  let result = cmd.replace(
    /((?:^|[;|&({\r\n])\s*[&.]\s*\(\s*)(['"][^'"]+['"](?:\s*\+\s*['"][^'"]+['"])+)(\s*\))/g,
    (_match, prefix: string, expr: string, suffix: string) => {
      const parts = Array.from(expr.matchAll(/(['"])([^'"]*)\1/g)).map((m) => m[2]);
      return `${prefix}"${parts.join("")}"${suffix}`;
    }
  );

  // Unquote & "cmd", & 'cmd', & ("cmd"), & ('cmd')
  result = result.replace(
    /((?:^|[;|&({\r\n])\s*&\s*)(?:\(\s*)?(['"])([^'"\r\n]+)\2(?:\s*\))?/g,
    "$1$3"
  );

  // Unquote dot-sourced command at command position: . "cmd" or . 'cmd'
  result = result.replace(
    /((?:^|[;|&({\r\n])\s*\.\s+)(?:\(\s*)?(['"])([^'"\r\n]+)\2(?:\s*\))?/g,
    "$1$3"
  );

  return result;
}

/**
 * Extracts bodies of PowerShell `$(...)` subexpressions from bare code and double-quoted strings.
 * Single-quoted strings are skipped because PowerShell does not evaluate `$(...)` inside them.
 */
function extractSubexpressions(cmd: string): string[] {
  const results: string[] = [];
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inSingle) {
      if (ch === "'") {
        if (cmd[i + 1] === "'") {
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }

    if (inDouble) {
      if (ch === "`") {
        i++; // skip escaped char inside double quotes
        continue;
      }
      if (ch === '"') {
        if (cmd[i + 1] === '"') {
          i++;
        } else {
          inDouble = false;
        }
        continue;
      }
    } else {
      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        continue;
      }
    }

    if (ch === "$" && cmd[i + 1] === "(") {
      const start = i + 2;
      let depth = 1;
      let j = start;
      let subSingle = false;
      let subDouble = false;

      while (j < cmd.length && depth > 0) {
        const c = cmd[j];
        if (subSingle) {
          if (c === "'") {
            if (cmd[j + 1] === "'") {
              j++;
            } else {
              subSingle = false;
            }
          }
        } else if (subDouble) {
          if (c === "`") {
            j++;
          } else if (c === '"') {
            if (cmd[j + 1] === '"') {
              j++;
            } else {
              subDouble = false;
            }
          }
        } else {
          if (c === "'") {
            subSingle = true;
          } else if (c === '"') {
            subDouble = true;
          } else if (c === "(") {
            depth++;
          } else if (c === ")") {
            depth--;
            if (depth === 0) {
              break;
            }
          }
        }
        j++;
      }

      if (depth === 0) {
        const body = cmd.slice(start, j).trim();
        if (body.length > 0) {
          results.push(body);
        }
      }
    }
  }

  return results;
}

/**
 * Contract-defined destructive PowerShell patterns:
 * 1. Remove-* cmdlets
 * 2. Format-Volume, Clear-Disk, Initialize-Disk, Restart-Computer, Stop-Computer
 * 3. shutdown or shutdown.exe in command position
 * 4. del, erase, rd, rmdir, ri, rm in command position (start of string or after ;, |, &, (, {, or newline)
 */
export const DESTRUCTIVE_POWERSHELL_PATTERNS: RegExp[] = [
  /\bremove-[a-z0-9_]+\b/i,
  /\b(format-volume|clear-disk|initialize-disk|restart-computer|stop-computer)\b/i,
  /(?:^|[;|&({\r\n])\s*(?:[&.]\s+)?(?:[^\s;|&({\r\n]*[/\\])?(?:shutdown(?:\.exe)?)(?![a-zA-Z0-9_\-])/i,
  /(?:^|[;|&({\r\n])\s*(?:[&.]\s+)?(?:del|erase|rd|rmdir|ri|rm)(?![a-zA-Z0-9_\-])(?!\s*=)/i,
];

export interface DestructiveCheckResult {
  isDestructive: boolean;
  reason?: string;
}

const ENCODED_COMMAND_SWITCH_PATTERN =
  /(?:^|[;|&({\r\n\s])(?:[^\s;|&({\r\n]*[/\\])?(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^\r\n;|&})]*?\s-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?=\s|$|[;|&})])/i;

const ENCODED_COMMAND_ARG_PATTERN =
  /(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^\r\n;|&})]*?\s-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)\s+['"]?([A-Za-z0-9+/=]{4,})['"]?/i;

const DOTNET_DELETE_PATTERN =
  /\[\s*(?:system\s*\.\s*)?io\s*\.\s*(?:file|directory)\s*\]\s*::\s*delete\s*\(/i;

const SCRIPTBLOCK_CREATE_PATTERN =
  /\[\s*(?:system\s*\.\s*management\s*\.\s*automation\s*\.\s*)?scriptblock\s*\]\s*::\s*create\s*\(/i;

const DYNAMIC_EXEC_PATTERN =
  /(?:^|[;|&({\r\n])\s*(?:[&.]\s+)?(?:iex|invoke-expression)(?![a-zA-Z0-9_\-])(?!\s*=)/i;

const ROBOCOPY_DESTRUCTIVE_PATTERN =
  /(?:^|[;|&({\r\n])\s*(?:[&.]\s+)?(?:[^\s;|&({\r\n]*[/\\])?robocopy(?:\.exe)?\b[^\r\n;|&})]*?\s\/(?:mir|purge)(?=\s|$|[;|&})])/i;

const CMD_INDIRECTION_PATTERN =
  /(?:^|[;|&({\r\n])\s*(?:[&.]\s+)?(?:[^\s;|&({\r\n]*[/\\])?cmd(?:\.exe)?(?:\s+\/[a-z](?::[^\s;|&})]+)?)*\s+\/[ck]\s+([\s\S]+)$/i;

const POWERSHELL_COMMAND_INDIRECTION_PATTERN =
  /(?:^|[;|&({\r\n])\s*(?:[&.]\s+)?(?:[^\s;|&({\r\n]*[/\\])?(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^\r\n;|&})]*?\s-(?:c|co|com|comm|comma|comman|command)\s+([\s\S]+)$/i;

function extractLeadingPayload(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('"')) {
    const match = /^"((?:[^"`]|`[\s\S]|"")*)"/.exec(trimmed);
    if (match) {
      return match[1].replace(/""/g, '"');
    }
  }
  if (trimmed.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'/.exec(trimmed);
    if (match) {
      return match[1].replace(/''/g, "'");
    }
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function matchDestructivePatterns(strippedCmd: string): RegExp | undefined {
  return DESTRUCTIVE_POWERSHELL_PATTERNS.find((pattern) => pattern.test(strippedCmd));
}

function evaluatePowerShellCommand(rawCmd: string, depth = 0): DestructiveCheckResult {
  const normalizedCmd = unquoteInvokedCommands(normalizeBackticks(rawCmd));
  const rawStripped = stripQuotedStrings(rawCmd);
  const normStripped = stripQuotedStrings(normalizedCmd);
  const strippedViews = normStripped === rawStripped ? [rawStripped] : [rawStripped, normStripped];
  const fullViews = normalizedCmd === rawCmd ? [rawCmd] : [rawCmd, normalizedCmd];

  for (const view of strippedViews) {
    if (ENCODED_COMMAND_SWITCH_PATTERN.test(view)) {
      for (const fullView of fullViews) {
        const argMatch = ENCODED_COMMAND_ARG_PATTERN.exec(fullView);
        if (argMatch?.[1]) {
          const decoded = Buffer.from(argMatch[1], "base64").toString("utf16le");
          const decodedMatch = matchDestructivePatterns(
            stripQuotedStrings(unquoteInvokedCommands(normalizeBackticks(decoded)))
          );
          if (decodedMatch) {
            return {
              isDestructive: true,
              reason: `Encoded PowerShell command decoded match: ${decodedMatch.source}`,
            };
          }
        }
      }
      return {
        isDestructive: true,
        reason: "Opaque encoded PowerShell command (-EncodedCommand)",
      };
    }

    if (DOTNET_DELETE_PATTERN.test(view)) {
      return {
        isDestructive: true,
        reason: "High-risk .NET static Delete call",
      };
    }

    if (SCRIPTBLOCK_CREATE_PATTERN.test(view)) {
      return {
        isDestructive: true,
        reason: "Dynamic PowerShell scriptblock creation ([scriptblock]::Create)",
      };
    }

    if (DYNAMIC_EXEC_PATTERN.test(view)) {
      return {
        isDestructive: true,
        reason: "Dynamic PowerShell code execution (iex / Invoke-Expression)",
      };
    }

    if (ROBOCOPY_DESTRUCTIVE_PATTERN.test(view)) {
      return {
        isDestructive: true,
        reason: "Destructive robocopy mirror/purge operation",
      };
    }
  }

  if (depth < 4) {
    for (const fullView of fullViews) {
      const cmdMatch = CMD_INDIRECTION_PATTERN.exec(fullView);
      if (cmdMatch?.[1]) {
        const innerCmd = extractLeadingPayload(cmdMatch[1]);
        const innerResult = evaluatePowerShellCommand(innerCmd, depth + 1);
        if (innerResult.isDestructive) {
          return innerResult;
        }
      }

      const psCmdMatch = POWERSHELL_COMMAND_INDIRECTION_PATTERN.exec(fullView);
      if (psCmdMatch?.[1]) {
        const innerCmd = extractLeadingPayload(psCmdMatch[1]);
        const innerResult = evaluatePowerShellCommand(innerCmd, depth + 1);
        if (innerResult.isDestructive) {
          return innerResult;
        }
      }

      const subexpressions = extractSubexpressions(fullView);
      for (const subexpr of subexpressions) {
        const subResult = evaluatePowerShellCommand(subexpr, depth + 1);
        if (subResult.isDestructive) {
          return subResult;
        }
      }
    }
  }

  for (const view of strippedViews) {
    const matchedPattern = matchDestructivePatterns(view);
    if (matchedPattern) {
      return {
        isDestructive: true,
        reason: `High-risk PowerShell command matched: ${matchedPattern.source}`,
      };
    }
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
