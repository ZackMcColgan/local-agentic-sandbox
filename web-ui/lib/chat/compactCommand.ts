/**
 * Composer slash-command recognition for manual context compaction.
 *
 * `/compact` is the industry-standard manual-compaction command (Claude Code
 * and peers). It must match ONLY when the trimmed message is exactly the
 * command, case-insensitive. Any longer text — including messages that merely
 * contain `/compact` (e.g. "/compact please", "run /compact now") — is a
 * normal chat message and must be sent byte-identically.
 */
export const COMPACT_COMMAND = "/compact";

/**
 * Returns true when `text` (after trimming surrounding whitespace) is exactly
 * the /compact command, case-insensitive.
 */
export function isCompactCommand(text: string): boolean {
  return text.trim().toLowerCase() === COMPACT_COMMAND;
}
