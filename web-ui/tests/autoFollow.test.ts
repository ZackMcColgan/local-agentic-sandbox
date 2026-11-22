import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_FOLLOW_THRESHOLD_PX,
  computeFollowState,
  shouldAutoScrollOnUpdate,
} from "../lib/autoFollow";

describe("autoFollow — scroll follow & floating Live pill", () => {
  it("stays pinned when at or near the bottom", () => {
    const state = computeFollowState({
      scrollTop: 950,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    assert.equal(state.isAtBottom, true);
    assert.equal(state.shouldShowLivePill, false);
  });

  it("disengages follow and reveals Live pill when scrolled up past threshold", () => {
    const state = computeFollowState({
      scrollTop: 400,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    assert.equal(state.isAtBottom, false);
    assert.equal(state.shouldShowLivePill, true);
    assert.equal(AUTO_FOLLOW_THRESHOLD_PX, 90);
  });

  it("auto-scrolls on streaming updates only when follow is pinned", () => {
    assert.equal(
      shouldAutoScrollOnUpdate({
        isFollowPinned: true,
        isStreaming: true,
        isUserScrolledUp: false,
      }),
      true
    );
    assert.equal(
      shouldAutoScrollOnUpdate({
        isFollowPinned: false,
        isStreaming: true,
        isUserScrolledUp: true,
      }),
      false
    );
    assert.equal(
      shouldAutoScrollOnUpdate({
        isFollowPinned: true,
        isStreaming: false,
        isUserScrolledUp: false,
      }),
      false
    );
  });
});
