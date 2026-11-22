export type TargetShell = "powershell" | "cmd" | "bash";

export interface DialectCheckResult {
  ok: boolean;
  reason?: string;
  noRules?: boolean;
}

const POWERSHELL_FORBIDDEN: Array<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /(?:^|[;&|\s])export\s+[A-Za-z_][A-Za-z0-9_]*=/,
    hint: "Use '$env:VAR = \"val\"' instead of bash 'export VAR=val' in PowerShell.",
  },
  { pattern: /\s&&\s/, hint: "Use ';' instead of '&&' for PowerShell 5.1 compatibility." },
  {
    pattern: /(?:^|[;&|\s])rm\s+-rf\s+/,
    hint: "Use 'Remove-Item -Recurse -Force' instead of 'rm -rf' in PowerShell.",
  },
  {
    pattern: /(?:^|[;&|\s])grep\s+-[A-Za-z]*r/,
    hint: "Use 'Select-String' or 'git grep' instead of 'grep -r' in PowerShell.",
  },
  {
    pattern: /<<\s*['"]?[A-Za-z_]+['"]?/,
    hint: "Use PowerShell here-string '@\" ... \"@' instead of bash '<<EOF'.",
  },
];

const BASH_FORBIDDEN: Array<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /\$env:[A-Za-z_][A-Za-z0-9_]*/,
    hint: "Use '$VAR' instead of PowerShell '$env:VAR' in bash.",
  },
  {
    pattern: /\b(Get-ChildItem|Remove-Item|Set-Location|Select-String)\b/,
    hint: "Use POSIX commands (ls, rm, cd, grep) instead of PowerShell cmdlets in bash.",
  },
];

export function checkCommandDialect(command: string, shell: TargetShell): DialectCheckResult {
  const trimmed = (command || "").trim();
  if (!trimmed) return { ok: true };

  if (shell === "powershell") {
    for (const rule of POWERSHELL_FORBIDDEN) {
      if (rule.pattern.test(trimmed)) {
        return { ok: false, reason: `Shell dialect mismatch (target: powershell): ${rule.hint}` };
      }
    }
  } else if (shell === "bash") {
    for (const rule of BASH_FORBIDDEN) {
      if (rule.pattern.test(trimmed)) {
        return { ok: false, reason: `Shell dialect mismatch (target: bash): ${rule.hint}` };
      }
    }
  } else if (shell === "cmd") {
    return { ok: true, noRules: true, reason: "No dialect rules configured for cmd shell." };
  }
  return { ok: true };
}
