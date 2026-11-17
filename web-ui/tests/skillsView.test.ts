import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillsView } from "../components/SkillsView";

describe("E8: SkillsView collapses dual empty cards (UI-038)", () => {
  it("renders single unified empty state when both pending and active lists are empty", () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillsView, {
        pendingProposals: [],
        activeSkills: [],
      } as any)
    );
    assert.ok(html.includes("No skills to review"), "Expected 'No skills to review'");
    assert.equal(
      html.includes("No active skills promoted yet"),
      false,
      "Expected no second 'No active skills promoted yet' empty box"
    );
  });
});
