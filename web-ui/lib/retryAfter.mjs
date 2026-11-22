/**
 * Parses an HTTP `Retry-After` header value into a delay in milliseconds.
 *
 * Contract (per brief):
 * - null / undefined / empty / whitespace-only -> null
 * - non-negative integer string (e.g. "120", "0", "000") -> seconds * 1000
 *   (a plain delay, independent of nowMs)
 * - valid HTTP-date string (e.g. "Wed, 21 Oct 2015 07:28:00 GMT") ->
 *   Math.max(0, Date.parse(value) - nowMs), where nowMs defaults to Date.now()
 *   (past dates clamp to 0)
 * - negative (e.g. "-5") or unparseable -> null
 *
 * @param {string | null | undefined} headerValue
 * @param {number} [nowMs]
 * @returns {number | null}
 */
export function parseRetryAfter(headerValue, nowMs = Date.now()) {
  if (headerValue === null || headerValue === undefined) {
    return null;
  }

  if (typeof headerValue !== 'string') {
    return null;
  }

  const trimmed = headerValue.trim();
  if (trimmed === '') {
    return null;
  }

  // Numeric-looking values are handled as seconds; only non-negative integers
  // are valid. Rejects negatives ("-5") and non-integers ("1.5").
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    if (!Number.isInteger(numeric) || numeric < 0) {
      return null;
    }
    return numeric * 1000;
  }

  // Otherwise treat as an HTTP-date; clamp past dates to 0.
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.max(0, parsed - nowMs);
}

export default parseRetryAfter;
