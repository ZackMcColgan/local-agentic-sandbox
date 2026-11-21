import { STALL_WINDOW_MS } from "./inAppSupervisor";
import type { Thread, ThreadLiveness } from "./types";

/** How long a live turn may go without a record touch before it reads as stalled. */
export const TURN_STALL_WINDOW_MS = STALL_WINDOW_MS;

/**
 * qa-6 / UI-001 + UI-002: hard cap on zombie live signals. A turn-presence
 * entry (or execution-set entry) whose thread record has gone untouched
 * past this cap belongs to a turn that died without clearing its live
 * signals — reconcile reaps it instead of trusting it forever. A genuinely
 * live turn heartbeats its record (touchActiveTurn + per-round snapshots),
 * so its record never approaches this cap while it works.
 */
export const ZOMBIE_TURN_AGE_CAP_MS = 6 * 60 * 60 * 1000;

/** True when the thread record has not been touched for longer than windowMs. */
export function isRecordStaleBeyond(thread: Thread, now: number, windowMs: number): boolean {
  const touchedAt = Date.parse(thread.updatedAt || thread.createdAt || "");
  if (!Number.isFinite(touchedAt)) return false;
  return now - touchedAt > windowMs;
}

/**
 * A presence entry is a zombie when it is older than the hard cap AND the
 * thread record has been stale past the ordinary stall window. Both
 * conditions are required: an ancient presence with a fresh record is a
 * live long turn; a young presence with a stale record may just be a
 * quiet round.
 */
export function isZombiePresence(
  presence: { startedAt: string } | null | undefined,
  thread: Thread,
  now: number
): boolean {
  if (!presence) return false;
  const startedAt = Date.parse(presence.startedAt || "");
  if (!Number.isFinite(startedAt)) return false;
  if (now - startedAt <= ZOMBIE_TURN_AGE_CAP_MS) return false;
  return isRecordStaleBeyond(thread, now, TURN_STALL_WINDOW_MS);
}

/**
 * Derives liveness from the record's last-activity timestamp (updatedAt) against the
 * live-execution state. A live-but-stale turn is NEVER reconciled to completed here;
 * reconciliation stays owned by reconcileThread.
 */
export function computeTurnLiveness(
  thread: Thread,
  now: number,
  isLiveOverride: boolean = false
): ThreadLiveness {
  const isLive = thread.status === "active" || thread.status === "running" || isLiveOverride;
  if (!isLive) return "settled";
  const touchedAt = Date.parse(thread.updatedAt || thread.createdAt || "");
  if (!Number.isFinite(touchedAt)) return "stalled";
  return now - touchedAt <= TURN_STALL_WINDOW_MS ? "alive" : "stalled";
}
