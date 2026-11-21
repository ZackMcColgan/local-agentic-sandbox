/** Max characters for a derived thread-list title (UI-008). */
export const THREAD_TITLE_MAX_CHARS = 80;

/**
 * UI-008: derive a readable thread-list title from a goal/prompt at
 * record-create time. Strips the driver/session style prefixes
 * ('Session: ', 'JOB — ' incl. hyphen/dash variants) case-insensitively,
 * collapses to the first line, and truncates at a word boundary so the
 * sidebar never shows a raw prefix or a mid-word cut. Plain goals pass
 * through unchanged apart from the word-boundary truncation.
 */
export function deriveStoredThreadTitle(raw: string | undefined): string {
  let text = (raw ?? "").trim();
  // Strip stacked style prefixes: 'Session:' / 'JOB' followed by an em/en dash,
  // hyphen, or colon separator. Only the exact prefix tokens are removed —
  // ordinary words that merely start with 'job'/'session' are left intact.
  const prefixPattern = /^(?:session|job)\s*[:\-–—]\s*/i;
  while (prefixPattern.test(text)) {
    text = text.replace(prefixPattern, "").trim();
  }
  // First line only — multi-line briefs keep the summary line.
  const firstLine = text.split(/\r?\n/)[0].trim();
  return firstLine || "New thread";
}

export function deriveThreadTitle(
  raw: string | undefined,
  maxChars: number = THREAD_TITLE_MAX_CHARS
): string {
  const firstLine = deriveStoredThreadTitle(raw);
  if (firstLine === "New thread") return firstLine;
  if (firstLine.length <= maxChars) return firstLine;
  // Truncate at a word boundary: cut at the last whitespace before the cap.
  const window = firstLine.slice(0, maxChars);
  const lastBoundary = window.lastIndexOf(" ");
  const cut = lastBoundary > 0 ? window.slice(0, lastBoundary) : window;
  return cut.trim();
}
