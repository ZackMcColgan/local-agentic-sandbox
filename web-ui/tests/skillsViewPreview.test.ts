import { describe, it } from "node:test";
import assert from "node:assert";
import React from "react";
import { renderToString } from "react-dom/server";
import { Window } from "happy-dom";
import { SkillsView } from "../components/SkillsView.js";

describe("Sprint U4 — Skills Candidate Diff Review & SKILL.md Preview Suite", () => {
  const dummyPending = [
    {
      id: "pytest-workspace-isolation",
      title: "pytest-workspace-isolation",
      pattern: "pytest-import-error",
      occurrences: 4,
      solutionSummary: "Execute python3 -m pytest via workspace_run_command inside /workspace",
      status: "pending" as const
    }
  ];

  it("renders '◨ View SKILL.md' button on pending skill candidate cards", () => {
    const html = renderToString(
      React.createElement(SkillsView, {
        onOpenDrawer: () => {},
        initialPending: dummyPending,
        initialActive: [],
        initialFlywheel: []
      })
    );

    assert.ok(
      html.includes("View SKILL.md") || html.includes("◨ View SKILL.md"),
      "Must render 'View SKILL.md' button for pending candidates"
    );
  });

  it("contains SKILL.md preview drawer elements and direct action handlers", () => {
    const html = renderToString(
      React.createElement(SkillsView, {
        onOpenDrawer: () => {},
        initialPending: dummyPending,
        initialActive: [],
        initialFlywheel: [],
        initialPreviewCandidate: dummyPending[0]
      })
    );

    const window = new Window();
    window.document.body.innerHTML = html;

    // Verify candidate card renders pattern and solution summary
    assert.ok(html.includes("pytest-workspace-isolation"));
    assert.ok(html.includes("Execute python3 -m pytest"));

    // Verify preview modal/drawer
    assert.ok(html.includes("SKILL.md Preview"), "Must render SKILL.md Preview title");
    assert.ok(
      html.includes("skills/pending/pytest-workspace-isolation.md") ||
      window.document.body.textContent?.includes("skills/pending/pytest-workspace-isolation.md"),
      "Must render pending skill file path"
    );
    assert.ok(html.includes("Directive"), "Must render markdown directive section");
    assert.ok(html.includes("confidence: 0.94"), "Must render frontmatter confidence");
    assert.ok(html.includes("✓ Approve"), "Must render direct Approve action");
    assert.ok(html.includes("Reject"), "Must render direct Reject action");
  });
});
