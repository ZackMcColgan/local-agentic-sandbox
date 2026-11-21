import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractCitations,
  hasCompletionLanguage,
  verifyEvidenceLinkedSummary,
} from "../lib/evidenceLinkedSummaries";

describe("Evidence-linked job summaries", () => {
  it("(a) summary with citations that resolve returns completed", async () => {
    const summary = "All changes are completed and merged in PR #109 (commit abc1234).";
    const result = await verifyEvidenceLinkedSummary(summary, {
      resolveCommit: async (sha: string) => sha === "abc1234",
      checkPr: async (pr: number) =>
        pr === 109 ? { exists: true, state: "MERGED" } : { exists: false, state: null },
    });

    assert.equal(result.flagged, true);
    assert.equal(result.completionStamp, "completed");
    assert.equal(result.gaps.length, 0);
  });

  it("(b) completion language with zero citations returns completed-unverified", async () => {
    const summary = "Everything is done and shipped.";
    const result = await verifyEvidenceLinkedSummary(summary, {
      resolveCommit: async () => true,
      checkPr: async () => ({ exists: true, state: "OPEN" }),
    });

    assert.equal(result.flagged, true);
    assert.equal(result.completionStamp, "completed-unverified");
    assert.ok(result.gaps.length >= 1);
  });

  it("(c) cited SHA not in git log returns completed-unverified with gap naming the SHA", async () => {
    const summary = "Finished the fix in commit deadbeef99.";
    const result = await verifyEvidenceLinkedSummary(summary, {
      resolveCommit: async () => false,
      checkPr: async () => ({ exists: true, state: "OPEN" }),
    });

    assert.equal(result.flagged, true);
    assert.equal(result.completionStamp, "completed-unverified");
    assert.ok(result.gaps.some((g) => g.kind === "commit" && g.claim.includes("deadbeef99")));
  });

  it("(d) cited PR number nonexistent returns completed-unverified with gap naming the PR", async () => {
    const summary = "Completed in PR #9999.";
    const result = await verifyEvidenceLinkedSummary(summary, {
      resolveCommit: async () => true,
      checkPr: async () => ({ exists: false, state: null }),
    });

    assert.equal(result.flagged, true);
    assert.equal(result.completionStamp, "completed-unverified");
    assert.ok(result.gaps.some((g) => g.kind === "pr" && g.claim.includes("9999")));
  });

  it("(e) non-completion text with no citations is NOT flagged", async () => {
    const summary = "I am checking the logs now. Do you want me to proceed with the refactor?";
    const result = await verifyEvidenceLinkedSummary(summary, {
      resolveCommit: async () => false,
      checkPr: async () => ({ exists: false, state: null }),
    });

    assert.equal(result.flagged, false);
    assert.equal(result.completionStamp, undefined);
    assert.equal(result.gaps.length, 0);
  });

  it("(f) summary whose only 'citation' is a bare 'tests pass' with no run reference returns completed-unverified", async () => {
    const summary = "All done — tests pass.";
    const result = await verifyEvidenceLinkedSummary(summary, {
      resolveCommit: async () => true,
      checkPr: async () => ({ exists: true, state: "OPEN" }),
    });

    assert.equal(result.flagged, true);
    assert.equal(result.completionStamp, "completed-unverified");
    assert.ok(result.gaps.length >= 1);
  });

  it("recognizes test:gate pass line only when it names the run/head it covers", () => {
    const bare = extractCitations("tests pass");
    assert.equal(bare.gateLines.length, 0);

    const withHead = extractCitations("test:gate passed on head abc1234");
    assert.equal(withHead.gateLines.length, 1);
    assert.ok(withHead.commits.includes("abc1234"));

    assert.equal(hasCompletionLanguage("Work is completed."), true);
    assert.equal(hasCompletionLanguage("Still investigating the issue."), false);
  });

  it("(g) non-job summary with completion language, hex token, and #N returns neutral result without invoking adapters", async () => {
    let resolveCalls = 0;
    let prCalls = 0;
    const summary = "All done — the answer is complete. See deadbeef and #5.";
    const result = await verifyEvidenceLinkedSummary(
      summary,
      {
        resolveCommit: async () => {
          resolveCalls += 1;
          return true;
        },
        checkPr: async () => {
          prCalls += 1;
          return { exists: true, state: "MERGED" };
        },
      },
      { isJobSummary: false }
    );

    assert.equal(result.flagged, false);
    assert.equal(result.completionStamp, undefined);
    assert.equal(result.gaps.length, 0);
    assert.equal(resolveCalls, 0);
    assert.equal(prCalls, 0);
  });

  it("(h) job summary with explicit isJobSummary: true keeps verification behavior", async () => {
    const noCitations = await verifyEvidenceLinkedSummary(
      "All done — the answer is complete.",
      {
        resolveCommit: async () => true,
        checkPr: async () => ({ exists: true, state: "OPEN" }),
      },
      { isJobSummary: true }
    );
    assert.equal(noCitations.flagged, true);
    assert.equal(noCitations.completionStamp, "completed-unverified");
    assert.ok(noCitations.gaps.length >= 1);

    const withCitations = await verifyEvidenceLinkedSummary(
      "All done — merged in #5 (deadbeef).",
      {
        resolveCommit: async (sha: string) => sha === "deadbeef",
        checkPr: async (pr: number) =>
          pr === 5 ? { exists: true, state: "MERGED" } : { exists: false, state: null },
      },
      { isJobSummary: true }
    );
    assert.equal(withCitations.flagged, true);
    assert.equal(withCitations.completionStamp, "completed");
    assert.equal(withCitations.gaps.length, 0);
  });
});
