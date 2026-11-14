/**
 * Pure, client-safe helper to condense raw task failure/parked text
 * into a concise one-sentence summary plus optional raw details.
 */
export function summarizeTaskFailureReason(raw?: string): { summary: string; details?: string } {
  const text = (raw || "").trim();
  if (!text) return { summary: "Task did not complete." };
  const hasGitStatus =
    text.includes("git status --porcelain") ||
    /^\s*[MADRCU?]{1,2}\s+\S+/m.test(text);
  if (hasGitStatus) {
    return {
      summary: "Uncommitted workspace changes or dirty working tree blocked milestone verification.",
      details: text,
    };
  }
  if (text.length > 180) {
    const firstSentence = text.split(/(?<=[.!?])\s+/)[0] || text.slice(0, 150);
    return {
      summary: firstSentence.length > 160 ? `${firstSentence.slice(0, 157)}...` : firstSentence,
      details: text,
    };
  }
  return { summary: text };
}
