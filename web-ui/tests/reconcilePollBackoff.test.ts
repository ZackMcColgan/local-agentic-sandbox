import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  RECONCILE_POLL_BASE_MS,
  RECONCILE_POLL_MAX_DELAY_MS,
  RECONCILE_POLL_MAX_ATTEMPTS,
  RECONCILE_POLL_MAX_TOTAL_MS,
  reconcilePollDelayMs,
  shouldStopReconcilePoll
} from "../lib/reconcilePollPolicy";

/**
 * UI-006 + UI-006b (docs/ui-qa-findings-2026-11-10.md): the reconcile poll in
 * ChatStream.tsx re-armed on a fixed 1s setTimeout with no backoff, no attempt
 * cap, no total-time cap, and kept polling while ChatStream was hidden
 * (app/page.tsx hides via CSS; the component stays mounted).
 *
 * The policy is extracted to lib/reconcilePollPolicy.ts so the loop's
 * arithmetic is testable without a browser; wiring is asserted against source.
 */
describe("reconcile poll backoff policy (UI-006)", () => {
  it("re-arm interval grows exponentially across attempts", () => {
    assert.equal(reconcilePollDelayMs(0), RECONCILE_POLL_BASE_MS);
    assert.equal(reconcilePollDelayMs(1), RECONCILE_POLL_BASE_MS * 2);
    assert.equal(reconcilePollDelayMs(2), RECONCILE_POLL_BASE_MS * 4);
    assert.equal(reconcilePollDelayMs(3), RECONCILE_POLL_BASE_MS * 8);
    // strictly non-decreasing across the whole attempt range
    for (let i = 1; i < RECONCILE_POLL_MAX_ATTEMPTS; i++) {
      assert.ok(
        reconcilePollDelayMs(i) >= reconcilePollDelayMs(i - 1),
        `delay must not shrink at attempt ${i}`
      );
    }
    // growth must actually exceed the old fixed 1s cadence
    assert.ok(reconcilePollDelayMs(3) > RECONCILE_POLL_BASE_MS, "backoff must grow past the fixed 1s cadence");
  });

  it("delay is clamped to the max delay ceiling", () => {
    assert.equal(reconcilePollDelayMs(20), RECONCILE_POLL_MAX_DELAY_MS);
    assert.ok(RECONCILE_POLL_MAX_DELAY_MS > RECONCILE_POLL_BASE_MS);
  });

  it("stops after the attempt cap", () => {
    assert.equal(
      shouldStopReconcilePoll({ attempts: RECONCILE_POLL_MAX_ATTEMPTS - 1, elapsedMs: 0, isActiveView: true }),
      false,
      "must keep polling one attempt below the cap"
    );
    assert.equal(
      shouldStopReconcilePoll({ attempts: RECONCILE_POLL_MAX_ATTEMPTS, elapsedMs: 0, isActiveView: true }),
      true,
      "must stop at the attempt cap"
    );
  });

  it("stops after the total-time cap", () => {
    assert.equal(
      shouldStopReconcilePoll({ attempts: 1, elapsedMs: RECONCILE_POLL_MAX_TOTAL_MS - 1, isActiveView: true }),
      false,
      "must keep polling one ms below the total-time cap"
    );
    assert.equal(
      shouldStopReconcilePoll({ attempts: 1, elapsedMs: RECONCILE_POLL_MAX_TOTAL_MS, isActiveView: true }),
      true,
      "must stop at the total-time cap"
    );
  });

  it("stops entirely when ChatStream is not the active view (UI-006b)", () => {
    assert.equal(
      shouldStopReconcilePoll({ attempts: 0, elapsedMs: 0, isActiveView: false }),
      true,
      "hidden ChatStream must never poll"
    );
    assert.equal(
      shouldStopReconcilePoll({ attempts: RECONCILE_POLL_MAX_ATTEMPTS, elapsedMs: RECONCILE_POLL_MAX_TOTAL_MS, isActiveView: false }),
      true,
      "hidden ChatStream must stay stopped even past caps"
    );
  });

  it("keeps polling while active and inside both caps", () => {
    assert.equal(
      shouldStopReconcilePoll({ attempts: 2, elapsedMs: 5000, isActiveView: true }),
      false
    );
  });
});

describe("reconcile poll wiring (UI-006)", () => {
  const streamSrc = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
  const pageSrc = fs.readFileSync(path.resolve(__dirname, "../app/page.tsx"), "utf8");

  it("ChatStream uses the backoff policy instead of the fixed 1s re-arm", () => {
    assert.match(streamSrc, /reconcilePollDelayMs/, "loop must re-arm via reconcilePollDelayMs");
    assert.match(streamSrc, /shouldStopReconcilePoll/, "loop must consult shouldStopReconcilePoll");
    assert.doesNotMatch(
      streamSrc,
      /setTimeout\(pollDetachedTurn,\s*1000\)/,
      "the fixed 1s setTimeout re-arm must be gone"
    );
  });

  it("ChatStream gates the poll on the active-view signal", () => {
    assert.match(streamSrc, /isActiveView/, "ChatStream must receive an active-view signal");
    assert.match(streamSrc, /isActiveView\s*\]?\s*\)/, "poll effect must depend on the active-view signal");
  });

  it("page.tsx derives isActiveView from the existing active-view signal, no new global", () => {
    assert.match(
      pageSrc,
      /isActiveView=\{activeNavView === "sessions" && viewMode === "unified"\}/,
      "page must pass the existing (activeNavView === sessions && viewMode === unified) signal to ChatStream"
    );
  });
});
