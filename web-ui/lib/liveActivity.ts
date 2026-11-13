import { formatElapsedDuration } from "./chatUtils";

/**
 * Pure helpers for the Live Activity Header (UI-017) and the header
 * disconnect alert chip. Kept free of React so the behavior is unit-testable
 * and shared by every surface that renders turn liveness.
 */

/** A turn is "live" while activity arrived within this window. */
export const LIVE_WINDOW_SECONDS = 14;
/** Past this many silent seconds a running turn reads as STALLED. */
export const STALLED_THRESHOLD_SECONDS = 45;
/** How long the RECOVERED banner stays on screen after a reconnect. */
export const RECOVERED_BANNER_MS = 10_000;

export type StreamFreshness = "live" | "idle" | "stalled";

export interface FreshnessResult {
  state: StreamFreshness;
  secondsAgo: number;
}

export function freshnessFor(lastActivityAtMs: number, nowMs: number): FreshnessResult {
  const secondsAgo = Math.max(0, Math.floor((nowMs - lastActivityAtMs) / 1000));
  if (secondsAgo <= LIVE_WINDOW_SECONDS) return { state: "live", secondsAgo };
  if (secondsAgo <= STALLED_THRESHOLD_SECONDS) return { state: "idle", secondsAgo };
  return { state: "stalled", secondsAgo };
}

/**
 * Phase label in words for the current tool, e.g.
 * "Writing code — host_run_file_write". Before the first tool call (or when
 * the active tool is unknown) the honest label is "Starting turn…".
 */
export function phaseLabelForTool(toolName?: string | null): string {
  const tool = (toolName || "").trim();
  if (!tool) return "Starting turn…";
  if (/file_write|write_file/.test(tool)) return `Writing code — ${tool}`;
  if (/file_read|read_file/.test(tool)) return `Reading repo — ${tool}`;
  if (/grep/.test(tool)) return `Searching repo — ${tool}`;
  if (/search_web|web_search/.test(tool)) return `Searching the web — ${tool}`;
  if (/run_tests|test_run|run_test/.test(tool)) return `Running tests — ${tool}`;
  if (/run_command|execute|shell|bash|command/.test(tool)) return `Running command — ${tool}`;
  if (/browser/.test(tool)) return `Browsing — ${tool}`;
  return `Working — ${tool}`;
}

/** Collapsed end-of-turn Thinking row label: "Thought for 2m 41s". */
export function formatThoughtLabel(durationMs: number): string {
  return `Thought for ${formatElapsedDuration(Math.max(0, Math.round(durationMs / 1000)))}`;
}

export interface HostDisconnectInput {
  hostAccess: boolean;
  runnerState: string | null;
  runnerAvailable: boolean | null;
}

/**
 * The header disconnect alert chip renders ONLY while the host runner is
 * actually down: host access is enabled in Settings but the runner reports
 * UNAVAILABLE (or the availability probe said false before a state arrived).
 * Access disabled by choice is not a disconnect, and an unknown state never
 * raises the alarm.
 */
export function hostDisconnectChipVisible(input: HostDisconnectInput): boolean {
  if (!input.hostAccess) return false;
  if (input.runnerState === "UNAVAILABLE") return true;
  if (input.runnerState === null && input.runnerAvailable === false) return true;
  return false;
}

export type StreamBannerKind = "disconnected" | "recovered" | null;

export function streamBannerKind(input: {
  isDisconnected: boolean;
  recoveredAtMs: number | null;
  nowMs: number;
}): StreamBannerKind {
  if (input.isDisconnected) return "disconnected";
  if (input.recoveredAtMs != null && input.nowMs - input.recoveredAtMs <= RECOVERED_BANNER_MS) {
    return "recovered";
  }
  return null;
}
