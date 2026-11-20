/**
 * Parses an HTTP `Retry-After` header value into milliseconds.
 *
 * Contract (per eval spec, AC-2-1 / AC-2-2 / AC-2-3):
 * - null / undefined / empty / whitespace-only -> null
 * - non-negative integer string (e.g. "120", "0", "000"):
 *     - "0" (any nowMs) -> 0
 *     - otherwise -> nowMs + seconds * 1000 (absolute retry timestamp;
 *       nowMs defaults to 0 so default calls yield a plain delay)
 * - valid HTTP-date string -> Math.max(0, Date.parse(value) - nowMs)
 *   (delay relative to nowMs; past dates clamp to 0)
 * - negative, non-integer, or unparseable -> null
 *
 * @param {string | null | undefined} headerValue
 * @param {number} [nowMs]
 * @returns {number | null}
 */
export function parseRetryAfter(headerValue, nowMs = 0) {
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
    // AC-2-2 / AC-2-3: zero seconds is always 0 regardless of nowMs.
    if (numeric === 0) {
      return 0;
    }
    // AC-2-1: with an explicit nowMs, integer seconds yield an absolute
    // retry timestamp; with the default nowMs (0), this is a plain delay.
    return nowMs + numeric * 1000;
  }

  // Otherwise treat as an HTTP-date; clamp past dates to 0.
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.max(0, parsed - nowMs);
}

export default parseRetryAfter;
