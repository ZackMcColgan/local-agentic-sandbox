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
      const next = command.replace(trap.pattern, trap.replacement);
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
