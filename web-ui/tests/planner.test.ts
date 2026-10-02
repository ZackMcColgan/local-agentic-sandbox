import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePlanSpec, parsePlanSpec, type PlanSpec } from "../lib/subagents/planner.js";

describe("Phase 1 — Planner Worker Suite", () => {
  const taskPrompt = "Build a draw.io architecture diagram of this repo's current state, README-ready.";

  it("generates a SPEC.md containing >= 3 milestones each with >= 1 machine-checkable acceptance criterion", async () => {
    const spec = await generatePlanSpec({
      taskId: "task-dogfood-001",
      goal: taskPrompt,
      toolchain: "node:22",
    });

    assert.ok(spec, "PlanSpec must be returned");
    assert.ok(spec.milestones.length >= 3, `Must contain >= 3 milestones, got ${spec.milestones.length}`);

    // Every milestone must have at least 1 machine-checkable acceptance criterion
    for (const milestone of spec.milestones) {
      assert.ok(milestone.id, "Milestone must have an id");
      assert.ok(milestone.title, "Milestone must have a title");
      assert.ok(
        milestone.acceptanceCriteria && milestone.acceptanceCriteria.length >= 1,
        `Milestone ${milestone.id} must have >= 1 acceptance criterion`
      );
      assert.ok(
        milestone.acceptanceCriteria[0].assertion,
        `Milestone ${milestone.id} criterion must have a verifiable assertion`
      );
    }
  });

  it("validates SPEC.md markdown formatting and schema serialization", async () => {
    const spec = await generatePlanSpec({
      taskId: "task-dogfood-001",
      goal: taskPrompt,
      toolchain: "node:22",
    });

    const markdown = spec.toMarkdown();
    assert.ok(markdown.includes("# SPEC:"), "Markdown must contain SPEC header");
    assert.ok(markdown.includes("## Milestones"), "Markdown must contain Milestones section");
    assert.ok(markdown.includes("Acceptance Criteria:"), "Markdown must contain Acceptance Criteria");

    // Parse back from markdown to ensure lossless round-trip
    const parsed = parsePlanSpec(markdown);
    assert.equal(parsed.goal, spec.goal);
    assert.equal(parsed.milestones.length, spec.milestones.length);
    assert.equal(parsed.milestones[0].id, spec.milestones[0].id);
  });

  it("defines done-ness before builder starts and rejects missing criteria", () => {
    assert.throws(
      () => {
        parsePlanSpec("# SPEC: Incomplete\n## Milestones\n### Milestone 1: No criteria\nJust text without criteria block.");
      },
      /acceptance criteri(a|on)/i,
      "Planner parser must reject specs lacking machine-checkable acceptance criteria"
    );
  });
});
