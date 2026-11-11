/**
 * Pure search-and-replace core for the host_replace_string tool.
 *
 * Exact-string semantics only: no regex, and the replacement text is
 * inserted literally (String.replace's $-pattern substitution is NOT
 * applied — code edits routinely contain $ sequences that must survive
 * byte-for-byte). The web-ui diff preview implements the same semantics.
 */
export interface ReplaceStringResult {
  success: boolean;
  /** New full file content. Present only on success. */
  content?: string;
  /** How many replacements were applied. Present only on success. */
  replacements?: number;
  /** Total exact occurrences of oldString found in the content. */
  occurrences: number;
  /** Human-readable failure reason. Present only on failure. */
  error?: string;
}

export function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = content.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = content.indexOf(needle, idx + needle.length);
  }
  return count;
}

export function applyReplaceString(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false
): ReplaceStringResult {
  if (typeof oldString !== "string" || oldString.length === 0) {
    return { success: false, occurrences: 0, error: "oldString must not be empty" };
  }
  const occurrences = countOccurrences(content, oldString);
  if (occurrences === 0) {
    return { success: false, occurrences: 0, error: "oldString not found in file content" };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      success: false,
      occurrences,
      error: `oldString occurs ${occurrences} times; pass replaceAll=true or expand oldString with surrounding context to disambiguate`
    };
  }
  if (replaceAll) {
    return {
      success: true,
      content: content.split(oldString).join(newString),
      replacements: occurrences,
      occurrences
    };
  }
  const idx = content.indexOf(oldString);
  const next =
    content.slice(0, idx) + newString + content.slice(idx + oldString.length);
  return { success: true, content: next, replacements: 1, occurrences };
}
