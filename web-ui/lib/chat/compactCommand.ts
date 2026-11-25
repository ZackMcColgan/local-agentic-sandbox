/**
 * Board #139: /compact composer slash command (industry-standard). Matches
 * ONLY the trimmed, case-insensitive exact token
 * "/compact" — anything longer (e.g. "/compact please", "run /compact now")
 * is a normal chat message and must send byte-identical.
 */
export function isCompactCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/compact";
}
