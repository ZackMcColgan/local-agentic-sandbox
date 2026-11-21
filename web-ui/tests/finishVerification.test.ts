import { describe, it } from "node:test";
import assert from "node:assert/strict";

// @ts-ignore - resolved at test time
import { verifyCompletionClaims, stampCompletion } from "../lib/finishVerification";

describe("Phase 2: finish-verification against ground truth", () => {
  it("returns completed-unverified with named gap when a claimed commit SHA does not resolve", async () => {
    const result = await verifyCompletionClaims(
      { commits: ["deadbeef0000"], gatePassed: true },
      {
        resolveCommit: async () => false,
        checkPr: async () => ({ exists: true, state: "OPEN" }),
      }
    );
    assert.equal(result.status, "completed-unverified");
    assert.ok(result.gaps.length >= 1);
    assert.match(result.gaps[0].claim, /deadbeef0000/);
  });

  it("returns completed-unverified when a claimed PR does not exist", async () => {
    const result = await verifyCompletionClaims(
      { commits: ["abc1234"], prs: [{ number: 9999, expectedState: "OPEN" }], gatePassed: true },
      {
        resolveCommit: async () => true,
        checkPr: async () => ({ exists: false, state: null }),
      }
    );
    assert.equal(result.status, "completed-unverified");
    assert.ok(result.gaps.some((g) => g.kind === "pr" && g.claim.includes("9999")));
  });

  it("returns completed when commit, PR, and recorded gate all verify", async () => {
    const result = await verifyCompletionClaims(
      { commits: ["abc1234"], prs: [{ number: 108, expectedState: "OPEN" }], gatePassed: true },
      {
        resolveCommit: async () => true,
        checkPr: async () => ({ exists: true, state: "OPEN" }),
      }
    );
    assert.equal(result.status, "completed");
    assert.equal(result.gaps.length, 0);

    const stamped = stampCompletion({ id: "t1" }, result);
    assert.equal(stamped.completionStamp, "completed");
  });

  it("treats fallback-written file as verified when covering gate passes, and unverified when absent/failing", async () => {
    const verified = await verifyCompletionClaims(
      { fallbackFiles: ["web-ui/lib/foo.ts"], gatePassed: true },
      {
        resolveCommit: async () => true,
        checkPr: async () => ({ exists: true, state: "OPEN" }),
      }
    );
    assert.equal(verified.status, "completed");

    const unverified = await verifyCompletionClaims(
      { fallbackFiles: ["web-ui/lib/foo.ts"], gatePassed: false },
      {
        resolveCommit: async () => true,
        checkPr: async () => ({ exists: true, state: "OPEN" }),
      }
    );
    assert.equal(unverified.status, "completed-unverified");
    assert.ok(unverified.gaps.some((g) => g.kind === "fallback_file"));
  });
});
