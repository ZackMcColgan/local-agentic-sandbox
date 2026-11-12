/**
 * Reconcile-poll backoff policy (UI-006 / UI-006b,
 * docs/ui-qa-findings-2026-11-10.md).
 *
 * The detached-turn reconciliation poll in ChatStream.tsx previously re-armed
 * on a fixed 1s setTimeout with no backoff, no attempt cap, and no total-time
 * cap - measured 5 GETs in 8s on a detached thread, and it kept polling while
 * ChatStream was hidden (app/page.tsx hides via CSS, the component stays
 * mounted). This policy caps the traffic and gates on the active view.
 */

/** First re-arm delay. */
export const RECONCILE_POLL_BASE_MS = 1000;

/** Ceiling for a single re-arm delay. */
export const RECONCILE_POLL_MAX_DELAY_MS = 8000;

/** Hard cap on poll attempts for one reconcile episode. */
export const RECONCILE_POLL_MAX_ATTEMPTS = 12;

/** Hard cap on total elapsed poll time for one reconcile episode. */
export const RECONCILE_POLL_MAX_TOTAL_MS = 60_000;

/**
 * Exponential backoff for the poll re-arm: base * 2^attempt, clamped to
 * RECONCILE_POLL_MAX_DELAY_MS.
 */
export function reconcilePollDelayMs(attempt: number): number {
  const delay = RECONCILE_POLL_BASE_MS * Math.pow(2, Math.max(0, attempt));
  return Math.min(delay, RECONCILE_POLL_MAX_DELAY_MS);
}

export interface ReconcilePollState {
  /** Poll attempts completed for the current reconcile episode. */
  attempts: number;
  /** Milliseconds elapsed since the episode started. */
  elapsedMs: number;
  /** Whether ChatStream is the active view (hidden views must not poll). */
  isActiveView: boolean;
}

/**
 * True when the poll must stop: hidden view, attempt cap, or total-time cap.
 */
export function shouldStopReconcilePoll(state: ReconcilePollState): boolean {
  if (!state.isActiveView) return true;
  if (state.attempts >= RECONCILE_POLL_MAX_ATTEMPTS) return true;
  if (state.elapsedMs >= RECONCILE_POLL_MAX_TOTAL_MS) return true;
  return false;
}
