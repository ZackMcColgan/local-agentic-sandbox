import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveSupervisorBadgeState } from "../components/supervisorBadgeState";

describe("SupervisorStatusBadge — state derivation", () => {
  it("returns needs-attention when thread.needsAttention is true", () => {
    const state = deriveSupervisorBadgeState({
      needsAttention: true,
      stalledReason: "Turn stalled: no activity for 10m",
      autoResumeCount: 2,
    });
    assert.equal(state?.kind, "needs_attention");
    assert.match(state?.label ?? "", /needs attention/i);
  });

  it("returns stalled when thread.stalledReason is set without needsAttention", () => {
    const state = deriveSupervisorBadgeState({
      stalledReason: "Turn stalled: no activity for 10m",
    });
    assert.equal(state?.kind, "stalled");
    assert.match(state?.label ?? "", /stalled/i);
  });

  it("returns auto-resumed when autoResumeCount > 0 and not needsAttention", () => {
    const state = deriveSupervisorBadgeState({
      autoResumeCount: 1,
    });
    assert.equal(state?.kind, "auto_resumed");
    assert.match(state?.label ?? "", /1\/2/);
  });

  it("returns null for normal threads", () => {
    const state = deriveSupervisorBadgeState({});
    assert.equal(state, null);
  });
});
