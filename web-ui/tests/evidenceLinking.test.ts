import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createCriticWorker } from "../lib/subagents/workerPool.js";
import { Milestone, EvidenceItem } from "../lib/subagents/types.js";
import {
  checkOllama,
  enableOllamaMock,
  disableOllamaMock,
  logServiceMode
} from "./helpers/serviceMocks.js";

describe("Phase 2 — Item 5: Evidence Linking Suite", () => {

  let useRealOllama = false;

  before(async () => {
    useRealOllama = await checkOllama();
    logServiceMode("ollama", useRealOllama);
    if (!useRealOllama) enableOllamaMock();
  });

  after(() => {
    if (!useRealOllama) disableOllamaMock();
  });
  it("Critic verdict with 3 evidence items → accepted", async () => {
    const milestone: Milestone = {
      id: "M-EV-1",
      title: "Evidence inclusion",
      description: "Verify criteria with evidence",
      status: "in_progress",
      builderIterations: 1,
      criticRounds: 0,
      acceptanceCriteria: [
        { id: "AC-1", assertion: "must have egress-mesh" },
        { id: "AC-2", assertion: "must have #ffffff" },
        { id: "AC-3", assertion: "must have 30 cells" }
      ]
    };

    const diff = `--- a/arch.drawio\n+++ b/arch.drawio\n@@ -1,3 +1,6 @@\n+ network: egress-mesh\n+ background: #ffffff\n+ 30 mxCells rendered`;
    const critic = createCriticWorker();
    const review = await critic.evaluateMilestoneDiff(milestone, { diff });

    assert.equal(review.approved, true);
    assert.ok(review.evidence && review.evidence.length >= 3, "Must collect >= 3 evidence items");
    assert.ok(review.evidence.every((e) => e.type && e.ref && e.excerpt));
  });

  it("Critic verdict with empty evidence → treated as abstain (not approved)", async () => {
    const milestone: Milestone = {
      id: "M-EV-EMPTY",
      title: "Empty evidence gate",
      description: "No evidence collected",
      status: "in_progress",
      builderIterations: 1,
      criticRounds: 0,
      acceptanceCriteria: []
    };

    const critic = createCriticWorker();
    const review = await critic.evaluateMilestoneDiff(milestone, {
      diff: "+ comment line only without criteria",
      forceEmptyEvidence: true
    } as any);

    assert.equal(review.approved, false, "Empty evidence MUST fail-closed");
    assert.equal(review.abstained, true, "Empty evidence treated as abstain");
    assert.ok(review.feedback.some((f) => f.includes("Evidence linking check failed") || f.includes("fail-closed")));
  });

  it("Evidence excerpts are truncated to 500 chars max", async () => {
    const longString = "A".repeat(1000);
    const milestone: Milestone = {
      id: "M-EV-LONG",
      title: "Truncation check",
      description: "Ensure truncation",
      status: "in_progress",
      builderIterations: 1,
      criticRounds: 0,
      acceptanceCriteria: [
        { id: "AC-LONG", assertion: "must have egress-mesh" }
      ]
    };

    const diff = `+ network: egress-mesh ${longString}`;
    const critic = createCriticWorker();
    const review = await critic.evaluateMilestoneDiff(milestone, { diff });

    assert.ok(review.evidence);
    for (const ev of review.evidence) {
      assert.ok(ev.excerpt.length <= 500, `Evidence excerpt length (${ev.excerpt.length}) must be <= 500`);
    }
  });

  it("Each evidence item has a valid type and non-empty ref", async () => {
    const milestone: Milestone = {
      id: "M-EV-VALID",
      title: "Type validation",
      description: "Check schema compliance",
      status: "in_progress",
      builderIterations: 1,
      criticRounds: 0,
      acceptanceCriteria: [
        { id: "AC-V1", assertion: "egress-mesh network" }
      ]
    };

    const diff = "+ egress-mesh network confirmed";
    const critic = createCriticWorker();
    const review = await critic.evaluateMilestoneDiff(milestone, { diff });

    assert.ok(review.evidence && review.evidence.length > 0);
    for (const ev of review.evidence) {
      assert.ok(["diff", "test", "file"].includes(ev.type));
      assert.ok(ev.ref.trim().length > 0);
      assert.ok(ev.excerpt.trim().length > 0);
    }
  });
});
