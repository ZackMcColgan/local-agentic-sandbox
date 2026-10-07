import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCriticWorker } from "../lib/subagents/workerPool";
import { Milestone } from "../lib/subagents/types";

describe("Critic Worker — Validation, Rejection, and Fail-Closed Abstention", () => {
  const sampleMilestone: Milestone = {
    id: "M-test-critic",
    title: "Implement SVG weather card",
    dependencies: [],
    acceptanceCriteria: [
      { id: "c1", assertion: "Canvas background is #ffffff" },
      { id: "c2", assertion: "Diagram models browser-mcp attached to egress-mesh" }
    ],
    status: "in_progress"
  };

  it("approves valid builder output meeting all criteria", async () => {
    const mockGenerate = async () => ({
      text: JSON.stringify({
        approved: true,
        feedback: [],
        analysis: "All criteria verified against diff lines."
      }),
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      model: "swift-27b-mtp",
      duration_ms: 120
    });

    const critic = createCriticWorker({ generate: mockGenerate });
    const diff = `--- a/diagram.svg
+++ b/diagram.svg
@@ -1,3 +1,5 @@
+<svg background="#ffffff">
+  <g id="browser-mcp" network="egress-mesh" />
+</svg>`;

    const review = await critic.evaluateMilestoneDiff(sampleMilestone, { diff });

    assert.equal(review.approved, true, "Critic must approve matching builder diff");
    assert.equal(review.abstained, false);
    assert.equal(review.feedback.length, 0);
  });

  it("rejects invalid builder output with clear rejection reason", async () => {
    const mockGenerate = async () => ({
      text: JSON.stringify({
        approved: false,
        feedback: ["Diff specifies network=ai-mesh instead of required egress-mesh."],
        analysis: "Network configuration violates acceptance criteria."
      }),
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 130,
      model: "swift-27b-mtp",
      duration_ms: 130
    });

    const critic = createCriticWorker({ generate: mockGenerate });
    const diff = `--- a/diagram.svg
+++ b/diagram.svg
@@ -1,3 +1,5 @@
+<svg background="#ffffff">
+  <g id="browser-mcp" network="ai-mesh" />
+</svg>`;

    const review = await critic.evaluateMilestoneDiff(sampleMilestone, { diff });

    assert.equal(review.approved, false, "Critic must reject flawed builder diff");
    assert.ok(review.feedback.length > 0, "Critic must provide rejection reasons");
    assert.ok(
      review.feedback.some((f) => f.includes("egress-mesh")),
      "Feedback must mention the specific criterion violation"
    );
  });

  it("abstains (does NOT approve) on Ollama failure, logging and surfacing abstention", async () => {
    let loggedError = "";
    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      loggedError += args.join(" ") + "\n";
      originalConsoleError(...args);
    };

    const failingGenerate = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    };

    try {
      const critic = createCriticWorker({ generate: failingGenerate });
      const diff = `--- a/diagram.svg
+++ b/diagram.svg
@@ -1,2 +1,3 @@
+<svg background="#ffffff" network="egress-mesh"></svg>`;

      const review = await critic.evaluateMilestoneDiff(sampleMilestone, { diff });

      assert.equal(review.approved, false, "Critic must NOT approve when model fails");
      assert.equal(review.abstained, true, "Critic must set abstained: true");
      assert.ok(
        review.feedback.some((f) => f.includes("critic model unreachable")),
        "Abstention reason must be surfaced in review feedback"
      );
      assert.ok(loggedError.length > 0, "Abstention must be logged to console.error");
    } finally {
      console.error = originalConsoleError;
    }
  });
});
