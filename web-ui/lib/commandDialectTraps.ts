export interface CommandDialectTrap {
  id: string;
  action: "rewrite" | "reject";
  pattern: RegExp;
  replacement?: string;
  hint: string;
}

/**
 * Single data-driven trap list for host command pre-execution linting.
 * Adding a new trap is a one-line entry in this array.
 */
export const COMMAND_DIALECT_TRAPS: CommandDialectTrap[] = [
  {
    id: "ps-chain-and",
    action: "rewrite",
    pattern: /\s*&&\s*/g,
    replacement: " ; ",
    hint: "PowerShell 5.1 does not support `&&`; rewritten to `;`.",
  },
  {
    id: "ps-chain-or",
    action: "rewrite",
    pattern: /\s*\|\|\s*/g,
    replacement: " ; ",
    hint: "PowerShell 5.1 does not support `||`; rewritten to `;`.",
  },
  {
    id: "interactive-git-patch",
    action: "reject",
    pattern: /\bgit\s+(?:add|checkout|reset|restore)\b[^\n]*\s-(?:p|-patch)\b/i,
    hint: "Interactive patch mode (`-p`) prompts for stdin; stage specific files instead.",
  },
  {
    id: "interactive-npm-init",
    action: "reject",
    pattern: /\bnpm\s+init\b(?![^\n]*\s-y\b)/i,
    hint: "`npm init` prompts interactively; pass `-y` (`npm init -y`).",
  },
  {
    id: "interactive-ssh",
    action: "reject",
    pattern: /^\s*ssh\s+/i,
    hint: "Interactive `ssh` sessions prompt for input and are not supported.",
  },
  {
    id: "prohibition-force-push",
    action: "reject",
    pattern: /\bgit\s+push\s+[^\n]*(?:--force|-f)\b/i,
    hint: "Force-pushing is prohibited; use a normal push or a new commit.",
  },
  {
    id: "prohibition-root-rm",
    action: "reject",
    pattern: /\brm\s+-rf\s+\/(?:\s|$)/i,
    hint: "Recursive deletion of `/` is prohibited.",
  },
];
