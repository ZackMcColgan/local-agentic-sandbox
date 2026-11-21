import { COMMAND_DIALECT_TRAPS } from "./commandDialectTraps";

export interface CommandLintResult {
  command: string;
  rewritten: boolean;
  rejected: boolean;
  ruleIds: string[];
  traceNotes: string[];
  hint?: string;
}

/**
 * Applies a regex replacement only to segments outside single- and double-quoted spans.
 * Quoted spans pass through byte-identical.
 */
function replaceOutsideQuotes(input: string, pattern: RegExp, replacement: string): string {
  let out = "";
  let segmentStart = 0;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === null) {
      if (ch === "'" || ch === '"') {
        if (i > segmentStart) {
          pattern.lastIndex = 0;
          out += input.slice(segmentStart, i).replace(pattern, replacement);
        }
        quote = ch;
        segmentStart = i;
      }
    } else if (quote === '"') {
      if ((ch === "\\" || ch === "`") && i + 1 < input.length) {
        i++;
      } else if (ch === '"') {
        out += input.slice(segmentStart, i + 1);
        quote = null;
        segmentStart = i + 1;
      }
    } else if (ch === "'") {
      out += input.slice(segmentStart, i + 1);
      quote = null;
      segmentStart = i + 1;
    }
  }

  if (segmentStart < input.length) {
    if (quote !== null) {
      out += input.slice(segmentStart);
    } else {
      pattern.lastIndex = 0;
      out += input.slice(segmentStart).replace(pattern, replacement);
    }
  }

  return out;
}

/**
 * Lints a host command against COMMAND_DIALECT_TRAPS before execution.
 * Clean commands pass byte-identical with no trace noise.
 */
export function lintHostCommand(rawCommand: string): CommandLintResult {
  let command = rawCommand;
  let rewritten = false;
  const ruleIds: string[] = [];
  const traceNotes: string[] = [];

  for (const trap of COMMAND_DIALECT_TRAPS) {
    trap.pattern.lastIndex = 0;
    if (!trap.pattern.test(command)) continue;
    trap.pattern.lastIndex = 0;

    if (trap.action === "reject") {
      return {
        command: rawCommand,
        rewritten: false,
        rejected: true,
        ruleIds: [trap.id],
        traceNotes: [`[${trap.id}] Rejected: ${trap.hint}`],
        hint: trap.hint,
      };
    }

    if (trap.action === "rewrite" && trap.replacement !== undefined) {
      const next = replaceOutsideQuotes(command, trap.pattern, trap.replacement);
      if (next !== command) {
        command = next;
        rewritten = true;
        ruleIds.push(trap.id);
        traceNotes.push(`[${trap.id}] Rewritten: ${trap.hint}`);
      }
    }
  }

  return {
    command,
    rewritten,
    rejected: false,
    ruleIds,
    traceNotes,
  };
}
