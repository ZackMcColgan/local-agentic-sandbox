/**
 * Client-safe helpers for board thread links. This module must stay free of
 * Node-only imports (fs, path, crypto) so client components can import it
 * without dragging the server board stores into the browser bundle.
 */
export function extractThreadIdFromLink(threadLink?: string): string | null {
  if (typeof threadLink !== "string") return null;
  const trimmed = threadLink.trim();
  if (!trimmed) return null;
  const queryMatch = /[?&]thread=([^&#]+)/.exec(trimmed);
  if (queryMatch) {
    try {
      return decodeURIComponent(queryMatch[1]);
    } catch {
      return queryMatch[1];
    }
  }
  if (!trimmed.includes("/") && !trimmed.includes("?")) {
    return trimmed;
  }
  return null;
}
